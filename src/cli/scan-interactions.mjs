import { createBrowserContext } from '../browser/browser-context.mjs';
import {
  ensureCommentPageReady,
  waitForCommentsArea,
  extractComments,
  getSelectedWorkTitle,
} from '../adapters/comment-page.mjs';
import { parseDouyinTimeText } from '../adapters/work-modal-page.mjs';
import { commentFingerprint, commentInitialStatus, normalizeTimeText, notificationFingerprint } from '../domain/event-fingerprint.mjs';
import { normalizeCommentEvent, buildRawPayloadJson } from '../domain/comment-event-normalization.mjs';
import { insertEvent, getEventCounts, findUnstableEvent, promoteUnstableEvent, enrichEvent, upsertNotificationEvent } from '../db/interaction-repository.mjs';
import logger from '../utils/logger.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { captureEvidence } from '../browser/failure-evidence.mjs';
import { promptRecoveryAction } from '../browser/interactive-control.mjs';
import { RESULT_CODES, success, blocking } from '../domain/result-codes.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { resolve } from 'path';

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

async function runNotificationScan(page, run, type, pauseAfterOpen = 0, debugNotificationDom = false) {
  console.error('[scan] === 通知面板扫描（增量逐批采集） ===');

  const {
    ensureNotificationPageReady, openNotificationPanel, closeNotificationPanel,
    extractVisibleNotifications, scrollPanelDown,
    waitForNotificationPanelStable, moveMouseIntoPanel,
  } = await import('../adapters/notification-page.mjs');

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

  const { stable, empty, panelBox } = await waitForNotificationPanelStable(page);
  if (!stable || empty) {
    if (!stable) {
      return blocking(
        RESULT_CODES.NOTIFICATION_PANEL_NOT_FOUND,
        '通知面板未稳定或已消失',
        { data: { step: 'notify-panel-unstable' } }
      );
    }
    console.error('[scan] 通知面板为空（暂无消息）');
    await closeNotificationPanel(page);
    return success({
      inserted: 0, duplicateCount: 0, enriched: 0, ambiguousCount: 0,
      profileResolved: 0, profileUnresolved: 0, parseFailed: 0,
      scrollRounds: 0, events: [], ambiguousEvents: [], failedEvents: [],
      empty: true, step: 'notify-scan',
    });
  }

  await moveMouseIntoPanel(page, panelBox);
  console.error('[scan] 通知面板已就绪，鼠标保持在面板内');

  if (pauseAfterOpen > 0) {
    console.error(`[scan] --pause-after-open: 暂停 ${pauseAfterOpen}ms，可人工确认面板...`);
    await page.waitForTimeout(pauseAfterOpen);
  }

  const wantComments = (type === 'all' || type === 'comment');
  const wantLikes = (type === 'all' || type === 'like');
  const notificationDays = Number(run.options?.days || 0) > 0 ? Number(run.options.days) : null;

  let totalInserted = 0;
  let totalDuplicateCount = 0;
  let totalAmbiguousCount = 0;
  let totalEnrichedCount = 0;
  let totalProfileResolved = 0;
  let totalProfileUnresolved = 0;
  let parseFailedCount = 0;
  let scrollRounds = 0;
  const maxScrolls = 20;
  const allEvents = [];
  const ambiguousEvents = [];
  const failedEvents = [];
  const seenItemKeys = new Set();
  let consecutiveEmptyRounds = 0;
  let consecutiveOldRelevantCount = 0;
  let stopDueToOldRelevant = false;

  console.error('[scan] 开始逐批采集通知...');

  let debugDumpDone = false;

  while (scrollRounds < maxScrolls) {
    const batchResult = await extractVisibleNotifications(page);
    if (!batchResult || !batchResult.ok) {
      if (scrollRounds === 0) {
        return blocking(
          RESULT_CODES.NOTIFICATION_ITEMS_EMPTY,
          batchResult?.message || '通知解析失败',
          { data: { step: 'notify-extract' } }
        );
      }
      break;
    }

    if (debugNotificationDom && !debugDumpDone) {
      debugDumpDone = true;
      try {
        const { debugDumpNotificationItems } = await import('../adapters/notification-page.mjs');
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const debugDir = resolve('data', 'debug', 'notifications', ts);
        console.error(`[scan] --debug-notification-dom: 保存通知 DOM 调试信息到 ${debugDir}`);
        await debugDumpNotificationItems(page, debugDir);
      } catch (err) {
        console.error(`[scan] debug dump 失败: ${err.message}`);
      }
    }

      const notifications = batchResult.data.notifications || [];
      const noMoreData = batchResult.data.noMoreData || false;
      let batchInserted = 0;
    let batchEnriched = 0;
    let batchDuplicate = 0;
    let batchAmbiguous = 0;
    let batchProfileResolved = 0;
    let batchProfileUnresolved = 0;
    let newInBatch = 0;
    let processedInBatch = 0;

    for (const n of notifications) {
      const itemKey = n.notificationItemKey || (n.username + '||' + n.action + '||' + (n.content || ''));
      if (seenItemKeys.has(itemKey)) continue;
      seenItemKeys.add(itemKey);

      try {
        if (!wantComments && n.eventType === 'comment') continue;
        if (!wantLikes && n.eventType === 'like') continue;

        const isRelevantEvent = n.eventType === 'comment' || n.eventType === 'like';
        const parsedNotificationTime = notificationDays && isRelevantEvent ? parseDouyinTimeText(n.timeText || '') : null;
        const isOlderThanWindow = !!(notificationDays && parsedNotificationTime && new Date(parsedNotificationTime).getTime() < Date.now() - notificationDays * 86400000);
        if (isRelevantEvent && notificationDays) {
          if (isOlderThanWindow) {
            consecutiveOldRelevantCount++;
            if (consecutiveOldRelevantCount >= 3) {
              console.error(`[scan]   连续 ${consecutiveOldRelevantCount} 条评论/点赞通知超过 ${notificationDays} 天，停止继续滚动`);
              stopDueToOldRelevant = true;
              break;
            }
            continue;
          }
          consecutiveOldRelevantCount = 0;
        }

        newInBatch++;
        processedInBatch++;

        if (n.eventType === 'comment') {
          const normResult = normalizeCommentEvent({
            actorName: n.username,
            actorProfileUrl: n.actorProfileUrl || '',
            commentText: n.content || '',
            eventTimeText: n.timeText || '',
            workTitle: n.workTitle || '',
            workId: n.workId || '',
            workUrl: n.workUrl || '',
            rawText: n.rawText || '',
            notificationItemKey: n.notificationItemKey || '',
          });
          if (!normResult.valid) {
            batchDuplicate++;
            continue;
          }
        }

        const profileResolutionStatus = n.actorProfileUrl
          ? (n.profileResolveMethod || 'resolved') : 'unresolved';

        if (n.actorProfileUrl) batchProfileResolved++;
        else batchProfileUnresolved++;

        const { fp, confidence } = notificationFingerprint({
          eventType: n.eventType, username: n.username,
          actorProfileKey: n.actorProfileKey, actorProfileUrl: n.actorProfileUrl,
          action: n.action,
          content: n.eventType === 'comment' ? n.content : null,
          rawText: n.rawText,
          notificationItemKey: n.notificationItemKey,
          platformEventId: n.platformEventId || null,
          workId: n.workId || null,
          workUrl: n.workUrl || null,
          thumbnailKey: n.thumbnailKey || null,
        });

        const rawPayload = {
          rawText: n.rawText,
          notificationItemKey: n.notificationItemKey,
          extractSource: 'notification',
          profileResolveMethod: profileResolutionStatus,
          workId: n.workId || null,
          workUrl: n.workUrl || null,
          workTitle: n.workTitle || null,
          thumbnailKey: n.thumbnailKey || null,
          thumbnailSrc: n.thumbnailSrc || null,
          thumbnailAlt: n.thumbnailAlt || null,
          dedupConfidence: confidence,
          profileResolutionStatus,
        };

        if (n.eventType === 'comment') {
          const normResult = normalizeCommentEvent({
            actorName: n.username,
            actorProfileUrl: n.actorProfileUrl || '',
            commentText: n.content || '',
            eventTimeText: n.timeText || '',
            workTitle: n.workTitle || '',
            workId: n.workId || '',
            workUrl: n.workUrl || '',
            rawText: n.rawText || '',
            notificationItemKey: n.notificationItemKey || '',
          });
          if (normResult.warnings && normResult.warnings.length > 0) {
            rawPayload.warnings = normResult.warnings;
          }
        }

        const result = upsertNotificationEvent({
          eventType: n.eventType, actorName: n.username,
          actorProfileKey: n.actorProfileKey || null,
          actorProfileUrl: n.actorProfileUrl || null,
          relation: n.relation,
          commentText: n.eventType === 'comment' ? n.content : null,
          eventTimeText: n.timeText,
          fingerprint: fp,
          dedupConfidence: confidence,
          platformEventId: n.platformEventId || null,
          notificationItemKey: n.notificationItemKey || null,
          workId: n.workId || null,
          workUrl: n.workUrl || null,
          action: n.action,
          content: n.eventType === 'comment' ? n.content : null,
          rawPayloadJson: JSON.stringify(rawPayload),
          targetWorkId: n.workId || null,
          targetWorkUrl: n.workUrl || null,
          profileResolutionStatus,
          myWorkTitle: n.workTitle || null,
        });

        if (result.action === 'inserted') {
          batchInserted++;
          const tag = n.actorProfileUrl ? '' : ' [no-profile]';
          console.error(`[scan]   + ${n.username} [${n.relation}] ${n.action} ${n.timeText}${tag}`);
          allEvents.push({
            eventId: result.eventId, eventType: n.eventType,
            actorName: n.username, actorProfileUrl: n.actorProfileUrl || null,
            relation: n.relation, profileResolutionStatus,
            dbAction: 'inserted', dedupConfidence: confidence,
            platformEventId: n.platformEventId || null,
            targetWorkId: n.workId || null,
            targetWorkUrl: n.workUrl || null,
          });
        } else if (result.action === 'enriched') {
          batchEnriched++;
          console.error(`[scan]   ~ ${n.username} [${n.relation}] enriched`);
          allEvents.push({
            eventId: result.eventId, eventType: n.eventType,
            actorName: n.username, actorProfileUrl: n.actorProfileUrl || null,
            relation: n.relation, profileResolutionStatus,
            dbAction: 'enriched', dedupConfidence: confidence,
            platformEventId: n.platformEventId || null,
            targetWorkId: n.workId || null,
            targetWorkUrl: n.workUrl || null,
          });
        } else if (result.action === 'duplicate') {
          batchDuplicate++;
        } else if (result.action === 'ambiguous') {
          batchAmbiguous++;
          console.error(`[scan]   ? ${n.username} [${n.relation}] ambiguous match`);
          ambiguousEvents.push({
            eventType: n.eventType,
            actorName: n.username, actorProfileUrl: n.actorProfileUrl || null,
            relation: n.relation,
            platformEventId: n.platformEventId || null,
            targetWorkId: n.workId || null,
            error: result.error || 'ambiguous',
          });
        }
      } catch (err) {
        parseFailedCount++;
        failedEvents.push({
          actorName: n.username || 'unknown',
          eventType: n.eventType || 'unknown',
          error: err.message || 'parse error',
        });
      }
    }

    totalInserted += batchInserted;
    totalDuplicateCount += batchDuplicate;
    totalAmbiguousCount += batchAmbiguous;
    totalEnrichedCount += batchEnriched;
    totalProfileResolved += batchProfileResolved;
    totalProfileUnresolved += batchProfileUnresolved;
    scrollRounds++;
    run.scanned += notifications.length;
    run.enriched = totalEnrichedCount;

    console.error(`[scan]   轮次 ${scrollRounds}: +${batchInserted}条 (${batchDuplicate}重复, ${batchEnriched}补全, ${batchAmbiguous}歧义, ${batchProfileResolved}主页解析, ${newInBatch}新)`);
    if (stopDueToOldRelevant) {
      break;
    }

    if (noMoreData) {
      console.error('[scan] 面板显示"暂无更多数据"，停止采集');
      break;
    }

    if (newInBatch === 0) {
      consecutiveEmptyRounds++;
      if (consecutiveEmptyRounds >= 2) {
        console.error('[scan] 连续 2 轮无新通知，停止采集');
        break;
      }
    } else {
      consecutiveEmptyRounds = 0;
    }

    const allDuplicate = notifications.length > 0 && processedInBatch === 0 && batchInserted === 0 && batchEnriched === 0;
    if (allDuplicate) {
      console.error('[scan] 本轮全部为重复数据，停止采集');
      break;
    }

    const scrollResult = await scrollPanelDown(page, { deltaY: 600 });
    if (!scrollResult.scrolled) {
      console.error('[scan] 无法滚动通知面板');
      break;
    }
  }

  if (!run.options?.keepOpen) {
    await closeNotificationPanel(page);
  }

  console.error(`[scan] 通知扫描完成: ${totalInserted} 条入库 | ${totalDuplicateCount} 重复 | ${totalEnrichedCount} 补全信息 | ${totalAmbiguousCount} 歧义 | ${totalProfileResolved} 主页已解析 | ${totalProfileUnresolved} 主页未解析 | ${parseFailedCount} 条解析失败 | ${scrollRounds} 轮滚动`);
  return success({
    inserted: totalInserted,
    duplicateCount: totalDuplicateCount, enriched: totalEnrichedCount,
    ambiguousCount: totalAmbiguousCount,
    profileResolved: totalProfileResolved, profileUnresolved: totalProfileUnresolved,
    parseFailed: parseFailedCount,
    scrollRounds,
    events: allEvents,
    ambiguousEvents,
    failedEvents,
    step: 'notify-scan',
  });
}

