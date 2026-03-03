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
