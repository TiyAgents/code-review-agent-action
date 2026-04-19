const core = require('@actions/core');
const github = require('@actions/github');

const { loadConfig } = require('./config');
const { filterFiles } = require('./globs');
const { buildDiffLineMaps, resolveInlineLocation } = require('./diff-map');
const { inlineKeyFromFinding } = require('./inline-key');
const {
  configureRuntime,
  createPlannerAgent,
  createReviewerAgent,
  runStructuredWithRepair,
  buildPlannerInput,
  buildBatchReviewInput
} = require('./agents');
const { createProvider, createModel } = require('./provider');
const {
  normalizeFindings,
  dedupeAndSortFindings,
  groupFindingsBySeverity
} = require('./aggregate');
const { loadProjectGuidance } = require('./repo-guidance');
const { upsertSummaryComment, createReview } = require('./publish');
const { sanitizePublicErrorDetail } = require('./public-error');

function getTextBundle(language) {
  const lang = String(language || 'English').trim().toLowerCase();
  const zh = lang.includes('zh') || lang.includes('chinese') || lang.includes('中文');

  if (!zh) {
    return {
      suggestionLabel: 'Suggestion',
      riskLabel: 'Risk',
      confidenceLabel: 'Confidence',
      unknownConfidenceValue: 'N/A',
      summaryTitle: 'AI Code Review Summary',
      preferredLanguage: 'Preferred language',
      overallAssessment: 'Overall Assessment',
      majorFindings: 'Major Findings by Severity',
      actionableSuggestions: 'Actionable Suggestions',
      potentialRisks: 'Potential Risks',
      testSuggestions: 'Test Suggestions',
      fileLevelCoverage: 'File-Level Coverage Notes',
      inlineDowngraded: 'Inline Downgraded Items (processed but not inline)',
      coverageStatus: 'Coverage Status',
      unknownConfidenceFindings: 'Findings with unknown confidence (N/A)',
      uncoveredList: 'Uncovered list',
      noPatchCoveredList: 'No-patch covered list',
      runtimeBudget: 'Runtime/Budget',
      runtimeRounds: 'Rounds used',
      runtimePlannerCalls: 'Planner calls',
      runtimeReviewerCalls: 'Reviewer calls',
      runtimeModelCalls: 'Model calls',
      runtimePlannedBatches: 'Planned batches',
      runtimeExecutedBatches: 'Executed batches',
      runtimeSubAgentRuns: 'Sub-agent runs',
      noMajorIssues: 'No major issues identified from the reviewed diff.',
      noFileNotes: 'No file-level notes.',
      moreFileEntries: (count) => `- ... and ${count} more file-level entries.`,
      noBlockingOverall: 'No blocking issue was detected in the reviewed diff; keep focused regression testing before merge.',
      detectedOverall: (count) => `Detected ${count} actionable findings, prioritize CRITICAL/HIGH before merge.`,
      defaultActionable: '- Address the highest severity findings first and add targeted tests for changed logic.',
      defaultRisks: '- Potential hidden risks remain in edge cases not covered by the current diff context.',
      defaultTests: '- Add happy-path + boundary + failure-path tests for touched modules.',
      none: '- None',
      yes: 'YES',
      no: 'NO',
      fromSubAgentTag: (name) => `[From SubAgent: ${name}]`,
      reasons: 'Reasons',
      structuredDegrade: 'Structured-output summary-only degradation',
      syntheticInline: 'Automated review completed for this PR diff. No concrete inline issue was selected after aggregation.',
      reviewCompleted: 'Automated PR review completed.',
      reviewSeeSummary: 'See the summary comment for detailed analysis and coverage details.',
      lowRiskDefault: 'Patch content unavailable (binary/large/renamed), reviewed as file-level risk only.',
      lowRiskHint: 'Behavior changes may exist without visible unified diff context.',
      lowRiskTestHint: 'Run targeted integration/regression tests covering this file change.',
      cannotInlineWithoutPatch: 'cannot_inline_without_patch',
      uncoveredConclusion: 'File was in scope but not fully reviewed before budget limits.',
      uncoveredRisk: 'Potential missed issues due to budget/round constraints.',
      uncoveredTest: 'Run focused manual review and add tests before merge.'
    };
  }

  return {
    suggestionLabel: '建议',
    riskLabel: '风险',
    confidenceLabel: '置信度',
    unknownConfidenceValue: 'N/A',
    summaryTitle: 'AI 代码审查汇总',
    preferredLanguage: '指定语言',
    overallAssessment: '总体评价',
    majorFindings: '主要问题（按严重级别）',
    actionableSuggestions: '可执行建议',
    potentialRisks: '潜在风险',
    testSuggestions: '测试建议',
    fileLevelCoverage: '文件级覆盖说明',
    inlineDowngraded: '无法 inline 的已处理项',
    coverageStatus: '覆盖状态',
    unknownConfidenceFindings: '置信度未知（N/A）的问题数',
    uncoveredList: '未覆盖文件清单',
    noPatchCoveredList: '无 patch 文件覆盖清单',
    runtimeBudget: '轮次与预算',
    runtimeRounds: '轮次',
    runtimePlannerCalls: 'Planner 调用',
    runtimeReviewerCalls: 'SubAgent 调用',
    runtimeModelCalls: '模型调用',
    runtimePlannedBatches: '计划批次',
    runtimeExecutedBatches: '执行批次',
    runtimeSubAgentRuns: 'SubAgent 执行次数',
    noMajorIssues: '在已审查 diff 中未发现主要问题。',
    noFileNotes: '无文件级备注。',
    moreFileEntries: (count) => `- 其余 ${count} 条文件级记录已省略。`,
    noBlockingOverall: '在本次已审查 diff 中未发现阻塞性问题，合并前建议继续做针对性回归测试。',
    detectedOverall: (count) => `共发现 ${count} 条可执行问题，建议优先处理 CRITICAL/HIGH。`,
    defaultActionable: '- 优先修复高严重级别问题，并为变更逻辑补充针对性测试。',
    defaultRisks: '- 当前 diff 上下文之外仍可能存在边界条件风险。',
    defaultTests: '- 建议补充正常路径、边界条件与失败路径测试。',
    none: '- 无',
    yes: '是',
    no: '否',
    fromSubAgentTag: (name) => `[来自 SubAgent：${name}]`,
    reasons: '原因',
    structuredDegrade: '结构化输出降级为仅汇总评论',
    syntheticInline: '自动审查已完成；聚合后没有可稳定定位的具体 inline 问题。',
    reviewCompleted: '自动化 PR 审查已完成。',
    reviewSeeSummary: '详细结论请查看汇总评论。',
    lowRiskDefault: '该文件 patch 不可用（可能为二进制/超大 diff/重命名），已按文件级风险处理。',
    lowRiskHint: '缺少可见 unified diff，上下文外行为变更风险仍存在。',
    lowRiskTestHint: '请对该文件改动执行定向集成/回归测试。',
    cannotInlineWithoutPatch: '无patch无法inline',
    uncoveredConclusion: '该文件在审查范围内，但受轮次/预算限制未完成充分审查。',
    uncoveredRisk: '受预算或轮次限制，可能遗漏问题。',
    uncoveredTest: '合并前建议补充人工审查并增加对应测试。'
  };
}

