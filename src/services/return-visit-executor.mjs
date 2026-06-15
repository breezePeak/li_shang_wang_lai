import fs from 'fs';
import path from 'path';
import {
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
  collectCandidateAwemesFromProfile,
  collectCurrentOpenedWork,
  extractWorkIdFromUrl,
  openProfileWorkByAwemeId,
} from './return-visit-work-collector.mjs';
import { LocalAgentProvider } from '../agent/local-agent-provider.mjs';
import { DEFAULT_RETURN_VISIT_MAX_WORKS_TO_CHECK } from '../config/defaults.mjs';
import { getDb } from '../db/database.mjs';

const FIXED_UPDATE_REQUEST_COMMENT = '蹲个更新呀～';

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

function createCheckedWorkEntry(candidate = {}, patch = {}) {
  return {
    workId: candidate.workId || candidate.awemeId || '',
    workUrl: candidate.workUrl || '',
    userDigged: candidate.userDigged ?? null,
    likeState: patch.likeState || null,
    likeStateSource: patch.likeStateSource || null,
    action: patch.action || 'skip',
    reason: patch.reason || null,
  };
}

function getFixedUpdateRequestComment() {
  return FIXED_UPDATE_REQUEST_COMMENT;
}

function areAllCheckedWorksAlreadyLiked(checkedWorks = [], candidateCount = 0) {
  return candidateCount > 0
    && checkedWorks.length >= candidateCount
    && checkedWorks.every(item => item?.likeState === 'already_liked');
}

function pickFallbackUpdateRequestCandidate(candidates = []) {
  const firstNonTop = candidates.find(candidate => Number(candidate?.isTop) !== 1);
  return firstNonTop || candidates[0] || null;
}

export function findPostedUpdateRequestCommentByWork(workId, commentText = FIXED_UPDATE_REQUEST_COMMENT) {
  const normalizedWorkId = String(workId || '').trim();
  const normalizedComment = String(commentText || '').trim();
  if (!normalizedWorkId || !normalizedComment) return null;

  const db = getDb();
  return db.prepare(`
    SELECT
      id,
      task_id,
      user_name,
      target_work_id,
      generated_comment,
      comment_status,
      status,
      executed_at,
      updated_at
    FROM return_visit_tasks
    WHERE target_work_id = ?
      AND comment_status = 'posted'
      AND generated_comment = ?
    ORDER BY COALESCE(executed_at, updated_at) DESC, id DESC
    LIMIT 1
  `).get(normalizedWorkId, normalizedComment) || null;
}

async function resolveWorkForExecution(page, task, options = {}) {
  const {
    pageLoadRetryCount = 1,
    maxWorksToCheck = DEFAULT_RETURN_VISIT_MAX_WORKS_TO_CHECK,
  } = options;
  const profileUrl = task?.userProfileUrl;

  if (!profileUrl) {
    console.error('[resolve] [FAIL] 缺少 profileUrl');
    return { ok: false, status: 'failed_collect', reason: 'missing_profile_url' };
  }

  console.error(`[visit] task=${task.taskId} 打开用户主页 profileUrl=${profileUrl}`);
  const selected = await collectCandidateAwemesFromProfile(page, profileUrl, {
    pageLoadRetryCount,
    maxWorksToCheck,
  });

  if (!selected.ok) {
    const reason = selected.reason || 'select_profile_work_failed';
    if (selected.status === 'skipped_private') {
      return { ok: false, status: 'skipped_private', reason };
    }
    if (selected.status === 'skipped_no_work') {
      return { ok: false, status: 'skipped_no_work', reason };
    }
    if (selected.status === 'skipped_no_suitable_work') {
      return { ok: false, status: 'skipped_no_suitable_work', reason };
    }
    return { ok: false, status: 'failed_collect', reason };
  }

  return {
    ok: true,
    candidates: selected.candidates || [],
    stats: selected.stats || null,
  };
}

