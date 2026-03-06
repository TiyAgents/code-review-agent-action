const OpenAIImport = require('openai');
const { zodTextFormat } = require('openai/helpers/zod');

const OpenAI = OpenAIImport.default || OpenAIImport;

const COMPATIBILITY_MODES = [
  'auto',
  'responses_json_schema',
  'chat_json_schema',
  'chat_json_object',
  'prompt_json'
];

const OFFICIAL_OPENAI_HOST = 'api.openai.com';
const SUCCESS_MODE_CACHE = new Map();

let runtimeState = {
  client: null,
  apiKey: '',
  baseURL: '',
  compatibilityMode: 'auto'
};

function configureOpenAIClient({ apiKey, baseURL, compatibilityMode }) {
  runtimeState = {
    client: new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {})
    }),
    apiKey,
    baseURL: baseURL || '',
    compatibilityMode: compatibilityMode || 'auto'
  };
  SUCCESS_MODE_CACHE.clear();
}

function getConfiguredHost(baseURL) {
  if (!baseURL) {
    return OFFICIAL_OPENAI_HOST;
  }

  try {
    return new URL(baseURL).hostname.toLowerCase();
  } catch {
    return OFFICIAL_OPENAI_HOST;
  }
}

function isOfficialHost(baseURL) {
  return getConfiguredHost(baseURL) === OFFICIAL_OPENAI_HOST;
}

function getCompatibilityModes({ model, baseURL, configuredMode }) {
  const explicitMode = String(configuredMode || 'auto').trim();
  if (explicitMode && explicitMode !== 'auto') {
    return [explicitMode];
  }

  const cacheKey = `${getConfiguredHost(baseURL)}|${model}`;
  const cached = SUCCESS_MODE_CACHE.get(cacheKey);
  const defaults = isOfficialHost(baseURL)
    ? ['responses_json_schema', 'chat_json_schema', 'chat_json_object', 'prompt_json']
    : ['chat_json_object', 'chat_json_schema', 'prompt_json', 'responses_json_schema'];

  if (!cached) {
    return defaults;
  }

  return [cached, ...defaults.filter((mode) => mode !== cached)];
}

function cacheSuccessfulMode({ model, baseURL, mode }) {
  SUCCESS_MODE_CACHE.set(`${getConfiguredHost(baseURL)}|${model}`, mode);
}

function clearCachedMode({ model, baseURL }) {
  SUCCESS_MODE_CACHE.delete(`${getConfiguredHost(baseURL)}|${model}`);
}

function getJsonSchemaFormat(agent) {
  if (!agent._jsonSchemaFormat) {
    const raw = zodTextFormat(agent.schema, agent.responseName || 'output');
    agent._jsonSchemaFormat = {
      type: raw.type,
      name: raw.name,
      strict: raw.strict,
      schema: sanitizeJsonSchema(raw.schema)
    };
  }
  return agent._jsonSchemaFormat;
}

function sanitizeJsonSchema(schema) {
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeJsonSchema(item));
  }
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(schema)) {
    if (['$schema', 'default', 'title', 'description', 'examples'].includes(key)) {
      continue;
    }

    cleaned[key] = value && typeof value === 'object'
      ? sanitizeJsonSchema(value)
      : value;
  }

  if (cleaned.type === 'integer' && Number.isFinite(cleaned.exclusiveMinimum)) {
    cleaned.minimum = cleaned.exclusiveMinimum + 1;
    delete cleaned.exclusiveMinimum;
  }

  if (cleaned.type === 'integer' && Number.isFinite(cleaned.exclusiveMaximum)) {
    cleaned.maximum = cleaned.exclusiveMaximum - 1;
    delete cleaned.exclusiveMaximum;
  }

  return cleaned;
}

function buildUserInput(agent, input, repairContext) {
  const blocks = [
    String(input || '').trim(),
    '',
    agent.outputContractPrompt,
    'Return exactly one JSON object. Do not wrap it in markdown or code fences.'
  ];

  if (repairContext) {
    blocks.push('');
    blocks.push('The previous attempt was invalid. Re-emit the same answer as valid JSON only.');
    blocks.push(`Validation error: ${repairContext.error}`);
    if (repairContext.preview) {
      blocks.push(`Previous output preview: ${repairContext.preview}`);
    }
  }

  return blocks.filter((block, index, items) => block || (index > 0 && items[index - 1] !== '')).join('\n');
}

