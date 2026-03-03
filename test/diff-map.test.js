const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDiffLineMaps, resolveInlineLocation } = require('../src/diff-map');

test('buildDiffLineMaps and resolveInlineLocation handle LEFT/RIGHT mapping', () => {
  const files = [
    {
      filename: 'src/a.js',
      patch: [
        '@@ -10,3 +10,4 @@',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 3;',
        '+const c = 4;',
        ' return a + b;'
      ].join('\n')
    }
  ];

  const map = buildDiffLineMaps(files);

  const right = resolveInlineLocation({ path: 'src/a.js', side: 'RIGHT', line: 11 }, map);
  assert.equal(right.ok, true);
  assert.equal(right.side, 'RIGHT');
  assert.equal(right.line, 11);

  const left = resolveInlineLocation({ path: 'src/a.js', side: 'LEFT', line: 11 }, map);
  assert.equal(left.ok, true);
  assert.equal(left.side, 'LEFT');
  assert.equal(left.line, 11);

  const invalid = resolveInlineLocation({ path: 'src/a.js', side: 'RIGHT', line: 999 }, map);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'line_not_present_in_diff_hunks');
});

test('resolveInlineLocation fails when path not in map', () => {
  const map = buildDiffLineMaps([]);
  const result = resolveInlineLocation({ path: 'missing.js', side: 'RIGHT', line: 1 }, map);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'path_not_in_commentable_diff');
});
