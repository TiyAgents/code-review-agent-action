const crypto = require('node:crypto');
const { normalizeInlineKey } = require('./inline-key');

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function markerTag(marker) {
  return `<!-- ${marker} -->`;
}

function markerMetaTag(marker, meta) {
  return `<!-- ${marker}:meta ${JSON.stringify(meta)} -->`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseMarkerMeta(marker, body) {
  if (!body) {
    return null;
  }

  const escapedMarker = escapeRegex(marker);
  const regex = new RegExp(`<!--\\s*${escapedMarker}:meta\\s+(.+?)\\s*-->`);
  const match = body.match(regex);
  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function hasInlineKeyMarker(body) {
  return /<!--\s*ai-code-review-agent:inline-key\s+[a-z0-9_-]{1,120}\s*-->/i.test(String(body || ''));
}

function extractInlineIssueKey(body) {
  const text = String(body || '');
  const markerMatch = text.match(/<!--\s*ai-code-review-agent:inline-key\s+([a-z0-9_-]{1,120})\s*-->/i);
  if (markerMatch) {
    return normalizeInlineKey(markerMatch[1]);
  }

  const headingMatch = text.match(/\*\*\[[^\]]+\]\s+(.+?)\*\*/);
  if (headingMatch) {
    return normalizeInlineKey(headingMatch[1]);
  }

  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) || '';
  return normalizeInlineKey(firstLine);
}

function buildInlineCommentKey(comment) {
  const path = String(comment.path || '').trim();
  const side = String(comment.side || 'RIGHT').trim().toUpperCase();
  const line = Number.parseInt(String(comment.line || comment.original_line || 0), 10) || 0;
  const issueKey = extractInlineIssueKey(comment.body || '');
  return `${path}|${side}|${line}|${issueKey}`;
}

async function listReviewComments(octokit, { owner, repo, pullNumber }) {
  const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100
  });
  return hydrateMinimizedStateForComments(octokit, comments);
}

function splitIntoChunks(items, chunkSize) {
  const out = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    out.push(items.slice(i, i + chunkSize));
  }
  return out;
}

async function hydrateMinimizedStateForComments(octokit, comments) {
  if (!octokit || typeof octokit.graphql !== 'function') {
    return comments || [];
  }

  const nodeIds = [...new Set((comments || [])
    .map((comment) => String(comment.node_id || '').trim())
    .filter(Boolean))];
  if (nodeIds.length === 0) {
    return comments || [];
  }

  const minimizedByNodeId = new Map();
  for (const ids of splitIntoChunks(nodeIds, 50)) {
    try {
      const result = await octokit.graphql(
        `
          query PullRequestReviewCommentMinimizedState($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on PullRequestReviewComment {
                id
                isMinimized
              }
            }
          }
        `,
        { ids }
      );

      for (const node of result.nodes || []) {
        if (!node || !node.id) {
          continue;
        }
        minimizedByNodeId.set(node.id, Boolean(node.isMinimized));
      }
    } catch {
      // Best effort: keep dedupe behavior if GraphQL query fails.
      return comments || [];
    }
  }

  return (comments || []).map((comment) => {
    const nodeId = String(comment.node_id || '').trim();
    if (!nodeId || !minimizedByNodeId.has(nodeId)) {
      return comment;
    }
    return {
      ...comment,
      isMinimized: minimizedByNodeId.get(nodeId)
    };
  });
}

function filterDuplicateInlineComments(inlineComments, existingComments) {
  const existingKeys = new Set(
    (existingComments || [])
      .filter((comment) => hasInlineKeyMarker(comment.body || ''))
      .filter((comment) => comment.isMinimized !== true)
      .map((comment) => buildInlineCommentKey(comment))
  );
  return (inlineComments || []).filter((comment) => !existingKeys.has(buildInlineCommentKey(comment)));
}

function buildInlineCommentKeySet(comments) {
  return new Set((comments || []).map((comment) => buildInlineCommentKey(comment)));
}

async function minimizeOutdatedInlineComments(octokit, { existingComments, activeInlineCommentKeys }) {
  if (!octokit || typeof octokit.graphql !== 'function') {
    return {
      attempted: 0,
      minimized: 0,
      alreadyMinimized: 0,
      failed: 0,
      skipped: true,
      reason: 'graphql_unavailable'
    };
  }

  const candidates = (existingComments || [])
    .filter((comment) => hasInlineKeyMarker(comment.body || ''))
    .filter((comment) => comment.isMinimized !== true)
    .filter((comment) => comment.node_id)
    .filter((comment) => !activeInlineCommentKeys.has(buildInlineCommentKey(comment)));

  let minimized = 0;
  let alreadyMinimized = 0;
  let failed = 0;
  for (const comment of candidates) {
    try {
      await octokit.graphql(
        `
          mutation MinimizeComment($subjectId: ID!) {
            minimizeComment(input: {subjectId: $subjectId, classifier: OUTDATED}) {
              minimizedComment {
                isMinimized
              }
            }
          }
        `,
        {
          subjectId: comment.node_id
        }
      );
      minimized += 1;
    } catch (error) {
      const message = String(error && (error.message || error));
      if (/already minimized|is minimized/i.test(message)) {
        alreadyMinimized += 1;
        continue;
      }
      failed += 1;
    }
  }

  return {
    attempted: candidates.length,
    minimized,
    alreadyMinimized,
    failed,
    skipped: false,
    reason: ''
  };
}