function uniqueItems(items) {
  return [...new Set((items || []).map((i) => String(i || '').trim()).filter(Boolean))];
}

function normalizeDimensionNames(items) {
  return uniqueItems(items).map((x) => x.toLowerCase());
}

function chunk(items, chunkSize) {
  const out = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    out.push(items.slice(i, i + chunkSize));
  }
  return out;
}

function addPublicDegradedReason(reasons, code, detail) {
  reasons.push(`${code}: ${sanitizePublicErrorDetail(detail)}`);
}

function getErrorMessage(error, fallback = 'unknown_error') {
  return String(error?.message || error || fallback);
}

/**
 * Create a simple concurrency limiter (semaphore).
 * Returns { run(asyncFn) → Promise } that ensures at most `concurrency`
 * async functions execute simultaneously.
 */
function createSemaphore(concurrency) {
  let active = 0;
  const queue = [];

  function tryNext() {
    while (queue.length > 0 && active < concurrency) {
      const { fn, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve().then(fn).then(
        (value) => { active -= 1; resolve(value); tryNext(); },
        (error) => { active -= 1; reject(error); tryNext(); }
      );
    }
  }

  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        tryNext();
      });
    }
  };
}

function shouldUseSummaryOnlyMode({ hadStructuredOutputFailure, hasSuccessfulReviewerOutput }) {
  return Boolean(hadStructuredOutputFailure && !hasSuccessfulReviewerOutput);
}

function sanitizePlannedBatches(batches, pendingPathSet, maxFilesPerBatch) {
  const out = [];

  for (const batch of batches || []) {
    const filePaths = uniqueItems(batch.filePaths || []).filter((path) => pendingPathSet.has(path));
    if (filePaths.length === 0) {
      continue;
    }

    out.push({
      focus: String(batch.focus || 'general').toLowerCase(),
      reason: String(batch.reason || ''),
      filePaths: filePaths.slice(0, maxFilesPerBatch)
    });
  }

  return out;
}

function summarizePlannerBatchesForLog(batches, maxEntries = 12) {
  if (!batches.length) {
    return 'none';
  }

  return batches.slice(0, maxEntries).map((batch, index) => {
    const previewPaths = batch.filePaths.slice(0, 3).join(', ');
    const extra = batch.filePaths.length > 3 ? ` +${batch.filePaths.length - 3} more` : '';
    const reason = batch.reason ? ` reason=${batch.reason}` : '';
    return `#${index + 1} focus=${batch.focus} files=${batch.filePaths.length}${reason} paths=[${previewPaths}${extra}]`;
  }).join(' | ');
}

function formatConfidenceValue(confidence, unknownValue = 'N/A') {
  const value = Number.parseFloat(String(confidence));
  if (!Number.isFinite(value)) {
    return unknownValue;
  }

  const clamped = Math.min(1, Math.max(0, value));
  return clamped.toFixed(2);
}

function buildInlineBody(finding, text) {
  const lines = [];
  const subAgent = String(finding.sourceDimension || 'general').trim().toLowerCase() || 'general';
  const inlineKey = inlineKeyFromFinding(finding);
  lines.push(`**[${finding.severity.toUpperCase()}] ${finding.title}**`);
  lines.push(finding.summary);

  if (finding.suggestion) {
    lines.push(`${text.suggestionLabel}: ${finding.suggestion}`);
  }

  if (finding.risk) {
    lines.push(`${text.riskLabel}: ${finding.risk}`);
  }

  lines.push(`${text.confidenceLabel}: ${formatConfidenceValue(finding.confidence, text.unknownConfidenceValue)}`);
  lines.push(`<div align="right">${text.fromSubAgentTag(subAgent)}</div>`);
  lines.push(`<!-- ai-code-review-agent:inline-key ${inlineKey} -->`);

  return lines.join('\n\n');
}

