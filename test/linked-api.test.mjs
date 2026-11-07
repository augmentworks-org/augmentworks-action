import assert from 'node:assert/strict';
import test from 'node:test';

import { createLinkedApi, LinkedApiError, validateLinkedApiOrigin } from '../src/linked-api.mjs';

const schemaVersion = 'aw-github-integration/1';
const apiOrigin = 'https://staging.augmentworks.ai';
const path = '/v1/integrations/github/ci/admissions';
const apiKey = 'aw_api_' + 'A'.repeat(40);
const tokenOrigin = 'https://example.actions.githubusercontent.com';
const env = { ACTIONS_ID_TOKEN_REQUEST_URL: tokenOrigin + '/token?api-version=2.0&audience=discard',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-token' };
const aud = 'https://augmentworks.ai/integrations/github/actions';
const id = suffix => '00000000-0000-4000-8000-' + suffix.padStart(12, '0');
const selector = { schemaVersion, bindingId: id('1'), suiteRevisionId: id('2'), maxCredits: 4, jobKey: 'release',
  matrixLeg: 'default', evaluationSlot: 'default' };
const issue = { ...selector, quoteId: id('3'), executionPlanDigest: 'b'.repeat(64) };
const receipt = { schemaVersion, bindingId: issue.bindingId, suiteRevisionId: issue.suiteRevisionId, quoteId: issue.quoteId,
  executionPlanDigest: issue.executionPlanDigest, maxCredits: 3, admissionId: id('4'), runId: null,
  createRequestId: 'crq_github_ci_v1_' + 'a'.repeat(32), baselineId: null, operationId: null,
  target: { kind: 'fixed', origin: 'https://stage.example.test' } };
const attached = { schemaVersion, admissionId: receipt.admissionId, runId: id('5') };
const leak = 'raw-secret-from-provider';
const base64 = data => Buffer.from(JSON.stringify(data)).toString('base64url');
function jwt(overrides = {}) {
  const iat = Math.floor(Date.now() / 1000);
  return 'eyJhbGciOiJSUzI1NiJ9.' + base64({ iss: 'https://token.actions.githubusercontent.com', aud, iat,
    exp: iat + 300, ...overrides }) + '.c2ln';
}

function fixture({ platform = () => Response.json(receipt, { status: 201 }), oidc, ...options } = {}) {
  const calls = [];
  const api = createLinkedApi({ apiOrigin, apiKey, env, ...options, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (new URL(url).origin === tokenOrigin) {
      return oidc ? oidc() : Response.json({ value: jwt({ jti: String(calls.length) }) });
    }
    return platform(url, init);
  } });
  return { calls, api };
}

test('recover, issue and attach send exact P0 bodies with independent, scoped assertions', async () => {
  const { calls, api } = fixture({ platform(url) {
    if (url.endsWith('/recover')) return Response.json({ schemaVersion, request: null });
    if (url.endsWith('/run')) return Response.json(attached);
    return Response.json(receipt, { status: 201 });
  } });
  assert.deepEqual(await api.recover(selector), { schemaVersion, request: null });
  assert.deepEqual(await api.issue(issue), receipt);
  assert.deepEqual(await api.attach(attached.admissionId, attached.runId), attached);
  assert.equal(calls.length, 6);
  const expected = [
    ['POST', path + '/recover', selector],
    ['POST', path, issue],
    ['PUT', path + '/' + attached.admissionId + '/run', { schemaVersion, runId: attached.runId }],
  ];
  const tokens = new Set();
  for (const [i, [method, route, body]] of expected.entries()) {
    const [provider, service] = calls.slice(i * 2, i * 2 + 2);
    for (const { init } of [provider, service]) {
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.cache, 'no-store');
      assert.ok(init.signal instanceof AbortSignal);
    }
    const url = new URL(provider.url);
    assert.equal(url.origin, tokenOrigin);
    assert.deepEqual(url.searchParams.getAll('audience'), [aud]);
    assert.equal(url.searchParams.get('api-version'), '2.0');
    assert.equal(provider.init.method, 'GET');
    assert.deepEqual(provider.init.headers, { Authorization: 'Bearer runner-token' });
    assert.equal(service.url, apiOrigin + route);
    assert.equal(service.init.method, method);
    assert.deepEqual(JSON.parse(service.init.body), body);
    assert.equal(service.init.headers.Authorization, 'Bearer ' + apiKey);
    assert.doesNotMatch(JSON.stringify(service), /runner-token/);
    const token = service.init.headers['X-GitHub-Actions-OIDC'];
    assert.equal(JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).aud, aud);
    tokens.add(token);
  }
  assert.equal(tokens.size, 3);
});

test('recovery returns an exact retained request and replay accepts an already attached run', async () => {
  const { api } = fixture({ platform: url => url.endsWith('/recover')
    ? Response.json({ schemaVersion, request: issue }) : Response.json({ ...receipt, runId: attached.runId }) });
  const recovered = await api.recover(selector);
  assert.deepEqual(recovered.request, issue);
  assert.deepEqual(await api.issue(recovered.request), { ...receipt, runId: attached.runId });
});

