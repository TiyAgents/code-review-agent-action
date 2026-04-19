const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { z } = require('zod');

function loadRuntimeWithMockedAI(generateTextMock) {
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'ai') {
      return {
        generateText: generateTextMock,
        Output: {
          object: ({ schema }) => ({ type: 'object', schema })
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve('../src/model-runtime')];
    return require('../src/model-runtime');
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/model-runtime')];
  }
}

function createAgent() {
  return {
    model: 'test-model',
    instructions: 'System instructions',
    outputContractPrompt: 'JSON contract here',
    responseName: 'test_output',
    schema: z.object({ overall: z.string() })
  };
}

function createFakeModel() {
  return { modelId: 'test-model', provider: 'test' };
}

test('runStructuredWithRepair returns parsed output on success', async () => {
  const runtime = loadRuntimeWithMockedAI(async () => ({
    output: { overall: 'looks good' },
    text: '{"overall":"looks good"}'
  }));

  runtime.configureRuntime({ model: createFakeModel() });
  const agent = createAgent();
  const result = await runtime.runStructuredWithRepair(agent, 'review this code');

  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { overall: 'looks good' });
  assert.equal(result.calls, 1);
  assert.equal(result.repaired, false);
});

test('runStructuredWithRepair falls back to text parsing when output is null', async () => {
  const runtime = loadRuntimeWithMockedAI(async () => ({
    output: null,
    text: '{"overall":"from text"}'
  }));

  runtime.configureRuntime({ model: createFakeModel() });
  const agent = createAgent();
  const result = await runtime.runStructuredWithRepair(agent, 'review');

  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { overall: 'from text' });
  assert.equal(result.calls, 1);
});

test('runStructuredWithRepair triggers repair on first failure and succeeds', async () => {
  let callCount = 0;
  const runtime = loadRuntimeWithMockedAI(async () => {
    callCount += 1;
    if (callCount === 1) {
      return { output: null, text: 'not json' };
    }
    return { output: { overall: 'repaired' }, text: '{"overall":"repaired"}' };
  });

  runtime.configureRuntime({ model: createFakeModel() });
  const agent = createAgent();
  const result = await runtime.runStructuredWithRepair(agent, 'review');

  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { overall: 'repaired' });
  assert.equal(result.calls, 2);
  assert.equal(result.repaired, true);
});

test('runStructuredWithRepair returns error when both attempts fail', async () => {
  const runtime = loadRuntimeWithMockedAI(async () => ({
    output: null,
    text: 'garbage'
  }));

  runtime.configureRuntime({ model: createFakeModel() });
  const agent = createAgent();
  const result = await runtime.runStructuredWithRepair(agent, 'review');

  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.equal(result.calls, 2);
  assert.equal(result.repaired, true);
});

test('runStructuredWithRepair skips repair when allowRepair=false', async () => {
  const runtime = loadRuntimeWithMockedAI(async () => ({
    output: null,
    text: 'garbage'
  }));

  runtime.configureRuntime({ model: createFakeModel() });
  const agent = createAgent();
  const result = await runtime.runStructuredWithRepair(agent, 'review', { allowRepair: false });

  assert.equal(result.ok, false);
  assert.equal(result.calls, 1);
  assert.equal(result.repaired, false);
});

test('runStructuredWithRepair handles empty output text', async () => {
  const runtime = loadRuntimeWithMockedAI(async () => ({
    output: null,
    text: ''
  }));

  runtime.configureRuntime({ model: createFakeModel() });
  const agent = createAgent();
  const result = await runtime.runStructuredWithRepair(agent, 'review', { allowRepair: false });

  assert.equal(result.ok, false);
  assert.ok(result.error.message.includes('empty output'));
});

test('runStructuredWithRepair handles generateText throwing', async () => {
  let callCount = 0;
  const runtime = loadRuntimeWithMockedAI(async () => {
    callCount += 1;
    if (callCount === 1) {
      throw new Error('API rate limit exceeded');
    }
    return { output: { overall: 'recovered' }, text: '{"overall":"recovered"}' };
  });

  runtime.configureRuntime({ model: createFakeModel() });
  const agent = createAgent();
  const result = await runtime.runStructuredWithRepair(agent, 'review');

  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { overall: 'recovered' });
  assert.equal(result.repaired, true);
});

test('configureRuntime throws when model is falsy', () => {
  const runtime = loadRuntimeWithMockedAI(async () => ({}));
  assert.throws(() => runtime.configureRuntime({ model: null }), /valid AI SDK model/);
});

test('runStructuredWithRepair throws when runtime not configured', async () => {
  const runtime = loadRuntimeWithMockedAI(async () => ({}));
  const agent = createAgent();
  await assert.rejects(
    () => runtime.runStructuredWithRepair(agent, 'review'),
    /not configured/
  );
});

test('extractJsonObjectText extracts JSON from code fences', () => {
  const runtime = loadRuntimeWithMockedAI(async () => ({}));
  const input = '```json\n{"overall":"test"}\n```';
  assert.equal(runtime.extractJsonObjectText(input), '{"overall":"test"}');
});

test('extractJsonObjectText extracts JSON from mixed text', () => {
  const runtime = loadRuntimeWithMockedAI(async () => ({}));
  const input = 'Here is the result: {"overall":"test"} done.';
  assert.equal(runtime.extractJsonObjectText(input), '{"overall":"test"}');
});

test('requestStructuredOutput uses agent.modelInstance when provided', async () => {
  const customModel = { modelId: 'custom-reviewer', provider: 'test' };
  let usedModel = null;
  const runtime = loadRuntimeWithMockedAI(async (opts) => {
    usedModel = opts.model;
    return { output: { overall: 'from custom' }, text: '{}' };
  });

  runtime.configureRuntime({ model: createFakeModel() });
  const agent = { ...createAgent(), modelInstance: customModel };
  const result = await runtime.runStructuredWithRepair(agent, 'review');

  assert.equal(result.ok, true);
  assert.equal(usedModel, customModel);
});

test('requestStructuredOutput falls back to runtimeState.model when agent.modelInstance is null', async () => {
  const defaultModel = createFakeModel();
  let usedModel = null;
  const runtime = loadRuntimeWithMockedAI(async (opts) => {
    usedModel = opts.model;
    return { output: { overall: 'from default' }, text: '{}' };
  });

  runtime.configureRuntime({ model: defaultModel });
  const agent = { ...createAgent(), modelInstance: null };
  const result = await runtime.runStructuredWithRepair(agent, 'review');

  assert.equal(result.ok, true);
  assert.equal(usedModel, defaultModel);
});

test('schema validation failure on first attempt triggers repair', async () => {
  let callCount = 0;
  const runtime = loadRuntimeWithMockedAI(async () => {
    callCount += 1;
    if (callCount === 1) {
      // Returns valid JSON but fails schema validation (missing required field)
      return { output: null, text: '{"wrong_field":"value"}' };
    }
    return { output: { overall: 'valid' }, text: '{"overall":"valid"}' };
  });

  runtime.configureRuntime({ model: createFakeModel() });
  const agent = createAgent();
  const result = await runtime.runStructuredWithRepair(agent, 'review');

  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { overall: 'valid' });
  assert.equal(result.repaired, true);
});
