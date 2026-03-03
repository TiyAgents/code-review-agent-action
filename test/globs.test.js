const test = require('node:test');
const assert = require('node:assert/strict');

const { filterFiles } = require('../src/globs');

test('filterFiles applies include and exclude globs', () => {
  const files = [
    { filename: 'src/a.ts' },
    { filename: 'src/a.test.ts' },
    { filename: 'docs/readme.md' }
  ];

  const result = filterFiles(files, ['**/*.ts'], ['**/*.test.ts']);
  assert.deepEqual(result.map((x) => x.filename), ['src/a.ts']);
});

test('filterFiles handles undefined include/exclude patterns safely', () => {
  const files = [
    { filename: 'src/a.ts' },
    { filename: 'docs/readme.md' }
  ];

  const result = filterFiles(files, undefined, null);
  assert.deepEqual(result.map((x) => x.filename), ['src/a.ts', 'docs/readme.md']);
});

test('filterFiles returns empty array for empty files input', () => {
  assert.deepEqual(filterFiles([], ['**/*.ts'], ['**/*.test.ts']), []);
  assert.deepEqual(filterFiles(undefined, ['**/*.ts'], ['**/*.test.ts']), []);
});

test('filterFiles treats empty include as include-all', () => {
  const files = [
    { filename: 'src/a.ts' },
    { filename: 'docs/readme.md' }
  ];
  const result = filterFiles(files, [], []);
  assert.deepEqual(result.map((x) => x.filename), ['src/a.ts', 'docs/readme.md']);
});

test('filterFiles with empty exclude keeps include result unchanged', () => {
  const files = [
    { filename: 'src/a.ts' },
    { filename: 'src/a.test.ts' },
    { filename: 'docs/readme.md' }
  ];
  const includeOnly = filterFiles(files, ['**/*.ts'], []);
  const includeAndUndefinedExclude = filterFiles(files, ['**/*.ts'], undefined);
  assert.deepEqual(includeOnly.map((x) => x.filename), ['src/a.ts', 'src/a.test.ts']);
  assert.deepEqual(includeAndUndefinedExclude.map((x) => x.filename), ['src/a.ts', 'src/a.test.ts']);
});