test('refuses third-party destinations and insecure OIDC URLs before sending credentials', () => {
  assert.equal(validateLinkedApiOrigin('https://augmentworks.ai'), 'https://augmentworks.ai');
  for (const origin of ['http://staging.augmentworks.ai', 'https://staging.augmentworks.ai/',
    'https://pr.augmentworks.ai', 'https://staging.augmentworks.ai.evil.test', 'https://user@staging.augmentworks.ai']) {
    assert.throws(() => fixture({ apiOrigin: origin }), LinkedApiError);
  }
  for (const endpoint of ['https://evil.test/token', 'https://a.actions.githubusercontent.com.evil.test/token',
    'https://a.actions.githubusercontent.com@evil.test/token', tokenOrigin + ':444/token',
    'http://a.actions.githubusercontent.com/token', 'https://user@a.actions.githubusercontent.com/token',
    tokenOrigin + '/token#frag']) {
    assert.throws(() => fixture({ env: { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: endpoint } }), LinkedApiError);
  }
  assert.throws(() => fixture({ env: { ...env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'bad\ncredential' } }), LinkedApiError);
});

test('never forwards a wrong audience, issuer, stale or overly long-lived GitHub assertion', async () => {
  const iat = Math.floor(Date.now() / 1000);
  for (const token of [leak, jwt({ aud: 'other' }), jwt({ iss: 'https://evil.test' }), jwt({ exp: iat - 1 }),
    jwt({ iat: iat + 301 }), jwt({ exp: iat + 7200 })]) {
    const { api, calls } = fixture({ oidc: () => Response.json({ value: token }) });
    await assert.rejects(api.issue(issue), LinkedApiError);
    assert.equal(calls.length, 1);
  }
});

test('checks outgoing issue/selector fields and path parameters before fetching any identity', async () => {
  const { api, calls } = fixture();
  for (const change of [{ maxCredits: -1 }, { quoteId: 'bad' }, { matrixLeg: 'matrix' }, { baselineId: id('6') },
    { operationId: id('7') }, { executionPlanDigest: 'F'.repeat(64) }, { jobKey: '../path' }]) {
    await assert.rejects(api.issue({ ...issue, ...change }), LinkedApiError);
  }
  await assert.rejects(api.recover({ ...selector, quoteId: id('3') }), LinkedApiError);
  await assert.rejects(api.attach('../other', attached.runId), LinkedApiError);
  assert.equal(calls.length, 0);
});

test('rejects mismatched, malformed or expanded admissions', async () => {
  for (const change of [{ quoteId: id('8') }, { bindingId: id('8') }, { suiteRevisionId: id('8') }, { maxCredits: 5 },
    { maxCredits: 1.25 }, { executionPlanDigest: 'f'.repeat(64) }, { admissionId: 'x' }, { runId: 'x' },
    { createRequestId: 'crq_too_short' }, { baselineId: id('8') }, { operationId: id('8') }, { extra: true },
    { target: { kind: 'verified_preview', origin: 'https://stage.example.test' } },
    { target: { kind: 'fixed', origin: 'https://user@stage.example.test' } },
    { target: { kind: 'fixed', origin: 'https://stage.example.test/path' } },
    { target: { kind: 'fixed', origin: 'http://stage.example.test' } }]) {
    const { api } = fixture({ platform: () => Response.json({ ...receipt, ...change }) });
    await assert.rejects(api.issue(issue), LinkedApiError);
  }
});

test('rejects recovery with modified selector or an incomplete saved request and rejects unrelated attachment', async () => {
  for (const changed of [{ ...issue, maxCredits: 3 }, { ...issue, suiteRevisionId: id('8') }, { ...issue, jobKey: 'other' },
    { ...issue, bindingId: id('8') }, { ...issue, quoteId: null }, {}]) {
    const { api } = fixture({ platform: () => Response.json({ schemaVersion, request: changed }) });
    await assert.rejects(api.recover(selector), LinkedApiError);
  }
  for (const changed of [{ ...attached, admissionId: id('8') }, { ...attached, runId: id('8') }, { ...attached, extra: true }]) {
    const { api } = fixture({ platform: () => Response.json(changed) });
    await assert.rejects(api.attach(attached.admissionId, attached.runId), LinkedApiError);
  }
});

test('bounds JSON by decoded stream bytes even without Content-Length', async () => {
  for (const response of [new Response(leak + ' '.repeat(17000)), new Response(Buffer.from([0xc3, 0x28])),
    new Response('{'), new Response('{}', { headers: { 'Content-Length': '999999' } })]) {
    const { api } = fixture({ platform: () => response });
    await assert.rejects(api.issue(issue), err => err instanceof LinkedApiError && !err.message.includes(leak));
  }
});

test('conflicts and transport errors surface safe, bounded diagnostics and issue exactly once', async () => {
  for (const [platform, code] of [
    [() => Response.json({ schemaVersion, error: { code: 'idempotency_conflict', message: leak } }, { status: 409 }), 'idempotency_conflict'],
    [() => Response.json({ schemaVersion, error: { code: leak, message: leak } }, { status: 409 }), undefined],
    [() => { throw Error(leak); }, undefined],
    [() => Response.redirect('https://untrusted.test/' + leak), undefined],
  ]) {
    const { api, calls } = fixture({ platform });
    await assert.rejects(api.issue(issue), err => err instanceof LinkedApiError && err.code === code && !err.message.includes(leak));
    assert.equal(calls.length, 2);
  }
});
