const crypto = require('node:crypto');

function normalizeInlineKey(raw, options = {}) {
  const maxLength = Number.parseInt(String(options.maxLength || 120), 10) || 120;
  const source = String(raw || '').trim();
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (normalized) {
    return normalized.slice(0, maxLength);
  }

  const fallbackSeed = String(options.fallbackSeed || source || 'issue');
  const digest = crypto.createHash('sha1').update(fallbackSeed).digest('hex').slice(0, 16);
  return `issue_${digest}`.slice(0, maxLength);
}

function inlineKeyFromFinding(finding) {
  const fingerprint = String(finding?.fingerprint || '').trim();
  if (fingerprint) {
    return normalizeInlineKey(fingerprint, { maxLength: 80, fallbackSeed: fingerprint });
  }

  const title = String(finding?.title || '').trim();
  const stableSeed = [
    title,
    String(finding?.path || ''),
    String(finding?.side || ''),
    String(finding?.line ?? '')
  ].join('|');
  return normalizeInlineKey(title, { maxLength: 80, fallbackSeed: stableSeed || 'issue' });
}

module.exports = {
  normalizeInlineKey,
  inlineKeyFromFinding
};
