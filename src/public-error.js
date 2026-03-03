function sanitizePublicErrorDetail(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return 'unknown_error';
  }

  // Remove common secret-like tokens and endpoints before exposing to PR comments.
  let out = raw
    .replace(/https?:\/\/[^\s)]+/gi, '<redacted-url>')
    .replace(/\b(?:localhost|127(?:\.\d{1,3}){3}|::1)\b/gi, '<redacted-host>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<redacted-ip>')
    .replace(/\bauthorization\s*[:=]\s*(?:bearer|token)\s+[^\s,;]+/gi, 'authorization=<redacted>')
    .replace(/\bauthorization\s*[:=]\s*[^\s,;]+/gi, 'authorization=<redacted>')
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr)[_-][A-Za-z0-9_-]{10,}\b/g, '<redacted-token>')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '<redacted-token>')
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '<redacted-token>')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '<redacted-token>')
    .replace(/\b(api[-_]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>');

  if (out.length > 240) {
    out = `${out.slice(0, 240)}...`;
  }

  return out;
}

module.exports = {
  sanitizePublicErrorDetail
};
