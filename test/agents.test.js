const test = require('node:test');
const assert = require('node:assert/strict');

function loadAgents() {
  delete require.cache[require.resolve('../src/agents')];
  return require('../src/agents');
}

test('createReviewerAgent schema normalizes nullable, omitted, and string confidence', () => {
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

  const parsedString = schema.parse({
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
  });
  assert.equal(parsedString.findings[0].confidence, 0.9);

  const confidenceCases = [
    [0, 0],
    [0.5, 0.5],
    [0.99, 0.99],
    [1, 1],
    [1.01, 1],
    [1.5, 1],
    [50, 1],
    [100, 1],
    [150, 1],
    [-0.5, 0],
    [Number.NaN, null],
    [Infinity, null],
    ['not-a-number', null]
  ];

  for (const [input, expected] of confidenceCases) {
    const parsed = schema.parse({
      overall: 'ok',
      findings: [
        {
          title: `Confidence ${String(input)}`,
          severity: 'low',
          path: 'src/a.js',
          summary: 'desc',
          confidence: input,
          evidence: ['e1']
        }
      ]
    });
    assert.equal(parsed.findings[0].confidence, expected);
  }

  const parsedPercent = schema.parse({
    overall: 'ok',
    findings: [
      {
        title: 'Percent confidence',
        severity: 'low',
        path: 'src/a.js',
        summary: 'desc',
        confidence: '90%',
        evidence: ['e1']
      }
    ]
  });
  assert.equal(parsedPercent.findings[0].confidence, 0.9);

  const parsedOutOfRange = schema.parse({
    overall: 'ok',
    findings: [
      {
        title: 'Out-of-range confidence',
        severity: 'low',
        path: 'src/a.js',
        summary: 'desc',
        confidence: 120,
        evidence: ['e1']
      }
    ]
  });
  assert.equal(parsedOutOfRange.findings[0].confidence, 1);
});

test('createPlannerAgent schema normalizes planner batches and done values', () => {
  const { createPlannerAgent } = loadAgents();
  const agent = createPlannerAgent({ model: 'gpt-test', projectGuidance: null });

  const parsed = agent.opts.outputType.parse({
    batches: [
      {
        focus: 123,
        filePaths: 'src/a.js',
        reason: null
      },
      {
        focus: 'empty',
        filePaths: [null, '', 'src/b.js', 'src/b.js'],
        reason: 'keep one path'
      }
    ],
    done: 'true',
    notes: 42
  });

  assert.equal(parsed.done, true);
  assert.equal(parsed.notes, '42');
  assert.deepEqual(parsed.batches[0], {
    focus: '123',
    filePaths: ['src/a.js'],
    reason: ''
  });
  assert.deepEqual(parsed.batches[1].filePaths, ['src/b.js']);

  // done boundary tests
  const doneCases = [
    ['false', false],
    [0, false],
    ['', false],
    ['no', false],
    ['n', false],
    ['pending', false],
    [null, false],
    [undefined, false]
  ];
  for (const [input, expected] of doneCases) {
    const result = agent.opts.outputType.parse({
      batches: [],
      done: input
    });
    assert.equal(result.done, expected, `done=${JSON.stringify(input)} should be ${expected}`);
  }
});

