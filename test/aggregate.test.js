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
      line: 12,
      confidence: 0.9,
      evidence: ['line 12 changed']
    },
    {
      path: 'src/out.js',
      title: 'Out of scope',
      summary: 'Should be removed',
      severity: 'low',
      line: 1,
      confidence: 0.9,
      evidence: ['out of scope']
    },
    {
      path: 'src/b.js',
      title: 'Issue B',
      summary: 'Summary B',
      severity: 'unknown',
      side: 'FILE',
      line: null,
      confidence: 0.5,
      evidence: ['weak hint']
    },
    {
      path: 'src/b.js',
      title: 'Issue C',
      summary: 'Summary C',
      severity: 'medium',
      side: 'RIGHT',
      line: 4,
      confidence: 0.95,
      evidence: []
    }
  ];

  const normalized = normalizeFindings(findings, allowed, { minConfidence: 0.72 });
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].severity, 'high');
  assert.equal(normalized[0].side, 'RIGHT');
  assert.deepEqual(normalized[0].evidence, ['line 12 changed']);
});

test('dedupeAndSortFindings dedupes semantic duplicates and keeps cross-file findings', () => {
  const findings = [
    {
      path: 'a.js',
      side: 'RIGHT',
      line: 3,
      severity: 'medium',
      title: 'Missing bounds check',
      summary: 'Input length is not validated before array access',
      confidence: 0.74,
      evidence: ['array access added'],
      fingerprint: 'missing_bounds_check'
    },
    {
      path: 'a.js',
      side: 'RIGHT',
      line: 3,
      severity: 'high',
      title: 'Missing input length validation',
      summary: 'No bounds validation before indexing into array',
      confidence: 0.91,
      evidence: ['index access without guard'],
      fingerprint: 'missing_bounds_check'
    },
    {
      path: 'b.js',
      side: 'RIGHT',
      line: 3,
      severity: 'high',
      title: 'Missing input length validation',
      summary: 'No bounds validation before indexing into array',
      confidence: 0.88,
      evidence: ['same pattern but in another file'],
      fingerprint: 'missing_bounds_check'
    },
    {
      path: 'a.js',
      side: 'RIGHT',
      line: 1,
      severity: 'low',
      title: 'Minor style issue',
      summary: 'Name can be clearer',
      confidence: 0.8,
      evidence: ['rename variable']
    }
  ];

  const result = dedupeAndSortFindings(findings, 10);
  assert.equal(result.length, 3);
  assert.equal(result[0].severity, 'high');
  assert.equal(result[0].path, 'a.js');
  assert.equal(result[0].confidence, 0.91);
  assert.deepEqual(result[0].evidence.sort(), ['array access added', 'index access without guard'].sort());
  assert.equal(result[1].severity, 'high');
  assert.equal(result[1].path, 'b.js');
  assert.equal(result[2].severity, 'low');
});

test('dedupeAndSortFindings handles maxFindings boundaries predictably', () => {
  const findings = [
    { path: 'b.js', side: 'RIGHT', line: 2, severity: 'medium', title: 'B', summary: 'b', confidence: 0.9, evidence: ['b'] },
    { path: 'a.js', side: 'RIGHT', line: 2, severity: 'high', title: 'A', summary: 'a', confidence: 0.9, evidence: ['a'] },
    { path: 'c.js', side: 'RIGHT', line: 2, severity: 'low', title: 'C', summary: 'c', confidence: 0.9, evidence: ['c'] }
  ];

  const unlimited = dedupeAndSortFindings(findings, undefined);
  assert.equal(unlimited.length, 3);
  assert.deepEqual(unlimited.map((x) => x.path), ['a.js', 'b.js', 'c.js']);

  const topTwo = dedupeAndSortFindings(findings, 2);
  assert.equal(topTwo.length, 2);
  assert.deepEqual(topTwo.map((x) => x.path), ['a.js', 'b.js']);

  const none = dedupeAndSortFindings(findings, 0);
  assert.equal(none.length, 0);
});

test('dedupeAndSortFindings keeps deterministic order on same severity/confidence', () => {
  const findings = [
    { path: 'a.js', side: 'RIGHT', line: 9, severity: 'medium', title: 'T1', summary: 'S1', confidence: 0.8, evidence: ['1'] },
    { path: 'a.js', side: 'RIGHT', line: 4, severity: 'medium', title: 'T2', summary: 'S2', confidence: 0.8, evidence: ['2'] },
    { path: 'b.js', side: 'RIGHT', line: 1, severity: 'medium', title: 'T3', summary: 'S3', confidence: 0.8, evidence: ['3'] }
  ];

  const result = dedupeAndSortFindings(findings, 10);
  assert.deepEqual(
    result.map((x) => `${x.path}:${x.line}`),
    ['a.js:4', 'a.js:9', 'b.js:1']
  );
});
