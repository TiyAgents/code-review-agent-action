const SEVERITY_RANK = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

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

function normalizeFindings(findings, allowedPaths) {
  const pathSet = new Set(allowedPaths);
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

    if (!title || !summary) {
      continue;
    }

    out.push({
      title,
      summary,
      suggestion: String(finding.suggestion || '').trim(),
      risk: String(finding.risk || '').trim(),
      category: String(finding.category || 'general').toLowerCase(),
      severity,
      path,
      side,
      line
    });
  }

  return out;
}

function dedupeAndSortFindings(findings, maxFindings) {
  const deduped = [];
  const seen = new Set();

  for (const finding of findings) {
    const key = [
      finding.path,
      finding.side,
      finding.line ?? 'na',
      finding.severity,
      finding.title.toLowerCase(),
      finding.summary.toLowerCase()
    ].join('|');

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(finding);
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
