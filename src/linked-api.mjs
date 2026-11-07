const version = 'aw-github-integration/1';
const admissionPath = '/v1/integrations/github/ci/admissions';
const issuer = 'https://token.actions.githubusercontent.com';
const audience = 'https://augmentworks.ai/integrations/github/actions';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const isUuid = value => typeof value === 'string' && uuid.test(value);
const sameId = (left, right) => isUuid(left) && isUuid(right) && left.toLowerCase() === right.toLowerCase();
const credits = value => Number.isSafeInteger(value) && value >= 0;

export class LinkedApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function validateLinkedApiOrigin(value) {
  if (value !== 'https://augmentworks.ai' && value !== 'https://staging.augmentworks.ai') {
    throw new LinkedApiError('Linked CI requires an approved AugmentWorks API origin.');
  }
  return value;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function canonicalHttpsOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('https://')) return false;
  try { return new URL(value).origin === value; } catch { return false; }
}

const selectorKeys = ['schemaVersion', 'bindingId', 'suiteRevisionId', 'maxCredits', 'jobKey', 'matrixLeg', 'evaluationSlot'];

function validSelector(body) {
  return body.schemaVersion === version && isUuid(body.bindingId) && isUuid(body.suiteRevisionId) && credits(body.maxCredits) &&
    typeof body.jobKey === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(body.jobKey) &&
    body.matrixLeg === 'default' && body.evaluationSlot === 'default';
}

function issueRequest(input) {
  const body = { ...input };
  if (!exactKeys(body, [...selectorKeys, 'quoteId', 'executionPlanDigest']) || !validSelector(body) ||
      !isUuid(body.quoteId) || typeof body.executionPlanDigest !== 'string' || !/^[0-9a-f]{64}$/.test(body.executionPlanDigest)) {
    throw new LinkedApiError('Invalid protected-push admission request.');
  }
  return body;
}

function validateAdmission(doc, request) {
  if (!exactKeys(doc, ['schemaVersion', 'admissionId', 'createRequestId', 'bindingId', 'baselineId',
    'operationId', 'suiteRevisionId', 'quoteId', 'maxCredits', 'executionPlanDigest', 'target', 'runId']) ||
      doc.schemaVersion !== version || !isUuid(doc.admissionId) ||
      typeof doc.createRequestId !== 'string' || !/^crq_[A-Za-z0-9_-]{20,96}$/.test(doc.createRequestId) ||
      !sameId(doc.bindingId, request.bindingId) || !sameId(doc.suiteRevisionId, request.suiteRevisionId) ||
      !sameId(doc.quoteId, request.quoteId) || !credits(doc.maxCredits) || doc.maxCredits > request.maxCredits ||
      doc.executionPlanDigest !== request.executionPlanDigest || doc.baselineId !== null || doc.operationId !== null ||
      !exactKeys(doc.target, ['kind', 'origin']) || doc.target.kind !== 'fixed' ||
      !canonicalHttpsOrigin(doc.target.origin) || (doc.runId !== null && !isUuid(doc.runId))) {
    throw new LinkedApiError('The admission did not match the approved quote, plan, ceiling and fixed-target contract.');
  }
  return doc;
}

function tokenEndpoint(env) {
  try {
    const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (url.protocol === 'https:' && url.hostname.endsWith('.actions.githubusercontent.com') &&
        !url.username && !url.password && !url.port && !url.hash &&
        typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === 'string' &&
        env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length <= 16384 &&
        /^[A-Za-z0-9._~+/-]+=*$/.test(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)) {
      url.searchParams.set('audience', audience);
      return url;
    }
  } catch { /* URL parser errors may include the runner credential. */ }
  throw new LinkedApiError('Linked CI requires a GitHub Actions OIDC endpoint and id-token: write permission.');
}

async function boundedJson(response, limit) {
  const reader = response.body?.getReader();
  const invalid = () => new LinkedApiError('Linked CI received an invalid or oversized JSON response.');
  if (!reader) throw invalid();
  const chunks = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > limit) throw invalid();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw invalid();
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    await reader.cancel().catch(() => {});
    throw invalid();
  } finally {
    reader.releaseLock();
  }
}

