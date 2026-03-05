#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const OpenAIImport = require('openai');
const { z } = require('zod');
const { zodTextFormat } = require('openai/helpers/zod');

const OpenAI = OpenAIImport.default || OpenAIImport;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }

    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function extractOutputText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text;
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

function formatIssues(issues) {
  return (issues || [])
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function parseBooleanEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return defaultValue;
  }
  const value = String(raw).trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes') {
    return true;
  }
  if (value === '0' || value === 'false' || value === 'no') {
    return false;
  }
  return defaultValue;
}

function parsePositiveIntEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return defaultValue;
  }
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

function parseModelList(value) {
  const seen = new Set();
  const models = [];
  for (const entry of String(value || '').split('|')) {
    const model = entry.trim();
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    models.push(model);
  }
  return models;
}

function isLikelyTokenTruncation(response, parseError) {
  const reason = String(response?.incomplete_details?.reason || '').toLowerCase();
  if (reason.includes('max_output_tokens') || reason.includes('max tokens') || reason.includes('length')) {
    return true;
  }
  if (String(response?.status || '').toLowerCase() === 'incomplete' && reason) {
    return true;
  }
  const parseMessage = String(parseError?.message || parseError || '').toLowerCase();
  if (parseMessage.includes('unexpected end of json')) {
    return true;
  }
  return false;
}

