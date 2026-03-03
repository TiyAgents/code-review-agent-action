const { minimatch } = require('minimatch');

function matchesAny(path, patterns) {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  return patterns.some((pattern) => minimatch(path, pattern, { dot: true, nocase: false }));
}

function filterFiles(files, includePatterns, excludePatterns) {
  const fileList = Array.isArray(files) ? files : [];
  const includes = Array.isArray(includePatterns) ? includePatterns.filter(Boolean) : [];
  const excludes = Array.isArray(excludePatterns) ? excludePatterns.filter(Boolean) : [];

  return fileList.filter((file) => {
    const included = includes.length === 0 ? true : matchesAny(file.filename, includes);
    const excluded = matchesAny(file.filename, excludes);
    return included && !excluded;
  });
}

module.exports = {
  filterFiles
};
