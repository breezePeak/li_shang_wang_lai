import { getEvents } from '../db/interaction-repository.mjs';
import { createPlan } from '../db/plan-repository.mjs';
import { ensureDir, writeJSON } from '../utils/filesystem.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { getDb } from '../db/database.mjs';
import { createBrowserContext } from '../browser/browser-context.mjs';
import {
  ensureNotificationPageReady,
  openNotificationPanel,
  closeNotificationPanel,
  clickLikeProfileLink,
} from '../adapters/notification-page.mjs';
import { findLatestNonPinnedVideo } from '../adapters/user-profile-page.mjs';
import { navigateToVideo, checkLikeState, getVideoTitle } from '../adapters/video-page.mjs';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import path from 'path';

function parseArgs(argv) {
  const args = { mode: 'manual', out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode' && argv[i + 1]) { args.mode = argv[++i]; }
    if (argv[i] === '--out' && argv[i + 1]) { args.out = argv[++i]; }
  }
  return args;
}

async function processOneLikeEvent(page, event) {
  const r = {
    eventId: event.id,
    actorName: event.actor_name,
    relation: event.relation,
    actorProfileUrl: '',
    targetVideoUrl: '',
    targetVideoId: null,
    targetVideoTitle: '',
    targetRule: 'latest_non_pinned_video',
    candidateCount: 0,
    alreadyLiked: null,
    approved: false,
    status: 'planned',
    reason: '',
    code: '',
  };

  if (event.relation !== 'friend' && event.relation !== 'mutual') {
    r.status = 'skipped';
    r.reason = `关系为 ${event.relation}，非好友/互关`;
    return r;
  }

  console.error(`\n[plan-likes] ${event.actor_name} [${event.relation}]`);

  // Build full event context for precise notification matching
  // Extract stored rawText / notificationItemKey from raw_payload_json if available
  let rawPayload = {};
  try {
    if (event.raw_payload_json) rawPayload = JSON.parse(event.raw_payload_json);
  } catch { /* ignore */ }

  // If the event already has a profile URL from notification scanning, use it directly
  if (event.actor_profile_url) {
    r.actorProfileUrl = event.actor_profile_url;
    console.error(`[plan-likes]   主页(来自扫描): ${r.actorProfileUrl.slice(0, 60)}`);
    // Navigate directly to known profile URL instead of clicking notification item
    await page.goto(r.actorProfileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
  } else {
    // Click avatar in notification panel → navigates to user profile
    // Pass full event context for precise matching (not just username)
    const clicked = await clickLikeProfileLink(page, {
      username: event.actor_name,
      relation: event.relation,
      action: '赞了你的作品',  // Like events always have this action
      timeText: event.event_time_text,
      notificationItemKey: rawPayload.notificationItemKey || '',
      rawText: rawPayload.rawText || '',
    });
    if (!clicked) {
      r.status = 'blocked';
      r.reason = `通知面板中未找到 ${event.actor_name} 的精确匹配条目`;
      return r;
    }
    r.actorProfileUrl = page.url();
    console.error(`[plan-likes]   主页(来自通知): ${r.actorProfileUrl.slice(0, 60)}`);
  }

  // Find latest non-pinned video on profile page
  const videoResult = await findLatestNonPinnedVideo(page);
  if (!videoResult.ok) {
    r.status = 'blocked';
    r.reason = videoResult.message;
    r.code = videoResult.code;
    return r;
  }

  r.targetVideoUrl = videoResult.data.videoUrl;
  r.targetRule = videoResult.data.targetRule || 'latest_non_pinned_video';
  r.targetVideoId = videoResult.data.videoId || null;
  r.candidateCount = videoResult.data.candidateCount || 0;
  console.error(`[plan-likes]   最新视频: ${r.targetVideoUrl.slice(0, 60)} (id=${r.targetVideoId}, 共${r.candidateCount}个候选)`);

  await page.waitForTimeout(2000);

  // Navigate to the video to check like state
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
    r.reason = likeResult.ok
      ? `点赞状态置信度不足 (${likeResult.data.confidence || 'unknown'})`
      : likeResult.message;
    r.code = likeResult.code || 'LIKE_STATE_UNKNOWN';
    return r;
  }
  if (likeResult.data.alreadyLiked) {
    r.status = 'skipped';
    r.reason = '已经点过赞';
    r.alreadyLiked = true;
    return r;
  }

  const titleResult = await getVideoTitle(page);
  if (titleResult.ok && titleResult.data.title) {
    r.targetVideoTitle = titleResult.data.title;
  }

  console.error(`[plan-likes]   未点赞，加入计划`);
  return r;
}

