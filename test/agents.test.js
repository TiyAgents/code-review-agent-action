const test = require('node:test');
const assert = require('node:assert/strict');

function loadAgents() {
  delete require.cache[require.resolve('../src/agents')];
  return require('../src/agents');
}

test('createReviewerAgent schema accepts nullable/omitted confidence and rejects invalid confidence', () => {
  const { createReviewerAgent } = loadAgents();
  const agent = createReviewerAgent({
    dimension: 'general',
    model: 'gpt-test',
    language: 'English',
    projectGuidance: null
  });

  const schema = agent.opts.outputType;
  const parsedOmitted = schema.parse({
    overall: 'ok',
    findings: [
      {
        title: 'No confidence field',
        severity: 'low',
        path: 'src/a.js',
        summary: 'desc',
        evidence: ['e1']
      }
    ]
  });
  assert.equal(parsedOmitted.findings[0].confidence, null);

  const parsedNull = schema.parse({
    overall: 'ok',
    findings: [
      {
        title: 'Null confidence field',
        severity: 'low',
        path: 'src/a.js',
        summary: 'desc',
        confidence: null,
        evidence: ['e1']
      }
    ]
  });
  assert.equal(parsedNull.findings[0].confidence, null);

  const parsedNumeric = schema.parse({
    overall: 'ok',
    findings: [
      {
        title: 'Numeric confidence',
        severity: 'low',
        path: 'src/a.js',
        summary: 'desc',
        confidence: 0.9,
        evidence: ['e1']
      }
    ]
  });
  assert.equal(parsedNumeric.findings[0].confidence, 0.9);

  assert.throws(
    () => schema.parse({
      overall: 'ok',
      findings: [
        {
          title: 'String confidence',
          severity: 'low',
          path: 'src/a.js',
          summary: 'desc',
          confidence: '0.9',
          evidence: ['e1']
        }
      ]
    }),
    /Expected number, received string/
  );

  assert.throws(
    () => schema.parse({
      overall: 'ok',
      findings: [
        {
          title: 'Out-of-range confidence',
          severity: 'low',
          path: 'src/a.js',
          summary: 'desc',
          confidence: 1.2,
          evidence: ['e1']
        }
      ]
    }),
    /Number must be less than or equal to 1/
  );
});

test('buildBatchReviewInput keeps additional file with truncation at boundary', () => {
  const { buildBatchReviewInput } = loadAgents();

  const result = buildBatchReviewInput({
    dimension: 'general',
    round: 1,
    maxContextChars: 400,
    availableDimensions: ['general', 'security'],
    batchFiles: [
      {
        filename: 'first.js',
        status: 'modified',
        changes: 3,
        additions: 2,
        deletions: 1,
        patch: '+a\n+b\n-c\n'
      },
      {
        filename: 'second.js',
        status: 'modified',
        changes: 300,
        additions: 250,
        deletions: 50,
        patch: '+'.repeat(1200)
      }
    ]
  });

  assert.deepEqual(result.selectedPaths, ['first.js', 'second.js']);
  assert.match(result.prompt, /\.\.\. \[patch truncated for context budget\]/);
});

test('buildBatchReviewInput skips files when budget cannot fit any section body', () => {
  const { buildBatchReviewInput } = loadAgents();

  const result = buildBatchReviewInput({
    dimension: 'general',
    round: 1,
    maxContextChars: 40,
    availableDimensions: ['general'],
    batchFiles: [
      {
        filename: 'tiny.js',
        status: 'modified',
        changes: 1,
        additions: 1,
        deletions: 0,
        patch: '+x'
      }
    ]
  });

  assert.deepEqual(result.selectedPaths, []);
});

test('buildBatchReviewInput includes absolute line anchors in prompt', () => {
  const { buildBatchReviewInput } = loadAgents();

  const result = buildBatchReviewInput({
    dimension: 'general',
    round: 2,
    maxContextChars: 4000,
    availableDimensions: ['general', 'security'],
    batchFiles: [
      {
        filename: 'src/sample.js',
        status: 'modified',
        changes: 4,
        additions: 2,
        deletions: 2,
        patch: [
          '@@ -10,3 +10,3 @@',
          ' const a = 1;',
          '-const b = 2;',
          '+const b = 3;',
          '-return a + b;',
          '+return a - b;'
        ].join('\n')
      }
    ]
  });

  assert.match(result.prompt, /\[L10\|R10\]\s+ const a = 1;/);
  assert.match(result.prompt, /\[L11\|R-\]\s+-const b = 2;/);
  assert.match(result.prompt, /\[L-\|R11\]\s+\+const b = 3;/);
  assert.match(result.prompt, /\[L12\|R-\]\s+-return a \+ b;/);
  assert.match(result.prompt, /\[L-\|R12\]\s+\+return a - b;/);
});

test('buildBatchReviewInput preserves line anchors for code starting with +++ and ---', () => {
  const { buildBatchReviewInput } = loadAgents();

  const result = buildBatchReviewInput({
    dimension: 'general',
    round: 1,
    maxContextChars: 4000,
    availableDimensions: ['general'],
    batchFiles: [
      {
        filename: 'src/example.txt',
        status: 'modified',
        changes: 2,
        additions: 1,
        deletions: 1,
        patch: ['@@ -1,2 +1,2 @@', '- ---old', '+ +++new'].join('\n')
      }
    ]
  });

  assert.match(result.prompt, /\[L1\|R-\] - ---old/);
  assert.match(result.prompt, /\[L-\|R1\] \+ \+\+\+new/);
});
