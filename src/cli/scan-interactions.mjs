import { createBrowserContext } from '../browser/browser-context.mjs';
import {
  ensureCommentPageReady,
  waitForCommentsArea,
  extractComments,
  getSelectedWorkTitle,
} from '../adapters/comment-page.mjs';
import { commentFingerprint, commentInitialStatus, normalizeTimeText } from '../domain/event-fingerprint.mjs';
import { insertEvent, getEventCounts, findUnstableEvent, promoteUnstableEvent } from '../db/interaction-repository.mjs';
import logger from '../utils/logger.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { captureEvidence } from '../browser/failure-evidence.mjs';
import { promptRecoveryAction } from '../browser/interactive-control.mjs';
import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';

async function runCommentScan(page, run) {
  console.error('[scan] === 评论扫描 ===');

  console.error('[scan] 导航到评论管理页...');
  const navResult = await ensureCommentPageReady(page);
  if (!navResult.ok) return { ...navResult, data: { ...navResult.data, step: 'comment-navigate' } };

  console.error('[scan] 等待评论列表...');
  const areaResult = await waitForCommentsArea(page);
  if (!areaResult.ok) return { ...areaResult, data: { ...areaResult.data, step: 'comment-wait-area' } };

  if (areaResult.data.pageState === 'empty-comments') {
    console.error('[scan] 暂无评论');
    return success({ commentCount: 0, step: 'comment-scan' });
  }

  const titleResult = await getSelectedWorkTitle(page);
  const workTitle = titleResult.data?.title || '';
  console.error(`[scan] 当前作品: ${workTitle || '(未识别)'}`);

  const extractResult = await extractComments(page);
  if (!extractResult.ok) return { ...extractResult, data: { ...extractResult.data, step: 'comment-extract' } };

  const comments = extractResult.data.comments;
  console.error(`[scan] 发现 ${comments.length} 条评论`);

  let newCount = 0;
  let duplicateCount = 0;
  let parseFailedCount = 0;

  for (const c of comments) {
    try {
      if (!c.username || !c.content) {
        parseFailedCount++;
        continue;
      }
      // Do NOT normalize day-relative time before status check:
      // "昨天23:44" must stay unstable so it doesn't enter prepare/dry-run.
      // normalizeTimeText is only used for display/normalized storage, not for status.
      const status = commentInitialStatus(c.timeText);
      const fp = commentFingerprint(c, workTitle);

      // If relative-time comment, check if unstable event exists → may be the same
      // comment scanned again with drifted time.
      const existing = status === 'unstable' ? findUnstableEvent(fp) : null;

      if (existing) {
        // Same comment re-scanned with drifted relative time — skip
        duplicateCount++;
        continue;
      }

      // For stable-time comments, check if there's a matching unstable event that should
      // be promoted. Use content-only fingerprint (no PID, no time) to match the unstable entry.
      if (status === 'new') {
        const unstableFp = commentFingerprint({ ...c, platformEventId: '', timeText: '' }, workTitle);
        const unstableExisting = findUnstableEvent(unstableFp);
        if (unstableExisting) {
          const promoted = promoteUnstableEvent(unstableExisting.id, fp, c.timeText, c.platformEventId || null);
          if (promoted) {
            newCount++;
            console.error(`[scan]   ^ ${c.username}: ${c.content.slice(0, 40)} (promoted from unstable event #${unstableExisting.id})`);
            continue;
          }
        }
      }

      const id = insertEvent({
        eventType: 'comment',
        actorName: c.username,
        relation: 'unknown',
        myWorkTitle: workTitle,
        commentText: c.content,
        eventTimeText: c.timeText,
        platformEventId: c.platformEventId || null,
        fingerprint: fp,
        status,
      });

      if (id) {
        newCount++;
        const tag = status === 'unstable' ? ' [unstable]' : '';
        console.error(`[scan]   + ${c.username}: ${c.content.slice(0, 40)}...${tag}`);
      } else {
        duplicateCount++;
      }
    } catch {
      parseFailedCount++;
    }
  }

  run.scanned += comments.length;
  run.parseFailed += parseFailedCount;

  console.error(`[scan] 评论扫描完成: ${newCount} 条新入库, ${duplicateCount} 条重复${parseFailedCount > 0 ? `, ${parseFailedCount} 条解析失败` : ''}`);
  return success({ commentCount: newCount, duplicateCount, parseFailedCount, step: 'comment-scan' });
}