async function main() {
  const { options, remaining } = parseCommonArgs(process.argv.slice(2));

  const typeIdx = remaining.indexOf('--type');
  const type = typeIdx >= 0 ? remaining[typeIdx + 1] : 'all';
  const pauseIdx = remaining.indexOf('--pause-after-open');
  const pauseAfterOpen = pauseIdx >= 0 ? parseInt(remaining[pauseIdx + 1], 10) || 0 : 0;
  const debugNotificationDom = remaining.includes('--debug-notification-dom');
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

    // --- Notification scanning phase (ONLY interaction entry point) ---
    // All new interaction collection flows through the notification center.
    // runCommentScan() is preserved only for reply execution positioning,
    // NOT for new event collection.
    const notifResult = await runPhaseWithRecovery(page, run, 'notification', () => runNotificationScan(page, run, type, pauseAfterOpen, debugNotificationDom), options);
    if (!notifResult.ok) {
      if (options.json) {
        printJsonError('interactions:scan', notifResult.code || RESULT_CODES.BLOCKED,
          notifResult.message || '通知扫描失败', { recoverable: notifResult.recoverable !== false }); return;
      }
      return;
    }
    if (notifResult.action === 'quit-close' || notifResult.action === 'quit-keep-open') return;

    console.error('');
    console.error('[scan] ====== 扫描完成 ======');
    const counts = getEventCounts();
    for (const row of counts) {
      console.error(`[scan] ${row.event_type}/${row.status}: ${row.count}`);
    }

    // --json output for agent consumption
    if (options.json) {
      const notifData = notifResult.data || {};
      printJsonResult('interactions:scan', {
        events: notifData.events || [],
        failedEvents: notifData.failedEvents || [],
        ambiguousEvents: notifData.ambiguousEvents || [],
        counts,
      }, {
        totalScanned: run.scanned,
        inserted: notifData.inserted || 0,
        duplicates: notifData.duplicateCount || 0,
        enriched: run.enriched || 0,
        ambiguous: notifData.ambiguousCount || 0,
        parseFailed: notifData.parseFailed || 0,
        profileResolved: notifData.profileResolved || 0,
        profileUnresolved: notifData.profileUnresolved || 0,
        scrollRounds: notifData.scrollRounds || 0,
        source: 'notification',
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
