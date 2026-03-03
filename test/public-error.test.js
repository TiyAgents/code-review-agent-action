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
