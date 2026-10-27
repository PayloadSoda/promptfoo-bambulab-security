import test from 'node:test';
import assert from 'node:assert/strict';
import { allowsRequest, configuredOrigin } from '../access.mjs';

test('local aliases and forwarded ports work with their same-origin requests', () => {
  for (const host of ['127.0.0.1:4310', 'localhost:4310', '0.0.0.0:4310', '[::1]:4310', 'localhost:14310', 'LOCALHOST:4310', 'localhost.:4310', 'localhost']) {
    assert.equal(allowsRequest({ host }), true, host);
    assert.equal(allowsRequest({ host, origin: `http://${host}` }), true, host);
  }
});

test('explicit deployment origin works with preserved and rewritten proxy hosts', () => {
  const origin = configuredOrigin('https://runner.example.com/');
  assert.equal(origin, 'https://runner.example.com');
  assert.equal(allowsRequest({ host: 'runner.example.com' }, origin), true);
  assert.equal(allowsRequest({ host: 'runner.example.com', origin }, origin), true);
  assert.equal(allowsRequest({ host: '127.0.0.1:4310', origin }, origin), true);
  assert.equal(allowsRequest({ host: 'runner.example.com', origin: 'http://runner.example.com' }, origin), false);
  assert.equal(allowsRequest({ host: 'runner.example.com:8443' }, origin), false);
});

test('unconfigured domains, cross-origin requests and malformed values stay blocked', () => {
  for (const host of ['untrusted.example', 'localhost.evil.example', '127.0.0.1.evil.example', 'user@localhost:4310', 'localhost:4310/path', 'localhost:99999', '']) {
    assert.equal(allowsRequest({ host }), false, host);
  }
  for (const origin of ['https://untrusted.example', 'http://localhost:9999', 'null', 'file:///', 'http://localhost:4310/path']) {
    assert.equal(allowsRequest({ host: 'localhost:4310', origin }), false, origin);
  }
  assert.equal(allowsRequest({ host: 'untrusted.example', 'x-forwarded-host': 'localhost:4310' }), false);
  assert.equal(allowsRequest({}), false);
  assert.throws(() => configuredOrigin('https://example.com/path'), /RUNNER_ORIGIN/);
});