async function main() {
  runMigrations();

  const commonArgs = parseCommonArgs(process.argv.slice(2));
  const cmdArgs = parseArgs(commonArgs.remaining);

  console.error('[plan-likes] 读取点赞事件...');
  const likes = getEvents({ eventType: 'like', status: 'new', limit: 20 });

  if (likes.length === 0) {
    console.error('[plan-likes] 没有点赞事件。先运行 npm run interactions:scan -- --type like');
    process.exit(0);
  }

  console.error(`[plan-likes] 找到 ${likes.length} 个点赞事件`);

  const run = createRunContext('plan-likes', commonArgs.options);
  const db = getDb();
  const now = new Date().toISOString();

  let browser = null;
  let page = null;
  const items = [];
  let hasVerifiedItem = false;

  try {
    console.error('[plan-likes] 启动浏览器...');
    const ctx = await createBrowserContext({ headless: false });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    // Step 1: Navigate to self page and open notification panel
    console.error('[plan-likes] 导航到个人主页并打开通知面板...');
    await ensureNotificationPageReady(page);

    const panelOpen = await openNotificationPanel(page);
    if (!panelOpen) {
      console.error('[plan-likes] 无法打开通知面板，请手动打开后重试');
      run.hadBlocked = true;
    } else {
      // Step 2: For each like event, click avatar to navigate to user profile
      for (let i = 0; i < likes.length; i++) {
        const item = await processOneLikeEvent(page, likes[i]);
        items.push(item);

        if (item.status === 'planned') {
          hasVerifiedItem = true;
        }

        if (i < likes.length - 1) {
          // Go back to self page and reopen notification panel for next item
          console.error('[plan-likes] 返回个人主页...');
          await ensureNotificationPageReady(page);
          await openNotificationPanel(page);
          await page.waitForTimeout(1000);
        }
      }
    }
  } catch (err) {
    console.error('[plan-likes] 错误:', err.message);
    run.hadError = true;
    process.exitCode = 1;
  } finally {
    const planDir = path.resolve('data', 'plans');
    ensureDir(planDir);
    const timestamp = now.replace(/[:.]/g, '-').slice(0, 19);
    const outPath = cmdArgs.out || path.join(planDir, `likes-plan-${timestamp}.json`);

    const plan = {
      planType: 'reciprocal_like',
      mode: cmdArgs.mode,
      createdAt: now,
      plannedCount: items.filter(i => i.status === 'planned').length,
      skippedCount: items.filter(i => i.status === 'skipped').length,
      blockedCount: items.filter(i => i.status === 'blocked').length,
      items,
    };

    writeJSON(outPath, plan);
    console.error(`\n[plan-likes] 计划已保存: ${outPath}`);

    const planId = createPlan({ planType: 'reciprocal_like', mode: cmdArgs.mode, payload: plan });
    plan.planId = planId;
    writeJSON(outPath, plan);
    console.error(`[plan-likes] DB 计划 ID: ${planId}`);

    // Update event statuses
    for (const item of items) {
      if (item.status === 'planned') {
        db.prepare("UPDATE interaction_events SET status = 'planned', updated_at = ? WHERE id = ? AND status = 'new'")
          .run(now, item.eventId);
      }
    }

    run.scanned = likes.length;
    run.planned = plan.plannedCount;
    run.skipped = plan.skippedCount;
    run.blocked = plan.blockedCount;
    saveRunSummary(run);

    console.error(`\n===== 汇总 =====`);
    console.error(`  计划内: ${plan.plannedCount} | 跳过: ${plan.skippedCount} | 阻塞: ${plan.blockedCount}`);

    if (hasVerifiedItem) {
      console.error('\n===== 候选预览 =====');
      console.error('注意：好友回访在 MVP 阶段仅支持预览，真实点赞默认禁用。');
      for (const item of items) {
        if (item.status === 'planned') {
          console.error(`  [${item.eventId}] ${item.actorName} [${item.relation}] previewOnly`);
          if (item.actorProfileUrl) console.error(`    主页: ${item.actorProfileUrl}`);
          if (item.targetVideoUrl) console.error(`    目标: ${item.targetVideoUrl}`);
          if (item.targetVideoTitle) console.error(`    标题: ${item.targetVideoTitle.slice(0, 60)}`);
          console.error('');
        }
      }
    }

    // --json output for agent consumption
    if (commonArgs.options.json) {
      printJsonResult('likes:plan', {
        candidates: items.map(i => ({
          eventId: i.eventId,
          actorName: i.actorName,
          relation: i.relation,
          actorProfileUrl: i.actorProfileUrl || null,
          targetVideoUrl: i.targetVideoUrl || null,
          targetVideoTitle: i.targetVideoTitle || null,
          alreadyLiked: i.alreadyLiked || false,
          status: i.status,
          reason: i.reason || null,
          previewOnly: true,
          executeAllowed: false,
        })),
      }, {
        total: items.length,
        planned: plan.plannedCount,
        skipped: plan.skippedCount,
        blocked: plan.blockedCount,
      });
    }

    if (browser) {
      saveRunSummary(run);
      const shouldClose = resolveBrowserClose(run);
      if (shouldClose) {
        await browser.close();
      } else {
        console.error('[plan-likes] 浏览器保持打开，供人工检查。');
      }
    }
  }
}

main().catch(err => {
  console.error('[plan-likes] 错误:', err.message);
  process.exit(1);
});
