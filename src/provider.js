const SUPPORTED_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'mistral',
  'openai-compatible'
];

/**
 * Create an AI SDK provider instance based on the provider type.
 *
 * @param {{ provider: string, apiKey: string, baseURL?: string }} opts
 * @returns {import('ai').Provider} AI SDK provider instance
 */
function createProvider({ provider, apiKey, baseURL }) {
  const type = String(provider || 'openai').trim().toLowerCase();

  switch (type) {
    case 'openai': {
      const { createOpenAI } = require('@ai-sdk/openai');
      return createOpenAI({
        apiKey,
        ...(baseURL ? { baseURL } : {})
      });
    }

    case 'anthropic': {
      const { createAnthropic } = require('@ai-sdk/anthropic');
      return createAnthropic({
        apiKey,
        ...(baseURL ? { baseURL } : {})
      });
    }

    case 'google': {
      const { createGoogleGenerativeAI } = require('@ai-sdk/google');
      return createGoogleGenerativeAI({
        apiKey,
        ...(baseURL ? { baseURL } : {})
      });
    }

    case 'mistral': {
      const { createMistral } = require('@ai-sdk/mistral');
      return createMistral({
        apiKey,
        ...(baseURL ? { baseURL } : {})
      });
    }

    case 'openai-compatible': {
      const { createOpenAICompatible } = require('@ai-sdk/openai-compatible');
      if (!baseURL) {
        throw new Error('openai-compatible provider requires a base URL (api_base).');
      }
      return createOpenAICompatible({
        name: 'custom',
        apiKey,
        baseURL
      });
    }

    default:
      throw new Error(
        `Unsupported AI provider: "${type}". ` +
        `Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}`
      );
  }
}

/**
 * Create a model instance from a provider and model name.
 *
 * @param {import('ai').Provider} provider AI SDK provider instance
 * @param {string} modelName Model identifier (e.g. 'gpt-4o', 'claude-sonnet-4-20250514')
 * @returns {import('ai').LanguageModel}
 */
function createModel(provider, modelName) {
  if (!modelName) {
    throw new Error('Model name is required.');
  }
  return provider(modelName);
}

module.exports = {
  SUPPORTED_PROVIDERS,
  createProvider,
  createModel
};
