const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadConfigWithMockedInputs(inputs, env = {}) {
  const originalLoad = Module._load;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalApiBase = process.env.OPENAI_API_BASE;

  process.env.OPENAI_API_KEY = env.OPENAI_API_KEY || '';
  process.env.OPENAI_API_BASE = env.OPENAI_API_BASE || '';

  const warnings = [];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@actions/core') {
      return {
        getInput(name, options = {}) {
          const value = Object.prototype.hasOwnProperty.call(inputs, name) ? inputs[name] : '';
          if (options.required && !value) {
            throw new Error(`Input required and not supplied: ${name}`);
          }
          return value;
        },
        warning(msg) {
          warnings.push(msg);
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/provider')];
    const { loadConfig } = require('../src/config');
    const config = loadConfig();
    config._warnings = warnings;
    return config;
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/provider')];
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
  assert.equal(config.aiProvider, 'openai');
  assert.deepEqual(config.apiBaseAllowlist, ['api.openai.com']);
});

test('loadConfig parses custom confidence and coverage-first mode', () => {
  const config = loadConfigWithMockedInputs({
    github_token: 'ghs_xxx',
    api_key: 'sk-test',
    min_finding_confidence: '0.85',
    missing_confidence_policy: 'fallback',
    fallback_confidence_value: '0.65',
    coverage_first_round_primary_only: 'false',
    auto_minimize_outdated_comments: 'false',
    api_base: 'https://gateway.example.com/v1',
    api_base_allowlist: 'api.openai.com, gateway.example.com'
  });

  assert.equal(config.minFindingConfidence, 0.85);
  assert.equal(config.missingConfidencePolicy, 'fallback');
  assert.equal(config.fallbackConfidenceValue, 0.65);
  assert.equal(config.coverageFirstRoundPrimaryOnly, false);
  assert.equal(config.autoMinimizeOutdatedComments, false);
  assert.equal(config.apiBase, 'https://gateway.example.com/v1');
  assert.deepEqual(config.apiBaseAllowlist, ['api.openai.com', 'gateway.example.com']);
});

test('loadConfig accepts ai_provider=anthropic', () => {
  const config = loadConfigWithMockedInputs({
    github_token: 'ghs_xxx',
    api_key: 'sk-ant-test',
    ai_provider: 'anthropic'
  });

  assert.equal(config.aiProvider, 'anthropic');
  assert.equal(config.apiKey, 'sk-ant-test');
});

test('loadConfig falls back from openai_api_key to api_key', () => {
  const config = loadConfigWithMockedInputs({
    github_token: 'ghs_xxx',
    openai_api_key: 'sk-legacy'
  });

  assert.equal(config.apiKey, 'sk-legacy');
  assert.equal(config.aiProvider, 'openai');
});

test('loadConfig falls back from openai_api_base to api_base', () => {
  const config = loadConfigWithMockedInputs({
    github_token: 'ghs_xxx',
    api_key: 'sk-test',
    openai_api_base: 'https://api.openai.com/v1',
    openai_api_base_allowlist: 'api.openai.com'
  });

  assert.equal(config.apiBase, 'https://api.openai.com/v1');
});

test('loadConfig warns when llm_compatibility_mode is non-auto', () => {
  const config = loadConfigWithMockedInputs({
    github_token: 'ghs_xxx',
    api_key: 'sk-test',
    llm_compatibility_mode: 'chat_json_object'
  });

  assert.ok(config._warnings.some((w) => w.includes('deprecated')));
});

test('loadConfig does not warn when llm_compatibility_mode is auto', () => {
  const config = loadConfigWithMockedInputs({
    github_token: 'ghs_xxx',
    api_key: 'sk-test',
    llm_compatibility_mode: 'auto'
  });

  assert.equal(config._warnings.filter((w) => w.includes('deprecated')).length, 0);
});

test('loadConfig rejects unsupported ai_provider', () => {
  assert.throws(
    () => loadConfigWithMockedInputs({
      github_token: 'ghs_xxx',
      api_key: 'sk-test',
      ai_provider: 'deepseek'
    }),
    /ai_provider must be one of/
  );
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

test('loadConfig rejects non-https api_base', () => {
  assert.throws(
    () => loadConfigWithMockedInputs({
      github_token: 'ghs_xxx',
      api_key: 'sk-test',
      api_base: 'http://gateway.example.com/v1',
      openai_api_base_allowlist: 'gateway.example.com'
    }),
    /must use https scheme/
  );
});

test('loadConfig rejects api_base host not in allowlist', () => {
  assert.throws(
    () => loadConfigWithMockedInputs({
      github_token: 'ghs_xxx',
      api_key: 'sk-test',
      api_base: 'https://gateway.example.com/v1',
      openai_api_base_allowlist: 'api.openai.com'
    }),
    /host is not in allowlist/
  );
});

test('loadConfig requires api key from any source', () => {
  assert.throws(
    () => loadConfigWithMockedInputs({
      github_token: 'ghs_xxx'
    }),
    /Missing API key/
  );
});

test('loadConfig rejects api_base when allowlist resolves to empty after normalization', () => {
  assert.throws(
    () => loadConfigWithMockedInputs({
      github_token: 'ghs_xxx',
      api_key: 'sk-test',
      api_base: 'https://gateway.example.com/v1',
      api_base_allowlist: '  ,  ',
      openai_api_base_allowlist: ''
    }),
    /allowlist is empty/
  );
});

test('loadConfig defaults maxConcurrency to 4', () => {
  const config = loadConfigWithMockedInputs({
    github_token: 'ghs_xxx',
    api_key: 'sk-test'
  });

  assert.equal(config.maxConcurrency, 4);
});

test('loadConfig parses custom max_concurrency', () => {
  const config = loadConfigWithMockedInputs({
    github_token: 'ghs_xxx',
    api_key: 'sk-test',
    max_concurrency: '8'
  });

  assert.equal(config.maxConcurrency, 8);
});

test('loadConfig rejects invalid max_concurrency', () => {
  assert.throws(
    () => loadConfigWithMockedInputs({
      github_token: 'ghs_xxx',
      api_key: 'sk-test',
      max_concurrency: '0'
    }),
    /max_concurrency must be a positive integer/
  );
});
