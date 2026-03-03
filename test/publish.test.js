const test = require('node:test');
const assert = require('node:assert/strict');

const { hashContent, upsertSummaryComment, createReview } = require('../src/publish');

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

test('upsertSummaryComment creates comment when no marker comment exists', async () => {
  let createdBody = '';
  const octokit = {
    paginate: async () => [],
    rest: {
      issues: {
        listComments: () => {
        },
        createComment: async ({ body }) => {
          createdBody = body;
          return { data: { id: 9 } };
        },
        updateComment: async () => {
          throw new Error('update should not be called');
        }
      }
    }
  };

  const result = await upsertSummaryComment(octokit, {
    owner: 'o',
    repo: 'r',
    issueNumber: 1,
    summaryMarker: 'ai-code-review-agent:summary',
    headSha: 'sha1',
    summaryMarkdown: 'body'
  });

  assert.equal(result.created, true);
  assert.equal(result.updated, false);
  assert.equal(result.skipped, false);
  assert.match(createdBody, /ai-code-review-agent:summary/);
});

test('upsertSummaryComment updates comment when digest or headSha changes', async () => {
  let updateCalled = false;
  let updatedCommentId = null;
  const existingBody = [
    '<!-- ai-code-review-agent:summary -->',
    '<!-- ai-code-review-agent:summary:meta {"headSha":"old","digest":"old"} -->',
    'old'
  ].join('\n\n');
  const octokit = {
    paginate: async () => [{ id: 77, body: existingBody }],
    rest: {
      issues: {
        listComments: () => {
        },
        createComment: async () => {
          throw new Error('create should not be called');
        },
        updateComment: async ({ comment_id }) => {
          updateCalled = true;
          updatedCommentId = comment_id;
        }
      }
    }
  };

  const result = await upsertSummaryComment(octokit, {
    owner: 'o',
    repo: 'r',
    issueNumber: 1,
    summaryMarker: 'ai-code-review-agent:summary',
    headSha: 'new',
    summaryMarkdown: 'new body'
  });

  assert.equal(result.created, false);
  assert.equal(result.updated, true);
  assert.equal(result.skipped, false);
  assert.equal(updateCalled, true);
  assert.equal(updatedCommentId, 77);
});

test('createReview downgrades inline comments when GitHub rejects inline location', async () => {
  const createCalls = [];
  const octokit = {
    paginate: async () => [],
    rest: {
      pulls: {
        listReviews: () => {
        },
        createReview: async (payload) => {
          createCalls.push(payload);
          if (payload.comments) {
            throw new Error('line must be part of the diff');
          }
          return { data: { id: 1 } };
        }
      }
    }
  };

  const result = await createReview(octokit, {
    owner: 'o',
    repo: 'r',
    pullNumber: 1,
    reviewMarker: 'ai-code-review-agent:review',
    headSha: 'sha2',
    digest: 'd1',
    reviewBody: 'review body',
    inlineComments: [{ path: 'a.js', side: 'RIGHT', line: 10, body: 'x' }]
  });

  assert.equal(result.created, true);
  assert.equal(result.downgradedInline, true);
  assert.equal(result.inlineCount, 0);
  assert.equal(createCalls.length, 2);
  assert.match(createCalls[1].body, /Inline comments were downgraded/);
});

test('createReview filters historical duplicate inline comments by location and issue key', async () => {
  const createCalls = [];
  const octokit = {
    paginate: async (method) => {
      if (method === octokit.rest.pulls.listReviews) {
        return [];
      }
      if (method === octokit.rest.pulls.listReviewComments) {
        return [
          {
            path: 'a.js',
            side: 'RIGHT',
            line: 10,
            body: [
              '**[MEDIUM] Duplicate issue**',
              'summary',
              '<!-- ai-code-review-agent:inline-key duplicate_issue -->'
            ].join('\n\n')
          }
        ];
      }
      return [];
    },
    rest: {
      pulls: {
        listReviews: () => {
        },
        listReviewComments: () => {
        },
        createReview: async (payload) => {
          createCalls.push(payload);
          return { data: { id: 1 } };
        }
      }
    }
  };

  const result = await createReview(octokit, {
    owner: 'o',
    repo: 'r',
    pullNumber: 1,
    reviewMarker: 'ai-code-review-agent:review',
    headSha: 'sha3',
    digest: 'd2',
    reviewBody: 'review body',
    inlineComments: [
      {
        path: 'a.js',
        side: 'RIGHT',
        line: 10,
        body: '**[MEDIUM] Duplicate issue**\n\nsummary\n\n<!-- ai-code-review-agent:inline-key duplicate_issue -->'
      },
      {
        path: 'a.js',
        side: 'RIGHT',
        line: 12,
        body: '**[MEDIUM] New issue**\n\nsummary\n\n<!-- ai-code-review-agent:inline-key new_issue -->'
      }
    ]
  });

  assert.equal(result.created, true);
  assert.equal(result.downgradedInline, false);
  assert.equal(result.inlineCount, 1);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].comments.length, 1);
  assert.equal(createCalls[0].comments[0].line, 12);
});

