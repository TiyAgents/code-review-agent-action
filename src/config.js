const core = require('@actions/core');
const { SUPPORTED_PROVIDERS } = require('./provider');

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

function validateBaseURL(baseURL, allowedHosts) {
  const raw = String(baseURL || '').trim();
  if (!raw) {
    return '';
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Input api_base must be a valid URL, got: ${raw}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Input api_base must use https scheme, got: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Input api_base must not contain username/password credentials.');
  }

  if (Array.isArray(allowedHosts)) {
    const allow = new Set(allowedHosts.map(normalizeHost).filter(Boolean));
    if (allow.size === 0) {
      throw new Error(
        'Input api_base is set but allowlist is empty — all hosts are blocked. ' +
        'Set api_base_allowlist (or openai_api_base_allowlist) to explicitly trust the target host.'
      );
    }
    const host = normalizeHost(parsed.hostname);
    if (!allow.has(host)) {
      throw new Error(
        `Input api_base host is not in allowlist: ${host}. ` +
        'Set openai_api_base_allowlist to explicitly trust this host.'
      );
    }
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

function parseEnumInput(name, defaultValue, allowedValues) {
  const raw = core.getInput(name) || String(defaultValue);
  const normalized = String(raw).trim().toLowerCase();
  if (!allowedValues.includes(normalized)) {
    throw new Error(`Input ${name} must be one of [${allowedValues.join(', ')}], got: ${raw}`);
  }
  return normalized;
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

  // Provider configuration with backward compatibility
  const aiProvider = parseEnumInput('ai_provider', 'openai', SUPPORTED_PROVIDERS);
  const apiKey = core.getInput('api_key')
    || core.getInput('openai_api_key')
    || process.env.OPENAI_API_KEY
    || '';
  const apiBaseRaw = core.getInput('api_base')
    || core.getInput('openai_api_base')
    || process.env.OPENAI_API_BASE
    || '';
  const apiBaseAllowlist = splitListInput(
    core.getInput('api_base_allowlist')
    || core.getInput('openai_api_base_allowlist')
    || process.env.OPENAI_API_BASE_ALLOWLIST
    || 'api.openai.com'
  );
  const apiBase = validateBaseURL(apiBaseRaw, apiBaseAllowlist);

  if (!apiKey) {
    throw new Error(
      'Missing API key. Provide input api_key (or openai_api_key for backward compatibility) or set OPENAI_API_KEY env.'
    );
  }

  // Warn about deprecated llm_compatibility_mode
  const llmCompatRaw = core.getInput('llm_compatibility_mode') || '';
  if (llmCompatRaw && llmCompatRaw.trim().toLowerCase() !== 'auto') {
    core.warning(
      'Input llm_compatibility_mode is deprecated and will be ignored. ' +
      'AI SDK handles provider compatibility automatically.'
    );
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
    aiProvider,
    apiKey,
    apiBase,
    openaiApiBaseAllowlist: apiBaseAllowlist,
    apiBaseAllowlist,
    include,
    exclude,
    plannerModel: core.getInput('planner_model') || 'gpt-5.3-codex',
    reviewerModel: core.getInput('reviewer_model') || 'gpt-5.3-codex',
    reviewDimensions: normalizedDimensions,
    reviewLanguage,
    minFindingConfidence: parseFloatRangeInput('min_finding_confidence', 0.72, 0, 1),
    missingConfidencePolicy: parseEnumInput('missing_confidence_policy', 'na', ['drop', 'na', 'fallback']),
    fallbackConfidenceValue: parseFloatRangeInput('fallback_confidence_value', 0.5, 0, 1),
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
