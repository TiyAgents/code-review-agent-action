#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  configureOpenAIClient,
  createPlannerAgent,
  createReviewerAgent,
  runStructuredWithRepair
} = require('../src/agents');
const { COMPATIBILITY_MODES } = require('../src/model-runtime');

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

function parseModeList(value) {
  const allowed = new Set(COMPATIBILITY_MODES.filter((mode) => mode !== 'auto'));
  const selected = [];
  for (const entry of String(value || '').split(/[|,]/)) {
    const mode = entry.trim();
    if (!mode || !allowed.has(mode) || selected.includes(mode)) {
      continue;
    }
    selected.push(mode);
  }
  return selected.length > 0
    ? selected
    : ['responses_json_schema', 'chat_json_schema', 'chat_json_object', 'prompt_json'];
}

function summarizeError(error) {
  return String(error?.message || error || 'unknown_error').slice(0, 220);
}

async function runCase({ model, baseURL, apiKey, mode, name, agent, input }) {
  configureOpenAIClient({ apiKey, baseURL, compatibilityMode: mode });
  const result = await runStructuredWithRepair(agent, input, { allowRepair: true });

  if (result.ok) {
    return {
      ok: true,
      name,
      mode,
      repaired: result.repaired
    };
  }

  return {
    ok: false,
    name,
    mode,
    error: summarizeError(result.error)
  };
}

async function main() {
  const cwd = process.cwd();
  loadEnvFile(path.join(cwd, '.env'));

  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_API_BASE || '';
  const modelInput = process.env.MODEL || process.env.OPENAI_MODEL || '';
  const modes = parseModeList(process.env.COMPATIBILITY_MODES || '');
  const bugProbeRequired = parseBooleanEnv('BUG_PROBE_REQUIRED', false);

  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY. Set it in environment or .env.');
  }

  const models = parseModelList(modelInput);
  if (models.length === 0) {
    throw new Error('Missing MODEL. Set MODEL in environment or .env. Use "|" to test multiple models.');
  }

  console.log(
    `Compatibility check start: models=${models.join('|')}${baseURL ? ` base=${baseURL}` : ''} modes=${modes.join(',')}`
  );

  const plannerPrompt = [
    'round=1',
    'maxRounds=3',
    'budgetRemainingCalls=10',
    'maxFilesPerBatch=2',
    'pendingFiles=',
    JSON.stringify([
      { path: 'src/a.js', status: 'modified', additions: 5, deletions: 1, changes: 6 },
      { path: 'src/b.js', status: 'modified', additions: 3, deletions: 0, changes: 3 },
      { path: 'src/c.js', status: 'added', additions: 12, deletions: 0, changes: 12 }
    ], null, 2)
  ].join('\n');

  const reviewerPrompt = [
    'dimension=general',
    'round=1',
    'availableDimensions=general,security,performance,testing',
    'Anchor format: [L<old>|R<new>] <raw diff line>; use RIGHT+R<number> or LEFT+L<number>.',
    'Review the following batch and return schema output.',
    '### src/a.js',
    'file=src/a.js',
    'status=modified',
    'changes=3',
    'additions=2',
    'deletions=1',
    '',
    '```text',
    '@@ -1,2 +1,3 @@',
    '[L1|R1] const oldValue = compute();',
    '[L2|R2] if (oldValue > 0) doWork();',
    '[L-|R3] retryTask();',
    '```'
  ].join('\n');

  const bugProbePrompt = [
    'dimension=general',
    'round=1',
    'availableDimensions=general,security,performance,testing',
    'Anchor format: [L<old>|R<new>] <raw diff line>; use RIGHT+R<number> or LEFT+L<number>.',
    'Review the following batch and return schema output.',
    '### src/auth/token.js',
    'file=src/auth/token.js',
    'status=modified',
    'changes=6',
    'additions=1',
    'deletions=1',
    '',
    '```text',
    '@@ -9,4 +9,4 @@',
    '[L9|R9] function canAccess(session) {',
    '[L10|R10]   let allowAccess = false;',
    '[L11|R11]   // only admin can pass',
    '[L12|R12]   if (!session.user.isAdmin) allowAccess = true;',
    '[L13|R13]   return allowAccess;',
    '[L14|R14] }',
    '```'
  ].join('\n');

  const allHardFailures = [];

  for (const model of models) {
    console.log(`\n=== model: ${model} ===`);

    const planner = createPlannerAgent({ model, projectGuidance: null });
    const reviewer = createReviewerAgent({
      dimension: 'general',
      model,
      language: 'English',
      projectGuidance: null
    });

    const modeResults = [];
    for (const mode of modes) {
      console.log(`-- mode: ${mode}`);
      const cases = [
        { name: 'planner', agent: planner, input: plannerPrompt },
        { name: 'reviewer', agent: reviewer, input: reviewerPrompt },
        { name: 'bug_probe', agent: reviewer, input: bugProbePrompt }
      ];

      const results = [];
      for (const testCase of cases) {
        process.stdout.write(`- ${testCase.name}: `);
        const result = await runCase({
          model,
          baseURL,
          apiKey,
          mode,
          ...testCase
        });
        results.push(result);
        if (result.ok) {
          process.stdout.write(`PASS${result.repaired ? ' (repaired)' : ''}\n`);
        } else {
          process.stdout.write(`FAIL (${result.error})\n`);
        }
      }

      modeResults.push({ mode, results });
    }

    const recommended = modeResults.find(({ results }) => {
      const plannerOk = results.find((item) => item.name === 'planner')?.ok;
      const reviewerOk = results.find((item) => item.name === 'reviewer')?.ok;
      return plannerOk && reviewerOk;
    });

    if (recommended) {
      console.log(`Recommended mode: ${recommended.mode}`);
    } else {
      console.log('Recommended mode: none');
    }

    for (const { mode, results } of modeResults) {
      const hardFailures = results
        .filter((item) => !item.ok && (item.name !== 'bug_probe' || bugProbeRequired))
        .map((item) => ({ ...item, model, mode }));
      allHardFailures.push(...hardFailures);

      const bugProbeResult = results.find((item) => item.name === 'bug_probe');
      if (bugProbeResult && !bugProbeResult.ok && !bugProbeRequired) {
        console.warn(`Bug probe (${mode}): FAIL (non-blocking).`);
      }
    }
  }

  if (allHardFailures.length > 0) {
    console.error('\nCompatibility check failed.');
    for (const item of allHardFailures) {
      console.error(`- [${item.model}] [${item.mode}] ${item.name}: ${item.error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('\nCompatibility check passed for all required cases.');
}

main().catch((error) => {
  console.error(`Compatibility check aborted: ${error.message || String(error)}`);
  process.exit(1);
});