function buildPromptJsonMessage(agent, input, repairContext) {
  const blocks = [
    'Follow these task instructions exactly.',
    agent.instructions,
    '',
    'Required JSON contract:',
    agent.outputContractPrompt,
    '',
    'Task input:',
    String(input || '').trim(),
    '',
    'Return exactly one JSON object with no markdown, no code fences, and no surrounding explanation.'
  ];

  if (repairContext) {
    blocks.push('');
    blocks.push('The previous attempt was invalid. Repair it.');
    blocks.push(`Validation error: ${repairContext.error}`);
    if (repairContext.preview) {
      blocks.push(`Previous output preview: ${repairContext.preview}`);
    }
  }

  return blocks.join('\n');
}

async function runStructuredWithRepair(agent, input, options = {}) {
  if (!runtimeState.client) {
    throw new Error('OpenAI client is not configured. Call configureOpenAIClient first.');
  }

  const allowRepair = options.allowRepair !== false;
  const modes = getCompatibilityModes({
    model: agent.model,
    baseURL: runtimeState.baseURL,
    configuredMode: runtimeState.compatibilityMode
  });

  let totalCalls = 0;
  let repaired = false;
  const failures = [];

  for (const mode of modes) {
    const modeResult = await runWithMode(agent, input, {
      mode,
      allowRepair,
      client: runtimeState.client
    });
    totalCalls += modeResult.calls;
    repaired = repaired || modeResult.repaired;

    if (modeResult.ok) {
      cacheSuccessfulMode({ model: agent.model, baseURL: runtimeState.baseURL, mode });
      return {
        ok: true,
        output: modeResult.output,
        calls: totalCalls,
        repaired,
        mode
      };
    }

    clearCachedMode({ model: agent.model, baseURL: runtimeState.baseURL });
    failures.push(`${mode}: ${modeResult.error.message || String(modeResult.error)}`);
  }

  return {
    ok: false,
    error: new Error(`Structured output failed across modes: ${failures.join(' | ')}`),
    calls: totalCalls,
    repaired
  };
}

async function runWithMode(agent, input, { mode, allowRepair, client }) {
  let calls = 0;

  try {
    calls += 1;
    const output = await requestStructuredOutput({ client, agent, input, mode, repairContext: null });
    return { ok: true, output, calls, repaired: false };
  } catch (firstError) {
    if (isModeUnsupportedError(firstError) || !allowRepair) {
      return { ok: false, error: firstError, calls, repaired: false, unsupportedMode: isModeUnsupportedError(firstError) };
    }

    const repairContext = {
      error: compactErrorMessage(firstError),
      preview: String(firstError.preview || '').slice(0, 300)
    };

    try {
      calls += 1;
      const repairedOutput = await requestStructuredOutput({ client, agent, input, mode, repairContext });
      return { ok: true, output: repairedOutput, calls, repaired: true };
    } catch (secondError) {
      return {
        ok: false,
        error: new Error(`Structured output failed after repair: ${compactErrorMessage(secondError)}`),
        calls,
        repaired: true,
        unsupportedMode: isModeUnsupportedError(secondError)
      };
    }
  }
}

async function requestStructuredOutput({ client, agent, input, mode, repairContext }) {
  const request = buildRequest({ client, agent, input, mode, repairContext });
  const response = await request.execute();
  const text = request.extractText(response);

  if (!text) {
    const error = new Error('Model returned empty output text.');
    error.code = 'empty_output';
    throw error;
  }

  let parsedObject;
  try {
    parsedObject = JSON.parse(extractJsonObjectText(text));
  } catch (error) {
    const wrapped = new Error(`Model output is not valid JSON: ${error.message || String(error)}`);
    wrapped.code = 'invalid_json';
    wrapped.preview = text.slice(0, 400);
    throw wrapped;
  }

  const parsed = agent.schema.safeParse(parsedObject);
  if (!parsed.success) {
    const error = new Error(`schema_validation_failed: ${formatIssues(parsed.error.issues)}`);
    error.code = 'schema_validation_failed';
    error.preview = JSON.stringify(parsedObject).slice(0, 400);
    throw error;
  }

  return parsed.data;
}

