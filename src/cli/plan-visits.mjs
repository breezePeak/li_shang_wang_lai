// 统一作品回访计划命令（第一阶段：候选预览）
//
// 读取评论事件和点赞事件，为每个互动用户生成回访候选。
// 同一用户指向同一目标作品时合并为一条 visit_work。
// 第一阶段仅预览，不执行真实点赞和评论。
//
// 用法：
//   npm run visits:plan -- --source all --json
//   npm run visits:plan -- --source like --json
//   npm run visits:plan -- --source comment --json

import { getEvents } from '../db/interaction-repository.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { createBrowserContext } from '../browser/browser-context.mjs';
import {
  ensureNotificationPageReady,
  openNotificationPanel,
  closeNotificationPanel,
  clickLikeProfileLink,
} from '../adapters/notification-page.mjs';
import { navigateToProfile } from '../adapters/user-profile-page.mjs';
import { findLatestNonPinnedVideo } from '../adapters/user-profile-page.mjs';
import { navigateToVideo, checkLikeState, getVideoTitle } from '../adapters/video-page.mjs';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';

function parseArgs(argv) {
  const args = { source: 'all' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source' && argv[i + 1]) args.source = argv[++i];
  }
  return args;
}

/**
 * Process one interaction event into a visit candidate.
 * Handles both comment and like source events.
 */
