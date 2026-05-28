import { createBrowserContext } from '../browser/browser-context.mjs';
import {
  ensureNotificationPageReady,
  openNotificationPanel,
  extractNotifications,
  closeNotificationPanel,
  clickLikeProfileLink,
} from '../adapters/notification-page.mjs';
import { findLatestNonPinnedVideo } from '../adapters/user-profile-page.mjs';
import { navigateToVideo, checkLikeState, clickLike, confirmLikeSucceeded, getVideoTitle } from '../adapters/video-page.mjs';
import { writeJSON, ensureDir } from '../utils/filesystem.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { getDb } from '../db/database.mjs';
import path from 'path';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { captureEvidence } from '../browser/failure-evidence.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';

function parseArgs(argv) {
  const args = { relation: 'friend' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--relation' && argv[i + 1]) { args.relation = argv[++i]; }
    if (argv[i] === '--max-items' && argv[i + 1]) { args.maxItems = parseInt(argv[++i]) || 1; }
  }
  return args;
}

function hasSucceededAction(db, eventId) {
  return !!db.prepare(
    "SELECT id FROM actions WHERE event_id = ? AND action_type = 'like_work' AND status = 'succeeded'"
  ).get(eventId);
}

function recordAction(db, eventId, targetTitle, targetUrl, status, reason) {
  db.prepare(`
    INSERT INTO actions (event_id, action_type, target_title, target_url, action_text, status, reason, executed_at)
    VALUES (?, 'like_work', ?, ?, '', ?, ?, ?)
  `).run(eventId, targetTitle, targetUrl, status, reason || null, new Date().toISOString());
}

