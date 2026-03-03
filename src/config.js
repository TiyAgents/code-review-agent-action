const core = require('@actions/core');

const DEFAULT_SUMMARY_MARKER = 'ai-code-review-agent:summary';
const DEFAULT_REVIEW_MARKER = 'ai-code-review-agent:review';

function splitListInput(value) {
  return (value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase();
}

function validateOpenAIBaseURL(openaiApiBase, allowedHosts) {
  const raw = String(openaiApiBase || '').trim();
  if (!raw) {
    return '';
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Input openai_api_base must be a valid URL, got: ${raw}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Input openai_api_base must use https scheme, got: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Input openai_api_base must not contain username/password credentials.');
  }

  const host = normalizeHost(parsed.hostname);
  const allow = new Set((allowedHosts || []).map(normalizeHost).filter(Boolean));
  if (!allow.has(host)) {
    throw new Error(
      `Input openai_api_base host is not in allowlist: ${host}. ` +
      'Set openai_api_base_allowlist to explicitly trust this host.'
    );
  }

  return raw;
}

function parsePositiveIntInput(name, defaultValue) {
  const raw = core.getInput(name) || String(defaultValue);
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Input ${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

function parseBooleanInput(name, defaultValue) {
  const raw = String(core.getInput(name) || defaultValue).trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') {
    return true;
  }
  if (raw === 'false' || raw === '0' || raw === 'no') {
    return false;
  }
  throw new Error(`Input ${name} must be boolean-like (true/false), got: ${raw}`);
}

function parseFloatRangeInput(name, defaultValue, min, max) {
  const raw = core.getInput(name) || String(defaultValue);
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Input ${name} must be a number in [${min}, ${max}], got: ${raw}`);
  }
  return parsed;
}

function uniqueLowercase(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const normalized = String(item || '').trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function loadConfig() {
  const githubToken = core.getInput('github_token', { required: true });
  const openaiApiKey = core.getInput('openai_api_key') || process.env.OPENAI_API_KEY;
  const openaiApiBaseRaw = core.getInput('openai_api_base') || process.env.OPENAI_API_BASE || '';
  const openaiApiBaseAllowlist = splitListInput(
    core.getInput('openai_api_base_allowlist') || process.env.OPENAI_API_BASE_ALLOWLIST || 'api.openai.com'
  );
  const openaiApiBase = validateOpenAIBaseURL(openaiApiBaseRaw, openaiApiBaseAllowlist);

  if (!openaiApiKey) {
    throw new Error('Missing OpenAI API key. Provide input openai_api_key or OPENAI_API_KEY env.');
  }

  const include = splitListInput(core.getInput('include') || '**');
  const exclude = splitListInput(core.getInput('exclude'));

  const reviewDimensions = splitListInput(core.getInput('review_dimensions') || 'general,security,performance,testing');
  const normalizedDimensions = reviewDimensions.length
    ? uniqueLowercase(reviewDimensions)
    : ['general', 'security', 'performance', 'testing'];
  const reviewLanguage = core.getInput('review_language') || 'English';

  return {
    githubToken,
    openaiApiKey,
    openaiApiBase,
    openaiApiBaseAllowlist,
    include,
    exclude,
    plannerModel: core.getInput('planner_model') || 'gpt-5.3-codex',
    reviewerModel: core.getInput('reviewer_model') || 'gpt-5.3-codex',
    reviewDimensions: normalizedDimensions,
    reviewLanguage,
    minFindingConfidence: parseFloatRangeInput('min_finding_confidence', 0.72, 0, 1),
    coverageFirstRoundPrimaryOnly: parseBooleanInput('coverage_first_round_primary_only', true),
    autoMinimizeOutdatedComments: parseBooleanInput('auto_minimize_outdated_comments', true),
    maxRounds: parsePositiveIntInput('max_rounds', 8),
    maxModelCalls: parsePositiveIntInput('max_model_calls', 40),
    maxFilesPerBatch: parsePositiveIntInput('max_files_per_batch', 8),
    maxContextChars: parsePositiveIntInput('max_context_chars', 128000),
    maxFindings: parsePositiveIntInput('max_findings', 60),
    maxInlineComments: parsePositiveIntInput('max_inline_comments', 30),
    summaryMarker: DEFAULT_SUMMARY_MARKER,
    reviewMarker: DEFAULT_REVIEW_MARKER
  };
}

module.exports = {
  loadConfig,
  DEFAULT_SUMMARY_MARKER,
  DEFAULT_REVIEW_MARKER
};