async function processSourceEvent(page, event, sourceType) {
  const r = {
    sourceEventTypes: [sourceType],
    sourceEventIds: [event.id],
    actorName: event.actor_name,
    actorProfileUrl: event.actor_profile_url || '',
    actorProfileKey: event.actor_profile_key || '',
    relation: event.relation || 'unknown',
    targetVideoUrl: '',
    targetVideoId: null,
    targetVideoTitle: '',
    likeState: 'unknown',
    status: 'blocked',
    reason: '',
    code: '',
    previewOnly: true,
    executeAllowed: false,
  };

  console.error(`\n[visits:plan] ${event.actor_name} [${sourceType}]`);

  // Navigate to user profile
  if (event.actor_profile_url) {
    r.actorProfileUrl = event.actor_profile_url;
    console.error(`[visits:plan]   主页(来自扫描): ${r.actorProfileUrl.slice(0, 60)}`);
    await page.goto(r.actorProfileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
  } else if (sourceType === 'like') {
    // Use notification panel click for like sources
    const clicked = await clickLikeProfileLink(page, {
      username: event.actor_name,
      relation: event.relation,
      action: '赞了你的作品',
      timeText: event.event_time_text,
    });
    if (!clicked) {
      r.status = 'blocked';
      r.reason = `通知面板中未找到 ${event.actor_name} 的精确匹配条目`;
      return r;
    }
    r.actorProfileUrl = page.url();
    console.error(`[visits:plan]   主页(来自通知): ${r.actorProfileUrl.slice(0, 60)}`);
  } else {
    // Search for comment user profile
    const profileResult = await navigateToProfile(page, event.actor_name);
    if (!profileResult.ok) {
      r.status = 'blocked';
      r.reason = `无法找到用户 "${event.actor_name}" 的主页: ${profileResult.message}`;
      r.code = profileResult.code;
      return r;
    }
    r.actorProfileUrl = page.url();
    console.error(`[visits:plan]   主页(来自搜索): ${r.actorProfileUrl.slice(0, 60)}`);
  }

  // Find latest non-pinned video
  const videoResult = await findLatestNonPinnedVideo(page);
  if (!videoResult.ok) {
    r.status = 'blocked';
    r.reason = videoResult.message;
    r.code = videoResult.code;
    return r;
  }
  r.targetVideoUrl = videoResult.data.videoUrl;
  r.targetVideoId = videoResult.data.videoId || null;
  console.error(`[visits:plan]   最新视频: ${r.targetVideoUrl.slice(0, 60)}`);

  await page.waitForTimeout(2000);

  // Navigate to video, check like state
  const navResult = await navigateToVideo(page, videoResult.data.videoUrl);
  if (!navResult.ok) {
    r.status = 'blocked';
    r.reason = navResult.message;
    r.code = navResult.code;
    return r;
  }

  const likeResult = await checkLikeState(page);
  if (!likeResult.ok || likeResult.data.confidence !== 'confirmed') {
    r.status = 'blocked';
    r.likeState = 'unknown';
    r.reason = '点赞状态未确认';
    r.code = 'LIKE_STATE_UNKNOWN';
    return r;
  }

  if (likeResult.data.alreadyLiked) {
    r.status = 'skipped';
    r.likeState = 'already_liked';
    r.reason = '目标作品已点赞，本次回访跳过，不再评论。';
    return r;
  }

  const titleResult = await getVideoTitle(page);
  if (titleResult.ok && titleResult.data.title) {
    r.targetVideoTitle = titleResult.data.title;
  }

  r.status = 'planned';
  r.likeState = 'not_liked';
  r.reason = '';
  return r;
}

function mergeByTargetUrl(items) {
  const map = new Map();
  for (const item of items) {
    if (!item.targetVideoUrl) {
      // blocked items: keep as-is
      const key = `__direct_${item.actorName}_${item.sourceEventIds.join(',')}`;
      map.set(key, item);
      continue;
    }
    const key = `${item.actorName}||${item.targetVideoUrl}`;
    if (map.has(key)) {
      const existing = map.get(key);
      existing.sourceEventTypes = [...new Set([...existing.sourceEventTypes, ...item.sourceEventTypes])];
      existing.sourceEventIds = [...new Set([...existing.sourceEventIds, ...item.sourceEventIds])];
      // Prefer the better status: planned > skipped > blocked
      const statusPriority = { planned: 3, skipped: 2, blocked: 1 };
      if (statusPriority[item.status] > statusPriority[existing.status]) {
        existing.status = item.status;
        existing.reason = item.reason;
        existing.likeState = item.likeState;
      }
      if (!existing.targetVideoTitle && item.targetVideoTitle) {
        existing.targetVideoTitle = item.targetVideoTitle;
      }
      existing.code = existing.code || item.code;
    } else {
      map.set(key, item);
    }
  }
  return Array.from(map.values());
}

async function main() {
  runMigrations();

  const commonArgs = parseCommonArgs(process.argv.slice(2));
  const cmdArgs = parseArgs(commonArgs.remaining);
  const source = ['all', 'like', 'comment'].includes(cmdArgs.source) ? cmdArgs.source : 'all';

  // Read events
  const likeEvents = (source === 'all' || source === 'like')
    ? getEvents({ eventType: 'like', status: 'new', limit: 20 }) : [];
  const commentEvents = (source === 'all' || source === 'comment')
    ? getEvents({ eventType: 'comment', status: 'new', limit: 20 }) : [];

  const allEvents = [...likeEvents.map(e => ({ ...e, _sourceType: 'like' })),
                     ...commentEvents.map(e => ({ ...e, _sourceType: 'comment' }))];

  if (allEvents.length === 0) {
    if (commonArgs.options.json) {
      printJsonResult('visits:plan', { candidates: [] }, { total: 0, planned: 0, skipped: 0, blocked: 0 });
    } else {
      console.error('[visits:plan] 没有待处理事件。先运行 npm run interactions:scan');
    }
    return;
  }

  console.error(`[visits:plan] 找到 ${likeEvents.length} 点赞 + ${commentEvents.length} 评论事件 (来源: ${source})`);

  const run = createRunContext('plan-visits', commonArgs.options);
  let browser = null;
  let page = null;
  const items = [];

  try {
    console.error('[visits:plan] 启动浏览器...');
    const ctx = await createBrowserContext({ headless: false, enableReuse: commonArgs.options.keepOpen });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    // For like events: open notification panel first
    const hasLikeEvents = likeEvents.length > 0;
    if (hasLikeEvents) {
      console.error('[visits:plan] 导航到个人主页并打开通知面板...');
      await ensureNotificationPageReady(page);
      const panelOpen = await openNotificationPanel(page);
      if (!panelOpen) {
        run.hadBlocked = true;
        if (commonArgs.options.json) {
          printJsonError('visits:plan', RESULT_CODES.NOTIFICATION_PANEL_NOT_FOUND,
            '无法打开通知面板，like 来源事件无法处理', { recoverable: true }); return;
        }
        console.error('[visits:plan] 无法打开通知面板，跳过 like 来源');
      }
    }

    for (let i = 0; i < allEvents.length; i++) {
      const ev = allEvents[i];
      const item = await processSourceEvent(page, ev, ev._sourceType);
      items.push(item);

      if (i < allEvents.length - 1 && ev._sourceType === 'like') {
        // Go back and reopen notification panel for next like item
        await ensureNotificationPageReady(page);
        await openNotificationPanel(page);
        await page.waitForTimeout(1000);
      }
    }

    if (hasLikeEvents) {
      await closeNotificationPanel(page);
    }

    // Merge same user + same target URL
    const merged = mergeByTargetUrl(items);

    const planned = merged.filter(i => i.status === 'planned').length;
    const skipped = merged.filter(i => i.status === 'skipped').length;
    const blocked = merged.filter(i => i.status === 'blocked').length;

    run.scanned = allEvents.length;
    run.planned = planned;
    run.skipped = skipped;
    run.blocked = blocked;
    saveRunSummary(run);

    console.error(`\n===== 汇总 =====`);
    console.error(`  计划: ${planned} | 跳过: ${skipped} | 阻塞: ${blocked} | 合计: ${merged.length}`);

    if (planned > 0) {
      console.error('\n===== 回访候选 =====');
      for (const item of merged) {
        if (item.status === 'planned') {
          console.error(`  [${item.sourceEventIds.join(',')}] ${item.actorName} [${item.relation}]`);
          if (item.targetVideoUrl) console.error(`    视频: ${item.targetVideoUrl}`);
          if (item.targetVideoTitle) console.error(`    标题: ${item.targetVideoTitle.slice(0, 60)}`);
          console.error(`    来源: ${item.sourceEventTypes.join('+')} | previewOnly`);
          console.error('');
        }
      }
    }

    if (commonArgs.options.json) {
      printJsonResult('visits:plan', {
        candidates: merged.map(i => ({
          sourceEventTypes: i.sourceEventTypes,
          sourceEventIds: i.sourceEventIds,
          actorName: i.actorName,
          actorProfileUrl: i.actorProfileUrl || null,
          relation: i.relation,
          targetVideoUrl: i.targetVideoUrl || null,
          targetVideoTitle: i.targetVideoTitle || null,
          likeState: i.likeState,
          status: i.status,
          reason: i.reason || null,
          previewOnly: i.previewOnly,
          executeAllowed: i.executeAllowed,
        })),
      }, { total: merged.length, planned, skipped, blocked });
    }
  } catch (err) {
    console.error('[visits:plan] 错误:', err.message);
    run.hadError = true;
    if (commonArgs.options.json) {
      printJsonError('visits:plan', RESULT_CODES.UNKNOWN_ERROR, err.message, { recoverable: false });
    }
    process.exitCode = 1;
  } finally {
    if (browser) {
      const shouldClose = resolveBrowserClose(run);
      if (shouldClose) {
        await browser.close();
      } else {
        console.error('[visits:plan] 浏览器保持打开，供人工检查。');
      }
    }
  }
}

main().catch(err => {
  console.error('[visits:plan] 错误:', err.message);
  process.exit(1);
});
