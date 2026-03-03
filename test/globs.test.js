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

