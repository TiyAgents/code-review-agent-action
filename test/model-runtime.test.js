const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { z } = require('zod');
const { zodTextFormat } = require('openai/helpers/zod');

function loadRuntimeWithMockedOpenAI(clientFactory) {
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'openai') {
      return class FakeOpenAI {
        constructor() {
          return clientFactory();
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

test('runStructuredWithRepair falls back to chat_json_object and caches the successful mode', async () => {
  let responseCalls = 0;
  let chatCalls = 0;
  const runtime = loadRuntimeWithMockedOpenAI(() => ({
    responses: {
      create: async () => {
        responseCalls += 1;
        throw new Error('text.format is not supported by this provider');
      }
    },
    chat: {
      completions: {
        create: async (requestData) => {
          chatCalls += 1;
          if (requestData.response_format?.type === 'json_schema') {
            throw new Error('response_format json_schema not supported');
          }
          return {
            choices: [
              {
                message: {
                  content: '{"overall":"ok"}'
                }
              }
            ]
          };
        }
      }
    }
  }));

  runtime.configureOpenAIClient({ apiKey: 'sk-test', compatibilityMode: 'auto' });
  const agent = createAgent();

  const first = await runtime.runStructuredWithRepair(agent, 'input', { allowRepair: true });
  const second = await runtime.runStructuredWithRepair(agent, 'input', { allowRepair: true });

  assert.equal(first.ok, true);
  assert.equal(first.mode, 'chat_json_object');
  assert.equal(first.calls, 3);
  assert.equal(second.ok, true);
  assert.equal(second.mode, 'chat_json_object');
  assert.equal(second.calls, 1);
  assert.equal(responseCalls, 1);
  assert.equal(chatCalls, 3);
});

test('runStructuredWithRepair repairs invalid json in the same mode before failing over', async () => {
  const requests = [];
  let attempts = 0;
  const runtime = loadRuntimeWithMockedOpenAI(() => ({
    responses: {
      create: async () => {
        throw new Error('text.format is not supported by this provider');
      }
    },
    chat: {
      completions: {
        create: async (requestData) => {
          requests.push(requestData);
          attempts += 1;
          if (requestData.response_format?.type === 'json_schema') {
            throw new Error('response_format json_schema not supported');
          }
          if (attempts === 2) {
            return {
              choices: [
                {
                  message: {
                    content: 'not-json'
                  }
                }
              ]
            };
          }
          return {
            choices: [
              {
                message: {
                  content: '{"overall":"repaired"}'
                }
              }
            ]
          };
        }
      }
    }
  }));

  runtime.configureOpenAIClient({ apiKey: 'sk-test', compatibilityMode: 'auto' });

  const result = await runtime.runStructuredWithRepair(createAgent(), 'original-input', { allowRepair: true });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'chat_json_object');
  assert.equal(result.calls, 4);
  assert.equal(result.repaired, true);
  assert.equal(requests[2].messages[1].content.includes('Validation error:'), true);
  assert.equal(requests[2].messages[1].content.includes('Previous output preview:'), true);
});

test('prompt_json mode inlines system instructions into the user message', async () => {
  const captured = [];
  const runtime = loadRuntimeWithMockedOpenAI(() => ({
    responses: { create: async () => ({}) },
    chat: {
      completions: {
        create: async (requestData) => {
          captured.push(requestData);
          return {
            choices: [
              {
                message: {
                  content: '{"overall":"ok"}'
                }
              }
            ]
          };
        }
      }
    }
  }));

  runtime.configureOpenAIClient({ apiKey: 'sk-test', compatibilityMode: 'prompt_json', baseURL: 'https://gateway.example.com/v1' });
  const result = await runtime.runStructuredWithRepair(createAgent(), 'review this diff', { allowRepair: true });

  assert.equal(result.ok, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].messages.length, 1);
  assert.equal(captured[0].messages[0].role, 'user');
  assert.match(captured[0].messages[0].content, /Follow these task instructions exactly/);
  assert.match(captured[0].messages[0].content, /System instructions/);
  assert.match(captured[0].messages[0].content, /JSON contract here/);
});

test('sanitizeJsonSchema rewrites integer exclusiveMinimum for claude-compatible providers', () => {
  const runtime = loadRuntimeWithMockedOpenAI(() => ({ responses: {}, chat: { completions: {} } }));
  const schema = z.object({
    line: z.number().int().positive().nullable().default(null)
  });
  const raw = zodTextFormat(schema, 'test_output');
  const sanitized = runtime.sanitizeJsonSchema(raw.schema);

  const integerNode = sanitized.properties.line.anyOf.find((item) => item.type === 'integer');
  assert.equal(integerNode.minimum, 1);
  assert.equal('exclusiveMinimum' in integerNode, false);
  assert.equal('$schema' in sanitized, false);
  assert.equal('default' in sanitized.properties.line, false);
});
