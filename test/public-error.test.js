const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizePublicErrorDetail } = require('../src/public-error');

test('sanitizePublicErrorDetail redacts url/token and truncates long content', () => {
  const input = [
    'request failed: https://example.internal/v1?token=abc',
    'Authorization: Bearer ghp_1234567890ABCDEFGHIJKLMN',
    'api_key=sk-1234567890ABCDEFGHIJ'
  ].join(' ');
  const out = sanitizePublicErrorDetail(input);

  assert.match(out, /<redacted-url>/);
  assert.match(out, /authorization=<redacted>/i);
  assert.match(out, /api_key=<redacted>/i);
  assert.doesNotMatch(out, /ghp_1234567890ABCDEFGHIJKLMN/);
  assert.doesNotMatch(out, /sk-1234567890ABCDEFGHIJ/);
});

test('sanitizePublicErrorDetail handles empty input', () => {
  assert.equal(sanitizePublicErrorDetail(''), 'unknown_error');
});

test('sanitizePublicErrorDetail redacts authorization variants case-insensitively', () => {
  const input = [
    'AUTHORIZATION: Token ghp_abcdefghijklmnopqrstuvwxyz123456',
    'authorization=Bearer sk-abcdefghijklmnopqrstuvwxyz123456',
    'Authorization: custom-secret-value'
  ].join(' ; ');

  const out = sanitizePublicErrorDetail(input);
  assert.match(out, /authorization=<redacted>/i);
  assert.doesNotMatch(out, /ghp_[a-z0-9]+/i);
  assert.doesNotMatch(out, /sk-[a-z0-9]+/i);
  assert.doesNotMatch(out, /custom-secret-value/i);
});

test('sanitizePublicErrorDetail redacts api-key/token/secret in mixed formats', () => {
  const input = [
    'api-key: super-secret-key',
    'api_key=my_api_key_value',
    'token=abc1234567890',
    'secret: let_me_in'
  ].join(' ');

  const out = sanitizePublicErrorDetail(input);
  assert.match(out, /api-key=<redacted>/i);
  assert.match(out, /api_key=<redacted>/i);
  assert.match(out, /token=<redacted>/i);
  assert.match(out, /secret=<redacted>/i);
  assert.doesNotMatch(out, /super-secret-key|my_api_key_value|abc1234567890|let_me_in/i);
});

test('sanitizePublicErrorDetail truncates long output to bounded length', () => {
  const input = `failure ${'x'.repeat(400)}`;
  const out = sanitizePublicErrorDetail(input);
  assert.ok(out.length <= 243);
  assert.match(out, /\.\.\.$/);
});

test('sanitizePublicErrorDetail handles non-string input without throwing', () => {
  const out = sanitizePublicErrorDetail({ error: 'boom', token: 'abc' });
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
});

test('sanitizePublicErrorDetail redacts additional cloud/provider token formats', () => {
  const input = [
    'aws key AKIA1234567890ABCDEF',
    'google key AIza12345678901234567890123456789012345',
    'slack token xoxb-1234567890-abcdef-0987654321'
  ].join(' ; ');

  const out = sanitizePublicErrorDetail(input);
  assert.doesNotMatch(out, /AKIA1234567890ABCDEF/);
  assert.doesNotMatch(out, /AIza12345678901234567890123456789012345/);
  assert.doesNotMatch(out, /xoxb-1234567890-abcdef-0987654321/);
  assert.match(out, /<redacted-token>/);
});
