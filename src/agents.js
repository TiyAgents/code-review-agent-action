const { Agent, run, setDefaultOpenAIClient, setTracingDisabled } = require('@openai/agents');
const OpenAIImport = require('openai');
const { z } = require('zod');

const OpenAI = OpenAIImport.default || OpenAIImport;

const plannerOutputSchema = z.object({
  batches: z
    .array(
      z.object({
        focus: z.string().default('general'),
        filePaths: z.array(z.string()).min(1),
        reason: z.string().default('')
      })
    )
    .default([]),
  done: z.boolean().default(false),
  notes: z.string().default('')
});

const findingSchema = z.object({
  title: z.string().min(1),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  category: z.string().default('general'),
  path: z.string().min(1),
  side: z.enum(['LEFT', 'RIGHT', 'FILE']).default('RIGHT'),
  line: z.number().int().positive().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.8),
  evidence: z.array(z.string().min(1)).default([]),
  fingerprint: z.string().max(120).default(''),
  summary: z.string().min(1),
  suggestion: z.string().default(''),
  risk: z.string().default('')
});

const fileConclusionSchema = z.object({
  path: z.string().min(1),
  conclusion: z.string().min(1),
  risks: z.array(z.string()).default([]),
  testSuggestions: z.array(z.string()).default([]),
  note: z.string().default('')
});

const reviewOutputSchema = z.object({
  overall: z.string().min(1),
  findings: z.array(findingSchema).default([]),
  fileConclusions: z.array(fileConclusionSchema).default([]),
  recommendedExtraDimensions: z.array(z.string()).default([]),
  recommendationReason: z.string().default(''),
  actionableSuggestions: z.array(z.string()).default([]),
  potentialRisks: z.array(z.string()).default([]),
  testSuggestions: z.array(z.string()).default([])
});

function configureOpenAIClient({ apiKey, baseURL, disableTracing }) {
  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {})
  });
  setDefaultOpenAIClient(client);
  setTracingDisabled(Boolean(disableTracing));
}

function buildProjectGuidanceInstructions(projectGuidance) {
  if (!projectGuidance || !projectGuidance.content) {
    return '';
  }

  const truncatedHint = projectGuidance.truncated
    ? 'Note: guidance content is truncated for prompt budget.'
    : '';

  return `
Repository contributor guidance (${projectGuidance.path}):
<project_guidance>
${projectGuidance.content}
</project_guidance>
${truncatedHint}
- Follow this guidance when it applies to review decisions.
- If guidance conflicts with explicit task rules, explicit task rules win.
`;
}

function createPlannerAgent({ model, projectGuidance }) {
  const guidanceBlock = buildProjectGuidanceInstructions(projectGuidance);

  return new Agent({
    name: 'Review Planner',
    model,
    instructions: `You are the planner/orchestrator for PR code review.
Create batches that drive coverage to 100% over provided pending files.
Rules:
- Only include paths from pending files.
- Keep each batch <= maxFilesPerBatch.
- Prioritize risky files first (security-sensitive, infra, dependency, auth, concurrency).
- Prefer balanced batches by file size and risk.
- Set done=true only when no pending files remain or budget makes further work impossible.
${guidanceBlock}
Output must follow schema exactly.`,
    outputType: plannerOutputSchema
  });
}

function createReviewerAgent({ dimension, model, language, projectGuidance }) {
  const dimensionPrompt = {
    general: 'Focus on correctness, maintainability, edge cases, and regressions.',
    security: 'Focus on vulnerabilities, authn/authz, injection, secrets, unsafe deserialization, SSRF, path traversal, and supply chain risk.',
    performance: 'Focus on algorithmic complexity, memory, I/O, network, locking contention, and scalability bottlenecks.',
    testing: 'Focus on missing test coverage, flaky scenarios, boundary conditions, and observability gaps.'
  }[dimension] || 'Focus on correctness and practical engineering risks.';
  const guidanceBlock = buildProjectGuidanceInstructions(projectGuidance);

  return new Agent({
    name: `${dimension} reviewer`,
    model,
    instructions: `You are a ${dimension} code review sub-agent.
${dimensionPrompt}
Use this language for all natural-language output fields: ${language || 'English'}.
${guidanceBlock}
Rules:
- Review ONLY the provided file list and diff snippets.
- Diff snippets are line-anchored as [L<old>|R<new>] <raw diff line>.
- Use path/side/line when you can map issue to diff lines; otherwise side=FILE and line=null.
- For additions/context on new code, use side=RIGHT with the R<number> anchor.
- For removals on old code, use side=LEFT with the L<number> anchor.
- Never emit line numbers that do not appear in the provided anchors.
- Do not invent files or line numbers.
- Severity must be one of critical/high/medium/low.
- Set confidence in [0,1]. Include at least one concrete evidence item tied to provided diff context.
- If confidence is below 0.70, do not emit it as a finding; put it in file-level notes instead.
- Use fingerprint as stable short key for same issue across dimensions (e.g. unsafe_openai_base_url, planner_done_ignored).
- Keep findings concrete, actionable, and concise.
- Provide file-level conclusions for all files in this batch, including no-risk files.
- If you are the general reviewer, use recommendedExtraDimensions to request additional specialized review dimensions when needed (for example security/performance/testing), and explain with recommendationReason.
- If you are not the general reviewer, set recommendedExtraDimensions=[] and recommendationReason="".
Output must follow schema exactly.`,
    outputType: reviewOutputSchema
  });
}

