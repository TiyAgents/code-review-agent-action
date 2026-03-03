const test = require('node:test');
const assert = require('node:assert/strict');

const { hashContent } = require('../src/publish');

test('hashContent is deterministic', () => {
  const a = hashContent('hello world');
  const b = hashContent('hello world');
  const c = hashContent('hello world!');

  assert.equal(a, b);
  assert.notEqual(a, c);
});
