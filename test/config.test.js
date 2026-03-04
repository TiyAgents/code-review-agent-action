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
  assert.equal(config.missingConfidencePolicy, 'na');
  assert.equal(config.fallbackConfidenceValue, 0.5);
  assert.equal(config.coverageFirstRoundPrimaryOnly, true);
  assert.equal(config.autoMinimizeOutdatedComments, true);
  assert.deepEqual(config.openaiApiBaseAllowlist, ['api.openai.com']);
});

test('loadConfig parses custom confidence and coverage-first mode', () => {
  const config = loadConfigWithMockedInputs({
    github_token: 'ghs_xxx',
    openai_api_key: 'sk-test',
    min_finding_confidence: '0.85',
    missing_confidence_policy: 'fallback',
    fallback_confidence_value: '0.65',
    coverage_first_round_primary_only: 'false',
    auto_minimize_outdated_comments: 'false',
    openai_api_base: 'https://gateway.example.com/v1',
    openai_api_base_allowlist: 'api.openai.com, gateway.example.com'
  });

  assert.equal(config.minFindingConfidence, 0.85);
  assert.equal(config.missingConfidencePolicy, 'fallback');
  assert.equal(config.fallbackConfidenceValue, 0.65);
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

test('loadConfig rejects invalid missing_confidence_policy', () => {
  assert.throws(
    () => loadConfigWithMockedInputs({
      github_token: 'ghs_xxx',
      openai_api_key: 'sk-test',
      missing_confidence_policy: 'invalid'
    }),
    /missing_confidence_policy must be one of \[drop, na, fallback\]/
  );
});

test('loadConfig rejects invalid fallback_confidence_value range', () => {
  assert.throws(
    () => loadConfigWithMockedInputs({
      github_token: 'ghs_xxx',
      openai_api_key: 'sk-test',
      fallback_confidence_value: '-0.1'
    }),
    /fallback_confidence_value must be a number in \[0, 1\]/
  );
});

test('loadConfig normalizes missing_confidence_policy casing and whitespace', () => {
  const config = loadConfigWithMockedInputs({
    github_token: 'ghs_xxx',
    openai_api_key: 'sk-test',
    missing_confidence_policy: '  Fallback  '
  });

  assert.equal(config.missingConfidencePolicy, 'fallback');
});

test('loadConfig accepts fallback_confidence_value boundaries 0 and 1', () => {
  const low = loadConfigWithMockedInputs({
    github_token: 'ghs_xxx',
    openai_api_key: 'sk-test',
    fallback_confidence_value: '0'
  });
  assert.equal(low.fallbackConfidenceValue, 0);

  const high = loadConfigWithMockedInputs({
    github_token: 'ghs_xxx',
    openai_api_key: 'sk-test',
    fallback_confidence_value: '1'
  });
  assert.equal(high.fallbackConfidenceValue, 1);
});

test('loadConfig uses default fallback value when policy is fallback and value is omitted', () => {
  const config = loadConfigWithMockedInputs({
    github_token: 'ghs_xxx',
    openai_api_key: 'sk-test',
    missing_confidence_policy: 'fallback'
  });

  assert.equal(config.missingConfidencePolicy, 'fallback');
  assert.equal(config.fallbackConfidenceValue, 0.5);
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