async function runNotificationScan(page, run, type) {
  console.error('[scan] === 通知面板扫描（点赞+评论） ===');

  const { ensureNotificationPageReady, openNotificationPanel, closeNotificationPanel, extractNotifications } = await import('../adapters/notification-page.mjs');

  try {
    await ensureNotificationPageReady(page);
  } catch (err) {
    return blocking(
      RESULT_CODES.NAVIGATION_TIMEOUT,
      `通知页面导航超时: ${err.message}`,
      { data: { step: 'notify-navigate' } }
    );
  }

  const opened = await openNotificationPanel(page);
  if (!opened) {
    return blocking(
      RESULT_CODES.NOTIFICATION_PANEL_NOT_FOUND,
      '无法打开通知面板（未找到铃铛图标或面板未出现）',
      { data: { step: 'notify-open-panel' } }
    );
  }

  console.error('[scan] 通知面板已打开，提取通知...');

  let notifications;
  try {
    notifications = await extractNotifications(page);
  } catch (err) {
    return blocking(
      RESULT_CODES.NOTIFICATION_ITEMS_EMPTY,
      `通知解析失败: ${err.message}`,
      { data: { step: 'notify-extract' } }
    );
  }

  console.error(`[scan] 面板中发现 ${notifications.length} 条通知`);

  const rawText = await page.evaluate(() => {
    const panels = document.querySelectorAll('[class*="interaction"], [class*="notice"], [class*="message-panel"], [class*="scroll"], [class*="popup"], [class*="popper"], [class*="drawer"]');
    for (const p of panels) {
      const t = p.innerText || '';
      if (t.includes('互动消息') || t.includes('全部消息')) return t;
    }
    return '(panel not found)';
  });

  if (run.options.debug) {
    console.error('[scan] --- 面板原始文本 ---');
    console.error(rawText.slice(0, 1500));
    console.error('[scan] --- 原始文本结束 ---');
  }

  const { notificationFingerprint } = await import('../domain/event-fingerprint.mjs');

  const wantComments = (type === 'all');
  const wantLikes = true;

  let likeCount = 0;
  let commentCount = 0;
  let duplicateCount = 0;

  for (const n of notifications) {
    try {
      if (!wantComments && n.eventType === 'comment') continue;
      if (!wantLikes && n.eventType === 'like') continue;

      // Use notificationFingerprint for robust dedup (includes profile identifiers)
      const fp = notificationFingerprint({
        eventType: n.eventType,
        username: n.username,
        actorProfileKey: n.actorProfileKey,
        actorProfileUrl: n.actorProfileUrl,
        action: n.action,
        content: n.content,
        timeText: n.timeText,
        rawText: n.rawText,
      });

      const id = insertEvent({
        eventType: n.eventType,
        actorName: n.username,
        actorProfileKey: n.actorProfileKey || null,
        actorProfileUrl: n.actorProfileUrl || null,
        relation: n.relation,
        myWorkTitle: '',
        commentText: n.eventType === 'comment' ? n.content : null,
        eventTimeText: n.timeText,
        fingerprint: fp,
        rawPayloadJson: n.rawText ? JSON.stringify({ rawText: n.rawText, notificationItemKey: n.notificationItemKey }) : null,
      });

      if (id) {
        if (n.eventType === 'like') {
          likeCount++;
          console.error(`[scan]   + ${n.username} [${n.relation}] ${n.action} ${n.timeText}`);
        } else {
          commentCount++;
          console.error(`[scan]   + ${n.username}: ${n.content.slice(0, 30)} ${n.timeText}`);
        }
      } else {
        duplicateCount++;
      }
    } catch {
      // skip malformed entries
    }
  }

  await closeNotificationPanel(page);

  run.scanned += (likeCount + commentCount);
  console.error(`[scan] 通知扫描完成: ${likeCount} 赞 + ${commentCount} 评论入库${duplicateCount > 0 ? `, ${duplicateCount} 重复` : ''}`);
  return success({ likeCount, commentCount, duplicateCount, step: 'notify-scan' });
}

