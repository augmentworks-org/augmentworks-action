// Used only by the spawned Action acceptance test. Keep the production HTTPS allowlist intact.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const fixture = new URL(process.env.FIXTURE_SERVER);
assert.equal(fixture.protocol, 'http:');
assert.equal(fixture.hostname, '127.0.0.1');

const fetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const address = new URL(url);
  assert.ok(['https://staging.augmentworks.ai', 'https://example.actions.githubusercontent.com'].includes(address.origin));
  return fetch(fixture.origin + address.pathname + address.search, init);
};

// The CLI is a separate Node process and strips NODE_OPTIONS. Check the production
// origin and credential isolation before routing that real executable to the fixture.
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (command === process.execPath) {
    assert.equal(options.env.AUGMENTWORKS_API_URL, 'https://staging.augmentworks.ai');
    assert.equal(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
    assert.equal(options.env.GITHUB_OUTPUT, undefined);
    assert.equal(options.env.NODE_OPTIONS, undefined);
    options = { ...options, env: { ...options.env, AUGMENTWORKS_API_URL: fixture.origin } };
  }
  return spawn(command, args, options);
};
syncBuiltinESMExports();
