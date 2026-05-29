import { createBrowserContext } from '../browser/browser-context.mjs';
import {
  ensureNotificationPageReady,
  openNotificationPanel,
  extractNotifications,
  clickLikeProfileLink,
} from '../adapters/notification-page.mjs';
import { findLatestNonPinnedVideo } from '../adapters/user-profile-page.mjs';
import { navigateToVideo, checkLikeState, clickLike, confirmLikeSucceeded, getVideoTitle } from '../adapters/video-page.mjs';
import { writeJSON, ensureDir } from '../utils/filesystem.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { getDb } from '../db/database.mjs';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { captureEvidence } from '../browser/failure-evidence.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';

function parseArgs(argv) {
  const args = { plan: null, relation: 'friend' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plan' && argv[i + 1]) { args.plan = argv[++i]; }
    if (argv[i] === '--relation' && argv[i + 1]) { args.relation = argv[++i]; }
  }
  return args;
}

function hasSucceededAction(db, eventId) {
  return !!db.prepare(
    "SELECT id FROM actions WHERE event_id = ? AND action_type = 'like_work' AND status = 'succeeded'"
  ).get(eventId);
}

function hasSucceededLikeOnUrl(db, targetUrl) {
  return !!db.prepare(
    "SELECT id FROM actions WHERE target_url = ? AND action_type = 'like_work' AND status = 'succeeded'"
  ).get(targetUrl);
}

function recordAction(db, eventId, targetTitle, targetUrl, status, reason, evidenceJson, screenshotPath) {
  db.prepare(`
    INSERT INTO actions (event_id, action_type, target_title, target_url, action_text, status, reason, evidence_json, screenshot_path, executed_at)
    VALUES (?, 'like_work', ?, ?, '', ?, ?, ?, ?, ?)
  `).run(eventId, targetTitle, targetUrl, status, reason || null, evidenceJson || null, screenshotPath || null, new Date().toISOString());
}

