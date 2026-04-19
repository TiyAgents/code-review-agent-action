const test = require('node:test');
const assert = require('node:assert/strict');

const { SUPPORTED_PROVIDERS, createProvider, createModel } = require('../src/provider');

test('SUPPORTED_PROVIDERS includes all expected providers', () => {
  assert.deepEqual(SUPPORTED_PROVIDERS, [
    'openai',
    'anthropic',
    'google',
    'mistral',
    'openai-compatible'
  ]);
});

test('createProvider creates an openai provider instance', () => {
  const provider = createProvider({ provider: 'openai', apiKey: 'sk-test' });
  assert.equal(typeof provider, 'function');
});

test('createProvider creates an anthropic provider instance', () => {
  const provider = createProvider({ provider: 'anthropic', apiKey: 'sk-ant-test' });
  assert.equal(typeof provider, 'function');
});

test('createProvider creates a google provider instance', () => {
  const provider = createProvider({ provider: 'google', apiKey: 'goog-test' });
  assert.equal(typeof provider, 'function');
});

test('createProvider creates a mistral provider instance', () => {
  const provider = createProvider({ provider: 'mistral', apiKey: 'mist-test' });
  assert.equal(typeof provider, 'function');
});

test('createProvider creates an openai-compatible provider with baseURL', () => {
  const provider = createProvider({
    provider: 'openai-compatible',
    apiKey: 'sk-test',
    baseURL: 'https://api.groq.com/openai/v1'
  });
  assert.equal(typeof provider, 'function');
});

test('createProvider throws when openai-compatible has no baseURL', () => {
  assert.throws(
    () => createProvider({ provider: 'openai-compatible', apiKey: 'sk-test' }),
    /requires a base URL/
  );
});

test('createProvider throws for unsupported provider', () => {
  assert.throws(
    () => createProvider({ provider: 'deepseek', apiKey: 'sk-test' }),
    /Unsupported AI provider/
  );
});

test('createProvider defaults to openai when provider is empty', () => {
  const provider = createProvider({ provider: '', apiKey: 'sk-test' });
  assert.equal(typeof provider, 'function');
});

test('createModel returns a model object', () => {
  const provider = createProvider({ provider: 'openai', apiKey: 'sk-test' });
  const model = createModel(provider, 'gpt-4o');
  assert.ok(model);
  assert.equal(typeof model, 'object');
});

test('createModel throws when modelName is empty', () => {
  const provider = createProvider({ provider: 'openai', apiKey: 'sk-test' });
  assert.throws(
    () => createModel(provider, ''),
    /Model name is required/
  );
});