function updateEventStatus(db, eventId, status) {
  db.prepare("UPDATE interaction_events SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), eventId);
}

async function processOneLike(page, item, db, run) {
  const r = {
    actorName: item.username,
    relation: item.relation,
    status: 'skipped',
    reason: '',
  };

  // Check DB dedup: find the event first
  const events = db.prepare(
    "SELECT id FROM interaction_events WHERE actor_name = ? AND event_type = 'like' AND status = 'new' ORDER BY created_at DESC LIMIT 1"
  ).all(item.username);

  if (events.length === 0) {
    r.reason = '没有匹配的未处理事件';
    return r;
  }

  const eventId = events[0].id;

  if (hasSucceededAction(db, eventId)) {
    r.reason = '已成功回赞过';
    updateEventStatus(db, eventId, 'succeeded');
    return r;
  }

  if (run.executed >= run.options.maxItems) {
    r.reason = `已达到本轮最大执行数量 ${run.options.maxItems}`;
    r.status = 'skipped';
    return r;
  }

  console.log(`\n[reciprocate] ${item.username} [${item.relation}]`);

  // Click avatar → navigate to user profile
  const clicked = await clickLikeProfileLink(page, item.username);
  if (!clicked) {
    r.status = 'blocked';
    r.reason = `通知面板中未找到 ${item.username} 的头像`;
    return r;
  }

  console.log(`[reciprocate]   已进入主页`);

  const videoResult = await findLatestNonPinnedVideo(page);
  if (!videoResult.ok) {
    r.status = 'blocked';
    r.reason = videoResult.message;
    recordAction(db, eventId, '', '', 'blocked', r.reason);
    run.hadBlocked = true;
    return r;
  }

  const videoUrl = videoResult.data.videoUrl;
  console.log(`[reciprocate]   最新视频: ${videoUrl.slice(0, 60)}`);

  // Navigate to video page
  const navResult = await navigateToVideo(page, videoUrl);
  if (!navResult.ok) {
    r.status = 'blocked';
    r.reason = navResult.message;
    recordAction(db, eventId, '', videoUrl, 'blocked', r.reason);
    run.hadBlocked = true;
    return r;
  }

  const stateResult = await checkLikeState(page);
  if (stateResult.ok && stateResult.data.alreadyLiked) {
    r.status = 'skipped';
    r.reason = '已经点过赞';
    return r;
  }

  const likeResult = await clickLike(page);
  if (!likeResult.ok) {
    r.status = likeResult.code === RESULT_CODES.ALREADY_LIKED ? 'skipped' : 'blocked';
    r.reason = likeResult.message;
    recordAction(db, eventId, '', videoUrl, 'blocked', r.reason);
    run.hadBlocked = true;
    return r;
  }

  const confirmResult = await confirmLikeSucceeded(page);
  if (!confirmResult.ok) {
    r.status = 'blocked';
    r.reason = confirmResult.message;
    recordAction(db, eventId, '', videoUrl, 'blocked', r.reason);
    run.hadBlocked = true;
    return r;
  }

  r.status = 'succeeded';
  console.log(`[reciprocate]   ✓ 回赞成功`);

  const titleResult = await getVideoTitle(page);
  const videoTitle = titleResult.ok ? (titleResult.data?.title || '') : '';
  recordAction(db, eventId, videoTitle, videoUrl, 'succeeded', null);
  updateEventStatus(db, eventId, 'succeeded');
  run.executed++;
  run.succeeded++;

  return r;
}

async function main() {
  runMigrations();

  const commonArgs = parseCommonArgs(process.argv.slice(2));
  const cmdArgs = parseArgs(commonArgs.remaining);

  if (cmdArgs.relation && !['friend', 'mutual', 'all'].includes(cmdArgs.relation)) {
    console.error('--relation must be: friend, mutual, or all');
    process.exit(1);
  }
  const allowedRelation = cmdArgs.relation === 'all' ? null : cmdArgs.relation;

  const run = createRunContext('reciprocal-likes', commonArgs.options);
  commonArgs.options.keepOpen = true;

  console.log(`[reciprocate] mode: ${commonArgs.options.execute ? 'execute' : 'dry-run'}, max: ${commonArgs.options.maxItems}`);

  const db = getDb();
  let browser = null;
  let page = null;
  const results = [];
  let successCount = 0, skipCount = 0, blockedCount = 0;

  try {
    console.log('[reciprocate] 启动浏览器...');
    const ctx = await createBrowserContext({ headless: false });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    console.log('[reciprocate] 打开通知面板...');
    await ensureNotificationPageReady(page);

    const panelOpen = await openNotificationPanel(page);
    if (!panelOpen) {
      console.log('[reciprocate] 无法打开通知面板');
      run.hadBlocked = true;
    } else {
      // Extract all notification items from the panel
      const notifications = await extractNotifications(page);
      const likeItems = notifications.filter(n =>
        n.eventType === 'like' &&
        (allowedRelation ? n.relation === allowedRelation : true)
      );

      console.log(`[reciprocate] 通知面板中 ${likeItems.length} 条点赞 (${notifications.length} 条总通知)`);

      for (let i = 0; i < likeItems.length; i++) {
        const item = likeItems[i];

        if (run.executed >= commonArgs.options.maxItems && commonArgs.options.execute) {
          console.log(`[reciprocate] 已达到最大执行 ${commonArgs.options.maxItems}，停止`);
          break;
        }

        console.log(`[reciprocate] [${i + 1}/${likeItems.length}] ${item.username} [${item.relation}] ${item.action}`);

        const result = await processOneLike(page, item, db, run);
        results.push(result);

        if (result.status === 'succeeded') successCount++;
        else if (result.status === 'skipped') skipCount++;
        else if (result.status === 'blocked') blockedCount++;

        if (i < likeItems.length - 1) {
          // Navigate back to self page and reopen notification panel
          console.log('[reciprocate] 返回个人主页，重新打开通知面板...');
          await ensureNotificationPageReady(page);

          const reopened = await openNotificationPanel(page);
          if (!reopened) {
            console.log('[reciprocate] 无法重新打开通知面板');
            break;
          }
          await page.waitForTimeout(500);
        }
      }
    }
  } catch (err) {
    console.error('[reciprocate] 错误:', err.message);
    run.hadError = true;

    if (page) {
      try {
        const { evidenceDir } = await captureEvidence(page, {
          outputDir: run.outputDir,
          step: 'execute-error',
          code: RESULT_CODES.UNKNOWN_ERROR,
          message: err.message,
          recoverable: false,
        });
        run.evidenceDirectories.push(evidenceDir);
      } catch {}
    }

    process.exitCode = 1;
  } finally {
    // Write results
    const plansDir = path.resolve('data', 'plans');
    ensureDir(plansDir);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const resultPath = path.join(plansDir, `like-result-${ts}.json`);
    writeJSON(resultPath, {
      mode: commonArgs.options.execute ? 'execute' : 'dry-run',
      results,
      summary: { total: results.length, succeeded: successCount, skipped: skipCount, blocked: blockedCount, maxItems: commonArgs.options.maxItems },
    });
    console.log(`[reciprocate] 结果已保存: ${resultPath}`);
    console.log(`[reciprocate] ${successCount} 成功 / ${blockedCount} 阻塞 / ${skipCount} 跳过 / ${results.length} 总计`);

    saveRunSummary(run);

    const shouldClose = resolveBrowserClose(run);
    if (browser && shouldClose) {
      await browser.close();
    } else if (browser) {
      console.log('[reciprocate] 浏览器保持打开，供人工检查。');
    }
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