test('createReviewerAgent schema normalizes common model field drift', () => {
  const { createReviewerAgent } = loadAgents();
  const agent = createReviewerAgent({
    dimension: 'general',
    model: 'gpt-test',
    language: 'English',
    projectGuidance: null
  });

  const parsed = agent.opts.outputType.parse({
    overall: 123,
    findings: [
      {
        title: 456,
        severity: 'Warning',
        category: null,
        path: 'src/a.js',
        side: 'right',
        line: 'R42',
        confidence: '90%',
        evidence: 'single evidence',
        fingerprint: 'x'.repeat(140),
        summary: 'summary',
        suggestion: 789,
        risk: null
      },
      {
        title: 'Hint severity',
        severity: 'hint',
        path: 'src/b.js',
        summary: 'hint should be low',
        evidence: ['e2']
      },
      {
        title: 'missing path should be dropped',
        severity: 'high',
        summary: 'invalid finding'
      }
    ],
    fileConclusions: [
      {
        path: 'src/a.js',
        conclusion: 100,
        risks: 'risk text',
        testSuggestions: [null, 'test one'],
        note: null
      }
    ],
    recommendedExtraDimensions: 'security',
    recommendationReason: null,
    actionableSuggestions: ['do this', 99],
    potentialRisks: null,
    testSuggestions: 'add tests'
  });

  assert.equal(parsed.overall, '123');
  assert.equal(parsed.findings.length, 2);
  assert.deepEqual(parsed.findings[0], {
    title: '456',
    severity: 'medium',
    category: 'general',
    path: 'src/a.js',
    side: 'RIGHT',
    line: 42,
    confidence: 0.9,
    evidence: ['single evidence'],
    fingerprint: 'x'.repeat(120),
    summary: 'summary',
    suggestion: '789',
    risk: ''
  });
  assert.equal(parsed.findings[1].severity, 'low');
  assert.equal(parsed.findings[1].title, 'Hint severity');
  assert.deepEqual(parsed.fileConclusions[0], {
    path: 'src/a.js',
    conclusion: '100',
    risks: ['risk text'],
    testSuggestions: ['test one'],
    note: ''
  });
  assert.deepEqual(parsed.recommendedExtraDimensions, ['security']);
  assert.equal(parsed.recommendationReason, '');
  assert.deepEqual(parsed.actionableSuggestions, ['do this', '99']);
  assert.deepEqual(parsed.potentialRisks, []);
  assert.deepEqual(parsed.testSuggestions, ['add tests']);

  // side boundary tests
  const sideCases = [
    ['left', 'LEFT'],
    ['LEFT', 'LEFT'],
    ['l', 'LEFT'],
    ['FILE', 'FILE'],
    ['file', 'FILE'],
    ['none', 'FILE'],
    ['general', 'FILE'],
    ['center', 'RIGHT'],
    ['both', 'RIGHT'],
    ['', 'RIGHT']
  ];
  for (const [input, expected] of sideCases) {
    const sideResult = agent.opts.outputType.parse({
      overall: 'ok',
      findings: [
        {
          title: `Side ${input}`,
          severity: 'low',
          path: 'src/a.js',
          summary: 'desc',
          side: input,
          evidence: ['e1']
        }
      ]
    });
    assert.equal(sideResult.findings[0].side, expected, `side=${JSON.stringify(input)} should be ${expected}`);
  }
});