export async function executeReturnVisitTask(page, task, options = {}) {
  const {
    execute = true,
    pageLoadRetryCount = 1,
    maxWorksToCheck = DEFAULT_RETURN_VISIT_MAX_WORKS_TO_CHECK,
    maxReferenceComments = 5,
    waitBetweenLikeAndCommentMs = [2000, 3000],
    watchPolicy = 'seconds',
    watchSeconds = [3, 3],
    agentProvider = new LocalAgentProvider(),
    allLikedFallbackEnabled = true,
    allLikedFallbackComments = [],
  } = options;

  const taskId = task.taskId;
  const userName = task.userName || task.actorName || '';
  const logTag = `[visit][${taskId}]`;

  const taskStartedAt = Date.now();

  console.error(`${logTag} ========== 开始回访: ${userName} ==========`);
  logTimedStep(logTag, 'task_total', 'start', { user: userName || '(unknown)' });

  // [1/5] 解析作品
  console.error(`${logTag} [1/5] 解析作品: 从用户主页打开目标作品...`);
  const resolveStartedAt = Date.now();
  const resolved = await resolveWorkForExecution(page, task, {
    pageLoadRetryCount,
    maxWorksToCheck,
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
      return {
        ok: false,
        status,
        error: resolved.reason || status,
        likeStatus: task.likeStatus || 'pending',
        commentStatus: task.commentStatus || 'pending',
        checkedWorks: [],
      };
    }
    return {
      ok: false,
      status: 'failed_collect',
      error: resolved.reason || 'resolve_work_failed',
      likeStatus: task.likeStatus || 'pending',
      commentStatus: task.commentStatus || 'pending',
      checkedWorks: [],
    };
  }

  const candidates = Array.isArray(resolved.candidates) ? resolved.candidates : [];
  if (candidates.length === 0) {
    return {
      ok: false,
      status: 'skipped_no_work',
      error: 'no_candidate_work',
      likeStatus: task.likeStatus || 'pending',
      commentStatus: task.commentStatus || 'pending',
      checkedWorks: [],
    };
  }

  async function openCandidateWork(candidate) {
    const candidateWorkId = String(candidate?.workId || candidate?.awemeId || '').trim();
    const opened = await openProfileWorkByAwemeId(page, task.userProfileUrl, candidateWorkId, {
      pageLoadRetryCount,
      reuseCurrentProfile: true,
    });
    if (!opened.ok) {
      return { ok: false, status: 'failed_collect', reason: opened.reason || 'open_profile_work_failed' };
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
      return { ok: false, status: 'failed_collect', reason: 'opened_work_collect_failed' };
    }

    const currentWorkId = normalizeWorkId(fromCurrent.work?.workId || '');
    if (currentWorkId && currentWorkId !== normalizeWorkId(candidateWorkId)) {
      return {
        ok: false,
        status: 'failed_collect',
        reason: 'opened_work_id_mismatch',
        expectedWorkId: candidateWorkId,
        actualWorkId: fromCurrent.work.workId,
      };
    }

    return {
      ok: true,
      work: mergeWorkContext(opened.aweme || candidate, fromCurrent.work, candidateWorkId),
      autoPlayChecked,
    };
  }

  async function generateNormalComment(resolvedWork) {
    let commentText = String(task.generatedComment || '').trim();
    if (commentText && canReuseGeneratedCommentForWork(task, resolvedWork)) {
      console.error(`[agent] task=${taskId} 复用已生成评论 comment=${commentText}`);
      return { ok: true, commentText };
    }
    if (commentText) {
      console.error(`[agent] task=${taskId} 丢弃已生成评论: 当前作品上下文已变化`);
    }

    const visibleForAgent = await refreshVisibleWorkForComment(page, task, resolvedWork, maxReferenceComments, 'before_agent');
    if (!visibleForAgent.ok) {
      return {
        ok: false,
        status: 'failed_generate_comment',
        error: visibleForAgent.error,
        data: visibleForAgent,
      };
    }

    const commentContext = buildCommentContext(task, visibleForAgent.work);
    console.error(`[agent] task=${taskId} 请求生成普通回访评论`);
    try {
      const generated = await agentProvider.generateComment(commentContext);
      const text = String(generated || '').trim();
      if (!text) {
        return { ok: false, status: 'failed_generate_comment', error: 'comment_text_empty' };
      }
      return { ok: true, commentText: text };
    } catch (err) {
      return { ok: false, status: 'failed_generate_comment', error: 'agent_comment_failed', data: { reason: err.message } };
    }
  }

  async function postCommentForResolvedWork(resolvedWork, presentation, likeStatus, selectionMode, commentText) {
    if (task.commentStatus === 'posted') {
      console.error(`[visit] task=${taskId} skipped reason=已评论过`);
      return {
        ok: false,
        status: 'skipped_no_suitable_work',
        error: '已评论过',
        likeStatus,
        commentStatus: 'posted',
        resolvedWork,
        selectionMode,
      };
    }

    if (!execute) {
      return {
        ok: true,
        status: 'pending_execute',
        likeStatus,
        commentStatus: task.commentStatus || 'pending',
        resolvedWork,
        selectionMode,
        checkedWorks,
        dryRun: true,
        plannedAction: selectionMode === 'all_liked_update_request' ? 'update_request_comment' : 'like_and_comment',
        generatedComment: commentText || null,
      };
    }

    console.error(`${logTag} [4/5] 等待发评论... delay=${waitBetweenLikeAndCommentMs}ms`);
    const likeToCommentMs = await waitRandom(page, waitBetweenLikeAndCommentMs, 2000, 3000);
    logTimedStep(logTag, 'like_to_comment_delay', 'done', { waitedMs: likeToCommentMs });

    await pauseCurrentVideo(page);

    const beforeCommentBoxWorkCheck = await blockIfCurrentWorkChanged(page, task, resolvedWork, 'before_comment_box', {
      likeStatus,
      commentStatus: task.commentStatus || 'pending',
    });
    if (beforeCommentBoxWorkCheck) return { ...beforeCommentBoxWorkCheck, selectionMode, checkedWorks };

    const boxReady = await ensureReturnVisitCommentBoxReady(page, presentation);
    if (!boxReady.ok) {
      await saveDebugScreenshot(page, task.taskId, 'comment_box');
      return {
        ok: false,
        status: 'failed_comment',
        error: boxReady.reason || 'comment_box_not_found',
        likeStatus,
        commentStatus: 'failed',
        resolvedWork,
        selectionMode,
        checkedWorks,
      };
    }

    let finalCommentText = String(commentText || '').trim();
    if (!finalCommentText && selectionMode === 'normal_unliked') {
      const generated = await generateNormalComment(resolvedWork);
      if (!generated.ok) {
        return {
          ok: false,
          status: generated.status,
          error: generated.error,
          likeStatus,
          commentStatus: task.commentStatus || 'pending',
          resolvedWork,
          selectionMode,
          checkedWorks,
          data: generated.data,
        };
      }
      finalCommentText = generated.commentText;
    }

    if (!finalCommentText) {
      return {
        ok: false,
        status: 'failed_generate_comment',
        error: 'comment_text_empty',
        likeStatus,
        commentStatus: task.commentStatus || 'pending',
        resolvedWork,
        selectionMode,
        checkedWorks,
      };
    }

    if (selectionMode === 'all_liked_update_request') {
      const existingUpdateRequest = findPostedUpdateRequestCommentByWork(resolvedWork.workId, finalCommentText);
      if (existingUpdateRequest) {
        console.error(
          `[visit] task=${taskId} 数据库已记录该作品发过期待更新评论，跳过重复发送` +
          ` previous_task=${existingUpdateRequest.task_id || ''} work=${existingUpdateRequest.target_work_id || ''}`
        );
        return {
          ok: true,
          status: 'done',
          likeStatus,
          commentStatus: 'posted',
          resolvedWork,
          selectionMode,
          checkedWorks,
          generatedComment: finalCommentText,
          skipPostBecauseExistingComment: true,
          existingCommentMatch: existingUpdateRequest,
        };
      }
    }

    const beforeCommentSendWorkCheck = await blockIfCurrentWorkChanged(page, task, resolvedWork, 'before_comment_send', {
      likeStatus,
      commentStatus: task.commentStatus || 'pending',
    });
    if (beforeCommentSendWorkCheck) return { ...beforeCommentSendWorkCheck, selectionMode, checkedWorks };

    if (selectionMode === 'normal_unliked') {
      const visibleBeforeSend = await refreshVisibleWorkForComment(page, task, resolvedWork, maxReferenceComments, 'before_comment_send');
      if (!visibleBeforeSend.ok) {
        await saveDebugScreenshot(page, task.taskId, visibleBeforeSend.error || 'visible_work_before_comment_send');
        return {
          ok: false,
          status: 'failed_comment',
          error: visibleBeforeSend.error,
          likeStatus,
          commentStatus: 'failed',
          resolvedWork,
          selectionMode,
          checkedWorks,
          generatedComment: finalCommentText,
          data: visibleBeforeSend,
        };
      }
    }

    const commentResult = await postReturnVisitComment(page, finalCommentText, presentation, {
      execute: true,
      expectedWorkId: resolvedWork.workId,
      commentBoxReady: true,
    });
    if (!commentResult.ok) {
      await saveDebugScreenshot(page, task.taskId, 'comment');
      return {
        ok: false,
        status: 'failed_comment',
        error: commentResult.message || 'post_comment_failed',
        likeStatus,
        commentStatus: 'failed',
        resolvedWork,
        selectionMode,
        checkedWorks,
      };
    }

    if (commentResult.data?.unconfirmed) {
      await saveDebugScreenshot(page, task.taskId, 'comment_unconfirmed');
      return {
        ok: false,
        status: 'failed',
        error: 'comment_unconfirmed',
        likeStatus,
        commentStatus: 'failed',
        resolvedWork,
        selectionMode,
        checkedWorks,
        generatedComment: finalCommentText,
      };
    }

    const finalCommentStatus = 'posted';
    const done = canMarkDone({ likeStatus, commentStatus: finalCommentStatus });
    if (!done) {
      return {
        ok: false,
        status: 'failed',
        error: 'done_condition_not_met',
        likeStatus,
        commentStatus: finalCommentStatus,
        resolvedWork,
        selectionMode,
        checkedWorks,
      };
    }

    return {
      ok: true,
      status: 'done',
      likeStatus,
      commentStatus: finalCommentStatus,
      resolvedWork,
      selectionMode,
      checkedWorks,
      generatedComment: finalCommentText,
      executedAt: new Date().toISOString(),
    };
  }

  const checkedWorks = [];
  let missingApiLikeStateCount = 0;

  for (const candidate of candidates) {
    if (candidate.userDigged === 1) {
      checkedWorks.push(createCheckedWorkEntry(candidate, {
        likeState: 'already_liked',
        likeStateSource: 'post_api',
        action: 'skip',
        reason: 'already_liked_in_post_api',
      }));
      continue;
    }
    if (candidate.userDigged !== 0) {
      checkedWorks.push(createCheckedWorkEntry(candidate, {
        likeState: 'unknown',
        likeStateSource: 'post_api',
        action: 'skip',
        reason: 'user_digged_missing_in_post_api',
      }));
      missingApiLikeStateCount++;
      continue;
    }

    const opened = await openCandidateWork(candidate);
    if (!opened.ok) {
      if (opened.reason === 'opened_work_id_mismatch' || opened.reason === 'work_modal_not_ready') {
        return {
          ok: false,
          status: opened.status || 'failed_collect',
          error: opened.reason || 'open_candidate_failed',
          likeStatus: task.likeStatus || 'pending',
          commentStatus: task.commentStatus || 'pending',
          checkedWorks,
        };
      }
      checkedWorks.push(createCheckedWorkEntry(candidate, {
        action: 'skip',
        reason: opened.reason || 'open_candidate_failed',
      }));
      continue;
    }

    const resolvedWork = opened.work;
    const openedWorkCheck = await blockIfCurrentWorkChanged(page, task, resolvedWork, 'after_open');
    if (openedWorkCheck) {
      return { ...openedWorkCheck, checkedWorks };
    }

    const selectionMode = 'normal_unliked';
    const tentativeCheckedWorks = checkedWorks.concat([
      createCheckedWorkEntry(candidate, {
        likeState: 'not_liked',
        likeStateSource: 'post_api',
        action: execute ? 'like_and_comment' : 'plan_like_and_comment',
        reason: 'selected_unliked_candidate',
      }),
    ]);

    const presentation = await detectWorkPresentationKind(page, resolvedWork);
    const isNotePage = presentation.isNotePage;
    console.error(`${logTag} [2/5] 页面类型: isModal=${presentation.isModalPage} isNote=${isNotePage} hasVideo=${presentation.hasVideoElement}`);

    if (presentation.isModalPage && !opened.autoPlayChecked) {
      const modalReady = await waitForWorkModal(page, { timeoutMs: 8000, closeAutoPlay: true, openCommentArea: false });
      if (!modalReady?.ok) {
        return {
          ok: false,
          status: 'failed_collect',
          error: modalReady?.message || 'work_modal_not_ready',
          likeStatus: task.likeStatus || 'pending',
          commentStatus: task.commentStatus || 'pending',
          resolvedWork,
          selectionMode,
          checkedWorks: tentativeCheckedWorks,
        };
      }
    }

    if (!isNotePage) {
      await waitForInteractionWatchGate(page, watchPolicy, watchSeconds);
    }

    const afterWatchGateWorkCheck = await blockIfCurrentWorkChanged(page, task, resolvedWork, 'after_watch');
    if (afterWatchGateWorkCheck) return { ...afterWatchGateWorkCheck, selectionMode, checkedWorks: tentativeCheckedWorks };

    if (!execute) {
      return {
        ok: true,
        status: 'pending_execute',
        likeStatus: 'pending',
        commentStatus: task.commentStatus || 'pending',
        resolvedWork,
        selectionMode,
        checkedWorks: tentativeCheckedWorks,
        dryRun: true,
        plannedAction: 'like_and_comment',
      };
    }

    const clickResult = await clickLike(page, { execute: true });
    if (!clickResult.ok) {
      if (clickResult.code === 'ALREADY_LIKED') {
        checkedWorks.push(createCheckedWorkEntry(candidate, {
          likeState: 'already_liked',
          likeStateSource: 'dom',
          action: 'skip',
          reason: 'already_liked_on_click',
        }));
        continue;
      }
      await saveDebugScreenshot(page, task.taskId, 'like_click');
      return {
        ok: false,
        status: 'failed_like',
        error: clickResult.message || 'click_like_failed',
        likeStatus: 'failed',
        commentStatus: task.commentStatus || 'pending',
        resolvedWork,
        selectionMode,
        checkedWorks: tentativeCheckedWorks,
      };
    }

    const confirmResult = await confirmLikeSucceeded(page);
    if (!confirmResult.ok) {
      await saveDebugScreenshot(page, task.taskId, 'like_confirm');
    }

    return postCommentForResolvedWork(
      resolvedWork,
      presentation,
      'liked',
      selectionMode,
      '',
    ).then(result => ({ ...result, checkedWorks: tentativeCheckedWorks }));
  }

  if (areAllCheckedWorksAlreadyLiked(checkedWorks, candidates.length) && allLikedFallbackEnabled) {
    const fallbackCandidate = pickFallbackUpdateRequestCandidate(candidates);
    const fallbackIndex = candidates.findIndex(candidate => candidate?.workId === fallbackCandidate?.workId);
    const opened = await openCandidateWork(fallbackCandidate);
    if (!opened.ok) {
      return {
        ok: false,
        status: opened.status || 'failed_collect',
        error: opened.reason || 'open_fallback_profile_work_failed',
        likeStatus: 'already_liked',
        commentStatus: task.commentStatus || 'pending',
        checkedWorks,
      };
    }

    const resolvedWork = opened.work;
    const selectionMode = 'all_liked_update_request';
    const presentation = await detectWorkPresentationKind(page, resolvedWork);
    const fallbackComment = getFixedUpdateRequestComment();
    const fallbackCheckedWorks = checkedWorks.slice();
    if (fallbackIndex >= 0 && fallbackCheckedWorks[fallbackIndex]) {
      fallbackCheckedWorks[fallbackIndex] = {
        ...fallbackCheckedWorks[fallbackIndex],
        action: execute ? 'update_request_comment' : 'plan_update_request_comment',
        reason: 'all_candidates_already_liked',
      };
    }

    return postCommentForResolvedWork(
      resolvedWork,
      presentation,
      'already_liked',
      selectionMode,
      fallbackComment,
    ).then(result => ({ ...result, checkedWorks: fallbackCheckedWorks }));
  }

  return {
    ok: false,
    status: 'skipped_no_suitable_work',
    error: missingApiLikeStateCount >= candidates.length
      ? 'all_candidate_user_digged_missing'
      : `no_suitable_work_in_first_${candidates.length}`,
    likeStatus: task.likeStatus || 'pending',
    commentStatus: task.commentStatus || 'pending',
    checkedWorks,
    selectionMode: null,
  };
}