function buildRequest({ client, agent, input, mode, repairContext }) {
  const jsonSchemaFormat = getJsonSchemaFormat(agent);
  const userInput = buildUserInput(agent, input, repairContext);

  if (mode === 'responses_json_schema') {
    const requestData = {
      model: agent.model,
      instructions: agent.instructions,
      input: userInput,
      text: {
        format: jsonSchemaFormat
      }
    };

    return {
      execute: () => client.responses.create(requestData),
      extractText: extractResponsesText
    };
  }

  if (mode === 'chat_json_schema') {
    const requestData = {
      model: agent.model,
      messages: [
        { role: 'system', content: agent.instructions },
        { role: 'user', content: userInput }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: jsonSchemaFormat.name,
          strict: jsonSchemaFormat.strict,
          schema: jsonSchemaFormat.schema
        }
      }
    };

    return {
      execute: () => client.chat.completions.create(requestData),
      extractText: extractChatCompletionsText
    };
  }

  if (mode === 'chat_json_object') {
    const requestData = {
      model: agent.model,
      messages: [
        { role: 'system', content: agent.instructions },
        { role: 'user', content: userInput }
      ],
      response_format: {
        type: 'json_object'
      }
    };

    return {
      execute: () => client.chat.completions.create(requestData),
      extractText: extractChatCompletionsText
    };
  }

  if (mode === 'prompt_json') {
    const requestData = {
      model: agent.model,
      messages: [
        {
          role: 'user',
          content: buildPromptJsonMessage(agent, input, repairContext)
        }
      ]
    };

    return {
      execute: () => client.chat.completions.create(requestData),
      extractText: extractChatCompletionsText
    };
  }

  throw new Error(`Unknown compatibility mode: ${mode}`);
}

function extractResponsesText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const chunks = [];
  for (const item of response?.output || []) {
    if (item?.type !== 'message') {
      continue;
    }
    for (const content of item.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join('\n').trim();
}

function extractChatCompletionsText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item.text === 'string') {
          return item.text;
        }
        return '';
      })
      .join('\n')
      .trim();
  }

  return '';
}

function stripCodeFences(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    return fenced[1].trim();
  }
  return trimmed;
}

function extractJsonObjectText(text) {
  const cleaned = stripCodeFences(text);
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
    return cleaned;
  }

  const start = cleaned.indexOf('{');
  if (start === -1) {
    return cleaned;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return cleaned.slice(start, index + 1);
      }
    }
  }

  return cleaned;
}

function formatIssues(issues) {
  return (issues || [])
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function compactErrorMessage(error) {
  return String(error?.message || error || 'unknown_error');
}

function isModeUnsupportedError(error) {
  const message = compactErrorMessage(error).toLowerCase();
  const unsupportedHints = [
    'not supported',
    'unsupported',
    'unknown field',
    'unrecognized field',
    'extra inputs are not permitted',
    'invalid field',
    'invalid parameter',
    'response_format',
    'output_config.format.schema',
    'text.format',
    'json_schema',
    'json object response format is not supported',
    'instructions',
    'responses api',
    'chat.completions'
  ];

  return unsupportedHints.some((hint) => message.includes(hint));
}

module.exports = {
  COMPATIBILITY_MODES,
  configureOpenAIClient,
  getCompatibilityModes,
  runStructuredWithRepair,
  sanitizeJsonSchema,
  extractJsonObjectText,
  extractResponsesText,
  extractChatCompletionsText,
  isModeUnsupportedError,
  __private: {
    SUCCESS_MODE_CACHE,
    getConfiguredHost,
    buildUserInput,
    buildPromptJsonMessage,
    getJsonSchemaFormat,
    requestStructuredOutput,
    runWithMode,
    buildRequest,
    formatIssues,
    compactErrorMessage
  }
};
