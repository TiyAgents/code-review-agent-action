const { minimatch } = require('minimatch');

function matchesAny(path, patterns) {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  return patterns.some((pattern) => minimatch(path, pattern, { dot: true, nocase: false }));
}

function filterFiles(files, includePatterns, excludePatterns) {
  return files.filter((file) => {
    const included = includePatterns.length === 0 ? true : matchesAny(file.filename, includePatterns);
    const excluded = matchesAny(file.filename, excludePatterns);
    return included && !excluded;
  });
}

module.exports = {
  filterFiles
};