function buildReviewBody({
  text,
  findingsKept,
  unknownConfidenceFindings,
  inlineCommentsAttempted,
  coverage
}) {
  return [
    text.reviewCompleted,
    `- Findings kept: ${findingsKept}`,
    `- Findings with unknown confidence: ${unknownConfidenceFindings}`,
    `- Inline comments attempted: ${inlineCommentsAttempted}`,
    `- Target files: ${coverage.target}`,
    `- Covered files: ${coverage.covered}`,
    `- Uncovered files: ${coverage.uncovered}`,
    text.reviewSeeSummary
  ].join('\n');
}

function summarizeSeverity(groups, text, limitEach = 8) {
  const order = ['critical', 'high', 'medium', 'low'];
  const lines = [];

  for (const severity of order) {
    const bucket = groups[severity] || [];
    if (bucket.length === 0) {
      continue;
    }

    lines.push(`- ${severity.toUpperCase()} (${bucket.length})`);
    for (const finding of bucket.slice(0, limitEach)) {
      const loc = finding.line ? `${finding.path}:${finding.line}` : `${finding.path}`;
      lines.push(`  - ${loc} - ${finding.title}`);
    }
  }

  if (lines.length === 0) {
    lines.push(text.noMajorIssues);
  }

  return lines.join('\n');
}

function summarizeFileConclusions(fileConclusions, text, limit = 20) {
  if (!fileConclusions.length) {
    return text.noFileNotes;
  }

  const lines = [];
  for (const item of fileConclusions.slice(0, limit)) {
    const note = item.note ? ` (${item.note})` : '';
    lines.push(`- ${item.path}: ${item.conclusion}${note}`);
  }

  if (fileConclusions.length > limit) {
    lines.push(text.moreFileEntries(fileConclusions.length - limit));
  }

  return lines.join('\n');
}

function formatSummaryMarkdown({
  pull,
  reviewLanguage,
  findings,
  fileConclusions,
  actionableSuggestions,
  potentialRisks,
  testSuggestions,
  downgradedInline,
  uncovered,
  noPatchCovered,
  coverage,
  runtime,
  degradedSummaryOnly,
  degradedReasons
}) {
  const text = getTextBundle(reviewLanguage);
  const groups = groupFindingsBySeverity(findings);

  const overall = findings.length === 0
    ? text.noBlockingOverall
    : text.detectedOverall(findings.length);

  const actionable = actionableSuggestions.length
    ? actionableSuggestions.slice(0, 12).map((s) => `- ${s}`).join('\n')
    : text.defaultActionable;

  const risks = potentialRisks.length
    ? potentialRisks.slice(0, 12).map((s) => `- ${s}`).join('\n')
    : text.defaultRisks;

  const tests = testSuggestions.length
    ? testSuggestions.slice(0, 12).map((s) => `- ${s}`).join('\n')
    : text.defaultTests;

  const downgradedLines = downgradedInline.length
    ? downgradedInline.slice(0, 20).map((x) => `- ${x.path}: ${x.title} (${x.reason})`).join('\n')
    : text.none;

  const uncoveredLines = uncovered.length
    ? uncovered.map((x) => `- ${x.path}: ${x.reason}`).join('\n')
    : text.none;

  const noPatchLines = noPatchCovered.length
    ? noPatchCovered.map((x) => `- ${x.path}: ${x.reason}`).join('\n')
    : text.none;

  const degradedText = degradedSummaryOnly
    ? `${text.yes}\n\n${text.reasons}:\n${degradedReasons.map((x) => `- ${x}`).join('\n') || '- unknown'}`
    : text.no;
  const unknownConfidenceFindings = Number.isFinite(coverage.unknownConfidenceFindings)
    ? coverage.unknownConfidenceFindings
    : 0;

  return [
    `## ${text.summaryTitle}`,
    '',
    `PR: #${pull.number} (${pull.title})`,
    `${text.preferredLanguage}: ${reviewLanguage || 'English'}`,
    '',
    `### ${text.overallAssessment}`,
    overall,
    '',
    `### ${text.majorFindings}`,
    summarizeSeverity(groups, text),
    '',
    `### ${text.actionableSuggestions}`,
    actionable,
    '',
    `### ${text.potentialRisks}`,
    risks,
    '',
    `### ${text.testSuggestions}`,
    tests,
    '',
    `### ${text.fileLevelCoverage}`,
    summarizeFileConclusions(fileConclusions, text),
    '',
    `### ${text.inlineDowngraded}`,
    downgradedLines,
    '',
    `### ${text.coverageStatus}`,
    `- Target files: ${coverage.target}`,
    `- Covered files: ${coverage.covered}`,
    `- Uncovered files: ${coverage.uncovered}`,
    `- No-patch/binary covered as file-level: ${coverage.noPatch}`,
    `- ${text.unknownConfidenceFindings}: ${unknownConfidenceFindings}`,
    '',
    `${text.uncoveredList}:`,
    uncoveredLines,
    '',
    `${text.noPatchCoveredList}:`,
    noPatchLines,
    '',
    `### ${text.runtimeBudget}`,
    `- ${text.runtimeRounds}: ${runtime.roundsUsed}/${runtime.maxRounds}`,
    `- ${text.runtimePlannedBatches}: ${runtime.plannedBatches}`,
    `- ${text.runtimeExecutedBatches}: ${runtime.executedBatches}`,
    `- ${text.runtimeSubAgentRuns}: ${runtime.subAgentRuns}`,
    `- ${text.runtimePlannerCalls}: ${runtime.plannerCalls}`,
    `- ${text.runtimeReviewerCalls}: ${runtime.reviewerCalls}`,
    `- ${text.runtimeModelCalls}: ${runtime.modelCalls}/${runtime.maxModelCalls}`,
    `- ${text.structuredDegrade}: ${degradedText}`
  ].join('\n');
}

