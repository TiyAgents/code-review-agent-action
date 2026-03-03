const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeGuidanceContent,
  loadProjectGuidance
} = require('../src/repo-guidance');

test('normalizeGuidanceContent truncates when content exceeds limit', () => {
  const input = 'a'.repeat(50);
  const result = normalizeGuidanceContent(input, 20);

  assert.equal(result.truncated, true);
  assert.ok(result.content.includes('[truncated for prompt budget]'));
  assert.ok(result.content.length <= 60);
});

test('loadProjectGuidance follows priority AGENTS.md > AGENT.md > CLAUDE.md', async () => {
  const calls = [];
  const octokit = {
    rest: {
      repos: {
        getContent: async ({ path }) => {
          calls.push(path);
          if (path === 'AGENTS.md') {
            return {
              data: {
                type: 'file',
                content: Buffer.from('Use strict testing policy', 'utf8').toString('base64')
              }
            };
          }

          throw Object.assign(new Error('not found'), { status: 404 });
        }
      }
    }
  };

  const result = await loadProjectGuidance(octokit, {
    owner: 'o',
    repo: 'r',
    ref: 'sha'
  });

  assert.equal(result.found, true);
  assert.equal(result.path, 'AGENTS.md');
  assert.equal(result.content, 'Use strict testing policy');
  assert.deepEqual(calls, ['AGENTS.md']);
});

test('loadProjectGuidance falls back to lower-priority files', async () => {
  const octokit = {
    rest: {
      repos: {
        getContent: async ({ path }) => {
          if (path === 'AGENTS.md' || path === 'AGENT.md') {
            throw Object.assign(new Error('not found'), { status: 404 });
          }

          return {
            data: {
              type: 'file',
              content: Buffer.from('CLAUDE guidance', 'utf8').toString('base64')
            }
          };
        }
      }
    }
  };

  const result = await loadProjectGuidance(octokit, {
    owner: 'o',
    repo: 'r',
    ref: 'sha'
  });

  assert.equal(result.found, true);
  assert.equal(result.path, 'CLAUDE.md');
  assert.equal(result.content, 'CLAUDE guidance');
});

