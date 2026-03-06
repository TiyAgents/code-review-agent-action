const { z } = require('zod');
const { configureOpenAIClient, runStructuredWithRepair } = require('./model-runtime');

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
  confidence: z.number().min(0).max(1).nullable().optional().default(null),
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

function buildPlannerOutputContractPrompt() {
  return [
    'JSON contract:',
    '- Return exactly one JSON object with only these top-level keys: batches, done, notes.',
    '- batches is an array of objects with keys: focus, filePaths, reason.',
    '- Every filePaths value must be a non-empty array of strings.',
    '- done must be a boolean.',
    '- notes must be a string.',
    '- Do not add extra keys.',
    'Example shape:',
    '{"batches":[{"focus":"general","filePaths":["src/a.js"],"reason":"short reason"}],"done":false,"notes":""}'
  ].join('\n');
}

function buildReviewerOutputContractPrompt() {
  return [
    'JSON contract:',
    '- Return exactly one JSON object with only these top-level keys: overall, findings, fileConclusions, recommendedExtraDimensions, recommendationReason, actionableSuggestions, potentialRisks, testSuggestions.',
    '- findings is an array of objects with keys: title, severity, category, path, side, line, confidence, evidence, fingerprint, summary, suggestion, risk.',
    '- severity must be one of critical, high, medium, low.',
    '- side must be one of LEFT, RIGHT, FILE.',
    '- line must be a positive integer or null.',
    '- confidence must be a number in [0,1] or null.',
    '- evidence, recommendedExtraDimensions, actionableSuggestions, potentialRisks, testSuggestions, risks are arrays of strings.',
    '- fileConclusions is an array of objects with keys: path, conclusion, risks, testSuggestions, note.',
    '- Do not add extra keys.',
    'Example shape:',
    '{"overall":"short summary","findings":[],"fileConclusions":[{"path":"src/a.js","conclusion":"ok","risks":[],"testSuggestions":[],"note":""}],"recommendedExtraDimensions":[],"recommendationReason":"","actionableSuggestions":[],"potentialRisks":[],"testSuggestions":[]}'
  ].join('\n');
}

function createPlannerAgent({ model, projectGuidance }) {
  const guidanceBlock = buildProjectGuidanceInstructions(projectGuidance);

  const instructions = `You are the planner/orchestrator for PR code review.
Create batches that drive coverage to 100% over provided pending files.
Rules:
- Only include paths from pending files.
- Keep each batch <= maxFilesPerBatch.
- Prioritize risky files first (security-sensitive, infra, dependency, auth, concurrency).
- Prefer balanced batches by file size and risk.
- Set done=true only when no pending files remain or budget makes further work impossible.
${guidanceBlock}
Output must follow the required JSON contract exactly.`;

  return {
    name: 'Review Planner',
    model,
    instructions,
    schema: plannerOutputSchema,
    responseName: 'planner_output',
    outputContractPrompt: buildPlannerOutputContractPrompt(),
    opts: {
      outputType: plannerOutputSchema
    }
  };
}

function createReviewerAgent({ dimension, model, language, projectGuidance }) {
  const dimensionPrompt = {
    general: 'Focus on correctness, maintainability, edge cases, and regressions.',
    security: 'Focus on vulnerabilities, authn/authz, injection, secrets, unsafe deserialization, SSRF, path traversal, and supply chain risk.',
    performance: 'Focus on algorithmic complexity, memory, I/O, network, locking contention, and scalability bottlenecks.',
    testing: 'Focus on missing test coverage, flaky scenarios, boundary conditions, and observability gaps.'
  }[dimension] || 'Focus on correctness and practical engineering risks.';
  const guidanceBlock = buildProjectGuidanceInstructions(projectGuidance);

  const instructions = `You are a ${dimension} code review sub-agent.
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
- Set confidence in [0,1] when you can estimate it; otherwise use null.
- Include at least one concrete evidence item tied to provided diff context.
- If confidence is below 0.70, do not emit it as a finding; put it in file-level notes instead.
- Use fingerprint as stable short key for same issue across dimensions (e.g. unsafe_openai_base_url, planner_done_ignored).
- Keep findings concrete, actionable, and concise.
- Provide file-level conclusions for all files in this batch, including no-risk files.
- If you are the general reviewer, use recommendedExtraDimensions to request additional specialized review dimensions when needed (for example security/performance/testing), and explain with recommendationReason.
- If you are not the general reviewer, set recommendedExtraDimensions=[] and recommendationReason="".
Output must follow the required JSON contract exactly.`;

  return {
    name: `${dimension} reviewer`,
    model,
    instructions,
    schema: reviewOutputSchema,
    responseName: `${dimension}_review_output`,
    outputContractPrompt: buildReviewerOutputContractPrompt(),
    opts: {
      outputType: reviewOutputSchema
    }
  };
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
  buildBatchReviewInput,
  plannerOutputSchema,
  reviewOutputSchema
};