/**
 * Run a single dimension review for a batch. Returns a result object or null on skip.
 */
async function runDimension({
  dimension, round, batchIndex, batchCount, batchFiles, reviewerAgents,
  config, projectGuidance
}) {
  const tag = `Round ${round} [B${batchIndex + 1}/${batchCount}] SubAgent(${dimension})`;

  const agent = reviewerAgents[dimension] || createReviewerAgent({
    dimension,
    model: config.reviewerModel,
    language: config.reviewLanguage,
    projectGuidance
  });
  reviewerAgents[dimension] = agent;

  const reviewInput = buildBatchReviewInput({
    dimension,
    round,
    batchFiles,
    maxContextChars: config.maxContextChars,
    availableDimensions: config.reviewDimensions
  });

  if (reviewInput.selectedPaths.length === 0) {
    core.warning(`${tag}: selectedPaths=0 due to context budget, skipped.`);
    return null;
  }

  const agentStart = Date.now();
  core.info(`${tag} start: files=${reviewInput.selectedPaths.length}`);

  const reviewResult = await runStructuredWithRepair(agent, reviewInput.prompt, {
    allowRepair: true,
    maxTurns: 10
  });
  const elapsedMs = Date.now() - agentStart;

  if (!reviewResult.ok) {
    const reviewerErrorMessage = getErrorMessage(reviewResult.error);
    core.warning(
      `${tag} failed: calls=${reviewResult.calls} elapsed_ms=${elapsedMs} error=${reviewerErrorMessage}`
    );
    return {
      ok: false,
      dimension,
      calls: reviewResult.calls,
      degradedReason: `reviewer_structured_output_failed_round_${round}_${dimension}: ${sanitizePublicErrorDetail(reviewerErrorMessage)}`
    };
  }

  const findingCount = (reviewResult.output.findings || []).length;
  const fileConclusionCount = (reviewResult.output.fileConclusions || []).length;
  const suggestionCount = (reviewResult.output.actionableSuggestions || []).length;
  core.info(
    `${tag} done: calls=${reviewResult.calls} elapsed_ms=${elapsedMs} findings=${findingCount} file_conclusions=${fileConclusionCount} suggestions=${suggestionCount}`
  );

  return {
    ok: true,
    dimension,
    calls: reviewResult.calls,
    selectedPaths: reviewInput.selectedPaths,
    output: reviewResult.output
  };
}

/**
 * Execute a single batch with parallel dimension execution.
 * general dimension runs first (to collect recommendedExtraDimensions),
 * then remaining dimensions run in parallel via the shared semaphore.
 */
async function executeBatch({
  batch, batchIndex, batchCount, round, roundDimensions,
  pendingFileByPath, reviewerAgents, config, projectGuidance, semaphore
}) {
  const tag = `Round ${round} [B${batchIndex + 1}/${batchCount}]`;

  // Build result accumulator
  const result = {
    executed: false,
    calls: 0,
    reviewerCalls: 0,
    subAgentRuns: 0,
    hadStructuredOutputFailure: false,
    hasSuccessfulReviewerOutput: false,
    degradedReasons: [],
    findings: [],
    actionableSuggestions: [],
    potentialRisks: [],
    testSuggestions: [],
    fileConclusions: [],
    coveredPaths: [],
    dimensionResults: []
  };

  const batchFiles = batch.filePaths
    .map((path) => pendingFileByPath.get(path))
    .filter(Boolean);

  if (batchFiles.length === 0) {
    core.warning(`${tag}: no resolvable files after mapping, skipped.`);
    return result;
  }

  result.executed = true;
  core.info(`${tag}: focus=${batch.focus} files=${batchFiles.length}`);

  // Build execution dimensions: general first
  const executionDimensions = [];
  if (roundDimensions.includes('general')) {
    executionDimensions.push('general');
  }
  for (const dimension of roundDimensions) {
    if (dimension !== 'general') {
      executionDimensions.push(dimension);
    }
  }
  if (executionDimensions.length === 0 && roundDimensions.length > 0) {
    executionDimensions.push(roundDimensions[0]);
  }

  // Helper to process a dimension result into the batch accumulator
  function collectDimensionResult(dimResult) {
    if (!dimResult) return;
    result.calls += dimResult.calls;
    result.reviewerCalls += dimResult.calls;
    result.subAgentRuns += 1;

    if (!dimResult.ok) {
      result.hadStructuredOutputFailure = true;
      result.degradedReasons.push(dimResult.degradedReason);
      return;
    }

    result.hasSuccessfulReviewerOutput = true;
    result.dimensionResults.push({
      dimension: dimResult.dimension,
      selectedPaths: dimResult.selectedPaths
    });

    for (const finding of dimResult.output.findings || []) {
      result.findings.push({
        ...finding,
        category: finding.category || dimResult.dimension,
        sourceDimension: dimResult.dimension
      });
    }

    for (const suggestion of dimResult.output.actionableSuggestions || []) {
      result.actionableSuggestions.push(suggestion);
    }

    for (const risk of dimResult.output.potentialRisks || []) {
      result.potentialRisks.push(risk);
    }

    for (const testSuggestion of dimResult.output.testSuggestions || []) {
      result.testSuggestions.push(testSuggestion);
    }

    for (const fc of dimResult.output.fileConclusions || []) {
      result.fileConclusions.push({
        path: fc.path,
        conclusion: fc.conclusion,
        risks: fc.risks || [],
        testSuggestions: fc.testSuggestions || [],
        note: fc.note || ''
      });
    }

    for (const p of dimResult.selectedPaths) {
      result.coveredPaths.push(p);
    }
  }

  // Phase 1: run general dimension first (if present) to get extra dimension recommendations
  const hasGeneral = executionDimensions[0] === 'general';
  let parallelDimensions = executionDimensions;

  if (hasGeneral) {
    const generalResult = await runDimension({
      dimension: 'general',
      round,
      batchIndex,
      batchCount,
      batchFiles,
      reviewerAgents,
      config,
      projectGuidance
    });
    collectDimensionResult(generalResult);

    // Check for recommended extra dimensions from general
    if (generalResult?.ok) {
      const recommended = normalizeDimensionNames(generalResult.output.recommendedExtraDimensions || [])
        .filter((x) => x !== 'general')
        .filter((x) => config.reviewDimensions.includes(x));
      const appendable = recommended.filter((x) => !executionDimensions.includes(x));
      const recommendationReason = String(generalResult.output.recommendationReason || '').trim();

      if (appendable.length > 0) {
        executionDimensions.push(...appendable);
        core.info(
          `${tag}: general requested extra dimensions=${appendable.join(', ')}${recommendationReason ? ` reason=${recommendationReason}` : ''}`
        );
      } else if (recommendationReason) {
        core.info(`${tag}: general recommendation note=${recommendationReason}`);
      }
    }

    // Remaining dimensions (everything except general)
    parallelDimensions = executionDimensions.filter((d) => d !== 'general');
  }

  // Phase 2: run remaining dimensions in parallel via semaphore
  if (parallelDimensions.length > 0) {
    const dimPromises = parallelDimensions.map((dimension) =>
      semaphore.run(() => runDimension({
        dimension,
        round,
        batchIndex,
        batchCount,
        batchFiles,
        reviewerAgents,
        config,
        projectGuidance
      }))
    );

    const dimSettled = await Promise.allSettled(dimPromises);
    for (let i = 0; i < dimSettled.length; i += 1) {
      const outcome = dimSettled[i];
      if (outcome.status === 'rejected') {
        core.warning(`${tag} SubAgent(${parallelDimensions[i]}) unexpected error: ${getErrorMessage(outcome.reason)}`);
        result.subAgentRuns += 1;
        continue;
      }
      collectDimensionResult(outcome.value);
    }
  }

  if (!result.hasSuccessfulReviewerOutput && result.executed) {
    core.warning(`${tag}: no successful sub-agent outputs.`);
  }

  return result;
}

