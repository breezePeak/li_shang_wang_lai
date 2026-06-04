import fs from 'fs';
import path from 'path';
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

async function saveDebugScreenshot(page, taskId, phase) {
  try {
    const dir = 'data/debug/return-visit';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const timestamp = Date.now();
    const filename = `${taskId}_${phase}_${timestamp}.png`;
    const fullPath = path.join(dir, filename);
    await page.screenshot({ path: fullPath, fullPage: false });
    console.error(`[debug-screenshot] Saved screenshot to ${fullPath}`);
    return fullPath;
  } catch (err) {
    console.error(`[debug-screenshot] Failed to save screenshot: ${err.message}`);
    return null;
  }
}


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

/**
 * 新增: 控制视频播放观看频率与时长
 */
export async function handleVideoWatch(page, watchPolicy = 'seconds', watchSeconds = [5, 8]) {
  try {
    const videoInfo = await page.evaluate(() => {
      const video = document.querySelector('video');
      if (!video) return null;
      return {
        duration: video.duration || 0,
        paused: video.paused,
        currentTime: video.currentTime || 0
      };
    });

    if (!videoInfo) {
      console.log('[return-visit:watch] 页面上未找到 video 元素，自动跳过播放等待逻辑');
      return;
    }

    const duration = videoInfo.duration;
    // 若视频处于暂停状态，自动尝试唤醒播放
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video && video.paused) {
        video.play().catch(() => {});
      }
    });

    if (watchPolicy === 'full') {
      console.log(`[return-visit:watch] 完播模式启动。视频总时长: ${duration.toFixed(1)}s，开始等待播放结束...`);
      const startTime = Date.now();
      const maxWaitMs = duration > 0 ? (duration + 5) * 1000 : 30000;

      while (Date.now() - startTime < maxWaitMs) {
        const playState = await page.evaluate(() => {
          const video = document.querySelector('video');
          if (!video) return { ended: true };
          return {
            currentTime: video.currentTime || 0,
            duration: video.duration || 0,
            ended: video.ended || false
          };
        });

        if (playState.ended || (playState.duration > 0 && playState.currentTime >= playState.duration - 0.5)) {
          console.log(`[return-visit:watch] 完播已达成。播放进度: ${playState.currentTime.toFixed(1)}s / ${playState.duration.toFixed(1)}s`);
          break;
        }
        await page.waitForTimeout(1000);
      }
    } else {
      let [min, max] = normalizeRange(watchSeconds, 5, 8);
      let targetSeconds = randomInRange(min, max);

      if (duration > 0 && targetSeconds > duration) {
        targetSeconds = Math.ceil(duration);
        console.log(`[return-visit:watch] 视频总时长 (${duration.toFixed(1)}s) 短于设定的秒数。调整为完播，等待 ${targetSeconds} 秒...`);
      } else {
        console.log(`[return-visit:watch] 观看指定时长模式。视频时长: ${duration.toFixed(1)}s，正在等待观看 ${targetSeconds} 秒...`);
      }

      await page.waitForTimeout(targetSeconds * 1000);
      console.log(`[return-visit:watch] 已完成视频播放，共观看 ${targetSeconds} 秒。`);
    }
  } catch (err) {
    console.error(`[return-visit:watch] 播放把控等待执行异常: ${err.message}`);
  }
}

