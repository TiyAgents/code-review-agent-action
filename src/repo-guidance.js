const PROJECT_GUIDANCE_FILES = ['AGENTS.md', 'AGENT.md', 'CLAUDE.md'];
const DEFAULT_MAX_GUIDANCE_CHARS = 12000;

function normalizeGuidanceContent(content, maxChars = DEFAULT_MAX_GUIDANCE_CHARS) {
  const clean = String(content || '').trim();
  if (!clean) {
    return {
      content: '',
      truncated: false
    };
  }

  if (clean.length <= maxChars) {
    return {
      content: clean,
      truncated: false
    };
  }

  const suffix = '\n\n...[truncated for prompt budget]';
  const headLength = Math.max(0, maxChars - suffix.length);
  return {
    content: `${clean.slice(0, headLength)}${suffix}`,
    truncated: true
  };
}

async function loadProjectGuidance(octokit, {
  owner,
  repo,
  ref,
  candidatePaths = PROJECT_GUIDANCE_FILES,
  maxChars = DEFAULT_MAX_GUIDANCE_CHARS
}) {
  for (const path of candidatePaths) {
    try {
      const response = await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref
      });

      const data = response.data;
      if (!data || Array.isArray(data) || data.type !== 'file' || !data.content) {
        continue;
      }

      const decoded = Buffer.from(String(data.content), 'base64').toString('utf8');
      const normalized = normalizeGuidanceContent(decoded, maxChars);

      if (!normalized.content) {
        continue;
      }

      return {
        found: true,
        path,
        content: normalized.content,
        truncated: normalized.truncated
      };
    } catch (error) {
      if (error && error.status === 404) {
        continue;
      }

      return {
        found: false,
        path: null,
        content: '',
        truncated: false,
        error: error.message || String(error)
      };
    }
  }

  return {
    found: false,
    path: null,
    content: '',
    truncated: false
  };
}

module.exports = {
  PROJECT_GUIDANCE_FILES,
  DEFAULT_MAX_GUIDANCE_CHARS,
  normalizeGuidanceContent,
  loadProjectGuidance
};
