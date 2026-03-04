const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeFindings, dedupeAndSortFindings, groupFindingsBySeverity } = require('../src/aggregate');

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

  const fallbackOnNegative = dedupeAndSortFindings(findings, -1);
  assert.equal(fallbackOnNegative.length, 3);

  const fallbackOnNaN = dedupeAndSortFindings(findings, Number.NaN);
  assert.equal(fallbackOnNaN.length, 3);
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

test('dedupeAndSortFindings ranks unknown confidence after numeric values', () => {
  const findings = [
    { path: 'a.js', side: 'RIGHT', line: 3, severity: 'medium', title: 'T3', summary: 'S3', confidence: null, evidence: ['3'] },
    { path: 'a.js', side: 'RIGHT', line: 2, severity: 'medium', title: 'T2', summary: 'S2', confidence: 0, evidence: ['2'] },
    { path: 'a.js', side: 'RIGHT', line: 1, severity: 'medium', title: 'T1', summary: 'S1', confidence: 0.8, evidence: ['1'] }
  ];

  const result = dedupeAndSortFindings(findings, 10);
  assert.deepEqual(result.map((x) => x.line), [1, 2, 3]);
});

test('dedupeAndSortFindings merge prefers numeric confidence over unknown and updates sourceDimension', () => {
  const findings = [
    {
      path: 'a.js',
      side: 'RIGHT',
      line: 7,
      severity: 'medium',
      title: 'Issue from unknown confidence',
      summary: 'Unknown confidence finding',
      confidence: null,
      evidence: ['unknown'],
      fingerprint: 'same_issue',
      sourceDimension: 'general'
    },
    {
      path: 'a.js',
      side: 'RIGHT',
      line: 7,
      severity: 'medium',
      title: 'Issue from numeric confidence',
      summary: 'Numeric confidence finding',
      confidence: 0.91,
      evidence: ['numeric'],
      fingerprint: 'same_issue',
      sourceDimension: 'security'
    }
  ];

  const result = dedupeAndSortFindings(findings, 10);
  assert.equal(result.length, 1);
  assert.equal(result[0].confidence, 0.91);
  assert.equal(result[0].sourceDimension, 'security');
  assert.equal(result[0].title, 'Issue from numeric confidence');
});

test('normalizeFindings keeps confidence at threshold and normalizes side/line edge values', () => {
  const allowed = ['src/a.js'];
  const findings = [
    {
      path: 'src/a.js',
      title: 'Edge confidence',
      summary: 'Confidence exactly on threshold should be kept',
      severity: 'MEDIUM',
      side: 'weird',
      line: 0,
      confidence: 0.72,
      evidence: ['edge']
    }
  ];

  const normalized = normalizeFindings(findings, allowed, { minConfidence: 0.72 });
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].side, 'RIGHT');
  assert.equal(normalized[0].line, null);
  assert.equal(normalized[0].confidence, 0.72);
});

test('normalizeFindings handles confidence/evidence type anomalies predictably', () => {
  const allowed = ['src/a.js'];
  const findings = [
    {
      path: 'src/a.js',
      title: 'NaN confidence is unknown',
      summary: 'NaN confidence should be kept as unknown by default policy',
      severity: 'LOW',
      side: 'LEFT',
      line: -2,
      confidence: Number.NaN,
      evidence: ['e1']
    },
    {
      path: 'src/a.js',
      title: 'Non-array evidence drops finding',
      summary: 'Evidence must be array and non-empty',
      severity: 'LOW',
      side: 'LEFT',
      line: 5,
      confidence: 0.9,
      evidence: 'not-array'
    }
  ];

  const normalized = normalizeFindings(findings, allowed, { minConfidence: 0.72 });
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].title, 'NaN confidence is unknown');
  assert.equal(normalized[0].confidence, null);
  assert.equal(normalized[0].side, 'LEFT');
  assert.equal(normalized[0].line, null);
});

test('normalizeFindings drops findings with missing confidence when policy is drop', () => {
  const allowed = ['src/a.js'];
  const findings = [
    {
      path: 'src/a.js',
      title: 'Unknown confidence',
      summary: 'confidence missing',
      severity: 'LOW',
      side: 'RIGHT',
      line: 2,
      evidence: ['e1']
    }
  ];

  const normalized = normalizeFindings(findings, allowed, {
    minConfidence: 0.72,
    missingConfidencePolicy: 'drop'
  });
  assert.equal(normalized.length, 0);
});

test('normalizeFindings applies fallback confidence and min threshold when policy is fallback', () => {
  const allowed = ['src/a.js'];
  const findings = [
    {
      path: 'src/a.js',
      title: 'Fallback confidence',
      summary: 'confidence missing',
      severity: 'LOW',
      side: 'RIGHT',
      line: 2,
      evidence: ['e1']
    }
  ];

  const kept = normalizeFindings(findings, allowed, {
    minConfidence: 0.72,
    missingConfidencePolicy: 'fallback',
    fallbackConfidenceValue: 0.85
  });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].confidence, 0.85);

  const dropped = normalizeFindings(findings, allowed, {
    minConfidence: 0.72,
    missingConfidencePolicy: 'fallback',
    fallbackConfidenceValue: 0.5
  });
  assert.equal(dropped.length, 0);
});

test('groupFindingsBySeverity falls back unknown severities to medium', () => {
  const unknownSeverityFinding = {
    path: 'src/a.js',
    side: 'RIGHT',
    line: 10,
    severity: 'warning',
    title: 'Unknown severity',
    summary: 'Should not crash grouping',
    confidence: 0.9,
    evidence: ['x']
  };

  const groups = groupFindingsBySeverity([
    { ...unknownSeverityFinding, severity: 'critical' },
    unknownSeverityFinding,
    null
  ]);

  assert.equal(groups.critical.length, 1);
  assert.equal(groups.medium.length, 1);
  assert.equal(groups.medium[0].title, 'Unknown severity');
});
