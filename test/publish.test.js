const test = require('node:test');
const assert = require('node:assert/strict');

const { hashContent, upsertSummaryComment } = require('../src/publish');

test('hashContent is deterministic', () => {
  const a = hashContent('hello world');
  const b = hashContent('hello world');
  const c = hashContent('hello world!');

  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('upsertSummaryComment handles regex-special marker text safely', async () => {
  const summaryMarker = 'ai.code-review[agent](summary)+v1';
  const headSha = 'abc123';
  const summaryMarkdown = 'same summary body';
  const digest = hashContent(summaryMarkdown);
  const existingBody = [
    `<!-- ${summaryMarker} -->`,
    `<!-- ${summaryMarker}:meta ${JSON.stringify({ headSha, digest })} -->`,
    'previous summary'
  ].join('\n\n');

  let updateCalled = false;
  let createCalled = false;
  const octokit = {
    paginate: async () => [
      {
        id: 42,
        body: existingBody
      }
    ],
    rest: {
      issues: {
        listComments: () => {
        },
        updateComment: async () => {
          updateCalled = true;
        },
        createComment: async () => {
          createCalled = true;
          return { data: { id: 100 } };
        }
      }
    }
  };

  const result = await upsertSummaryComment(octokit, {
    owner: 'o',
    repo: 'r',
    issueNumber: 1,
    summaryMarker,
    headSha,
    summaryMarkdown
  });

  assert.equal(result.skipped, true);
  assert.equal(result.updated, false);
  assert.equal(result.created, false);
  assert.equal(updateCalled, false);
  assert.equal(createCalled, false);
});
