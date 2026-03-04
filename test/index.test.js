const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../src/index');

const {
  getTextBundle,
  chunk,
  sanitizePlannedBatches,
  shouldUseSummaryOnlyMode,
  formatConfidenceValue,
  buildInlineBody,
  formatSummaryMarkdown
} = __internal;

test('chunk splits arrays in fixed-size groups', () => {
  assert.deepEqual(chunk([], 2), []);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('sanitizePlannedBatches filters invalid paths and caps file count', () => {
  const pending = new Set(['a.js', 'b.js', 'c.js']);
  const sanitized = sanitizePlannedBatches([
    {
      focus: 'General',
      reason: 'risk-first',
      filePaths: ['a.js', 'missing.js', 'a.js', 'b.js']
    },
    {
      focus: 'security',
      filePaths: ['missing-only.js']
    }
  ], pending, 2);

  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].focus, 'general');
  assert.equal(sanitized[0].reason, 'risk-first');
  assert.deepEqual(sanitized[0].filePaths, ['a.js', 'b.js']);
});

test('shouldUseSummaryOnlyMode only enables summary-only when all structured runs failed', () => {
  assert.equal(shouldUseSummaryOnlyMode({
    hadStructuredOutputFailure: false,
    hasSuccessfulReviewerOutput: false
  }), false);
  assert.equal(shouldUseSummaryOnlyMode({
    hadStructuredOutputFailure: true,
    hasSuccessfulReviewerOutput: true
  }), false);
  assert.equal(shouldUseSummaryOnlyMode({
    hadStructuredOutputFailure: true,
    hasSuccessfulReviewerOutput: false
  }), true);
});

test('buildInlineBody includes severity, labels, inline key marker, and sub-agent tag', () => {
  const text = getTextBundle('English');
  const body = buildInlineBody({
    severity: 'medium',
    title: 'Missing null guard',
    summary: 'The value can be null before property access.',
    suggestion: 'Add a null check before dereference.',
    risk: 'Can throw at runtime.',
    confidence: 0.93,
    path: 'src/a.js',
    side: 'RIGHT',
    line: 10,
    sourceDimension: 'security'
  }, text);

  assert.match(body, /\*\*\[MEDIUM\] Missing null guard\*\*/);
  assert.match(body, /Suggestion: Add a null check before dereference\./);
  assert.match(body, /Risk: Can throw at runtime\./);
  assert.match(body, /Confidence: 0.93/);
  assert.match(body, /ai-code-review-agent:inline-key/);
  assert.match(body, /\[From SubAgent: security\]/);
  assert.ok(body.indexOf('Confidence: 0.93') < body.indexOf('[From SubAgent: security]'));
});

test('formatConfidenceValue handles invalid and boundary values predictably', () => {
  assert.equal(formatConfidenceValue(undefined), '0.80');
  assert.equal(formatConfidenceValue(null), '0.80');
  assert.equal(formatConfidenceValue('abc'), '0.80');
  assert.equal(formatConfidenceValue(-0.1), '0.00');
  assert.equal(formatConfidenceValue(1.2), '1.00');
  assert.equal(formatConfidenceValue('0.345'), '0.34');
  assert.equal(formatConfidenceValue(0), '0.00');
  assert.equal(formatConfidenceValue(1), '1.00');
});

test('buildInlineBody renders chinese confidence label before sub-agent tag', () => {
  const text = getTextBundle('zh-CN');
  const body = buildInlineBody({
    severity: 'low',
    title: '缺少日志上下文',
    summary: '建议补充必要上下文便于排查。',
    confidence: 0.88,
    path: 'src/a.js',
    side: 'RIGHT',
    line: 6,
    sourceDimension: 'testing'
  }, text);

  assert.match(body, /\*\*\[LOW\] 缺少日志上下文\*\*/);
  assert.match(body, /置信度: 0.88/);
  assert.match(body, /\[来自 SubAgent：testing\]/);
  assert.ok(body.indexOf('置信度: 0.88') < body.indexOf('[来自 SubAgent：testing]'));
});

test('formatSummaryMarkdown supports unknown severities and degraded reasons', () => {
  const markdown = formatSummaryMarkdown({
    pull: { number: 7, title: 'Add feature' },
    reviewLanguage: 'English',
    findings: [
      {
        severity: 'warning',
        title: 'Unknown severity should be grouped',
        path: 'src/a.js',
        line: 9
      }
    ],
    fileConclusions: [],
    actionableSuggestions: [],
    potentialRisks: [],
    testSuggestions: [],
    downgradedInline: [],
    uncovered: [],
    noPatchCovered: [],
    coverage: {
      target: 1,
      covered: 1,
      uncovered: 0,
      noPatch: 0
    },
    runtime: {
      roundsUsed: 1,
      maxRounds: 3,
      plannedBatches: 1,
      executedBatches: 1,
      subAgentRuns: 1,
      plannerCalls: 1,
      reviewerCalls: 1,
      modelCalls: 2,
      maxModelCalls: 10
    },
    degradedSummaryOnly: true,
    degradedReasons: ['planner_structured_output_failed_round_1: unknown_error']
  });

  assert.match(markdown, /## AI Code Review Summary/);
  assert.match(markdown, /- MEDIUM \(1\)/);
  assert.match(markdown, /Unknown severity should be grouped/);
  assert.match(markdown, /Structured-output summary-only degradation: YES/);
  assert.match(markdown, /planner_structured_output_failed_round_1: unknown_error/);
});
