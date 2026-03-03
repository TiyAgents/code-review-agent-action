const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadConfigWithMockedInputs(inputs, env = {}) {
  const originalLoad = Module._load;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalApiBase = process.env.OPENAI_API_BASE;

  process.env.OPENAI_API_KEY = env.OPENAI_API_KEY || '';
  process.env.OPENAI_API_BASE = env.OPENAI_API_BASE || '';

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@actions/core') {
      return {
        getInput(name, options = {}) {
          const value = Object.prototype.hasOwnProperty.call(inputs, name) ? inputs[name] : '';
          if (options.required && !value) {
            throw new Error(`Input required and not supplied: ${name}`);
          }
          return value;
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve('../src/config')];
    const { loadConfig } = require('../src/config');
    return loadConfig();
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/config')];
    process.env.OPENAI_API_KEY = originalApiKey;
    process.env.OPENAI_API_BASE = originalApiBase;
  }
}

test('loadConfig applies defaults for confidence and coverage-first mode', () => {
  const config = loadConfigWithMockedInputs({
    github_token: 'ghs_xxx',
    openai_api_key: 'sk-test'
  });

  assert.equal(config.minFindingConfidence, 0.72);
  assert.equal(config.coverageFirstRoundPrimaryOnly, true);
  assert.equal(config.autoMinimizeOutdatedComments, true);
  assert.deepEqual(config.openaiApiBaseAllowlist, ['api.openai.com']);
});

test('loadConfig parses custom confidence and coverage-first mode', () => {
  const config = loadConfigWithMockedInputs({
    github_token: 'ghs_xxx',
    openai_api_key: 'sk-test',
    min_finding_confidence: '0.85',
    coverage_first_round_primary_only: 'false',
    auto_minimize_outdated_comments: 'false',
    openai_api_base: 'https://gateway.example.com/v1',
    openai_api_base_allowlist: 'api.openai.com, gateway.example.com'
  });

  assert.equal(config.minFindingConfidence, 0.85);
  assert.equal(config.coverageFirstRoundPrimaryOnly, false);
  assert.equal(config.autoMinimizeOutdatedComments, false);
  assert.equal(config.openaiApiBase, 'https://gateway.example.com/v1');
  assert.deepEqual(config.openaiApiBaseAllowlist, ['api.openai.com', 'gateway.example.com']);
});

test('loadConfig rejects invalid confidence range', () => {
  assert.throws(
    () => loadConfigWithMockedInputs({
      github_token: 'ghs_xxx',
      openai_api_key: 'sk-test',
      min_finding_confidence: '1.5'
    }),
    /min_finding_confidence must be a number in \[0, 1\]/
  );
});

test('loadConfig normalizes and deduplicates review_dimensions while preserving order', () => {
  const config = loadConfigWithMockedInputs({
    github_token: 'ghs_xxx',
    openai_api_key: 'sk-test',
    review_dimensions: 'GENERAL, security,General, testing,security'
  });

  assert.deepEqual(config.reviewDimensions, ['general', 'security', 'testing']);
});

test('loadConfig rejects non-https openai_api_base', () => {
  assert.throws(
    () => loadConfigWithMockedInputs({
      github_token: 'ghs_xxx',
      openai_api_key: 'sk-test',
      openai_api_base: 'http://gateway.example.com/v1',
      openai_api_base_allowlist: 'gateway.example.com'
    }),
    /must use https scheme/
  );
});

test('loadConfig rejects openai_api_base host not in allowlist', () => {
  assert.throws(
    () => loadConfigWithMockedInputs({
      github_token: 'ghs_xxx',
      openai_api_key: 'sk-test',
      openai_api_base: 'https://gateway.example.com/v1',
      openai_api_base_allowlist: 'api.openai.com'
    }),
    /host is not in allowlist/
  );
});
