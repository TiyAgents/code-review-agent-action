const { generateText, Output } = require('ai');

let runtimeState = {
  model: null
};

/**
 * Configure the AI SDK runtime with a model instance.
 *
 * @param {{ model: import('ai').LanguageModel }} opts
 */
function configureRuntime({ model }) {
  if (!model) {
    throw new Error('A valid AI SDK model instance is required.');
  }
  runtimeState = { model };
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

/**
 * Run a structured output call with AI SDK, with one repair retry on failure.
 *
 * @param {object} agent Agent definition with { model, instructions, outputContractPrompt, schema }
 * @param {string} input User prompt input
 * @param {{ allowRepair?: boolean }} options
 * @returns {Promise<{ ok: boolean, output?: any, error?: Error, calls: number, repaired: boolean }>}
 */
async function runStructuredWithRepair(agent, input, options = {}) {
  if (!runtimeState.model) {
    throw new Error('Runtime is not configured. Call configureRuntime first.');
  }

  const allowRepair = options.allowRepair !== false;
  let totalCalls = 0;

  // First attempt
  try {
    totalCalls += 1;
    const output = await requestStructuredOutput({ agent, input, repairContext: null });
    return { ok: true, output, calls: totalCalls, repaired: false };
  } catch (firstError) {
    if (!allowRepair) {
      return { ok: false, error: firstError, calls: totalCalls, repaired: false };
    }

    const repairContext = {
      error: compactErrorMessage(firstError),
      preview: String(firstError.preview || '').slice(0, 300)
    };

    // Repair attempt
    try {
      totalCalls += 1;
      const repairedOutput = await requestStructuredOutput({ agent, input, repairContext });
      return { ok: true, output: repairedOutput, calls: totalCalls, repaired: true };
    } catch (secondError) {
      return {
        ok: false,
        error: new Error(`Structured output failed after repair: ${compactErrorMessage(secondError)}`),
        calls: totalCalls,
        repaired: true
      };
    }
  }
}

async function requestStructuredOutput({ agent, input, repairContext }) {
  const userPrompt = buildUserInput(agent, input, repairContext);
  const model = agent.modelInstance || runtimeState.model;

  const result = await generateText({
    model,
    system: agent.instructions,
    prompt: userPrompt,
    output: Output.object({ schema: agent.schema })
  });

  // AI SDK sets output to the parsed object when successful
  if (result.output !== undefined && result.output !== null) {
    return result.output;
  }

  // Fallback: some providers may return text but fail structured parsing.
  // AI SDK sets output=null when schema validation fails internally,
  // so we attempt manual JSON extraction from the raw text as a safety net.
  const text = (result.text || '').trim();
  if (!text) {
    const error = new Error('Model returned empty output text.');
    error.code = 'empty_output';
    throw error;
  }

  let parsedObject;
  try {
    parsedObject = JSON.parse(extractJsonObjectText(text));
  } catch (parseError) {
    const wrapped = new Error(`Model output is not valid JSON: ${parseError.message || String(parseError)}`);
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

module.exports = {
  configureRuntime,
  runStructuredWithRepair,
  extractJsonObjectText,
  __private: {
    buildUserInput,
    requestStructuredOutput,
    formatIssues,
    compactErrorMessage
  }
};
