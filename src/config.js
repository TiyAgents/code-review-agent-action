const core = require('@actions/core');

const DEFAULT_SUMMARY_MARKER = 'ai-code-review-agent:summary';
const DEFAULT_REVIEW_MARKER = 'ai-code-review-agent:review';

function splitListInput(value) {
  return (value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveIntInput(name, defaultValue) {
  const raw = core.getInput(name) || String(defaultValue);
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Input ${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

function loadConfig() {
  const githubToken = core.getInput('github_token', { required: true });
  const openaiApiKey = core.getInput('openai_api_key') || process.env.OPENAI_API_KEY;
  const openaiApiBase = core.getInput('openai_api_base') || process.env.OPENAI_API_BASE || '';

  if (!openaiApiKey) {
    throw new Error('Missing OpenAI API key. Provide input openai_api_key or OPENAI_API_KEY env.');
  }

  const include = splitListInput(core.getInput('include') || '**');
  const exclude = splitListInput(core.getInput('exclude'));

  const reviewDimensions = splitListInput(core.getInput('review_dimensions') || 'general,security,performance,testing');
  const normalizedDimensions = reviewDimensions.length
    ? reviewDimensions.map((d) => d.toLowerCase())
    : ['general', 'security', 'performance', 'testing'];
  const reviewLanguage = core.getInput('review_language') || 'English';

  return {
    githubToken,
    openaiApiKey,
    openaiApiBase,
    include,
    exclude,
    plannerModel: core.getInput('planner_model') || 'gpt-5.3-codex',
    reviewerModel: core.getInput('reviewer_model') || 'gpt-5.3-codex',
    reviewDimensions: normalizedDimensions,
    reviewLanguage,
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
