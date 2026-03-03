const SEVERITY_RANK = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeSeverity(value) {
  const s = String(value || '').toLowerCase();
  if (SEVERITY_RANK[s]) {
    return s;
  }
  return 'medium';
}

function normalizeSide(value) {
  const s = String(value || '').toUpperCase();
  if (s === 'LEFT' || s === 'RIGHT' || s === 'FILE') {
    return s;
  }
  return 'RIGHT';
}

function normalizeFingerprint(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeEvidence(value) {
  const raw = Array.isArray(value) ? value : [];
  return [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 3);
}

function normalizeTextForSimilarity(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccardSimilarity(a, b) {
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  if (a.includes(b) || b.includes(a)) {
    return 0.9;
  }

  const as = new Set(a.split(' '));
  const bs = new Set(b.split(' '));
  const union = new Set([...as, ...bs]);
  let intersection = 0;
  for (const token of as) {
    if (bs.has(token)) {
      intersection += 1;
    }
  }
  return union.size === 0 ? 0 : intersection / union.size;
}

function isSemanticallySameIssue(a, b) {
  if (
    a.fingerprint &&
    b.fingerprint &&
    a.fingerprint === b.fingerprint &&
    a.path === b.path &&
    a.side === b.side &&
    (a.line || 0) === (b.line || 0)
  ) {
    return true;
  }

  if (a.path !== b.path || a.side !== b.side || (a.line || 0) !== (b.line || 0)) {
    return false;
  }
  if (a.severity !== b.severity) {
    return false;
  }

  const titleSim = jaccardSimilarity(
    normalizeTextForSimilarity(a.title),
    normalizeTextForSimilarity(b.title)
  );
  const summarySim = jaccardSimilarity(
    normalizeTextForSimilarity(a.summary),
    normalizeTextForSimilarity(b.summary)
  );

  return Math.max(titleSim, summarySim) >= 0.78 || (titleSim >= 0.65 && summarySim >= 0.65);
}

function mergeFinding(base, incoming) {
  const preferIncoming = incoming.confidence > base.confidence;
  const mergedEvidence = [...new Set([...(base.evidence || []), ...(incoming.evidence || [])])].slice(0, 3);
  const severity = SEVERITY_RANK[incoming.severity] > SEVERITY_RANK[base.severity]
    ? incoming.severity
    : base.severity;
  return {
    ...base,
    ...(preferIncoming
      ? {
          title: incoming.title,
          summary: incoming.summary,
          suggestion: incoming.suggestion || base.suggestion,
          risk: incoming.risk || base.risk
        }
      : {}),
    severity,
    confidence: Math.max(base.confidence, incoming.confidence),
    evidence: mergedEvidence,
    fingerprint: base.fingerprint || incoming.fingerprint
  };
}

function normalizeFindings(findings, allowedPaths, options = {}) {
  const pathSet = new Set(allowedPaths);
  const minConfidence = Number.isFinite(options.minConfidence) ? options.minConfidence : 0;
  const out = [];

  for (const finding of findings || []) {
    const path = finding.path;
    if (!path || !pathSet.has(path)) {
      continue;
    }

    const severity = normalizeSeverity(finding.severity);
    const side = normalizeSide(finding.side);
    const line = Number.isInteger(finding.line) && finding.line > 0 ? finding.line : null;
    const title = String(finding.title || '').trim();
    const summary = String(finding.summary || '').trim();
    const confidenceRaw = Number.parseFloat(String(finding.confidence ?? '0.8'));
    const confidence = Number.isFinite(confidenceRaw) ? clamp(confidenceRaw, 0, 1) : 0.8;
    const evidence = normalizeEvidence(finding.evidence);

    if (!title || !summary || evidence.length === 0 || confidence < minConfidence) {
      continue;
    }

    out.push({
      title,
      summary,
      suggestion: String(finding.suggestion || '').trim(),
      risk: String(finding.risk || '').trim(),
      category: String(finding.category || 'general').trim().toLowerCase(),
      severity,
      path,
      side,
      line,
      confidence,
      evidence,
      fingerprint: normalizeFingerprint(finding.fingerprint)
    });
  }

  return out;
}

function dedupeAndSortFindings(findings, maxFindings) {
  const deduped = [];
  const seen = new Set();

  for (const finding of findings) {
    let merged = false;
    for (let i = 0; i < deduped.length; i += 1) {
      if (isSemanticallySameIssue(deduped[i], finding)) {
        deduped[i] = mergeFinding(deduped[i], finding);
        merged = true;
        break;
      }
    }

    if (!merged) {
      const key = [
        finding.path,
        finding.side,
        finding.line ?? 'na',
        finding.severity,
        finding.title.toLowerCase(),
        finding.summary.toLowerCase(),
        finding.fingerprint || ''
      ].join('|');

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduped.push(finding);
    }
  }

  deduped.sort((a, b) => {
    const severityDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (severityDiff !== 0) {
      return severityDiff;
    }

    const pathDiff = a.path.localeCompare(b.path);
    if (pathDiff !== 0) {
      return pathDiff;
    }

    const confidenceDiff = (b.confidence || 0) - (a.confidence || 0);
    if (confidenceDiff !== 0) {
      return confidenceDiff;
    }

    return (a.line || 0) - (b.line || 0);
  });

  return deduped.slice(0, maxFindings);
}

function groupFindingsBySeverity(findings) {
  const groups = {
    critical: [],
    high: [],
    medium: [],
    low: []
  };

  for (const finding of findings) {
    groups[finding.severity].push(finding);
  }

  return groups;
}

module.exports = {
  normalizeFindings,
  dedupeAndSortFindings,
  groupFindingsBySeverity,
  SEVERITY_RANK
};