// The platform verifies the provider signature and job claims. Before forwarding a
// bearer assertion, independently check its destination, issuer and short lifetime.
function scopedAssertion(doc) {
  const token = doc?.value;
  if (typeof token === 'string' && token.length <= 16384 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
    try {
      const { iss, aud, iat, exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      const now = Math.floor(Date.now() / 1000);
      if (iss === issuer && aud === audience && Number.isSafeInteger(iat) && Number.isSafeInteger(exp) &&
          iat <= now + 30 && exp > now && exp > iat && exp - iat <= 600) return token;
    } catch { /* Never expose raw assertions or parse errors. */ }
  }
  throw new LinkedApiError('GitHub returned an invalid, expired or incorrectly scoped OIDC assertion.');
}

const errorStatus = {
  invalid_input: 400, unauthenticated: 401, insufficient_permission: 403, not_found: 404,
  idempotency_conflict: 409, binding_conflict: 409, dispatch_pending: 409, approval_required: 409,
  quote_consumed: 409, quote_mismatch: 409, budget_exceeded: 409, quote_expired: 409,
  insufficient_credits: 409, resource_gone: 410, rate_limited: 429, service_unavailable: 503,
};

export function createLinkedApi({ apiOrigin, apiKey, env, fetchImpl = globalThis.fetch, signal }) {
  const origin = validateLinkedApiOrigin(apiOrigin);
  if (typeof apiKey !== 'string' || !/^aw_api_[A-Za-z0-9_-]{32,256}$/.test(apiKey)) {
    throw new LinkedApiError('Linked CI requires a scoped AugmentWorks machine API key.');
  }
  const oidcUrl = tokenEndpoint(env);
  const runnerToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  async function send(url, options) {
    try {
      const deadline = AbortSignal.timeout(15000);
      return await fetchImpl(url, { ...options, redirect: 'error', cache: 'no-store', credentials: 'omit',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    } catch {
      throw new LinkedApiError('The linked CI request could not be confirmed. Retry with the original approved request.');
    }
  }

  async function request(method, path, body, allowedStatuses) {
    const oidc = await send(oidcUrl.href, { method: 'GET', headers: { Authorization: 'Bearer ' + runnerToken } });
    if (oidc.status !== 200) {
      await oidc.body?.cancel().catch(() => {});
      throw new LinkedApiError('GitHub could not issue an OIDC assertion. Check id-token: write permission.');
    }
    const token = scopedAssertion(await boundedJson(oidc, 24 * 1024));
    const response = await send(origin + path, {
      method,
      headers: { Authorization: 'Bearer ' + apiKey, 'X-GitHub-Actions-OIDC': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const document = await boundedJson(response, 16 * 1024);
    if (!allowedStatuses.includes(response.status)) {
      const code = document?.error?.code;
      if (document?.schemaVersion === version && typeof code === 'string' &&
          Object.hasOwn(errorStatus, code) && response.status === errorStatus[code]) {
        throw new LinkedApiError('AugmentWorks rejected the linked CI request (' + code + ').', code);
      }
      throw new LinkedApiError('AugmentWorks returned an unexpected HTTP response to the linked CI request.');
    }
    return document;
  }

  return {
    async recover(input) {
      const selector = { ...input };
      if (!exactKeys(selector, selectorKeys) || !validSelector(selector)) {
        throw new LinkedApiError('Invalid protected-push recovery selector.');
      }
      const doc = await request('POST', admissionPath + '/recover', selector, [200]);
      if (!exactKeys(doc, ['schemaVersion', 'request']) || doc.schemaVersion !== version) {
        throw new LinkedApiError('AugmentWorks returned an invalid recovery response.');
      }
      if (doc.request !== null) {
        const retained = issueRequest(doc.request);
        if (!sameId(retained.bindingId, selector.bindingId) || !sameId(retained.suiteRevisionId, selector.suiteRevisionId) ||
            retained.maxCredits !== selector.maxCredits || retained.jobKey !== selector.jobKey) {
          throw new LinkedApiError('The retained issue request differs from the protected-push recovery selector.');
        }
      }
      return doc;
    },
    async issue(input) {
      const body = issueRequest(input);
      return validateAdmission(await request('POST', admissionPath, body, [201, 200]), body);
    },
    async attach(admissionId, runId) {
      if (![admissionId, runId].every(isUuid)) throw new LinkedApiError('Invalid admission or run ID for attachment.');
      const body = { schemaVersion: version, runId };
      const doc = await request('PUT', admissionPath + '/' + admissionId + '/run', body, [200]);
      if (!exactKeys(doc, ['schemaVersion', 'admissionId', 'runId']) || doc.schemaVersion !== version ||
          !sameId(doc.admissionId, admissionId) || !sameId(doc.runId, runId)) {
        throw new LinkedApiError('AugmentWorks did not confirm attachment of the expected admission and run.');
      }
      return doc;
    },
  };
}