async function main() {
  const { options, remaining } = parseCommonArgs(process.argv.slice(2));

  const typeIdx = remaining.indexOf('--type');
  const type = typeIdx >= 0 ? remaining[typeIdx + 1] : 'all';
  const validTypes = ['all', 'comment', 'like'];
  if (!validTypes.includes(type)) {
    if (options.json) {
      printJsonError('interactions:scan', RESULT_CODES.BLOCKED,
        `Invalid --type: ${type}. Must be one of: ${validTypes.join(', ')}`, { recoverable: false });
    } else {
      console.error(`Invalid --type: ${type}. Must be one of: ${validTypes.join(', ')}`);
    }
    process.exit(1);
  }

  logger.setLevel(options.debug ? 'DEBUG' : 'INFO');
  runMigrations();

  const run = createRunContext('scan-interactions', options);

  let browser = null;
  let page = null;

  try {
    console.error('[scan] 启动浏览器...');
    const ctx = await createBrowserContext({ headless: false, enableReuse: options.keepOpen });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    // --- Comment scanning phase ---
    if (type === 'all' || type === 'comment') {
      const commentResult = await runPhaseWithRecovery(page, run, 'comment', () => runCommentScan(page, run), options);
      if (!commentResult.ok) {
        if (options.json) {
          printJsonError('interactions:scan', commentResult.code || RESULT_CODES.BLOCKED,
            commentResult.message || '评论扫描失败', { recoverable: commentResult.recoverable !== false }); return;
        }
        return;
      }
      if (commentResult.action === 'quit-close' || commentResult.action === 'quit-keep-open') return;
    }

    // --- Notification scanning phase ---
    if (type === 'all' || type === 'like') {
      const notifResult = await runPhaseWithRecovery(page, run, 'notification', () => runNotificationScan(page, run, type), options);
      if (!notifResult.ok) {
        if (options.json) {
          printJsonError('interactions:scan', notifResult.code || RESULT_CODES.BLOCKED,
            notifResult.message || '通知扫描失败', { recoverable: notifResult.recoverable !== false }); return;
        }
        return;
      }
      if (notifResult.action === 'quit-close' || notifResult.action === 'quit-keep-open') return;
    }

    console.error('');
    console.error('[scan] ====== 扫描完成 ======');
    const counts = getEventCounts();
    for (const row of counts) {
      console.error(`[scan] ${row.event_type}/${row.status}: ${row.count}`);
    }

    // --json output for agent consumption
    if (options.json) {
      printJsonResult('interactions:scan', { counts }, {
        totalScanned: run.scanned,
        totalNew: counts.reduce((s, r) => s + r.count, 0),
        blocked: run.hadBlocked ? 1 : 0,
      });
    }

  } catch (err) {
    console.error('[scan] 未预期错误:', err.message);
    run.hadError = true;

    if (page) {
      try {
        const { evidenceDir } = await captureEvidence(page, {
          outputDir: run.outputDir,
          step: 'unhandled-error',
          code: RESULT_CODES.UNKNOWN_ERROR,
          message: err.message,
          recoverable: false,
        });
        run.evidenceDirectories.push(evidenceDir);
      } catch {
        // evidence capture should not cause secondary crash
      }
    }

    // Structured JSON error on failure
    if (options.json) {
      printJsonError('interactions:scan', RESULT_CODES.UNKNOWN_ERROR,
        err.message, { recoverable: false, evidence: run.evidenceDirectories }); return;
    }

    process.exitCode = 1;
  } finally {
    saveRunSummary(run);

    const shouldClose = resolveBrowserClose(run);

    if (browser && shouldClose) {
      console.error('[scan] 关闭浏览器...');
      await browser.close();
    } else if (browser) {
      console.error('[scan] 浏览器保持打开，供人工检查。手动关闭窗口或 Ctrl+C 退出。');
    }
  }
}

async function runPhaseWithRecovery(page, run, phaseName, phaseFn, options = {}) {
  let shouldRetry = true;

  while (shouldRetry) {
    const result = await phaseFn();

    if (result.ok) return result;

    run.hadBlocked = true;

    const evidenceData = { step: `${result.step || phaseName}`, code: result.code, message: result.message, recoverable: result.recoverable !== false };
    let evidenceDir;
    try {
      const evidenceResult = await captureEvidence(page, { outputDir: run.outputDir, ...evidenceData });
      evidenceDir = evidenceResult.evidenceDir;
    } catch {
      evidenceDir = run.outputDir;
    }

    run.evidenceDirectories.push(evidenceDir);

    // In --json mode, never show interactive prompts
    if (!run.options.pauseOnError || !evidenceData.recoverable || options.json) {
      return result;
    }

    const choice = await promptRecoveryAction(
      evidenceData.step, evidenceData.code, evidenceData.message, evidenceDir
    );

    switch (choice.action) {
      case 'retry':
        continue;
      case 'skip':
        console.error(`[scan]  跳过 ${phaseName}`);
        return { ...result, action: 'skipped' };
      case 'diagnose':
        try {
          await captureEvidence(page, {
            outputDir: run.outputDir,
            step: `${phaseName}-manual-diagnose`,
            code: result.code,
            message: 'User-requested diagnostic rescan',
            recoverable: true,
          });
          console.error('[scan]  诊断信息已保存。可以再次选择操作。');
        } catch (err) {
          console.error(`[scan]  诊断保存失败: ${err.message}`);
        }
        shouldRetry = true;
        break;
      case 'quit-close':
        console.error('[scan] 用户选择退出，关闭浏览器...');
        return { ...result, action: 'quit-close' };
      case 'quit-keep-open':
        console.error('[scan] 用户选择退出，浏览器保持打开。');
        return { ...result, action: 'quit-keep-open' };
      default:
        shouldRetry = true;
    }
  }
}

main().catch((err) => {
  console.error('[scan] 未捕获错误:', err.message);
  process.exit(1);
});