async function createResponseWithTimeout(client, requestData, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await client.responses.create(requestData, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function getSchemas() {
  const plannerOutputSchema = z.object({
    batches: z
      .array(
        z.object({
          focus: z.string().default('general'),
          filePaths: z.array(z.string()).min(1),
          reason: z.string().default('')
        }).strict()
      )
      .default([]),
    done: z.boolean().default(false),
    notes: z.string().default('')
  }).strict();

  const findingSchema = z.object({
    title: z.string().min(1),
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    category: z.string().default('general'),
    path: z.string().min(1),
    side: z.enum(['LEFT', 'RIGHT', 'FILE']).default('RIGHT'),
    line: z.number().int().positive().nullable().default(null),
    confidence: z.number().min(0).max(1).nullable().optional().default(null),
    evidence: z.array(z.string().min(1)).default([]),
    fingerprint: z.string().max(120).default(''),
    summary: z.string().min(1),
    suggestion: z.string().default(''),
    risk: z.string().default('')
  }).strict();

  const fileConclusionSchema = z.object({
    path: z.string().min(1),
    conclusion: z.string().min(1),
    risks: z.array(z.string()).default([]),
    testSuggestions: z.array(z.string()).default([]),
    note: z.string().default('')
  }).strict();

  const reviewOutputSchema = z.object({
    overall: z.string().min(1),
    findings: z.array(findingSchema).default([]),
    fileConclusions: z.array(fileConclusionSchema).default([]),
    recommendedExtraDimensions: z.array(z.string()).default([]),
    recommendationReason: z.string().default(''),
    actionableSuggestions: z.array(z.string()).default([]),
    potentialRisks: z.array(z.string()).default([]),
    testSuggestions: z.array(z.string()).default([])
  }).strict();

  return { plannerOutputSchema, reviewOutputSchema };
}

async function runCase({
  client,
  model,
  timeoutMs,
  maxOutputTokens,
  retryOutputTokens,
  name,
  schema,
  prompt,
  postValidate
}) {
  const format = zodTextFormat(schema, `${name}_output`);
  const attemptTokens = [maxOutputTokens];
  if (retryOutputTokens > maxOutputTokens) {
    attemptTokens.push(retryOutputTokens);
  }

  let lastFailure = {
    ok: false,
    name,
    error: 'unknown_failure'
  };

  for (let attempt = 0; attempt < attemptTokens.length; attempt += 1) {
    const outputTokens = attemptTokens[attempt];
    const requestData = {
      model,
      input: prompt,
      text: {
        format
      },
      temperature: 0,
      max_output_tokens: outputTokens
    };

    try {
      const response = await createResponseWithTimeout(client, requestData, timeoutMs);
      const text = extractOutputText(response);
      if (!text) {
        lastFailure = {
          ok: false,
          name,
          error: `empty_output_text (max_output_tokens=${outputTokens})`,
          responseId: response?.id || ''
        };
        continue;
      }

      let rawObject;
      try {
        rawObject = JSON.parse(text);
      } catch (error) {
        lastFailure = {
          ok: false,
          name,
          error: `output_not_json: ${error.message || String(error)} (max_output_tokens=${outputTokens})`,
          responseId: response?.id || '',
          preview: text.slice(0, 400)
        };
        if (attempt + 1 < attemptTokens.length && isLikelyTokenTruncation(response, error)) {
          continue;
        }
        break;
      }

      const parsed = schema.safeParse(rawObject);
      if (!parsed.success) {
        lastFailure = {
          ok: false,
          name,
          error: `schema_validation_failed: ${formatIssues(parsed.error.issues)} (max_output_tokens=${outputTokens})`,
          responseId: response?.id || '',
          preview: text.slice(0, 400)
        };
        if (attempt + 1 < attemptTokens.length && isLikelyTokenTruncation(response)) {
          continue;
        }
        break;
      }

      if (typeof postValidate === 'function') {
        const validationError = postValidate(parsed.data);
        if (validationError) {
          lastFailure = {
            ok: false,
            name,
            error: `${validationError} (max_output_tokens=${outputTokens})`,
            responseId: response?.id || '',
            preview: text.slice(0, 400)
          };
          break;
        }
      }

      return {
        ok: true,
        name,
        responseId: response?.id || '',
        preview: JSON.stringify(parsed.data).slice(0, 220),
        outputTokens
      };
    } catch (error) {
      lastFailure = {
        ok: false,
        name,
        error: `${error?.message || String(error)} (max_output_tokens=${outputTokens})`
      };
      if (attempt + 1 < attemptTokens.length) {
        continue;
      }
      break;
    }
  }

  return lastFailure;
}

async function main() {
  const cwd = process.cwd();
  loadEnvFile(path.join(cwd, '.env'));

  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_API_BASE || '';
  const modelInput = process.env.MODEL || process.env.OPENAI_MODEL || '';
  const timeoutMs = parsePositiveIntEnv('SCHEMA_TEST_TIMEOUT_MS', 60000);
  const maxOutputTokens = parsePositiveIntEnv('MAX_OUTPUT_TOKENS', 3000);
  const retryOutputTokens = parsePositiveIntEnv('MAX_OUTPUT_TOKENS_RETRY', 6000);
  const bugProbeRequired = parseBooleanEnv('BUG_PROBE_REQUIRED', false);

  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY. Set it in environment or .env.');
  }
  const models = parseModelList(modelInput);
  if (models.length === 0) {
    throw new Error('Missing MODEL. Set MODEL in environment or .env. Use "|" to test multiple models.');
  }

  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {})
  });
  const { plannerOutputSchema, reviewOutputSchema } = getSchemas();

  console.log(
    `Schema support check start: models=${models.join('|')}${baseURL ? ` base=${baseURL}` : ''} ` +
    `max_output_tokens=${maxOutputTokens} retry=${retryOutputTokens}`
  );

  const plannerPrompt = [
    'Return JSON only.',
    'You are a planner for code review.',
    'Generate output that follows the planner schema.',
    'Use these pending files: ["src/a.js","src/b.js","src/c.js"].',
    'Create 1-2 batches, each maxFilesPerBatch=2.',
    'Set done=false and keep notes short.'
  ].join('\n');

  const reviewerPrompt = [
    'Return JSON only.',
    'You are a general reviewer for one batch.',
    'If no major issue, findings can be empty.',
    'Provide at least one fileConclusions item for path "src/a.js".',
    'Diff anchors:',
    '@@ -1,2 +1,3 @@',
    '[L1|R1] const oldValue = compute();',
    '[L2|R2] if (oldValue > 0) doWork();',
    '[L-|R3] retryTask();'
  ].join('\n');

  const bugProbePrompt = [
    'Return JSON only.',
    'You are a strict code reviewer. Find concrete defects only.',
    'This diff contains a real bug. findings should not be empty.',
    'Changed file: src/auth/token.js',
    'Diff anchors:',
    '@@ -9,4 +9,4 @@',
    '[L9|R9] function canAccess(session) {',
    '[L10|R10]   let allowAccess = false;',
    '[L11|R11]   // only admin can pass',
    '[L12|R12]   if (!session.user.isAdmin) allowAccess = true;',
    '[L13|R13]   return allowAccess;',
    '[L14|R14] }'
  ].join('\n');

  const cases = [
    { name: 'planner', schema: plannerOutputSchema, prompt: plannerPrompt },
    { name: 'reviewer', schema: reviewOutputSchema, prompt: reviewerPrompt },
    {
      name: 'bug_probe',
      schema: reviewOutputSchema,
      prompt: bugProbePrompt,
      postValidate: (output) => {
        const findings = Array.isArray(output.findings) ? output.findings : [];
        if (findings.length === 0) {
          return 'bug_probe_no_findings';
        }
        const foundTargetPath = findings.some((finding) => finding.path === 'src/auth/token.js');
        if (!foundTargetPath) {
          return 'bug_probe_missing_target_path_finding';
        }
        return '';
      }
    }
  ];

  const allHardFailures = [];

  for (const model of models) {
    console.log(`\n=== model: ${model} ===`);
    const results = [];

    for (const testCase of cases) {
      process.stdout.write(`- ${testCase.name}: `);
      const result = await runCase({
        client,
        model,
        timeoutMs,
        maxOutputTokens,
        retryOutputTokens,
        ...testCase
      });
      results.push(result);
      if (result.ok) {
        process.stdout.write(
          `PASS (response_id=${result.responseId || 'n/a'}, max_output_tokens=${result.outputTokens})\n`
        );
      } else {
        process.stdout.write(`FAIL (${result.error})\n`);
      }
    }

    const hardFailures = results
      .filter((r) => !r.ok && (r.name !== 'bug_probe' || bugProbeRequired))
      .map((r) => ({ ...r, model }));
    allHardFailures.push(...hardFailures);

    const bugProbeResult = results.find((r) => r.name === 'bug_probe');
    if (bugProbeResult && !bugProbeResult.ok && !bugProbeRequired) {
      console.warn('Bug probe: FAIL (non-blocking).');
    } else if (bugProbeResult && bugProbeResult.ok) {
      console.log('Bug probe: PASS.');
    } else if (bugProbeRequired) {
      console.log('Bug probe: FAIL (required).');
    }
  }

  if (allHardFailures.length > 0) {
    console.error('\nSchema support check failed.');
    for (const item of allHardFailures) {
      console.error(`- [${item.model}] ${item.name}: ${item.error}`);
      if (item.preview) {
        console.error(`  preview: ${item.preview}`);
      }
    }
    process.exitCode = 1;
    return;
  }

  console.log('\nSchema support check passed for all models.');
}

main().catch((error) => {
  console.error(`Schema support check aborted: ${error.message || String(error)}`);
  process.exit(1);
});
