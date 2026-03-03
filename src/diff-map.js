function parsePatchLines(patch) {
  const right = new Set();
  const left = new Set();

  const lines = patch.split('\n');
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of lines) {
    const line = rawLine || '';

    if (line.startsWith('@@')) {
      const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
      if (!match) {
        continue;
      }

      oldLine = Number.parseInt(match[1], 10);
      newLine = Number.parseInt(match[2], 10);
      continue;
    }

    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }

    if (line.startsWith('+')) {
      right.add(newLine);
      newLine += 1;
      continue;
    }

    if (line.startsWith('-')) {
      left.add(oldLine);
      oldLine += 1;
      continue;
    }

    if (line.startsWith(' ')) {
      left.add(oldLine);
      right.add(newLine);
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (line.startsWith('\\')) {
      continue;
    }
  }

  return { left, right };
}

function buildDiffLineMaps(files) {
  const map = new Map();

  for (const file of files) {
    if (!file.patch) {
      continue;
    }

    map.set(file.filename, parsePatchLines(file.patch));
  }

  return map;
}

function resolveInlineLocation(finding, diffMap) {
  if (!finding.path || !diffMap.has(finding.path)) {
    return { ok: false, reason: 'path_not_in_commentable_diff' };
  }

  const lineMap = diffMap.get(finding.path);
  const requestedSide = String(finding.side || 'RIGHT').toUpperCase();
  const line = Number.isInteger(finding.line) ? finding.line : null;

  if (!line || line < 1) {
    return { ok: false, reason: 'line_missing_or_invalid' };
  }

  if (requestedSide === 'RIGHT' && lineMap.right.has(line)) {
    return { ok: true, path: finding.path, side: 'RIGHT', line };
  }

  if (requestedSide === 'LEFT' && lineMap.left.has(line)) {
    return { ok: true, path: finding.path, side: 'LEFT', line };
  }

  if (lineMap.right.has(line)) {
    return { ok: true, path: finding.path, side: 'RIGHT', line };
  }

  if (lineMap.left.has(line)) {
    return { ok: true, path: finding.path, side: 'LEFT', line };
  }

  return { ok: false, reason: 'line_not_present_in_diff_hunks' };
}

module.exports = {
  buildDiffLineMaps,
  resolveInlineLocation
};