function updateEventStatus(db, eventId, status) {
  db.prepare("UPDATE interaction_events SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), eventId);
}

async function processOneItem(page, item, db, run, planId) {
  const r = {
    eventId: item.eventId,
    actorName: item.actorName,
    status: 'skipped',
    reason: '',
    step: '',
    code: '',
  };

  if (item.approved !== true) {
    r.status = 'skipped';
    r.reason = '未审批';
    r.code = RESULT_CODES.ACTION_NOT_APPROVED;
    return r;
  }

  if (!item.eventId) {
    r.status = 'blocked';
    r.reason = '计划条目缺少 eventId';
    return r;
  }

  // Validate event via eventId
  const event = db.prepare(
    "SELECT * FROM interaction_events WHERE id = ? AND event_type = 'like' AND status IN ('planned', 'approved')"
  ).get(item.eventId);

  if (!event) {
    r.status = 'blocked';
    r.reason = `未找到匹配的 planned/approved 点赞事件 (id=${item.eventId})`;
    return r;
  }

  if (event.relation !== 'friend' && event.relation !== 'mutual') {
    r.status = 'blocked';
    r.reason = `关系为 ${event.relation}，非好友/互关`;
    return r;
  }

  if (hasSucceededAction(db, item.eventId) || hasSucceededLikeOnUrl(db, item.targetVideoUrl)) {
    r.status = 'skipped';
    r.reason = '已成功回赞过，跳过';
    r.code = RESULT_CODES.DUPLICATE_ACTION;
    return r;
  }

  if (run.executed >= run.options.maxItems) {
    r.status = 'skipped';
    r.reason = `已达到本轮最大执行数量 ${run.options.maxItems}`;
    r.code = RESULT_CODES.MAX_ITEMS_REACHED;
    return r;
  }

  if (!item.targetVideoUrl) {
    r.status = 'blocked';
    r.reason = '计划缺少目标视频链接';
    return r;
  }

  const isExecute = run.options.execute === true;
  console.log(`\n[reciprocate] ${item.actorName} [${event.relation || item.relation}]`);

  // Dry-run: locate only
  if (!isExecute) {
    r.step = 'dry-run-locate';
    r.status = 'dry-run-ready';
    r.reason = '目标已定位，dry-run 不执行点赞';
    console.log(`[reciprocate]   ✓ dry-run 定位目标: ${item.targetVideoUrl.slice(0, 50)}`);
    return r;
  }

  // Execute: navigate to video and like
  const navResult = await navigateToVideo(page, item.targetVideoUrl);
  if (!navResult.ok) {
    r.status = 'blocked';
    r.reason = navResult.message;
    r.code = navResult.code;
    r.step = 'navigate-video';
    console.log(`[reciprocate]   ✗ ${navResult.message}`);
    recordAction(db, item.eventId, item.targetVideoTitle || '', item.targetVideoUrl, 'blocked', navResult.message, null, null);
    run.hadBlocked = true;
    return r;
  }

  const stateResult = await checkLikeState(page);
  if (!stateResult.ok) {
    r.status = 'blocked';
    r.reason = `点赞状态未知: ${stateResult.message}`;
    r.code = RESULT_CODES.LIKE_STATE_UNKNOWN;
    console.log(`[reciprocate]   ✗ 点赞状态未知，禁止点击`);
    recordAction(db, item.eventId, item.targetVideoTitle || '', item.targetVideoUrl, 'blocked', r.reason, null, null);
    run.hadBlocked = true;
    return r;
  }
  if (stateResult.data.confidence !== 'confirmed') {
    r.status = 'blocked';
    r.reason = `点赞状态置信度不足 (${stateResult.data.confidence || 'unknown'})，禁止点击`;
    r.code = RESULT_CODES.LIKE_STATE_UNKNOWN;
    console.log(`[reciprocate]   ✗ 点赞状态置信度不足，禁止点击`);
    recordAction(db, item.eventId, item.targetVideoTitle || '', item.targetVideoUrl, 'blocked', r.reason, null, null);
    run.hadBlocked = true;
    return r;
  }
  if (stateResult.data.alreadyLiked) {
    r.status = 'skipped';
    r.reason = '已经点过赞';
    r.code = RESULT_CODES.ALREADY_LIKED;
    console.log(`[reciprocate]   - 已经点过赞，跳过`);
    return r;
  }

  r.step = 'click-like';
  const likeResult = await clickLike(page, { execute: true });
  if (!likeResult.ok) {
    r.status = likeResult.code === RESULT_CODES.ALREADY_LIKED ? 'skipped' : 'blocked';
    r.reason = likeResult.message;
    r.code = likeResult.code;
    console.log(`[reciprocate]   ✗ ${likeResult.message}`);
    recordAction(db, item.eventId, item.targetVideoTitle || '', item.targetVideoUrl, 'blocked', likeResult.message, null, null);
    run.hadBlocked = true;
    return r;
  }

  const confirmResult = await confirmLikeSucceeded(page);
  if (!confirmResult.ok) {
    r.status = 'blocked';
    r.reason = confirmResult.message;
    r.code = RESULT_CODES.LIKE_STATE_UNKNOWN;
    console.log(`[reciprocate]   ✗ ${confirmResult.message}`);
    recordAction(db, item.eventId, item.targetVideoTitle || '', item.targetVideoUrl, 'blocked', confirmResult.message, null, null);
    run.hadBlocked = true;
    return r;
  }

  r.status = 'succeeded';
  console.log(`[reciprocate]   ✓ 回赞成功`);

  const titleResult = await getVideoTitle(page);
  const videoTitle = titleResult.ok ? (titleResult.data?.title || '') : item.targetVideoTitle || '';
  recordAction(db, item.eventId, videoTitle, item.targetVideoUrl, 'succeeded', null, null, null);
  updateEventStatus(db, item.eventId, 'succeeded');
  run.executed++;
  run.succeeded++;

  return r;
}

async function main() {
  runMigrations();

  const commonArgs = parseCommonArgs(process.argv.slice(2));
  const cmdArgs = parseArgs(commonArgs.remaining);

  // Safety gate: --execute requires --plan
  if (commonArgs.options.execute && !cmdArgs.plan) {
    console.error('[reciprocate] 安全拦截：--execute 必须同时提供 --plan <计划文件>。');
    console.error('[reciprocate] 原因：点赞回访的安全审批链路尚未完成，直接执行有安全风险。');
    process.exit(1);
  }

  // With --plan: read plan file
  let plan = null;
  if (cmdArgs.plan) {
    if (!existsSync(cmdArgs.plan)) {
      console.error(`计划文件不存在: ${cmdArgs.plan}`);
      process.exit(1);
    }
    plan = JSON.parse(readFileSync(cmdArgs.plan, 'utf8'));

    if (plan.planType !== 'reciprocal_like') {
      console.error(`计划类型不匹配: ${plan.planType} (期望 reciprocal_like)`);
      process.exit(1);
    }
  }

  const run = createRunContext('reciprocal-likes', commonArgs.options);
  commonArgs.options.keepOpen = true;

  const actionMode = commonArgs.options.execute ? 'execute' : 'dry-run';
  console.log(`[reciprocate] 模式: ${actionMode}`);

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

    if (plan) {
      // Plan-driven execution (safe path)
      const planId = plan.planId || null;
      const approvedItems = (plan.items || []).filter(i => i.approved === true);

      if (approvedItems.length === 0) {
        console.log('[reciprocate] 计划中没有 approved: true 的回赞任务。');
        process.exit(0);
      }

      console.log(`[reciprocate] ~ ${approvedItems.length} 条审批通过, 最大执行 ${commonArgs.options.maxItems}`);

      for (let i = 0; i < approvedItems.length; i++) {
        const result = await processOneItem(page, approvedItems[i], db, run, planId);
        results.push(result);

        if (result.status === 'succeeded') successCount++;
        else if (result.status === 'skipped') skipCount++;
        else if (result.status === 'blocked') {
          blockedCount++;
          run.hadBlocked = true;
        }

        if (commonArgs.options.execute && run.executed >= commonArgs.options.maxItems) {
          console.log(`[reciprocate] 已达到本轮最大执行数量 ${commonArgs.options.maxItems}, 停止。`);
          break;
        }

        if (i < approvedItems.length - 1) await page.waitForTimeout(1000);
      }
    } else {
      // No plan: dry-run notification scan only (unsafe execute path already blocked above)
      const allowedRelation = cmdArgs.relation === 'all' ? null : cmdArgs.relation;

      console.log('[reciprocate] 无计划文件，仅扫描通知面板 (dry-run)...');
      console.log('[reciprocate] 打开通知面板...');
      await ensureNotificationPageReady(page);

      const panelOpen = await openNotificationPanel(page);
      if (!panelOpen) {
        console.log('[reciprocate] 无法打开通知面板');
        run.hadBlocked = true;
      } else {
        const notifications = await extractNotifications(page);
        const likeItems = notifications.filter(n =>
          n.eventType === 'like' &&
          (allowedRelation ? n.relation === allowedRelation : true)
        );

        console.log(`[reciprocate] 通知面板中 ${likeItems.length} 条点赞 (${notifications.length} 条总通知，dry-run 不执行)`);

        for (const item of likeItems) {
          results.push({
            actorName: item.username,
            relation: item.relation,
            action: item.action,
            status: 'dry-run-scanned',
            reason: 'dry-run 扫描，未执行点赞',
          });
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
    const plansDir = path.resolve('data', 'plans');
    ensureDir(plansDir);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const resultPath = path.join(plansDir, `like-result-${ts}.json`);
    writeJSON(resultPath, {
      plan: cmdArgs.plan || null,
      mode: actionMode,
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
