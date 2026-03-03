const crypto = require('node:crypto');

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function markerTag(marker) {
  return `<!-- ${marker} -->`;
}

function markerMetaTag(marker, meta) {
  return `<!-- ${marker}:meta ${JSON.stringify(meta)} -->`;
}

function parseMarkerMeta(marker, body) {
  if (!body) {
    return null;
  }

  const regex = new RegExp(`<!--\\s*${marker}:meta\\s+(.+?)\\s*-->`);
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
  inlineComments
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
      reason: 'same_head_sha_and_digest_already_reviewed'
    };
  }

  const body = [markerTag(reviewMarker), markerMetaTag(reviewMarker, { headSha, digest }), reviewBody].join('\n\n');

  if (!inlineComments || inlineComments.length === 0) {
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
      downgradedInline: false
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
      comments: inlineComments
    });

    return {
      skipped: false,
      created: true,
      inlineCount: inlineComments.length,
      downgradedInline: false
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
      reason: `inline_rejected: ${error.message || String(error)}`
    };
  }
}

module.exports = {
  hashContent,
  upsertSummaryComment,
  createReview
};
