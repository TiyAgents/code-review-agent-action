const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeInlineKey, inlineKeyFromFinding } = require('../src/inline-key');

test('normalizeInlineKey keeps normalized ascii tokens', () => {
  const key = normalizeInlineKey('Unsafe OpenAI Base URL');
  assert.equal(key, 'unsafe_openai_base_url');
});

test('normalizeInlineKey falls back to deterministic hash for non-ascii-only input', () => {
  const a = normalizeInlineKey('这是一个中文标题');
  const b = normalizeInlineKey('这是一个中文标题');
  const c = normalizeInlineKey('另一个中文标题');

  assert.match(a, /^issue_[a-f0-9]{16}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('inlineKeyFromFinding never returns empty key without fingerprint', () => {
  const key = inlineKeyFromFinding({
    fingerprint: '',
    title: '这是中文问题',
    path: 'src/index.js',
    side: 'RIGHT',
    line: 123
  });

  assert.ok(key.length > 0);
  assert.match(key, /^[a-z0-9_-]+$/);
});
