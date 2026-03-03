const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadAgentsWithMockedRuntime(runImpl) {
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@openai/agents') {
      return {
        Agent: class FakeAgent {
          constructor(opts) {
            this.opts = opts;
          }
        },
        run: runImpl,
        setDefaultOpenAIClient: () => {},
        setTracingDisabled: () => {}
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve('../src/agents')];
    return require('../src/agents');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/agents')];
  }
}

test('runStructuredWithRepair succeeds on first structured output', async () => {
  const { runStructuredWithRepair } = loadAgentsWithMockedRuntime(async () => ({
    finalOutput: { overall: 'ok' }
  }));

  const result = await runStructuredWithRepair({}, 'input', { allowRepair: true, maxTurns: 3 });

  assert.equal(result.ok, true);
  assert.equal(result.calls, 1);
  assert.equal(result.repaired, false);
  assert.deepEqual(result.output, { overall: 'ok' });
});

test('runStructuredWithRepair retries once with repair prompt', async () => {
  const inputs = [];
  let attempts = 0;
  const { runStructuredWithRepair } = loadAgentsWithMockedRuntime(async (_agent, input) => {
    inputs.push(input);
    attempts += 1;
    if (attempts === 1) {
      throw new Error('schema parse failed');
    }
    return {
      finalOutput: { overall: 'repaired' }
    };
  });

  const result = await runStructuredWithRepair({}, 'original-input', { allowRepair: true, maxTurns: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.calls, 2);
  assert.equal(result.repaired, true);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0], 'original-input');
  assert.match(inputs[1], /previous attempt failed schema parsing\/validation/i);
});

test('runStructuredWithRepair returns first error when repair disabled', async () => {
  const { runStructuredWithRepair } = loadAgentsWithMockedRuntime(async () => {
    throw new Error('first-failure');
  });

  const result = await runStructuredWithRepair({}, 'input', { allowRepair: false, maxTurns: 2 });

  assert.equal(result.ok, false);
  assert.equal(result.calls, 1);
  assert.equal(result.repaired, false);
  assert.match(String(result.error?.message || result.error), /first-failure/);
});

test('runStructuredWithRepair reports wrapped error after repair failure', async () => {
  const { runStructuredWithRepair } = loadAgentsWithMockedRuntime(async () => {
    throw new Error('still-invalid');
  });

  const result = await runStructuredWithRepair({}, 'input', { allowRepair: true, maxTurns: 2 });

  assert.equal(result.ok, false);
  assert.equal(result.calls, 2);
  assert.equal(result.repaired, true);
  assert.match(String(result.error?.message || result.error), /Structured output failed after repair/);
  assert.match(String(result.error?.message || result.error), /still-invalid/);
});

test('buildBatchReviewInput keeps additional file with truncation at boundary', () => {
  const { buildBatchReviewInput } = loadAgentsWithMockedRuntime(async () => ({ finalOutput: {} }));

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
  const { buildBatchReviewInput } = loadAgentsWithMockedRuntime(async () => ({ finalOutput: {} }));

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