async function listPullFiles(octokit, owner, repo, pullNumber) {
  return octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100
  });
}

async function runAction() {
  const config = loadConfig();
  const text = getTextBundle(config.reviewLanguage);
  const context = github.context;

  if (context.eventName !== 'pull_request') {
    throw new Error(`Unsupported event: ${context.eventName}. This action only supports pull_request.`);
  }

  const pr = context.payload.pull_request;
  if (!pr) {
    throw new Error('Missing pull_request payload context.');
  }

  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const pullNumber = pr.number;
  const headSha = pr.head.sha;

  const octokit = github.getOctokit(config.githubToken);
  const projectGuidance = await loadProjectGuidance(octokit, {
    owner,
    repo,
    ref: headSha
  });

  if (projectGuidance.found) {
    core.info(`Loaded repository guidance from ${projectGuidance.path}.`);
  } else if (projectGuidance.error) {
    core.warning(`Failed to load repository guidance file: ${projectGuidance.error}`);
  } else {
    core.info('No repository guidance file found (AGENTS.md / AGENT.md / CLAUDE.md).');
  }

  core.info(`Loading PR files for ${owner}/${repo}#${pullNumber}`);
  const allFiles = await listPullFiles(octokit, owner, repo, pullNumber);
  core.info(`PR has ${allFiles.length} changed files before include/exclude filtering.`);

  const filteredFiles = filterFiles(allFiles, config.include, config.exclude);
  core.info(`Filtered target file count: ${filteredFiles.length}`);

  const targetPaths = filteredFiles.map((f) => f.filename);
  const targetPathSet = new Set(targetPaths);
  const coverageState = new Map();
  for (const file of filteredFiles) {
    coverageState.set(file.filename, { status: 'pending', reason: '' });
  }

  const patchFiles = filteredFiles.filter((file) => typeof file.patch === 'string' && file.patch.length > 0);
  const noPatchFiles = filteredFiles.filter((file) => !file.patch);

  for (const file of noPatchFiles) {
    coverageState.set(file.filename, {
      status: 'covered_no_patch',
      reason: 'patch_unavailable_or_binary'
    });
  }

  const fileConclusionsByPath = new Map();
  for (const file of noPatchFiles) {
    fileConclusionsByPath.set(file.filename, {
      path: file.filename,
      conclusion: text.lowRiskDefault,
      risks: [text.lowRiskHint],
      testSuggestions: [text.lowRiskTestHint],
      note: text.cannotInlineWithoutPatch
    });
  }

  let degradedSummaryOnly = false;
  let hadStructuredOutputFailure = false;
  let hasSuccessfulReviewerOutput = false;
  const degradedReasons = [];

  const rawFindings = [];
  const actionableSuggestionsSet = new Set();
  const potentialRisksSet = new Set();
  const testSuggestionsSet = new Set();

  let modelCalls = 0;
  let roundsUsed = 0;
  let plannerStoppedEarly = false;
  let plannerCalls = 0;
  let reviewerCalls = 0;
  let plannedBatchCount = 0;
  let executedBatchCount = 0;
  let subAgentRuns = 0;

  if (patchFiles.length > 0) {
    const provider = createProvider({
      provider: config.aiProvider,
      apiKey: config.apiKey,
      baseURL: config.apiBase || undefined
    });
    const plannerModelInstance = createModel(provider, config.plannerModel);
    const reviewerModelInstance = config.reviewerModel !== config.plannerModel
      ? createModel(provider, config.reviewerModel)
      : plannerModelInstance;
    configureRuntime({ model: plannerModelInstance });
    core.info(`AI provider: ${config.aiProvider}`);

    const planner = createPlannerAgent({
      model: config.plannerModel,
      projectGuidance
    });
    const reviewerAgents = {};
    for (const dimension of config.reviewDimensions) {
      reviewerAgents[dimension] = createReviewerAgent({
        dimension,
        model: config.reviewerModel,
        modelInstance: reviewerModelInstance,
        language: config.reviewLanguage,
        projectGuidance
      });
    }
    const primaryDimension = config.reviewDimensions.includes('general')
      ? 'general'
      : config.reviewDimensions[0];

    for (let round = 1; round <= config.maxRounds; round += 1) {
      const pendingPatchFiles = patchFiles.filter((file) => coverageState.get(file.filename)?.status === 'pending');
      if (pendingPatchFiles.length === 0) {
        break;
      }

      if (modelCalls >= config.maxModelCalls) {
        break;
      }

      roundsUsed = round;
      core.info(`Round ${round}: pending patch files=${pendingPatchFiles.length}`);

      const pendingSet = new Set(pendingPatchFiles.map((f) => f.filename));
      const plannerInput = buildPlannerInput({
        round,
        maxRounds: config.maxRounds,
        budgetRemaining: config.maxModelCalls - modelCalls,
        maxFilesPerBatch: config.maxFilesPerBatch,
        pendingFiles: pendingPatchFiles
      });

      const plannerResult = await runStructuredWithRepair(planner, plannerInput, {
        allowRepair: true,
        maxTurns: 8
      });
      modelCalls += plannerResult.calls;
      plannerCalls += plannerResult.calls;

      let plannedBatches = [];
      let plannerRequestedStop = false;
      if (!plannerResult.ok) {
        const plannerErrorMessage = getErrorMessage(plannerResult.error);
        hadStructuredOutputFailure = true;
        addPublicDegradedReason(
          degradedReasons,
          `planner_structured_output_failed_round_${round}`,
          plannerErrorMessage
        );
        core.warning(`Round ${round}: planner failed structured output. ${plannerErrorMessage}`);
      } else {
        plannedBatches = sanitizePlannedBatches(
          plannerResult.output.batches,
          pendingSet,
          config.maxFilesPerBatch
        );
        plannerRequestedStop = Boolean(plannerResult.output.done);
        const plannerNotes = String(plannerResult.output.notes || '').trim();
        core.info(
          `Round ${round}: planner done=${plannerRequestedStop} calls_used=${plannerResult.calls} batches=${plannedBatches.length}`
        );
        if (plannerNotes) {
          core.info(`Round ${round}: planner notes=${plannerNotes}`);
        }
        core.info(`Round ${round}: planner batch plan => ${summarizePlannerBatchesForLog(plannedBatches)}`);
      }

      if (plannerRequestedStop && plannedBatches.length === 0) {
        plannerStoppedEarly = true;
        core.info(`Planner signaled done at round ${round}; stopping with ${pendingPatchFiles.length} pending patch files.`);
        break;
      }

      if (plannedBatches.length === 0) {
        const fallbackBatches = chunk(pendingPatchFiles, config.maxFilesPerBatch).map((batchFiles) => ({
          focus: 'general',
          reason: 'fallback_chunking',
          filePaths: batchFiles.map((f) => f.filename)
        }));
        plannedBatches = fallbackBatches;
        core.warning(`Round ${round}: planner returned no valid batches, using fallback chunking (${plannedBatches.length} batches).`);
      }
      plannedBatchCount += plannedBatches.length;

      const pendingFileByPath = new Map(pendingPatchFiles.map((file) => [file.filename, file]));
      const remainingCallBudget = config.maxModelCalls - modelCalls;
      const callsIfAllDimensions = plannedBatches.length * config.reviewDimensions.length;
      const callsIfPrimaryOnly = plannedBatches.length;
      const forcePrimaryOnly = config.coverageFirstRoundPrimaryOnly
        && round === 1
        && config.reviewDimensions.length > 1;
      const budgetPrimaryOnly = !forcePrimaryOnly
        && config.reviewDimensions.length > 1
        && remainingCallBudget < callsIfAllDimensions
        && remainingCallBudget >= callsIfPrimaryOnly;
      const roundDimensions = (forcePrimaryOnly || budgetPrimaryOnly)
        ? [primaryDimension]
        : config.reviewDimensions;

      if (roundDimensions.length === 1 && config.reviewDimensions.length > 1) {
        core.info(
          `Round ${round}: using coverage-first mode with primary dimension "${roundDimensions[0]}".`
        );
      }
      core.info(`Round ${round}: scheduled dimensions=${roundDimensions.join(', ')}`);

      let roundProgress = false;

      // --- Parallel batch execution ---
      const semaphore = createSemaphore(config.maxConcurrency);
      const batchCount = plannedBatches.length;

      // Pre-allocate budget: each batch gets at most roundDimensions.length calls
      const estimatedCallsPerBatch = roundDimensions.length;
      let budgetAllowedBatches = batchCount;
      if (estimatedCallsPerBatch > 0) {
        const budgetRemaining = config.maxModelCalls - modelCalls;
        budgetAllowedBatches = Math.min(batchCount, Math.floor(budgetRemaining / estimatedCallsPerBatch));
      }

      if (budgetAllowedBatches <= 0) {
        core.info(`Round ${round}: insufficient budget for any batch (remaining=${config.maxModelCalls - modelCalls}), skipping.`);
        break;
      }

      const batchesToRun = plannedBatches.slice(0, budgetAllowedBatches);
      if (batchesToRun.length < batchCount) {
        core.info(
          `Round ${round}: budget limits parallel batches to ${batchesToRun.length}/${batchCount}`
        );
      }

      const batchPromises = batchesToRun.map((batch, batchIndex) =>
        semaphore.run(() => executeBatch({
          batch,
          batchIndex,
          batchCount,
          round,
          roundDimensions,
          pendingFileByPath,
          reviewerAgents,
          config,
          projectGuidance,
          semaphore
        }))
      );

      const batchSettled = await Promise.allSettled(batchPromises);

      // --- Merge batch results into global state ---
      for (let i = 0; i < batchSettled.length; i += 1) {
        const outcome = batchSettled[i];
        if (outcome.status === 'rejected') {
          core.warning(`Round ${round} Batch ${i + 1}: unexpected error: ${getErrorMessage(outcome.reason)}`);
          continue;
        }

        const result = outcome.value;
        modelCalls += result.calls;
        reviewerCalls += result.reviewerCalls;
        subAgentRuns += result.subAgentRuns;

        if (result.executed) {
          executedBatchCount += 1;
        }

        if (result.hadStructuredOutputFailure) {
          hadStructuredOutputFailure = true;
        }
        if (result.hasSuccessfulReviewerOutput) {
          hasSuccessfulReviewerOutput = true;
        }

        for (const reason of result.degradedReasons) {
          degradedReasons.push(reason);
        }

        for (const finding of result.findings) {
          rawFindings.push(finding);
        }

        for (const suggestion of result.actionableSuggestions) {
          actionableSuggestionsSet.add(suggestion);
        }

        for (const risk of result.potentialRisks) {
          potentialRisksSet.add(risk);
        }

        for (const testSuggestion of result.testSuggestions) {
          testSuggestionsSet.add(testSuggestion);
        }

        for (const fc of result.fileConclusions) {
          if (targetPathSet.has(fc.path)) {
            fileConclusionsByPath.set(fc.path, fc);
          }
        }

        for (const coveredPath of result.coveredPaths) {
          if (coverageState.get(coveredPath)?.status === 'pending') {
            coverageState.set(coveredPath, {
              status: 'covered',
              reason: `reviewed_round_${round}`
            });
            roundProgress = true;
          }
        }

        if (result.dimensionResults.length > 0) {
          core.info(
            `Round ${round} [B${i + 1}/${batchCount}]: merged_dimensions=${result.dimensionResults.length} batch_calls=${result.calls}`
          );
        }
      }

      core.info(
        `Round ${round}: all batches settled. total_model_calls=${modelCalls}/${config.maxModelCalls}`
      );

      if (plannerRequestedStop) {
        plannerStoppedEarly = true;
        core.info(`Planner requested stop after round ${round}.`);
        break;
      }

      if (!roundProgress) {
        break;
      }
    }
  }

  degradedSummaryOnly = shouldUseSummaryOnlyMode({
    hadStructuredOutputFailure,
    hasSuccessfulReviewerOutput
  });

  const normalizedFindings = dedupeAndSortFindings(
    normalizeFindings(rawFindings, targetPaths, {
      minConfidence: config.minFindingConfidence,
      missingConfidencePolicy: config.missingConfidencePolicy,
      fallbackConfidenceValue: config.fallbackConfidenceValue
    }),
    config.maxFindings
  );
  const unknownConfidenceFindings = normalizedFindings.filter((finding) => !Number.isFinite(finding.confidence)).length;

  const diffLineMap = buildDiffLineMaps(patchFiles);
  const inlineComments = [];
  const downgradedInline = [];

  if (!degradedSummaryOnly) {
    for (const finding of normalizedFindings) {
      if (inlineComments.length >= config.maxInlineComments) {
        downgradedInline.push({
          path: finding.path,
          title: finding.title,
          reason: 'max_inline_comments_cap_reached'
        });
        continue;
      }

      if (finding.side === 'FILE') {
        downgradedInline.push({
          path: finding.path,
          title: finding.title,
          reason: 'file_level_finding'
        });
        continue;
      }

      const location = resolveInlineLocation(finding, diffLineMap);
      if (!location.ok) {
        downgradedInline.push({
          path: finding.path,
          title: finding.title,
          reason: location.reason
        });
        continue;
      }

      inlineComments.push({
        path: location.path,
        side: location.side,
        line: location.line,
        body: buildInlineBody(finding, text)
      });
    }

    if (inlineComments.length === 0 && patchFiles.length > 0) {
      let synthetic = null;
      for (const file of patchFiles) {
        const map = diffLineMap.get(file.filename);
        if (!map) {
          continue;
        }

        const rightLines = [...map.right].sort((a, b) => a - b);
        if (rightLines.length > 0) {
          synthetic = {
            path: file.filename,
            side: 'RIGHT',
            line: rightLines[0]
          };
          break;
        }

        const leftLines = [...map.left].sort((a, b) => a - b);
        if (leftLines.length > 0) {
          synthetic = {
            path: file.filename,
            side: 'LEFT',
            line: leftLines[0]
          };
          break;
        }
      }

      if (synthetic) {
        inlineComments.push({
          ...synthetic,
          body: text.syntheticInline
        });
      }
    }
  }

  const uncovered = [];
  const noPatchCovered = [];

  for (const file of filteredFiles) {
    const state = coverageState.get(file.filename);
    if (!state || state.status === 'pending') {
      let reason = 'coverage_incomplete';
      if (modelCalls >= config.maxModelCalls) {
        reason = 'budget_exhausted_before_coverage';
      } else if (roundsUsed >= config.maxRounds) {
        reason = 'max_rounds_reached_before_coverage';
      } else if (plannerStoppedEarly) {
        reason = 'planner_signaled_done_before_coverage';
      }
      uncovered.push({ path: file.filename, reason });
      if (!fileConclusionsByPath.has(file.filename)) {
        fileConclusionsByPath.set(file.filename, {
          path: file.filename,
          conclusion: text.uncoveredConclusion,
          risks: [text.uncoveredRisk],
          testSuggestions: [text.uncoveredTest],
          note: reason
        });
      }
      continue;
    }

    if (state.status === 'covered_no_patch') {
      noPatchCovered.push({ path: file.filename, reason: state.reason });
    }
  }

  const coverage = {
    target: filteredFiles.length,
    covered: filteredFiles.length - uncovered.length,
    uncovered: uncovered.length,
    noPatch: noPatchCovered.length,
    unknownConfidenceFindings
  };

  if (filteredFiles.length === 0) {
    core.info('No files matched include/exclude filters; publishing minimal summary.');
  }

  const buildSummaryMarkdown = () => formatSummaryMarkdown({
    pull: pr,
    reviewLanguage: config.reviewLanguage,
    findings: normalizedFindings,
    fileConclusions: [...fileConclusionsByPath.values()],
    actionableSuggestions: uniqueItems([...actionableSuggestionsSet]),
    potentialRisks: uniqueItems([...potentialRisksSet]),
    testSuggestions: uniqueItems([...testSuggestionsSet]),
    downgradedInline,
    uncovered,
    noPatchCovered,
    coverage,
    runtime: {
      roundsUsed,
      maxRounds: config.maxRounds,
      plannedBatches: plannedBatchCount,
      executedBatches: executedBatchCount,
      subAgentRuns,
      plannerCalls,
      reviewerCalls,
      modelCalls,
      maxModelCalls: config.maxModelCalls
    },
    degradedSummaryOnly,
    degradedReasons
  });

  let summaryMarkdown = buildSummaryMarkdown();
  let summaryResult = await upsertSummaryComment(octokit, {
    owner,
    repo,
    issueNumber: pullNumber,
    summaryMarker: config.summaryMarker,
    headSha,
    summaryMarkdown
  });

  core.info(
    `Summary comment result: created=${summaryResult.created} updated=${summaryResult.updated} skipped=${summaryResult.skipped}`
  );

  if (!degradedSummaryOnly) {
    const reviewBody = buildReviewBody({
      text,
      findingsKept: normalizedFindings.length,
      unknownConfidenceFindings,
      inlineCommentsAttempted: inlineComments.length,
      coverage
    });

    const reviewResult = await createReview(octokit, {
      owner,
      repo,
      pullNumber,
      reviewMarker: config.reviewMarker,
      headSha,
      digest: summaryResult.digest,
      reviewBody,
      inlineComments,
      autoMinimizeOutdatedComments: config.autoMinimizeOutdatedComments
    });

    core.info(
      `Review result: created=${reviewResult.created} skipped=${reviewResult.skipped} inlineCount=${reviewResult.inlineCount} downgradedInline=${reviewResult.downgradedInline} minimized_outdated=${reviewResult.minimizeResult?.minimized || 0}/${reviewResult.minimizeResult?.attempted || 0} minimize_failed=${reviewResult.minimizeResult?.failed || 0}`
    );

    if (reviewResult.downgradedInline) {
      addPublicDegradedReason(
        degradedReasons,
        'inline_rejected_by_github_api',
        reviewResult.reason || 'inline_rejected_by_github_api'
      );

      const updatedSummaryMarkdown = buildSummaryMarkdown();
      if (updatedSummaryMarkdown !== summaryMarkdown) {
        summaryMarkdown = updatedSummaryMarkdown;
        summaryResult = await upsertSummaryComment(octokit, {
          owner,
          repo,
          issueNumber: pullNumber,
          summaryMarker: config.summaryMarker,
          headSha,
          summaryMarkdown
        });

        core.info(
          `Summary comment refreshed after inline downgrade: created=${summaryResult.created} updated=${summaryResult.updated} skipped=${summaryResult.skipped}`
        );
      }
    }
  } else {
    core.warning('Structured output degradation active: skipped PR review creation and posted summary only.');
  }

  core.setOutput('covered_files', String(coverage.covered));
  core.setOutput('target_files', String(coverage.target));
  core.setOutput('uncovered_files', String(coverage.uncovered));
  core.setOutput('degraded', degradedSummaryOnly ? 'true' : 'false');

  if (coverage.uncovered > 0) {
    core.warning(`Coverage incomplete: ${coverage.uncovered} file(s) not fully covered within budget.`);
  }
}

if (require.main === module) {
  runAction().catch((error) => {
    core.setFailed(error.message || String(error));
  });
}

module.exports = {
  runAction,
  __internal: {
    getTextBundle,
    uniqueItems,
    normalizeDimensionNames,
    chunk,
    addPublicDegradedReason,
    getErrorMessage,
    createSemaphore,
    shouldUseSummaryOnlyMode,
    sanitizePlannedBatches,
    summarizePlannerBatchesForLog,
    formatConfidenceValue,
    buildInlineBody,
    buildReviewBody,
    summarizeSeverity,
    summarizeFileConclusions,
    formatSummaryMarkdown
  }
};