test('createReviewerAgent exposes strict generation schema and tolerant parse schema', () => {
  const { createReviewerAgent } = loadAgents();
  const agent = createReviewerAgent({
    dimension: 'general',
    model: 'gpt-test',
    language: 'English',
    projectGuidance: null
  });

  assert.notEqual(agent.schema, agent.parseSchema);
  assert.throws(
    () => agent.schema.parse({
      overall: 'ok',
      findings: [
        {
          title: 'String confidence',
          severity: 'low',
          path: 'src/a.js',
          summary: 'desc',
          confidence: '0.9'
        }
      ]
    }),
    /Expected number, received string/
  );
  for (const invalidConfidence of [1.2, -0.5]) {
    assert.throws(
      () => agent.schema.parse({
        overall: 'ok',
        findings: [
          {
            title: 'Out-of-range confidence',
            severity: 'low',
            path: 'src/a.js',
            summary: 'desc',
            confidence: invalidConfidence
          }
        ]
      }),
      /Number must be (less than or equal to 1|greater than or equal to 0)/
    );
  }

  const parsed = agent.parseSchema.parse({
    overall: 'ok',
    findings: [
      {
        title: 'String confidence',
        severity: 'low',
        path: 'src/a.js',
        summary: 'desc',
        confidence: '0.9'
      }
    ]
  });
  assert.equal(parsed.findings[0].confidence, 0.9);
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

// --- Direct coerce function unit tests ---

test('coerceSeverity maps standard values and common aliases', () => {
  const { __private } = loadAgents();
  const cs = __private.coerceSeverity;
  assert.equal(cs('critical'), 'critical');
  assert.equal(cs('high'), 'high');
  assert.equal(cs('medium'), 'medium');
  assert.equal(cs('low'), 'low');
  assert.equal(cs('CRITICAL'), 'critical');
  assert.equal(cs('High'), 'high');
  assert.equal(cs('blocker'), 'critical');
  assert.equal(cs('blocking'), 'critical');
  assert.equal(cs('major'), 'high');
  assert.equal(cs('hi'), 'high');
  assert.equal(cs('warning'), 'medium');
  assert.equal(cs('warn'), 'medium');
  assert.equal(cs('minor'), 'low');
  assert.equal(cs('info'), 'low');
  assert.equal(cs('informational'), 'low');
  assert.equal(cs('hint'), 'low');
  assert.equal(cs('unknown'), 'medium');
  assert.equal(cs(''), 'medium');
});

test('coerceSide maps standard values and common aliases', () => {
  const { __private } = loadAgents();
  const cs = __private.coerceSide;
  assert.equal(cs('LEFT'), 'LEFT');
  assert.equal(cs('RIGHT'), 'RIGHT');
  assert.equal(cs('FILE'), 'FILE');
  assert.equal(cs('left'), 'LEFT');
  assert.equal(cs('right'), 'RIGHT');
  assert.equal(cs('file'), 'FILE');
  assert.equal(cs('L'), 'LEFT');
  assert.equal(cs('OLD'), 'LEFT');
  assert.equal(cs('REMOVED'), 'LEFT');
  assert.equal(cs('DELETED'), 'LEFT');
  assert.equal(cs('DELETION'), 'LEFT');
  assert.equal(cs('R'), 'RIGHT');
  assert.equal(cs('NEW'), 'RIGHT');
  assert.equal(cs('ADDED'), 'RIGHT');
  assert.equal(cs('ADDITION'), 'RIGHT');
  assert.equal(cs('NONE'), 'FILE');
  assert.equal(cs('GENERAL'), 'FILE');
  assert.equal(cs('OVERALL'), 'FILE');
  assert.equal(cs('center'), 'RIGHT');
  assert.equal(cs('both'), 'RIGHT');
  assert.equal(cs(''), 'RIGHT');
});

test('coercePositiveIntegerOrNull handles various inputs', () => {
  const { __private } = loadAgents();
  const cp = __private.coercePositiveIntegerOrNull;
  assert.equal(cp(42), 42);
  assert.equal(cp(1), 1);
  assert.equal(cp('42'), 42);
  assert.equal(cp('R42'), 42);
  assert.equal(cp('L42'), 42);
  assert.equal(cp('R:42'), 42);
  assert.equal(cp('#42'), 42);
  assert.equal(cp(0), null);
  assert.equal(cp(-1), null);
  assert.equal(cp('R0'), null);
  assert.equal(cp('R-1'), null);
  assert.equal(cp('abc'), null);
  assert.equal(cp(''), null);
  assert.equal(cp(null), null);
  assert.equal(cp(undefined), null);
  assert.equal(cp(3.14), null);
  assert.equal(cp('42R'), null);
});

test('coerceConfidence handles numeric, string, percent, and edge cases', () => {
  const { __private } = loadAgents();
  const cc = __private.coerceConfidence;
  assert.equal(cc(0), 0);
  assert.equal(cc(0.5), 0.5);
  assert.equal(cc(1), 1);
  assert.equal(cc(1.5), 1);
  assert.equal(cc(100), 1);
  assert.equal(cc('0.9'), 0.9);
  assert.equal(cc('90%'), 0.9);
  assert.equal(cc('100%'), 1);
  assert.equal(cc('150%'), 1);
  assert.equal(cc(-0.5), 0);
  assert.equal(cc(null), null);
  assert.equal(cc(undefined), null);
  assert.equal(cc(''), null);
  assert.equal(cc('not-a-number'), null);
  assert.equal(cc(Infinity), null);
  assert.equal(cc(NaN), null);
});

test('coerceBoolean handles various truthy and falsy inputs', () => {
  const { __private } = loadAgents();
  const cb = __private.coerceBoolean;
  assert.equal(cb(true), true);
  assert.equal(cb(false), false);
  assert.equal(cb(1), true);
  assert.equal(cb(0), false);
  assert.equal(cb('true'), true);
  assert.equal(cb('1'), true);
  assert.equal(cb('yes'), true);
  assert.equal(cb('y'), true);
  assert.equal(cb('done'), true);
  assert.equal(cb('false'), false);
  assert.equal(cb('0'), false);
  assert.equal(cb('no'), false);
  assert.equal(cb('n'), false);
  assert.equal(cb('pending'), false);
  assert.equal(cb('complete'), false);
  assert.equal(cb('finished'), false);
  assert.equal(cb(''), false);
  assert.equal(cb(undefined), undefined);
  assert.equal(cb(null), undefined);
});

test('coerceStringArray deduplicates, flattens, and filters', () => {
  const { __private } = loadAgents();
  const csa = __private.coerceStringArray;
  assert.deepEqual(csa(['a', 'b', 'a']), ['a', 'b']);
  assert.deepEqual(csa(['a', null, '', 'b']), ['a', 'b']);
  assert.deepEqual(csa('single'), ['single']);
  assert.deepEqual(csa(null), []);
  assert.deepEqual(csa(undefined), []);
  assert.deepEqual(csa([null, undefined]), []);
  assert.deepEqual(csa(['a', 'b', 'c', 'd'], 2), ['a', 'b']);
  assert.deepEqual(csa([[1, 2], 'a']), ['1', '2', 'a']);
});
