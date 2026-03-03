const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeFindings, dedupeAndSortFindings } = require('../src/aggregate');

test('normalizeFindings filters invalid findings and normalizes fields', () => {
  const allowed = ['src/a.js', 'src/b.js'];
  const findings = [
    {
      path: 'src/a.js',
      title: 'Issue A',
      summary: 'Summary A',
      severity: 'HIGH',
      side: 'right',
      line: 12
    },
    {
      path: 'src/out.js',
      title: 'Out of scope',
      summary: 'Should be removed',
      severity: 'low',
      line: 1
    },
    {
      path: 'src/b.js',
      title: 'Issue B',
      summary: 'Summary B',
      severity: 'unknown',
      side: 'FILE',
      line: null
    }
  ];

  const normalized = normalizeFindings(findings, allowed);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].severity, 'high');
  assert.equal(normalized[0].side, 'RIGHT');
  assert.equal(normalized[1].severity, 'medium');
  assert.equal(normalized[1].side, 'FILE');
});

test('dedupeAndSortFindings dedupes and sorts by severity/path/line', () => {
  const findings = [
    { path: 'b.js', side: 'RIGHT', line: 2, severity: 'medium', title: 'M', summary: 'm' },
    { path: 'a.js', side: 'RIGHT', line: 3, severity: 'high', title: 'H', summary: 'h' },
    { path: 'a.js', side: 'RIGHT', line: 3, severity: 'high', title: 'H', summary: 'h' },
    { path: 'a.js', side: 'RIGHT', line: 1, severity: 'low', title: 'L', summary: 'l' }
  ];

  const result = dedupeAndSortFindings(findings, 10);
  assert.equal(result.length, 3);
  assert.equal(result[0].severity, 'high');
  assert.equal(result[0].path, 'a.js');
  assert.equal(result[1].severity, 'medium');
  assert.equal(result[2].severity, 'low');
});
