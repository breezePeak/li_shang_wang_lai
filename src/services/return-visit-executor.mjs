import fs from 'fs';
import path from 'path';
import {
  checkLikeState,
  clickLike,
  confirmLikeSucceeded,
  activateCommentComposer,
  ensureCommentPanelOpen,
  findCommentInput,
  postVideoComment,
} from '../adapters/video-page.mjs';
import {
  ensureWorkModalCommentBoxReady,
  postWorkModalComment,
  waitForWorkModal,
} from '../adapters/work-modal-page.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';
import { canMarkDone } from './return-visit-task-service.mjs';
import {
  collectCurrentOpenedWork,
  collectFirstNonTopAwemeFromProfile,
  extractWorkIdFromUrl,
  openProfileWorkByAwemeId,
} from './return-visit-work-collector.mjs';
import { LocalAgentProvider } from '../agent/local-agent-provider.mjs';

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

function elapsedMs(startedAt) {
  return Date.now() - startedAt;
}

function formatLogFields(fields = {}) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}

function logTimedStep(logTag, step, event, fields = {}) {
  const suffix = formatLogFields(fields);
  console.error(`${logTag} [timing] step=${step} event=${event}${suffix ? ` ${suffix}` : ''}`);
}

async function waitWithProgress(promise, { logTag, step, startedAt = Date.now(), intervalMs = 2000, fields = {} } = {}) {
  logTimedStep(logTag, step, 'start', fields);
  let settled = false;
  const wrapped = Promise.resolve(promise).then(
    value => {
      settled = true;
      return { ok: true, value };
    },
    error => {
      settled = true;
      return { ok: false, error };
    }
  );

  while (!settled) {
    const result = await Promise.race([
      wrapped,
      new Promise(resolve => setTimeout(() => resolve({ pending: true }), intervalMs)),
    ]);
    if (!result.pending) {
      logTimedStep(logTag, step, result.ok ? 'done' : 'error', {
        elapsedMs: elapsedMs(startedAt),
        ...(result.ok ? {} : { error: result.error?.message || result.error }),
      });
      if (!result.ok) throw result.error;
      return result.value;
    }
    logTimedStep(logTag, step, 'waiting', { elapsedMs: elapsedMs(startedAt), ...fields });
  }

  const result = await wrapped;
  if (!result.ok) throw result.error;
  return result.value;
}

async function ensureVideoPlaybackStarted(page) {
  const videoInfo = await page.evaluate(() => {
    const video = document.querySelector('video');
    if (!video) return null;
    return {
      duration: Number(video.duration || 0),
      paused: !!video.paused,
      currentTime: Number(video.currentTime || 0),
    };
  });

  if (!videoInfo) {
    console.log('[return-visit:watch] 页面上未找到 video 元素，自动跳过播放等待逻辑');
    return null;
  }

  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (video && video.paused) {
      video.play().catch(() => {});
    }
  });

  return videoInfo;
}

export async function waitForInteractionWatchGate(page, watchPolicy = 'seconds', watchSeconds = [3, 3]) {
  try {
    const videoInfo = await ensureVideoPlaybackStarted(page);
    if (!videoInfo) return 0;

    const duration = Number(videoInfo.duration || 0);
    let [min, max] = normalizeRange(watchSeconds, 3, 3);
    let targetSeconds = randomInRange(min, max);

    if (duration > 0 && targetSeconds > duration) {
      targetSeconds = Math.max(1, Math.floor(Math.max(duration - 1, duration * 0.75)));
      console.log(`[return-visit:watch] 视频总时长 (${duration.toFixed(1)}s) 短于门槛时长。避免触发连播，调整为 ${targetSeconds} 秒后进入互动...`);
    } else if (duration > 0 && targetSeconds >= Math.max(1, duration - 0.5)) {
      targetSeconds = Math.max(1, Math.floor(Math.max(duration - 1, duration * 0.75)));
      console.log(`[return-visit:watch] 互动门槛接近完播 (${duration.toFixed(1)}s)。避免触发连播，调整为 ${targetSeconds} 秒后进入互动...`);
    } else if (watchPolicy === 'full') {
      console.log(`[return-visit:watch] full 模式改为“最短观看后互动”。视频继续自然播放，${targetSeconds} 秒后进入点赞评论...`);
    } else if (duration > 0) {
      console.log(`[return-visit:watch] 最短观看门槛。视频时长: ${duration.toFixed(1)}s，等待 ${targetSeconds} 秒后进入互动...`);
    } else {
      console.log(`[return-visit:watch] 最短观看门槛。视频时长未知，等待 ${targetSeconds} 秒后进入互动...`);
    }

    await page.waitForTimeout(targetSeconds * 1000);
    console.log(`[return-visit:watch] 已达到互动门槛，共观看 ${targetSeconds} 秒。`);
    return targetSeconds;
  } catch (err) {
    console.error(`[return-visit:watch] 互动门槛等待执行异常: ${err.message}`);
    return 0;
  }
}

/**
 * 新增: 控制视频播放观看频率与时长
 */
export async function handleVideoWatch(page, watchPolicy = 'seconds', watchSeconds = [3, 3]) {
  try {
    const videoInfo = await ensureVideoPlaybackStarted(page);
    if (!videoInfo) {
      return;
    }

    const duration = Number(videoInfo.duration || 0);

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
      let [min, max] = normalizeRange(watchSeconds, 3, 3);
      let targetSeconds = randomInRange(min, max);

      if (duration > 0 && targetSeconds > duration) {
        targetSeconds = Math.max(1, Math.floor(Math.max(duration - 1, duration * 0.75)));
        console.log(`[return-visit:watch] 视频总时长 (${duration.toFixed(1)}s) 短于设定的秒数。避免触发连播，等待 ${targetSeconds} 秒...`);
      } else if (duration > 0 && targetSeconds >= Math.max(1, duration - 0.5)) {
        targetSeconds = Math.max(1, Math.floor(Math.max(duration - 1, duration * 0.75)));
        console.log(`[return-visit:watch] 目标观看时长接近完播 (${duration.toFixed(1)}s)。避免触发连播，调整为 ${targetSeconds} 秒...`);
      } else if (duration > 0) {
        console.log(`[return-visit:watch] 观看指定时长模式。视频时长: ${duration.toFixed(1)}s，正在等待观看 ${targetSeconds} 秒...`);
      } else {
        console.log(`[return-visit:watch] 观看指定时长模式。视频时长未知，正在等待观看 ${targetSeconds} 秒...`);
      }

      await page.waitForTimeout(targetSeconds * 1000);
      console.log(`[return-visit:watch] 已完成视频播放，共观看 ${targetSeconds} 秒。`);
    }
  } catch (err) {
    console.error(`[return-visit:watch] 播放把控等待执行异常: ${err.message}`);
  }
}

