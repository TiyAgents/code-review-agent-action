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

test('inlineKeyFromFinding prefers fingerprint when present', () => {
  const key = inlineKeyFromFinding({
    fingerprint: 'Unsafe OpenAI Base URL',
    title: '这段标题不应影响',
    path: 'src/index.js',
    side: 'RIGHT',
    line: 12
  });

  assert.equal(key, 'unsafe_openai_base_url');
});

test('inlineKeyFromFinding stays stable for missing-field variants', () => {
  const cases = [
    { title: 'Only title' },
    { title: 'Only title', path: '' },
    { title: 'Only title', path: null, line: null, side: undefined },
    { title: '', path: 'src/a.js', side: 'LEFT', line: 0 },
    { title: '', path: '', side: 'UNKNOWN', line: null }
  ];

  for (const input of cases) {
    const a = inlineKeyFromFinding(input);
    const b = inlineKeyFromFinding(input);
    assert.match(a, /^[a-z0-9_-]+$/);
    assert.ok(a.length > 0);
    assert.equal(a, b);
  }
});

test('inlineKeyFromFinding differentiates by stable identifying fields', () => {
  const base = {
    fingerprint: '',
    title: '',
    path: 'src/a.js',
    side: 'RIGHT',
    line: 10
  };

  const keyA = inlineKeyFromFinding(base);
  const keyB = inlineKeyFromFinding({ ...base, line: 11 });
  const keyC = inlineKeyFromFinding({ ...base, path: 'src/b.js' });

  assert.notEqual(keyA, keyB);
  assert.notEqual(keyA, keyC);
});