export async function detectWorkPresentationKind(page, resolvedWork = {}) {
  const currentUrl = typeof page?.url === 'function' ? page.url() : '';
  const awemeType = String(resolvedWork?.awemeType || '').trim();

  let runtimeState = { hasVideoElement: false };
  try {
    runtimeState = await page.evaluate(() => ({
      hasVideoElement: !!document.querySelector('video'),
    }));
  } catch {}

  const isModalPage = /[?&]modal_id=/.test(currentUrl);
  const isNotePage = currentUrl.includes('/note/')
    || awemeType === '68'
    || (isModalPage && !runtimeState.hasVideoElement);

  return {
    currentUrl,
    isModalPage,
    isNotePage,
    hasVideoElement: Boolean(runtimeState.hasVideoElement),
  };
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
    console.error(`[return-visit:execute] 直链解析失败 taskId=${task.taskId}: ${direct.error || direct.reason || 'unknown'}，降级到主页采集`);
  }

  const fallback = await collectCandidateWorkFromProfile(page, task.userProfileUrl, {
    pageLoadRetryCount,
    maxWorksToCheck,
    maxReferenceComments,
  });

  if (!fallback.ok) {
    console.error(`[return-visit:execute] 作品解析失败 taskId=${task.taskId}: direct=${!knownWorkUrl ? 'no_url' : 'failed'} fallback_status=${fallback.status || 'failed'} reason=${fallback.reason || 'unknown'}`);
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
    watchPolicy = 'seconds',
    watchSeconds = [5, 8],
  } = options;

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

  // 检测是否是图文/note 页面（非视频），跳过视频专属操作
  const presentation = await detectWorkPresentationKind(page, resolvedWork);
  const currentUrl = presentation.currentUrl;
  const isNotePage = presentation.isNotePage;

  // 频率与时长调控防线: 点赞评论动作下发前强行进行观看拦截
  if (!isNotePage) {
    await handleVideoWatch(page, watchPolicy, watchSeconds);
  } else {
    console.error(`[return-visit:execute] 图文/note 页面，跳过视频监控 taskId=${task.taskId} url=${currentUrl}`);
  }

  const nextLikeStatus = { value: task.likeStatus || 'pending' };
  const nextCommentStatus = { value: task.commentStatus || 'pending' };

  const likeState = await checkLikeState(page);
  if (!likeState.ok || likeState.data?.confidence !== 'confirmed') {
    let debugCandidates = [];
    try {
      debugCandidates = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, [role="button"], a, svg');
        return Array.from(buttons).slice(0, 20).map(el => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            className: (el.className || '') + '',
            ariaLabel: el.getAttribute('aria-label') || '',
            role: el.getAttribute('role') || '',
            text: (el.innerText || '').slice(0, 20),
            visible: rect.width > 0 && rect.height > 0
          };
        });
      });
    } catch (err) {
      console.error(`[return-visit:execute] 收集点赞 debug 细节异常: ${err.message}`);
    }

    console.error(`[return-visit:execute] 点赞状态无法确认 taskId=${task.taskId} URL=${page.url()}`);
    console.error(`[return-visit:execute] 页面检测到的候选元素 (前 20 个):`, JSON.stringify(debugCandidates));

    await saveDebugScreenshot(page, task.taskId, 'like');

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
  } else if (Number(task?.targetWork?.userDigged || 0) === 1) {
    nextLikeStatus.value = 'already_liked';
  } else if (!execute) {
    nextLikeStatus.value = 'pending';
  } else {
    const clickResult = await clickLike(page, { execute: true });
    if (!clickResult.ok) {
      if (clickResult.code === 'ALREADY_LIKED') {
        nextLikeStatus.value = 'already_liked';
      } else {
        console.error(`[return-visit:execute] 点赞点击失败 taskId=${task.taskId}: ${clickResult.message}`);
        await saveDebugScreenshot(page, task.taskId, 'like_click');

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
        console.error(`[return-visit:execute] 点赞确认未通过 taskId=${task.taskId}: ${confirmResult.message}，但 clickLike 已执行，继续后续操作`);
        await saveDebugScreenshot(page, task.taskId, 'like_confirm');
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


  const commentText = String(task.generatedComment || '').trim();
  if (!commentText) {
    // 无评论文本时，仅凭点赞状态判断是否完成
    const done = canMarkDone({ likeStatus: nextLikeStatus.value, commentStatus: nextCommentStatus.value });
    return {
      ok: done,
      status: done ? 'done' : 'skipped_no_suitable_work',
      error: 'no_comment_text',
      likeStatus: nextLikeStatus.value,
      commentStatus: nextCommentStatus.value,
      resolvedWork: done ? resolvedWork : undefined,
    };
  }

  await waitRandom(page, waitBetweenLikeAndCommentMs, 2000, 6000);

  const commentResult = await postVideoComment(page, commentText, { execute: true });
  if (!commentResult.ok) {
    console.error(`[return-visit:execute] 评论失败 taskId=${task.taskId} URL=${page.url()}`);
    console.error(`[return-visit:execute] 评论失败 debug 细节:`, JSON.stringify(commentResult.data || {}));
    await saveDebugScreenshot(page, task.taskId, 'comment');

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
    console.error(`[return-visit:execute] 评论提交未确认 taskId=${task.taskId} URL=${page.url()}`);
    await saveDebugScreenshot(page, task.taskId, 'comment_unconfirmed');

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