async function findSummaryComment(octokit, { owner, repo, issueNumber, summaryMarker }) {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100
  });

  const tag = markerTag(summaryMarker);
  const matches = comments.filter((comment) => String(comment.body || '').includes(tag));
  if (matches.length === 0) {
    return null;
  }

  return matches[matches.length - 1];
}

async function upsertSummaryComment(octokit, {
  owner,
  repo,
  issueNumber,
  summaryMarker,
  headSha,
  summaryMarkdown
}) {
  const digest = hashContent(summaryMarkdown);
  const meta = { headSha, digest };
  const body = [markerTag(summaryMarker), markerMetaTag(summaryMarker, meta), summaryMarkdown].join('\n\n');

  const existing = await findSummaryComment(octokit, { owner, repo, issueNumber, summaryMarker });
  if (existing) {
    const existingMeta = parseMarkerMeta(summaryMarker, existing.body || '');
    if (existingMeta && existingMeta.headSha === headSha && existingMeta.digest === digest) {
      return {
        skipped: true,
        updated: false,
        created: false,
        commentId: existing.id,
        digest
      };
    }

    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body
    });

    return {
      skipped: false,
      updated: true,
      created: false,
      commentId: existing.id,
      digest
    };
  }

  const created = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body
  });

  return {
    skipped: false,
    updated: false,
    created: true,
    commentId: created.data.id,
    digest
  };
}

async function reviewAlreadyExists(octokit, { owner, repo, pullNumber, reviewMarker, headSha, digest }) {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100
  });

  for (const review of reviews) {
    const meta = parseMarkerMeta(reviewMarker, review.body || '');
    if (meta && meta.headSha === headSha && meta.digest === digest) {
      return true;
    }
  }

  return false;
}

async function createReview(octokit, {
  owner,
  repo,
  pullNumber,
  reviewMarker,
  headSha,
  digest,
  reviewBody,
  inlineComments,
  autoMinimizeOutdatedComments = true
}) {
  const already = await reviewAlreadyExists(octokit, {
    owner,
    repo,
    pullNumber,
    reviewMarker,
    headSha,
    digest
  });

  if (already) {
    return {
      skipped: true,
      created: false,
      inlineCount: 0,
      downgradedInline: false,
      reason: 'same_head_sha_and_digest_already_reviewed',
      minimizeResult: {
        attempted: 0,
        minimized: 0,
        alreadyMinimized: 0,
        failed: 0,
        skipped: true,
        reason: 'skipped_same_digest'
      }
    };
  }

  const body = [markerTag(reviewMarker), markerMetaTag(reviewMarker, { headSha, digest }), reviewBody].join('\n\n');
  let dedupedInlineComments = inlineComments || [];
  let historicalInlineComments = [];
  const needHistorical = dedupedInlineComments.length > 0 || autoMinimizeOutdatedComments;
  if (needHistorical) {
    historicalInlineComments = await listReviewComments(octokit, { owner, repo, pullNumber });
  }
  if (dedupedInlineComments.length > 0) {
    dedupedInlineComments = filterDuplicateInlineComments(dedupedInlineComments, historicalInlineComments);
  }
  const minimizeResult = autoMinimizeOutdatedComments
    ? await minimizeOutdatedInlineComments(octokit, {
      existingComments: historicalInlineComments,
      activeInlineCommentKeys: buildInlineCommentKeySet(inlineComments || [])
    })
    : {
      attempted: 0,
      minimized: 0,
      alreadyMinimized: 0,
      failed: 0,
      skipped: true,
      reason: 'disabled_by_config'
    };

  if (dedupedInlineComments.length === 0) {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: headSha,
      event: 'COMMENT',
      body
    });

    return {
      skipped: false,
      created: true,
      inlineCount: 0,
      downgradedInline: false,
      minimizeResult
    };
  }

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: headSha,
      event: 'COMMENT',
      body,
      comments: dedupedInlineComments
    });

    return {
      skipped: false,
      created: true,
      inlineCount: dedupedInlineComments.length,
      downgradedInline: false,
      minimizeResult
    };
  } catch (error) {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: headSha,
      event: 'COMMENT',
      body: `${body}\n\nInline comments were downgraded because GitHub API rejected at least one location.`
    });

    return {
      skipped: false,
      created: true,
      inlineCount: 0,
      downgradedInline: true,
      reason: `inline_rejected: ${error.message || String(error)}`,
      minimizeResult
    };
  }
}

module.exports = {
  hashContent,
  upsertSummaryComment,
  createReview
};