test('createReview does not suppress duplicates from minimized historical comments', async () => {
  const createCalls = [];
  const octokit = {
    paginate: async (method) => {
      if (method === octokit.rest.pulls.listReviews) {
        return [];
      }
      if (method === octokit.rest.pulls.listReviewComments) {
        return [
          {
            node_id: 'PRRC_dup_minimized',
            path: 'a.js',
            side: 'RIGHT',
            line: 10,
            body: [
              '**[MEDIUM] Duplicate issue**',
              'summary',
              '<!-- ai-code-review-agent:inline-key duplicate_issue -->'
            ].join('\n\n')
          }
        ];
      }
      return [];
    },
    graphql: async (_query, variables) => {
      if (Array.isArray(variables.ids)) {
        return {
          nodes: [{ id: 'PRRC_dup_minimized', isMinimized: true }]
        };
      }
      return {};
    },
    rest: {
      pulls: {
        listReviews: () => {
        },
        listReviewComments: () => {
        },
        createReview: async (payload) => {
          createCalls.push(payload);
          return { data: { id: 1 } };
        }
      }
    }
  };

  const result = await createReview(octokit, {
    owner: 'o',
    repo: 'r',
    pullNumber: 1,
    reviewMarker: 'ai-code-review-agent:review',
    headSha: 'sha3a',
    digest: 'd2a',
    reviewBody: 'review body',
    inlineComments: [
      {
        path: 'a.js',
        side: 'RIGHT',
        line: 10,
        body: '**[MEDIUM] Duplicate issue**\n\nsummary\n\n<!-- ai-code-review-agent:inline-key duplicate_issue -->'
      }
    ]
  });

  assert.equal(result.created, true);
  assert.equal(result.inlineCount, 1);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].comments.length, 1);
});

test('createReview minimizes outdated historical inline comments posted by this action', async () => {
  const minimizedSubjectIds = [];
  let hydrateCalls = 0;
  const octokit = {
    paginate: async (method) => {
      if (method === octokit.rest.pulls.listReviews) {
        return [];
      }
      if (method === octokit.rest.pulls.listReviewComments) {
        return [
          {
            node_id: 'PRRC_dup',
            path: 'a.js',
            side: 'RIGHT',
            line: 10,
            body: '**[MEDIUM] Duplicate**\n\nsummary\n\n<!-- ai-code-review-agent:inline-key dup -->'
          },
          {
            node_id: 'PRRC_old',
            path: 'a.js',
            side: 'RIGHT',
            line: 8,
            body: '**[LOW] Old issue**\n\nsummary\n\n<!-- ai-code-review-agent:inline-key old_issue -->'
          }
        ];
      }
      return [];
    },
    graphql: async (_query, variables) => {
      if (Array.isArray(variables.ids)) {
        hydrateCalls += 1;
        return {
          nodes: [
            { id: 'PRRC_dup', isMinimized: false },
            { id: 'PRRC_old', isMinimized: false }
          ]
        };
      }
      minimizedSubjectIds.push(variables.subjectId);
      return {};
    },
    rest: {
      pulls: {
        listReviews: () => {
        },
        listReviewComments: () => {
        },
        createReview: async () => ({ data: { id: 1 } })
      }
    }
  };

  const result = await createReview(octokit, {
    owner: 'o',
    repo: 'r',
    pullNumber: 1,
    reviewMarker: 'ai-code-review-agent:review',
    headSha: 'sha4',
    digest: 'd4',
    reviewBody: 'review body',
    inlineComments: [
      {
        path: 'a.js',
        side: 'RIGHT',
        line: 10,
        body: '**[MEDIUM] Duplicate**\n\nsummary\n\n<!-- ai-code-review-agent:inline-key dup -->'
      }
    ]
  });

  assert.equal(result.created, true);
  assert.equal(result.inlineCount, 0);
  assert.equal(result.minimizeResult.attempted, 1);
  assert.equal(result.minimizeResult.minimized, 1);
  assert.equal(hydrateCalls, 1);
  assert.deepEqual(minimizedSubjectIds, ['PRRC_old']);
});
