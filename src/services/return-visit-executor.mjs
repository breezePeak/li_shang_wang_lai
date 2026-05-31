import {
  checkLikeState,
  clickLike,
  confirmLikeSucceeded,
  postVideoComment,
} from '../adapters/video-page.mjs';
import { canMarkDone } from './return-visit-task-service.mjs';
import {
  collectWorkFromUrl,
  collectCandidateWorkFromProfile,
} from './return-visit-work-collector.mjs';

function normalizeRange(range, fallbackMin, fallbackMax) {
  if (Array.isArray(range) && range.length >= 2) {
    const min = Number(range[0]);
    const max = Number(range[1]);
    if (!isNaN(min) && !isNaN(max) && min >= 0 && max >= min) {
      return [min, max];
    }
  }
  return [fallbackMin, fallbackMax];
}

function randomInRange(min, max) {
  if (max <= min) return min;
  return Math.floor(min + Math.random() * (max - min + 1));
}

export async function waitRandom(page, range, fallbackMin, fallbackMax) {
  const [min, max] = normalizeRange(range, fallbackMin, fallbackMax);
  const ms = randomInRange(min, max);
  await page.waitForTimeout(ms);
  return ms;
}

async function resolveWorkForExecution(page, task, options = {}) {
  const { pageLoadRetryCount = 1, maxWorksToCheck = 3, maxReferenceComments = 5 } = options;
  const knownWorkUrl = task?.targetWork?.workUrl || null;
  if (knownWorkUrl) {
    const direct = await collectWorkFromUrl(page, knownWorkUrl, { pageLoadRetryCount, maxReferenceComments });
    if (direct.ok) {
      return {
        ok: true,
        work: direct.work,
        fromFallback: false,
      };
    }
  }

  const fallback = await collectCandidateWorkFromProfile(page, task.userProfileUrl, {
    pageLoadRetryCount,
    maxWorksToCheck,
    maxReferenceComments,
  });

  if (!fallback.ok) {
    return {
      ok: false,
      status: fallback.status || 'failed_collect',
      reason: fallback.reason || 'fallback_collect_failed',
    };
  }

  return {
    ok: true,
    work: fallback.selectedWork,
    fromFallback: true,
  };
}

export async function executeReturnVisitTask(page, task, options = {}) {
  const {
    execute = true,
    pageLoadRetryCount = 1,
    maxWorksToCheck = 3,
    maxReferenceComments = 5,
    waitBetweenLikeAndCommentMs = [2000, 6000],
  } = options;

  if (!task?.generatedComment || !String(task.generatedComment).trim()) {
    return {
      ok: false,
      status: 'failed_generate_comment',
      error: 'no_generated_comment',
      likeStatus: task.likeStatus || 'pending',
      commentStatus: task.commentStatus || 'pending',
    };
  }

  const resolved = await resolveWorkForExecution(page, task, {
    pageLoadRetryCount,
    maxWorksToCheck,
    maxReferenceComments,
  });

  if (!resolved.ok) {
    const status = resolved.status || 'failed_collect';
    if (status.startsWith('skipped_')) {
      return {
        ok: false,
        status,
        error: resolved.reason || status,
        likeStatus: task.likeStatus || 'pending',
        commentStatus: task.commentStatus || 'pending',
      };
    }
    return {
      ok: false,
      status: 'failed_collect',
      error: resolved.reason || 'resolve_work_failed',
      likeStatus: task.likeStatus || 'pending',
      commentStatus: task.commentStatus || 'pending',
    };
  }

  const resolvedWork = resolved.work;
  const nextLikeStatus = { value: task.likeStatus || 'pending' };
  const nextCommentStatus = { value: task.commentStatus || 'pending' };

  const likeState = await checkLikeState(page);
  if (!likeState.ok || likeState.data?.confidence !== 'confirmed') {
    return {
      ok: false,
      status: 'failed_like',
      error: likeState.message || 'like_state_unknown',
      likeStatus: 'failed',
      commentStatus: nextCommentStatus.value,
      resolvedWork,
    };
  }

  if (likeState.data.alreadyLiked) {
    nextLikeStatus.value = 'already_liked';
  } else if (!execute) {
    nextLikeStatus.value = 'pending';
  } else {
    const clickResult = await clickLike(page, { execute: true });
    if (!clickResult.ok) {
      if (clickResult.code === 'ALREADY_LIKED') {
        nextLikeStatus.value = 'already_liked';
      } else {
        return {
          ok: false,
          status: 'failed_like',
          error: clickResult.message || 'click_like_failed',
          likeStatus: 'failed',
          commentStatus: nextCommentStatus.value,
          resolvedWork,
        };
      }
    } else {
      const confirmResult = await confirmLikeSucceeded(page);
      if (!confirmResult.ok) {
        return {
          ok: false,
          status: 'failed_like',
          error: confirmResult.message || 'confirm_like_failed',
          likeStatus: 'failed',
          commentStatus: nextCommentStatus.value,
          resolvedWork,
        };
      }
      nextLikeStatus.value = 'liked';
    }
  }

  if (!execute) {
    return {
      ok: true,
      status: 'pending_execute',
      likeStatus: nextLikeStatus.value,
      commentStatus: nextCommentStatus.value,
      resolvedWork,
      dryRun: true,
    };
  }

  await waitRandom(page, waitBetweenLikeAndCommentMs, 2000, 6000);

  const commentText = String(task.generatedComment || '').trim();
  const commentResult = await postVideoComment(page, commentText, { execute: true });
  if (!commentResult.ok) {
    return {
      ok: false,
      status: 'failed_comment',
      error: commentResult.message || 'post_comment_failed',
      likeStatus: nextLikeStatus.value,
      commentStatus: 'failed',
      resolvedWork,
    };
  }

  if (commentResult.data?.unconfirmed) {
    return {
      ok: false,
      status: 'failed_comment',
      error: 'comment_unconfirmed',
      likeStatus: nextLikeStatus.value,
      commentStatus: 'failed',
      resolvedWork,
    };
  }

  nextCommentStatus.value = 'posted';
  const done = canMarkDone({
    likeStatus: nextLikeStatus.value,
    commentStatus: nextCommentStatus.value,
  });
  if (!done) {
    return {
      ok: false,
      status: 'failed',
      error: 'done_condition_not_met',
      likeStatus: nextLikeStatus.value,
      commentStatus: nextCommentStatus.value,
      resolvedWork,
    };
  }

  return {
    ok: true,
    status: 'done',
    likeStatus: nextLikeStatus.value,
    commentStatus: nextCommentStatus.value,
    resolvedWork,
    executedAt: new Date().toISOString(),
  };
}