export async function pauseCurrentVideo(page) {
  try {
    const result = await page.evaluate(() => {
      const video = document.querySelector('video');
      if (!video) return { found: false, paused: false };
      if (!video.paused) {
        video.pause();
      }
      return {
        found: true,
        paused: video.paused,
        currentTime: Number(video.currentTime || 0),
      };
    });
    if (result?.found) {
      console.error(`[return-visit:watch] 评论阶段前暂停视频 paused=${result.paused} currentTime=${Number(result.currentTime || 0).toFixed(1)}s`);
    }
    return result;
  } catch (err) {
    console.error(`[return-visit:watch] 暂停视频失败: ${err.message}`);
    return { found: false, paused: false };
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

function isWorkUrl(value) {
  return /\/(?:video|note)\/\d+|[?&]modal_id=\d+/.test(String(value || ''));
}

function normalizeWorkId(value) {
  return String(value || '').trim().replace(/^(video|note|modal)-/, '');
}

export function getCurrentWorkIdFromUrl(url = '') {
  return normalizeWorkId(extractWorkIdFromUrl(url) || '');
}

export async function verifyCurrentReturnVisitWork(page, resolvedWork = {}, phase = 'unknown') {
  const expectedWorkId = normalizeWorkId(resolvedWork.workId || extractWorkIdFromUrl(resolvedWork.workUrl || '') || '');
  const currentUrl = typeof page?.url === 'function' ? page.url() : '';
  const currentWorkId = getCurrentWorkIdFromUrl(currentUrl);

  if (!expectedWorkId) {
    return { ok: true, expectedWorkId, currentWorkId, currentUrl, reason: 'expected_work_id_missing' };
  }

  if (currentWorkId !== expectedWorkId) {
    return {
      ok: false,
      reason: currentWorkId ? 'current_work_mismatch' : 'current_work_id_missing',
      phase,
      expectedWorkId,
      currentWorkId,
      currentUrl,
    };
  }

  return { ok: true, expectedWorkId, currentWorkId, currentUrl };
}

async function blockIfCurrentWorkChanged(page, task, resolvedWork, phase, statuses = {}) {
  const check = await verifyCurrentReturnVisitWork(page, resolvedWork, phase);
  if (check.ok) return null;

  console.error(
    `[visit] task=${task.taskId} 当前作品已变化 phase=${phase} expected=${check.expectedWorkId}` +
      ` current=${check.currentWorkId || '(missing)'} url=${check.currentUrl}`
  );
  await saveDebugScreenshot(page, task.taskId, `wrong_work_${phase}`);
  return {
    ok: false,
    status: 'failed_collect',
    error: `wrong_work_${phase}`,
    likeStatus: statuses.likeStatus || task.likeStatus || 'pending',
    commentStatus: statuses.commentStatus || task.commentStatus || 'pending',
    resolvedWork,
  };
}

export async function postReturnVisitComment(page, text, presentation = {}, { execute = false, expectedWorkId = '', commentBoxReady = false } = {}) {
  if (presentation?.isModalPage) {
    console.error(`[comment] 发评论: modal页, 先打开评论区...`);
    if (!commentBoxReady) {
      const modalReady = await waitForWorkModal(page, { timeoutMs: 8000, closeAutoPlay: true });
      if (!modalReady?.ok) {
        console.error(`[comment] [FAIL] modal未就绪: ${modalReady?.message || modalReady?.code}`);
        return { ok: false, code: modalReady?.code, message: modalReady?.message || 'work_modal_not_ready', data: modalReady?.data };
      }
    } else {
      console.error('[comment] 复用已就绪的评论区，跳过重复打开');
    }
    if (expectedWorkId) {
      const workCheck = await verifyCurrentReturnVisitWork(page, { workId: expectedWorkId }, 'inside_comment_send');
      if (!workCheck.ok) {
        console.error(`[comment] [FAIL] 发送前作品变化 expected=${workCheck.expectedWorkId} current=${workCheck.currentWorkId || '(missing)'} url=${workCheck.currentUrl}`);
        return {
          ok: false,
          code: RESULT_CODES.WRONG_PAGE,
          message: 'wrong_work_inside_comment_send',
          data: workCheck,
        };
      }
    }
    console.error(`[comment] modal就绪, 发送评论...`);
    return postWorkModalComment(page, text);
  }

  if (expectedWorkId) {
    const workCheck = await verifyCurrentReturnVisitWork(page, { workId: expectedWorkId }, 'inside_comment_send');
    if (!workCheck.ok) {
      console.error(`[comment] [FAIL] 发送前作品变化 expected=${workCheck.expectedWorkId} current=${workCheck.currentWorkId || '(missing)'} url=${workCheck.currentUrl}`);
      return {
        ok: false,
        code: RESULT_CODES.WRONG_PAGE,
        message: 'wrong_work_inside_comment_send',
        data: workCheck,
      };
    }
  }

  console.error(`[comment] 发评论: 视频页...`);
  return postVideoComment(page, text, { execute });
}

export async function ensureReturnVisitCommentBoxReady(page, presentation = {}) {
  const startedAt = Date.now();
  if (presentation?.isModalPage) {
    console.error(`[comment-box] modal: start waitForWorkModal timeoutMs=8000 url=${typeof page?.url === 'function' ? page.url() : ''}`);
    const modalStartedAt = Date.now();
    const modalReady = await waitForWorkModal(page, { timeoutMs: 8000, closeAutoPlay: true });
    console.error(`[comment-box] modal: waitForWorkModal done ok=${Boolean(modalReady?.ok)} elapsedMs=${elapsedMs(modalStartedAt)} message=${modalReady?.message || ''} code=${modalReady?.code || ''}`);
    if (!modalReady?.ok) {
      return { ok: false, reason: modalReady?.message || modalReady?.code || 'work_modal_not_ready', data: modalReady?.data };
    }
    const boxStartedAt = Date.now();
    console.error('[comment-box] modal: start ensureWorkModalCommentBoxReady');
    const result = await ensureWorkModalCommentBoxReady(page);
    console.error(`[comment-box] modal: ensureWorkModalCommentBoxReady done ok=${Boolean(result?.ok)} elapsedMs=${elapsedMs(boxStartedAt)} method=${result?.method || ''} reason=${result?.reason || ''} totalElapsedMs=${elapsedMs(startedAt)}`);
    return result;
  }

  console.error(`[comment-box] video: start ensureCommentPanelOpen url=${typeof page?.url === 'function' ? page.url() : ''}`);
  const panelStartedAt = Date.now();
  const panelOpen = await ensureCommentPanelOpen(page);
  console.error(`[comment-box] video: ensureCommentPanelOpen done ok=${Boolean(panelOpen)} elapsedMs=${elapsedMs(panelStartedAt)}`);
  if (!panelOpen) return { ok: false, reason: 'comment_panel_not_open' };

  const findStartedAt = Date.now();
  console.error('[comment-box] video: start findCommentInput');
  let input = await findCommentInput(page);
  console.error(`[comment-box] video: findCommentInput done found=${Boolean(input)} elapsedMs=${elapsedMs(findStartedAt)}`);
  if (!input) {
    const activateStartedAt = Date.now();
    console.error('[comment-box] video: start activateCommentComposer');
    const activated = await activateCommentComposer(page);
    console.error(`[comment-box] video: activateCommentComposer done ok=${Boolean(activated?.ok)} elapsedMs=${elapsedMs(activateStartedAt)} reason=${activated?.reason || ''}`);
    if (activated?.ok) {
      await page.waitForTimeout(800);
      const refindStartedAt = Date.now();
      console.error('[comment-box] video: start findCommentInput after activate');
      input = await findCommentInput(page);
      console.error(`[comment-box] video: findCommentInput after activate done found=${Boolean(input)} elapsedMs=${elapsedMs(refindStartedAt)}`);
    }
  }

  const result = input ? { ok: true, method: 'video_comment_input' } : { ok: false, reason: 'comment_input_not_found' };
  console.error(`[comment-box] video: done ok=${result.ok} method=${result.method || ''} reason=${result.reason || ''} totalElapsedMs=${elapsedMs(startedAt)}`);
  return result;
}

export function buildCommentContext(task, resolvedWork = {}) {
  const maxLength = Number(process.env.COMMENT_MAX_LENGTH || task?.requirements?.maxLength || 30);
  return {
    taskId: task.taskId,
    targetUser: {
      userId: task.userId || '',
      nickname: task.userName || task.actorName || '',
      profileUrl: task.userProfileUrl || '',
    },
    work: {
      workId: resolvedWork.workId || '',
      desc: resolvedWork.workText || resolvedWork.desc || resolvedWork.contentSummary || '',
      authorNickname: task.userName || task.actorName || '',
    },
    interaction: {
      type: task.sourceType || task.interactionType || 'like',
      source: 'notification',
    },
    requirements: {
      maxLength,
      tone: '自然、简短、像真人',
    },
  };
}

function normalizeVisibleFingerprint(value) {
  return String(value || '').trim();
}

function workContextHasVisibleContent(work = {}) {
  const text = [work.workTitle, work.workText, work.contentSummary, ...(Array.isArray(work.referenceComments) ? work.referenceComments : [])]
    .filter(Boolean)
    .join('')
    .replace(/\s+/g, '');
  return text.length >= 8;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return value;
  }
  return null;
}

function normalizeContextText(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .trim();
}

function buildWorkContextSignature(work = {}) {
  return [
    work.workTitle,
    work.workText,
    work.contentSummary,
    work.desc,
    work.itemTitle,
  ]
    .map(normalizeContextText)
    .filter(text => text.length >= 4)
    .join('|')
    .slice(0, 240);
}

function mergeWorkContext(preferredWork = {}, visibleWork = {}, expectedWorkId = '') {
  const preferred = preferredWork || {};
  const visible = visibleWork || {};
  const workId = visible.workId || preferred.workId || expectedWorkId || '';
  const workUrl = isWorkUrl(visible.workUrl) ? visible.workUrl : preferred.workUrl;
  const workTitle = firstNonEmpty(preferred.workTitle, preferred.itemTitle, preferred.desc, visible.workTitle, visible.contentSummary);
  const workText = firstNonEmpty(preferred.workText, preferred.desc, preferred.contentSummary, visible.workText, visible.contentSummary);
  const contentSummary = firstNonEmpty(preferred.contentSummary, workText, visible.contentSummary);

  return {
    ...visible,
    ...preferred,
    workId,
    workUrl,
    workTitle,
    workText,
    contentSummary,
    publishTime: preferred.publishTime || visible.publishTime || null,
    likeState: visible.likeState || preferred.likeState || 'unknown',
    referenceComments: Array.isArray(visible.referenceComments) ? visible.referenceComments : (preferred.referenceComments || []),
    thumbnailSrc: visible.thumbnailSrc || preferred.thumbnailSrc || null,
    visibleFingerprint: visible.visibleFingerprint || preferred.visibleFingerprint || '',
  };
}

function canReuseGeneratedCommentForWork(task = {}, resolvedWork = {}) {
  const comment = String(task.generatedComment || '').trim();
  if (!comment) return false;

  const taskWorkId = normalizeWorkId(task.targetWork?.workId || '');
  const resolvedWorkId = normalizeWorkId(resolvedWork.workId || '');
  if (taskWorkId && resolvedWorkId && taskWorkId !== resolvedWorkId) return false;

  const oldSignature = buildWorkContextSignature(task.targetWork || {});
  const currentSignature = buildWorkContextSignature(resolvedWork || {});
  if (!oldSignature || !currentSignature) return true;

  return oldSignature === currentSignature
    || oldSignature.includes(currentSignature)
    || currentSignature.includes(oldSignature);
}

async function refreshVisibleWorkForComment(page, task, resolvedWork, maxReferenceComments, phase = 'before_agent') {
  const current = await collectCurrentOpenedWork(page, { maxReferenceComments });
  if (!current.ok) {
    return { ok: false, error: 'current_work_collect_failed', reason: current.reason || 'current_work_collect_failed' };
  }

  const visibleWork = current.work || {};
  const currentWorkId = normalizeWorkId(visibleWork.workId || '');
  const expectedWorkId = normalizeWorkId(resolvedWork.workId || '');
  console.error(
    `[visit:context] visible_work_context phase=${phase}` +
      ` expected=${expectedWorkId || '(missing)'}` +
      ` actual=${currentWorkId || '(missing)'}` +
      ` title="${String(visibleWork.workTitle || '').slice(0, 40)}"` +
      ` fingerprint="${normalizeVisibleFingerprint(visibleWork.visibleFingerprint).slice(0, 80)}"`
  );
  if (expectedWorkId && currentWorkId && currentWorkId !== expectedWorkId) {
    return { ok: false, error: 'opened_work_id_mismatch', expectedWorkId, actualWorkId: visibleWork.workId };
  }

  const originalFingerprint = normalizeVisibleFingerprint(resolvedWork.visibleFingerprint);
  const currentFingerprint = normalizeVisibleFingerprint(visibleWork.visibleFingerprint);
  if (originalFingerprint && currentFingerprint && originalFingerprint !== currentFingerprint) {
    return {
      ok: false,
      error: `visible_work_changed_${phase}`,
      originalFingerprint,
      currentFingerprint,
      expectedWorkId,
      actualWorkId: visibleWork.workId,
    };
  }

  if (!current.sufficient || !workContextHasVisibleContent(visibleWork)) {
    return {
      ok: false,
      error: `current_work_context_insufficient_${phase}`,
      reason: current.reason || 'content_too_short',
      expectedWorkId,
      actualWorkId: visibleWork.workId,
      visibleFingerprint: currentFingerprint,
    };
  }

  return {
    ok: true,
    work: mergeWorkContext(resolvedWork, visibleWork, expectedWorkId),
  };
}

async function resolveWorkForExecution(page, task, options = {}) {
  const { pageLoadRetryCount = 1, maxReferenceComments = 5 } = options;
  const knownWorkId = String(task?.targetWork?.workId || '').trim();
  const profileUrl = task?.userProfileUrl;

  async function openFallbackProfileWork(reason) {
    console.error(`[visit] task=${task.taskId} 改为从主页选择回访作品 reason=${reason || 'no_known_work'}`);
    const selected = await collectFirstNonTopAwemeFromProfile(page, profileUrl, {
      pageLoadRetryCount,
    });

    if (!selected.ok) {
      const selectedReason = selected.reason || 'select_profile_work_failed';
      if (selectedReason === 'skip_no_aweme' || selectedReason === 'skip_only_top_aweme') {
        return { ok: false, status: 'skipped_no_work', reason: selectedReason };
      }
      if (selectedReason === 'skip_aweme_id_missing') {
        return { ok: false, status: 'skipped_no_suitable_work', reason: selectedReason };
      }
      return { ok: false, status: 'failed_collect', reason: selectedReason };
    }

    const fallbackWorkId = String(selected.aweme?.workId || selected.aweme?.awemeId || '').trim();
    if (!fallbackWorkId) {
      return { ok: false, status: 'skipped_no_suitable_work', reason: 'fallback_work_id_missing' };
    }

    console.error(`[visit] task=${task.taskId} 选择主页作品 workId=${fallbackWorkId}`);
    const opened = await openProfileWorkByAwemeId(page, profileUrl, fallbackWorkId, {
      pageLoadRetryCount,
      reuseCurrentProfile: true,
    });

    if (!opened.ok) {
      return { ok: false, status: 'failed_collect', reason: opened.reason || 'open_fallback_profile_work_failed' };
    }

    let autoPlayChecked = false;
    if (String(page.url?.() || '').includes('modal_id=')) {
      const modalReady = await waitForWorkModal(page, { timeoutMs: 8000, closeAutoPlay: true, openCommentArea: false });
      if (!modalReady?.ok) {
        return { ok: false, status: 'failed_collect', reason: modalReady?.message || modalReady?.code || 'work_modal_not_ready' };
      }
      autoPlayChecked = true;
    }

    const fromCurrent = await collectCurrentOpenedWork(page, { maxReferenceComments });
    if (!fromCurrent.ok) {
      return { ok: false, status: 'failed_collect', reason: 'fallback_work_collect_failed' };
    }

    const currentWorkId = normalizeWorkId(fromCurrent.work?.workId || '');
    if (currentWorkId && currentWorkId !== normalizeWorkId(fallbackWorkId)) {
      return {
        ok: false,
        status: 'failed_collect',
        reason: 'opened_work_id_mismatch',
        expectedWorkId: fallbackWorkId,
        actualWorkId: fromCurrent.work.workId,
      };
    }

    const resolvedVisibleWork = mergeWorkContext(selected.aweme || {}, fromCurrent.work, fallbackWorkId);
    console.error(`[resolve] 回访作品收集完成: title="${String(resolvedVisibleWork.workTitle || '').slice(0, 30)}"`);
    return {
      ok: true,
      work: resolvedVisibleWork,
      fromFallback: true,
      openedFromProfile: true,
      autoPlayChecked,
    };
  }

  if (profileUrl && !knownWorkId) {
    return openFallbackProfileWork('missing_known_work_id');
  }

  if (profileUrl && knownWorkId) {
    console.error(`[visit] task=${task.taskId} 打开用户主页 profileUrl=${profileUrl}`);
    const opened = await openProfileWorkByAwemeId(page, profileUrl, knownWorkId, {
      pageLoadRetryCount,
    });
    if (opened.ok) {
      const count = opened.stats?.awemeCount ?? opened.stats?.responseCount ?? 0;
      console.error(`[visit] task=${task.taskId} 已监听到主页作品列表 API count=${count}`);
      console.error(`[visit] task=${task.taskId} 匹配作品成功 workId=${knownWorkId} index=${opened.index}`);
      console.error(`[visit] task=${task.taskId} 已点击目标作品`);
      console.error(`[visit] task=${task.taskId} 已进入作品页`);
      let autoPlayChecked = false;
      if (String(page.url?.() || '').includes('modal_id=')) {
        const modalReady = await waitForWorkModal(page, { timeoutMs: 8000, closeAutoPlay: true, openCommentArea: false });
        if (!modalReady?.ok) {
          return { ok: false, status: 'failed_collect', reason: modalReady?.message || modalReady?.code || 'work_modal_not_ready' };
        }
        autoPlayChecked = true;
      }
      const fromCurrent = await collectCurrentOpenedWork(page, { maxReferenceComments });
      if (fromCurrent.ok) {
        const currentWorkId = normalizeWorkId(fromCurrent.work?.workId || '');
        if (currentWorkId && currentWorkId !== normalizeWorkId(knownWorkId)) {
          return {
            ok: false,
            status: 'failed_collect',
            reason: 'opened_work_id_mismatch',
            expectedWorkId: knownWorkId,
            actualWorkId: fromCurrent.work.workId,
          };
        }

        const resolvedVisibleWork = mergeWorkContext(opened.aweme || {}, fromCurrent.work, knownWorkId);
        console.error(`[resolve] 作品收集完成: title="${String(resolvedVisibleWork.workTitle || '').slice(0, 30)}"`);
        return {
          ok: true,
          work: resolvedVisibleWork,
          fromFallback: false,
          openedFromProfile: true,
          autoPlayChecked,
        };
      }
      console.error(`[resolve] [FAIL] 当前页收集失败`);
    } else {
      if (opened.reason === 'target_work_not_found_in_profile_post_api') {
        console.error(`[visit] task=${task.taskId} failed reason=未在主页作品列表中找到目标作品`);
        return openFallbackProfileWork(opened.reason);
      } else {
        console.error(`[visit] task=${task.taskId} failed reason=${opened.reason || '主页打开作品失败'}`);
      }
      return { ok: false, status: 'failed_collect', reason: opened.reason || 'open_profile_work_failed' };
    }
    return { ok: false, status: 'failed_collect', reason: 'opened_work_collect_failed' };
  }

  console.error(`[resolve] [FAIL] 缺少 profileUrl 或 workId`);
  return { ok: false, status: 'failed_collect', reason: 'missing_profile_url_or_work_id' };
}

export async function executeReturnVisitTask(page, task, options = {}) {
  const {
    execute = true,
    pageLoadRetryCount = 1,
    maxWorksToCheck = 3,
    maxReferenceComments = 5,
    waitBetweenLikeAndCommentMs = [500, 1200],
    watchPolicy = 'seconds',
    watchSeconds = [3, 3],
    agentProvider = new LocalAgentProvider(),
  } = options;

  const taskId = task.taskId;
  const userName = task.userName || task.actorName || '';
  const logTag = `[visit][${taskId}]`;

  let commentText = '';
  const taskStartedAt = Date.now();

  console.error(`${logTag} ========== 开始回访: ${userName} ==========`);
  logTimedStep(logTag, 'task_total', 'start', { user: userName || '(unknown)' });

  // [1/5] 解析作品
  console.error(`${logTag} [1/5] 解析作品: 从用户主页打开目标作品...`);
  const resolveStartedAt = Date.now();
  const resolved = await resolveWorkForExecution(page, task, {
    pageLoadRetryCount,
    maxWorksToCheck,
    maxReferenceComments,
  });
  logTimedStep(logTag, 'resolve_work', resolved.ok ? 'done' : 'error', {
    elapsedMs: elapsedMs(resolveStartedAt),
    status: resolved.status || '',
    reason: resolved.reason || '',
  });

  if (!resolved.ok) {
    console.error(`${logTag} [FAIL] 作品解析失败: ${resolved.reason || resolved.status}`);
    const status = resolved.status || 'failed_collect';
    if (status.startsWith('skipped_')) {
      return { ok: false, status, error: resolved.reason || status, likeStatus: task.likeStatus || 'pending', commentStatus: task.commentStatus || 'pending' };
    }
    return { ok: false, status: 'failed_collect', error: resolved.reason || 'resolve_work_failed', likeStatus: task.likeStatus || 'pending', commentStatus: task.commentStatus || 'pending' };
  }

  const resolvedWork = resolved.work;
  console.error(`${logTag} [1/5] 作品解析完成: workId=${resolvedWork.workId} title="${String(resolvedWork.workTitle || '').slice(0, 30)}"`);
  const openedWorkCheck = await blockIfCurrentWorkChanged(page, task, resolvedWork, 'after_open');
  if (openedWorkCheck) return openedWorkCheck;

  // 作品一打开并通过上下文校验后，立刻启动 Agent 生成评论。
  // 后续 3 秒播放门槛、点赞检测/点击都与这段生成并行。
  commentText = String(task.generatedComment || '').trim();
  if (commentText && canReuseGeneratedCommentForWork(task, resolvedWork)) {
    console.error(`[agent] task=${taskId} 复用已生成评论 comment=${commentText}`);
  } else {
    if (commentText) {
      console.error(`[agent] task=${taskId} 丢弃已生成评论: 当前作品上下文已变化`);
      commentText = '';
    }
  }

  // 启动评论生成（后台并行，不阻塞视频观看）
  let commentGenPromise = null;
  let commentGenVisibleError = null;
  let commentGenStartedAt = null;
  let commentGenFinishedAt = null;
  if (!commentText) {
    commentGenStartedAt = Date.now();
    logTimedStep(logTag, 'agent_generate_comment', 'start', {
      phase: 'after_open',
      workId: resolvedWork.workId || '',
    });
    commentGenPromise = (async () => {
      try {
        const contextStartedAt = Date.now();
        const visibleForAgent = await refreshVisibleWorkForComment(page, task, resolvedWork, maxReferenceComments, 'before_agent');
        logTimedStep(logTag, 'agent_visible_context', visibleForAgent.ok ? 'done' : 'error', {
          elapsedMs: elapsedMs(contextStartedAt),
          error: visibleForAgent.error || '',
          reason: visibleForAgent.reason || '',
        });
        if (!visibleForAgent.ok) {
          commentGenVisibleError = visibleForAgent;
          return null;
        }
        const commentContext = buildCommentContext(task, visibleForAgent.work);
        console.error(`[agent] task=${taskId} 打开作品后立即请求生成评论（并行于播放/点赞）`);
        const requestStartedAt = Date.now();
        const text = await agentProvider.generateComment(commentContext);
        commentGenFinishedAt = Date.now();
        logTimedStep(logTag, 'agent_generate_comment', 'done', {
          elapsedMs: elapsedMs(commentGenStartedAt),
          requestMs: elapsedMs(requestStartedAt),
          length: String(text || '').length,
        });
        console.error(`[agent] task=${taskId} 评论生成成功 comment=${text}`);
        return text;
      } catch (err) {
        commentGenFinishedAt = Date.now();
        logTimedStep(logTag, 'agent_generate_comment', 'error', {
          elapsedMs: elapsedMs(commentGenStartedAt),
          error: err.message,
        });
        commentGenVisibleError = { ok: false, error: 'agent_comment_failed', reason: err.message };
        return null;
      }
    })();
  } else {
    logTimedStep(logTag, 'agent_generate_comment', 'skipped', { reason: 'reuse_generated_comment', length: commentText.length });
  }

  // [2/5] 检测页面类型 + 启动视频播放/最短观看门槛（与评论生成并行）
  const presentationStartedAt = Date.now();
  const presentation = await detectWorkPresentationKind(page, resolvedWork);
  logTimedStep(logTag, 'detect_presentation', 'done', {
    elapsedMs: elapsedMs(presentationStartedAt),
    isModal: presentation.isModalPage,
    isNote: presentation.isNotePage,
    hasVideo: presentation.hasVideoElement,
  });
  const currentUrl = presentation.currentUrl;
  const isNotePage = presentation.isNotePage;
  console.error(`${logTag} [2/5] 页面类型: isModal=${presentation.isModalPage} isNote=${isNotePage} hasVideo=${presentation.hasVideoElement}`);

  if (presentation.isModalPage && !resolved.autoPlayChecked) {
    const modalStartedAt = Date.now();
    const modalReady = await waitWithProgress(
      waitForWorkModal(page, { timeoutMs: 8000, closeAutoPlay: true, openCommentArea: false }),
      {
        logTag,
        step: 'modal_ready_before_watch',
        startedAt: modalStartedAt,
        fields: { timeoutMs: 8000, openCommentArea: false },
      }
    );
    if (!modalReady?.ok) {
      console.error(`${logTag} [2/5] [FAIL] modal未就绪: ${modalReady?.message || modalReady?.code}`);
      return { ok: false, status: 'failed_collect', error: modalReady?.message || 'work_modal_not_ready', likeStatus: task.likeStatus || 'pending', commentStatus: task.commentStatus || 'pending', resolvedWork };
    }
    const beforeWatchWorkCheck = await blockIfCurrentWorkChanged(page, task, resolvedWork, 'before_watch');
    if (beforeWatchWorkCheck) return beforeWatchWorkCheck;
  }

  // 最短观看门槛（与评论生成并行）
  if (!isNotePage) {
    console.error(`${logTag} [2/5] 等待最短观看门槛... policy=${watchPolicy} seconds=${watchSeconds}`);
    const watchStartedAt = Date.now();
    await waitForInteractionWatchGate(page, watchPolicy, watchSeconds);
    logTimedStep(logTag, 'watch_gate', 'done', {
      elapsedMs: elapsedMs(watchStartedAt),
      agentDone: Boolean(commentGenFinishedAt),
      agentElapsedMs: commentGenStartedAt ? elapsedMs(commentGenStartedAt) : '',
    });
    console.error(`${logTag} [2/5] 已达到互动门槛，进入点赞评论阶段`);
  } else {
    logTimedStep(logTag, 'watch_gate', 'skipped', { reason: 'note_page' });
    console.error(`${logTag} [2/5] 图文/note，跳过观看门槛`);
  }

  const afterWatchGateWorkCheck = await blockIfCurrentWorkChanged(page, task, resolvedWork, 'after_watch');
  if (afterWatchGateWorkCheck) return afterWatchGateWorkCheck;

  const nextLikeStatus = { value: task.likeStatus || 'pending' };
  const nextCommentStatus = { value: task.commentStatus || 'pending' };

  // [3/5] 点赞
  console.error(`${logTag} [3/5] 检测点赞状态... execute=${execute}`);
  const likeStateStartedAt = Date.now();
  const beforeLikeWorkCheck = await blockIfCurrentWorkChanged(page, task, resolvedWork, 'before_like', {
    likeStatus: nextLikeStatus.value,
    commentStatus: nextCommentStatus.value,
  });
  if (beforeLikeWorkCheck) return beforeLikeWorkCheck;
  const likeState = await checkLikeState(page);
  logTimedStep(logTag, 'check_like_state', likeState.ok ? 'done' : 'error', {
    elapsedMs: elapsedMs(likeStateStartedAt),
    confidence: likeState.data?.confidence || '',
    message: likeState.message || '',
  });
  if (!likeState.ok || likeState.data?.confidence !== 'confirmed') {
    console.error(`${logTag} [3/5] [FAIL] 点赞状态无法确认 confidence=${likeState.data?.confidence}`);
    let debugCandidates = [];
    try {
      debugCandidates = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, [role="button"], a, svg');
        return Array.from(buttons).slice(0, 20).map(el => {
          const rect = el.getBoundingClientRect();
          return { tag: el.tagName.toLowerCase(), className: (el.className || '') + '', ariaLabel: el.getAttribute('aria-label') || '', role: el.getAttribute('role') || '', text: (el.innerText || '').slice(0, 20), visible: rect.width > 0 && rect.height > 0 };
        });
      });
    } catch (err) {
      console.error(`${logTag} 收集点赞 debug 细节异常: ${err.message}`);
    }
    console.error(`${logTag} 页面候选元素:`, JSON.stringify(debugCandidates));
    await saveDebugScreenshot(page, task.taskId, 'like');
    return { ok: false, status: 'failed_like', error: likeState.message || 'like_state_unknown', likeStatus: 'failed', commentStatus: nextCommentStatus.value, resolvedWork };
  }

  const alreadyLiked = likeState.data.alreadyLiked;
  console.error(`${logTag} [3/5] 点赞状态: ${alreadyLiked ? '已赞' : '未赞'}`);

  if (alreadyLiked) {
    nextLikeStatus.value = 'already_liked';
    console.error(`${logTag} [3/5] 跳过点赞(已赞)`);
  } else if (!execute) {
    nextLikeStatus.value = 'pending';
    console.error(`${logTag} [3/5] 跳过点赞(dry-run)`);
  } else {
    console.error(`${logTag} [3/5] 执行点赞点击...`);
    const clickLikeStartedAt = Date.now();
    const clickResult = await clickLike(page, { execute: true });
    logTimedStep(logTag, 'click_like', clickResult.ok ? 'done' : 'error', {
      elapsedMs: elapsedMs(clickLikeStartedAt),
      code: clickResult.code || '',
      message: clickResult.message || '',
    });
    if (!clickResult.ok) {
      if (clickResult.code === 'ALREADY_LIKED') {
        nextLikeStatus.value = 'already_liked';
        console.error(`${logTag} [3/5] 点赞结果: 已赞(接口返回)`);
      } else {
        console.error(`${logTag} [3/5] [FAIL] 点赞失败: ${clickResult.message}`);
        await saveDebugScreenshot(page, task.taskId, 'like_click');
        return { ok: false, status: 'failed_like', error: clickResult.message || 'click_like_failed', likeStatus: 'failed', commentStatus: nextCommentStatus.value, resolvedWork };
      }
    } else {
      console.error(`${logTag} [3/5] 点赞点击完成，确认中...`);
      const confirmLikeStartedAt = Date.now();
      const confirmResult = await confirmLikeSucceeded(page);
      logTimedStep(logTag, 'confirm_like', confirmResult.ok ? 'done' : 'error', {
        elapsedMs: elapsedMs(confirmLikeStartedAt),
        message: confirmResult.message || '',
      });
      if (!confirmResult.ok) {
        console.error(`${logTag} [3/5] 点赞确认未通过: ${confirmResult.message}，继续后续操作`);
        await saveDebugScreenshot(page, task.taskId, 'like_confirm');
      } else {
        console.error(`${logTag} [3/5] 点赞确认通过`);
      }
      nextLikeStatus.value = 'liked';
    }
  }

  // [4/5] 评论
  if (!execute) {
    console.error(`${logTag} [4/5] 跳过评论(dry-run)`);
    return { ok: true, status: 'pending_execute', likeStatus: nextLikeStatus.value, commentStatus: nextCommentStatus.value, resolvedWork, dryRun: true };
  }

  if (task.commentStatus === 'posted') {
    console.error(`[visit] task=${taskId} skipped reason=已评论过`);
    return { ok: false, status: 'skipped_no_suitable_work', error: '已评论过', likeStatus: nextLikeStatus.value, commentStatus: 'posted', resolvedWork };
  }

  console.error(`${logTag} [4/5] 等待发评论... delay=${waitBetweenLikeAndCommentMs}ms`);
  const likeToCommentStartedAt = Date.now();
  const likeToCommentMs = await waitRandom(page, waitBetweenLikeAndCommentMs, 500, 1200);
  logTimedStep(logTag, 'like_to_comment_delay', 'done', {
    elapsedMs: elapsedMs(likeToCommentStartedAt),
    waitedMs: likeToCommentMs,
  });

  const pauseStartedAt = Date.now();
  await pauseCurrentVideo(page);
  logTimedStep(logTag, 'pause_video_before_comment', 'done', { elapsedMs: elapsedMs(pauseStartedAt) });

  const beforeCommentBoxWorkCheck = await blockIfCurrentWorkChanged(page, task, resolvedWork, 'before_comment_box', {
    likeStatus: nextLikeStatus.value,
    commentStatus: nextCommentStatus.value,
  });
  if (beforeCommentBoxWorkCheck) return beforeCommentBoxWorkCheck;

  const commentBoxStartedAt = Date.now();
  const boxReady = await waitWithProgress(
    ensureReturnVisitCommentBoxReady(page, presentation),
    {
      logTag,
      step: 'comment_box_ready',
      startedAt: commentBoxStartedAt,
      fields: {
        isModal: presentation.isModalPage,
        currentUrl: typeof page?.url === 'function' ? page.url() : '',
      },
    }
  );
  if (!boxReady.ok) {
    logTimedStep(logTag, 'comment_box_ready', 'failed', {
      elapsedMs: elapsedMs(commentBoxStartedAt),
      reason: boxReady.reason || '',
      method: boxReady.method || '',
    });
    console.error(`[visit] task=${taskId} failed reason=评论框不存在 detail=${boxReady.reason || ''}`);
    await saveDebugScreenshot(page, task.taskId, 'comment_box');
    return { ok: false, status: 'failed_comment', error: boxReady.reason || 'comment_box_not_found', likeStatus: nextLikeStatus.value, commentStatus: 'failed', resolvedWork };
  }
  logTimedStep(logTag, 'comment_box_ready', 'ready', {
    elapsedMs: elapsedMs(commentBoxStartedAt),
    method: boxReady.method || '',
    reason: boxReady.reason || '',
  });
  console.error(`[visit] task=${taskId} 评论框可用`);

  // 评论生成可能仍在后台进行。点赞已经在 3 秒观看门槛后完成，
  // 到真正发送评论前再等待生成结果，避免 Agent 延迟阻塞点赞动作。
  if (commentGenPromise) {
    const waitAgentStartedAt = Date.now();
    logTimedStep(logTag, 'agent_result_before_comment', 'inspect', {
      alreadyDone: Boolean(commentGenFinishedAt),
      agentElapsedMs: commentGenStartedAt ? elapsedMs(commentGenStartedAt) : '',
    });
    const generated = await waitWithProgress(commentGenPromise, {
      logTag,
      step: 'agent_result_before_comment',
      startedAt: waitAgentStartedAt,
      fields: {
        agentTotalElapsedMs: commentGenStartedAt ? elapsedMs(commentGenStartedAt) : '',
      },
    });
    if (commentGenVisibleError) {
      console.error(`[visit] task=${taskId} failed reason=${commentGenVisibleError.error} detail=${commentGenVisibleError.reason || ''}`);
      await saveDebugScreenshot(page, task.taskId, commentGenVisibleError.error || 'visible_work_before_agent');
      return {
        ok: false,
        status: 'failed_generate_comment',
        error: commentGenVisibleError.error,
        likeStatus: nextLikeStatus.value,
        commentStatus: nextCommentStatus.value,
        resolvedWork,
        data: commentGenVisibleError,
      };
    }
    if (!generated) {
      console.error(`[visit] task=${taskId} failed reason=Agent 生成评论失败`);
      return { ok: false, status: 'failed_generate_comment', error: 'agent_comment_failed', likeStatus: nextLikeStatus.value, commentStatus: nextCommentStatus.value, resolvedWork };
    }
    commentText = generated;
    logTimedStep(logTag, 'agent_result_before_comment', 'accepted', {
      waitElapsedMs: elapsedMs(waitAgentStartedAt),
      agentTotalElapsedMs: commentGenStartedAt ? elapsedMs(commentGenStartedAt) : '',
      length: String(commentText || '').length,
    });
  }

  if (!commentText) {
    console.error(`[visit] task=${taskId} failed reason=评论文本为空`);
    return { ok: false, status: 'failed_generate_comment', error: 'comment_text_empty', likeStatus: nextLikeStatus.value, commentStatus: nextCommentStatus.value, resolvedWork };
  }
  console.error(`${logTag} [4/5] 评论已生成: "${commentText.slice(0, 40)}"`);

  console.error(`${logTag} [5/5] 发送评论: "${commentText.slice(0, 40)}"`);
  const beforeCommentSendWorkCheck = await blockIfCurrentWorkChanged(page, task, resolvedWork, 'before_comment_send', {
    likeStatus: nextLikeStatus.value,
    commentStatus: nextCommentStatus.value,
  });
  if (beforeCommentSendWorkCheck) return beforeCommentSendWorkCheck;
  const visibleBeforeSendStartedAt = Date.now();
  const visibleBeforeSend = await refreshVisibleWorkForComment(page, task, resolvedWork, maxReferenceComments, 'before_comment_send');
  logTimedStep(logTag, 'visible_context_before_send', visibleBeforeSend.ok ? 'done' : 'error', {
    elapsedMs: elapsedMs(visibleBeforeSendStartedAt),
    error: visibleBeforeSend.error || '',
    reason: visibleBeforeSend.reason || '',
  });
  if (!visibleBeforeSend.ok) {
    console.error(`[visit] task=${taskId} failed reason=${visibleBeforeSend.error} detail=${visibleBeforeSend.reason || ''}`);
    await saveDebugScreenshot(page, task.taskId, visibleBeforeSend.error || 'visible_work_before_comment_send');
    return {
      ok: false,
      status: 'failed_comment',
      error: visibleBeforeSend.error,
      likeStatus: nextLikeStatus.value,
      commentStatus: 'failed',
      resolvedWork,
      generatedComment: commentText,
      data: visibleBeforeSend,
    };
  }
  const postCommentStartedAt = Date.now();
  const commentResult = await waitWithProgress(
    postReturnVisitComment(page, commentText, presentation, {
      execute: true,
      expectedWorkId: resolvedWork.workId,
      commentBoxReady: true,
    }),
    {
      logTag,
      step: 'post_comment',
      startedAt: postCommentStartedAt,
      fields: { isModal: presentation.isModalPage },
    }
  );
  logTimedStep(logTag, 'post_comment', commentResult.ok ? 'done_result_ok' : 'done_result_error', {
    elapsedMs: elapsedMs(postCommentStartedAt),
    message: commentResult.message || '',
    code: commentResult.code || '',
  });
  if (!commentResult.ok) {
    console.error(`${logTag} [5/5] [FAIL] 评论失败: ${commentResult.message} url=${page.url()}`);
    console.error(`${logTag} 评论失败详情:`, JSON.stringify(commentResult.data || {}));
    await saveDebugScreenshot(page, task.taskId, 'comment');
    return { ok: false, status: 'failed_comment', error: commentResult.message || 'post_comment_failed', likeStatus: nextLikeStatus.value, commentStatus: 'failed', resolvedWork };
  }

  if (commentResult.data?.unconfirmed) {
    console.error(`${logTag} [5/5] [FAIL] 评论未确认(已发送但未在评论区找到)`);
    await saveDebugScreenshot(page, task.taskId, 'comment_unconfirmed');
    return { ok: false, status: 'failed', error: 'comment_unconfirmed', likeStatus: nextLikeStatus.value, commentStatus: 'failed', resolvedWork, generatedComment: commentText };
  }

  console.error(`${logTag} [5/5] 评论成功 confirmed=true`);
  console.error(`[visit] task=${taskId} 评论填写完成`);
  console.error(`[visit] task=${taskId} 评论提交成功`);
  nextCommentStatus.value = 'posted';

  const done = canMarkDone({ likeStatus: nextLikeStatus.value, commentStatus: nextCommentStatus.value });
  if (!done) {
    console.error(`${logTag} [DONE?] 条件不满足 done=false like=${nextLikeStatus.value} comment=${nextCommentStatus.value}`);
    return { ok: false, status: 'failed', error: 'done_condition_not_met', likeStatus: nextLikeStatus.value, commentStatus: nextCommentStatus.value, resolvedWork };
  }

  console.error(`${logTag} [DONE] 回访完成 like=${nextLikeStatus.value} comment=${nextCommentStatus.value}`);
  logTimedStep(logTag, 'task_total', 'done', { elapsedMs: elapsedMs(taskStartedAt) });
  return { ok: true, status: 'done', likeStatus: nextLikeStatus.value, commentStatus: nextCommentStatus.value, resolvedWork, generatedComment: commentText, executedAt: new Date().toISOString() };
}
