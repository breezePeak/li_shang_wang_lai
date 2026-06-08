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
import { canMarkDone } from './return-visit-task-service.mjs';
import {
  collectCurrentOpenedWork,
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

export async function postReturnVisitComment(page, text, presentation = {}, { execute = false } = {}) {
  if (presentation?.isModalPage) {
    console.error(`[comment] 发评论: modal页, 先打开评论区...`);
    const modalReady = await waitForWorkModal(page, { timeoutMs: 8000, closeAutoPlay: true });
    if (!modalReady?.ok) {
      console.error(`[comment] [FAIL] modal未就绪: ${modalReady?.message || modalReady?.code}`);
      return { ok: false, code: modalReady?.code, message: modalReady?.message || 'work_modal_not_ready', data: modalReady?.data };
    }
    console.error(`[comment] modal就绪, 发送评论...`);
    return postWorkModalComment(page, text);
  }

  console.error(`[comment] 发评论: 视频页...`);
  return postVideoComment(page, text, { execute });
}

export async function ensureReturnVisitCommentBoxReady(page, presentation = {}) {
  if (presentation?.isModalPage) {
    const modalReady = await waitForWorkModal(page, { timeoutMs: 8000, closeAutoPlay: true });
    if (!modalReady?.ok) {
      return { ok: false, reason: modalReady?.message || modalReady?.code || 'work_modal_not_ready', data: modalReady?.data };
    }
    return ensureWorkModalCommentBoxReady(page);
  }

  const panelOpen = await ensureCommentPanelOpen(page);
  if (!panelOpen) return { ok: false, reason: 'comment_panel_not_open' };

  let input = await findCommentInput(page);
  if (!input) {
    const activated = await activateCommentComposer(page);
    if (activated?.ok) {
      await page.waitForTimeout(800);
      input = await findCommentInput(page);
    }
  }

  return input ? { ok: true, method: 'video_comment_input' } : { ok: false, reason: 'comment_input_not_found' };
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
      workId: resolvedWork.workId || task?.targetWork?.workId || '',
      desc: resolvedWork.workText || resolvedWork.desc || resolvedWork.contentSummary || task?.targetWork?.workText || task?.targetWork?.desc || '',
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

async function resolveWorkForExecution(page, task, options = {}) {
  const { pageLoadRetryCount = 1, maxReferenceComments = 5 } = options;
  const knownWorkId = String(task?.targetWork?.workId || '').trim();
  const profileUrl = task?.userProfileUrl;

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
      const fromCurrent = await collectCurrentOpenedWork(page, { maxReferenceComments });
      if (fromCurrent.ok) {
        console.error(`[resolve] 作品收集完成: title="${String(fromCurrent.work.workTitle || '').slice(0, 30)}"`);
        return {
          ok: true,
          work: { ...fromCurrent.work, workId: fromCurrent.work.workId || knownWorkId },
          fromFallback: false,
          openedFromProfile: true,
        };
      }
      console.error(`[resolve] [FAIL] 当前页收集失败`);
    } else {
      if (opened.reason === 'target_work_not_found_in_profile_post_api') {
        console.error(`[visit] task=${task.taskId} failed reason=未在主页作品列表中找到目标作品`);
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
    waitBetweenLikeAndCommentMs = [2000, 6000],
    watchPolicy = 'seconds',
    watchSeconds = [5, 8],
    agentProvider = new LocalAgentProvider(),
  } = options;

  const taskId = task.taskId;
  const userName = task.userName || task.actorName || '';
  const logTag = `[visit][${taskId}]`;

  console.error(`${logTag} ========== 开始回访: ${userName} ==========`);

  // [1/5] 解析作品
  console.error(`${logTag} [1/5] 解析作品: 从用户主页打开目标作品...`);
  const resolved = await resolveWorkForExecution(page, task, {
    pageLoadRetryCount,
    maxWorksToCheck,
    maxReferenceComments,
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

  // [2/5] 检测页面类型 + 观看视频
  const presentation = await detectWorkPresentationKind(page, resolvedWork);
  const currentUrl = presentation.currentUrl;
  const isNotePage = presentation.isNotePage;
  console.error(`${logTag} [2/5] 页面类型: isModal=${presentation.isModalPage} isNote=${isNotePage} hasVideo=${presentation.hasVideoElement}`);

  if (!isNotePage) {
    console.error(`${logTag} [2/5] 观看视频中... policy=${watchPolicy} seconds=${watchSeconds}`);
    await handleVideoWatch(page, watchPolicy, watchSeconds);
    console.error(`${logTag} [2/5] 观看完成`);
  } else {
    console.error(`${logTag} [2/5] 图文/note，跳过观看`);
  }

  const nextLikeStatus = { value: task.likeStatus || 'pending' };
  const nextCommentStatus = { value: task.commentStatus || 'pending' };

  // [3/5] 点赞
  console.error(`${logTag} [3/5] 检测点赞状态... execute=${execute}`);
  const likeState = await checkLikeState(page);
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
    const clickResult = await clickLike(page, { execute: true });
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
      const confirmResult = await confirmLikeSucceeded(page);
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
  await waitRandom(page, waitBetweenLikeAndCommentMs, 2000, 6000);

  const boxReady = await ensureReturnVisitCommentBoxReady(page, presentation);
  if (!boxReady.ok) {
    console.error(`[visit] task=${taskId} failed reason=评论框不存在 detail=${boxReady.reason || ''}`);
    await saveDebugScreenshot(page, task.taskId, 'comment_box');
    return { ok: false, status: 'failed_comment', error: boxReady.reason || 'comment_box_not_found', likeStatus: nextLikeStatus.value, commentStatus: 'failed', resolvedWork };
  }
  console.error(`[visit] task=${taskId} 评论框可用，进入 WAIT_AGENT_COMMENT`);

  let commentText = '';
  try {
    const commentContext = buildCommentContext(task, resolvedWork);
    console.error(`[agent] task=${taskId} 请求生成评论`);
    commentText = await agentProvider.generateComment(commentContext);
    console.error(`[agent] task=${taskId} 评论生成成功 comment=${commentText}`);
  } catch (err) {
    console.error(`[visit] task=${taskId} failed reason=Agent 生成评论失败: ${err.message}`);
    return { ok: false, status: 'failed_generate_comment', error: err.message || 'agent_comment_failed', likeStatus: nextLikeStatus.value, commentStatus: nextCommentStatus.value, resolvedWork };
  }

  console.error(`${logTag} [5/5] 发送评论: "${commentText.slice(0, 40)}"`);
  const commentResult = await postReturnVisitComment(page, commentText, presentation, { execute: true });
  if (!commentResult.ok) {
    console.error(`${logTag} [5/5] [FAIL] 评论失败: ${commentResult.message} url=${page.url()}`);
    console.error(`${logTag} 评论失败详情:`, JSON.stringify(commentResult.data || {}));
    await saveDebugScreenshot(page, task.taskId, 'comment');
    return { ok: false, status: 'failed_comment', error: commentResult.message || 'post_comment_failed', likeStatus: nextLikeStatus.value, commentStatus: 'failed', resolvedWork };
  }

  if (commentResult.data?.unconfirmed) {
    console.error(`${logTag} [5/5] [FAIL] 评论未确认(已发送但未在评论区找到)`);
    await saveDebugScreenshot(page, task.taskId, 'comment_unconfirmed');
    return { ok: false, status: 'failed_comment', error: 'comment_unconfirmed', likeStatus: nextLikeStatus.value, commentStatus: 'failed', resolvedWork };
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
  return { ok: true, status: 'done', likeStatus: nextLikeStatus.value, commentStatus: nextCommentStatus.value, resolvedWork, generatedComment: commentText, executedAt: new Date().toISOString() };
}