async function runStructuredWithRepair(agent, input, options = {}) {
  const maxTurns = options.maxTurns || 8;
  let calls = 0;

  try {
    calls += 1;
    const result = await run(agent, input, { maxTurns });
    if (!result.finalOutput) {
      throw new Error('Agent returned no structured output.');
    }
    return {
      ok: true,
      output: result.finalOutput,
      calls,
      repaired: false
    };
  } catch (firstError) {
    if (!options.allowRepair) {
      return {
        ok: false,
        error: firstError,
        calls,
        repaired: false
      };
    }

    const repairInput = `${input}\n\nThe previous attempt failed schema parsing/validation. Re-output strictly valid schema JSON with no extra keys.`;

    try {
      calls += 1;
      const repaired = await run(agent, repairInput, { maxTurns });
      if (!repaired.finalOutput) {
        throw new Error('Repair attempt returned no structured output.');
      }

      return {
        ok: true,
        output: repaired.finalOutput,
        calls,
        repaired: true
      };
    } catch (secondError) {
      return {
        ok: false,
        error: new Error(`Structured output failed after repair: ${secondError.message || String(secondError)}`),
        calls,
        repaired: true
      };
    }
  }
}

function buildPlannerInput({ round, maxRounds, budgetRemaining, maxFilesPerBatch, pendingFiles }) {
  const pendingPayload = pendingFiles.map((file) => ({
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes
  }));

  return [
    `round=${round}`,
    `maxRounds=${maxRounds}`,
    `budgetRemainingCalls=${budgetRemaining}`,
    `maxFilesPerBatch=${maxFilesPerBatch}`,
    'pendingFiles=',
    JSON.stringify(pendingPayload, null, 2)
  ].join('\n');
}

function formatPatchWithAnchors(patch) {
  if (typeof patch !== 'string' || patch.length === 0) {
    return '';
  }

  const lines = patch.split('\n');
  const output = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of lines) {
    const line = rawLine || '';

    if (line.startsWith('@@')) {
      const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
      if (match) {
        oldLine = Number.parseInt(match[1], 10);
        newLine = Number.parseInt(match[2], 10);
        inHunk = true;
      } else {
        inHunk = false;
      }
      output.push(line);
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (line.startsWith('+')) {
      output.push(`[L-|R${newLine}] ${line}`);
      newLine += 1;
      continue;
    }

    if (line.startsWith('-')) {
      output.push(`[L${oldLine}|R-] ${line}`);
      oldLine += 1;
      continue;
    }

    if (line.startsWith(' ')) {
      output.push(`[L${oldLine}|R${newLine}] ${line}`);
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (line.startsWith('\\')) {
      output.push(`[L-|R-] ${line}`);
      continue;
    }
  }

  if (output.length === 0) {
    return patch;
  }

  return output.join('\n');
}

function buildBatchReviewInput({ dimension, round, batchFiles, maxContextChars, availableDimensions }) {
  let usedChars = 0;
  const sections = [];
  const selectedPaths = [];
  const truncationNotice = '\n... [patch truncated for context budget]';

  for (const file of batchFiles) {
    const header = [
      `file=${file.filename}`,
      `status=${file.status}`,
      `changes=${file.changes}`,
      `additions=${file.additions}`,
      `deletions=${file.deletions}`
    ].join('\n');

    let patch = formatPatchWithAnchors(file.patch);
    if (!patch) {
      patch = '[patch unavailable]';
    }

    const staticSection = `\n### ${file.filename}\n${header}\n\n`;
    const patchIntro = '```text\n';
    const patchOutro = '\n```\n';

    const fixedCost = staticSection.length + patchIntro.length + patchOutro.length;
    const remaining = maxContextChars - usedChars - fixedCost;

    if (remaining <= 0 && sections.length > 0) {
      break;
    }
    if (remaining <= 0) {
      continue;
    }

    let patchBody = patch;
    if (patchBody.length > remaining) {
      if (remaining > truncationNotice.length) {
        patchBody = `${patchBody.slice(0, remaining - truncationNotice.length)}${truncationNotice}`;
      } else if (sections.length > 0) {
        continue;
      } else {
        patchBody = patchBody.slice(0, remaining);
      }
    }

    const block = `${staticSection}${patchIntro}${patchBody}${patchOutro}`;
    if (block.length + usedChars > maxContextChars && sections.length > 0) {
      continue;
    }

    sections.push(block);
    selectedPaths.push(file.filename);
    usedChars += block.length;
  }

  const prompt = [
    `dimension=${dimension}`,
    `round=${round}`,
    `availableDimensions=${(availableDimensions || []).join(',')}`,
    'Anchor format: [L<old>|R<new>] <raw diff line>; use RIGHT+R<number> or LEFT+L<number>.',
    'Review the following batch and return schema output.',
    ...sections
  ].join('\n');

  return {
    prompt,
    selectedPaths
  };
}

module.exports = {
  configureOpenAIClient,
  createPlannerAgent,
  createReviewerAgent,
  runStructuredWithRepair,
  buildPlannerInput,
  buildBatchReviewInput
};
