import { createBrowserContext } from '../browser/browser-context.mjs';
import { ensureCommentPageReady, waitForCommentsArea, extractComments, getSelectedWorkTitle } from '../adapters/comment-page.mjs';
import { commentFingerprint } from '../domain/event-fingerprint.mjs';
import { insertEvent, getEventCounts } from '../db/interaction-repository.mjs';
import logger from '../utils/logger.mjs';

async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  const type = args.includes('--type') ? args[args.indexOf('--type') + 1] : 'all';
  const validTypes = ['all', 'comment', 'like'];
  if (!validTypes.includes(type)) {
    console.error(`Invalid --type: ${type}. Must be one of: ${validTypes.join(', ')}`);
    process.exit(1);
  }

  logger.setLevel('INFO');

  // Ensure database is initialized
  const { runMigrations } = await import('../db/migrations.mjs');
  runMigrations();

  const { generateFingerprint } = await import('../domain/event-fingerprint.mjs');

  let browser = null;
  let commentCount = 0;
  let likeCount = 0;

  try {
    console.log('[scan] 启动浏览器...');
    const ctx = await createBrowserContext({ headless: false });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    const page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    // --- Comment scanning ---
    if (type === 'all' || type === 'comment') {
      console.log('[scan] === 评论扫描 ===');

      await ensureCommentPageReady(page);
      await waitForCommentsArea(page);

      const workTitle = await getSelectedWorkTitle(page);
      console.log(`[scan] 当前作品: ${workTitle || '(未识别)'}`);

      const comments = await extractComments(page);
      console.log(`[scan] 发现 ${comments.length} 条评论`);

      for (const c of comments) {
        const fp = commentFingerprint(c, workTitle);
        const id = insertEvent({
          eventType: 'comment',
          actorName: c.username,
          relation: c.hasReplied ? 'unknown' : 'unknown', // can't determine relation from comment page alone
          myWorkTitle: workTitle,
          commentText: c.content,
          eventTimeText: c.timeText,
          fingerprint: fp,
        });

        if (id) {
          commentCount++;
          console.log(`[scan]   + ${c.username}: ${c.content.slice(0, 40)}...`);
        }
      }

      console.log(`[scan] 评论扫描完成: ${commentCount} 条新评论入库`);
    }

    // --- Like + Comment scanning via notification panel ---
    if (type === 'all' || type === 'like') {
      console.log('[scan] === 通知面板扫描（点赞+评论） ===');

      const { ensureNotificationPageReady, openNotificationPanel, closeNotificationPanel, extractNotifications } = await import('../adapters/notification-page.mjs');
      
      await ensureNotificationPageReady(page);
      
      const opened = await openNotificationPanel(page);
      if (!opened) {
        console.log('[scan] 无法打开通知面板（未找到铃铛图标），跳过。');
      } else {
        console.log('[scan] 通知面板已打开，提取通知...');
        
        const notifications = await extractNotifications(page);
        console.log(`[scan] 面板中发现 ${notifications.length} 条通知`);

        // Always dump raw panel text for debugging
        const rawText = await page.evaluate(() => {
          const panels = document.querySelectorAll('[class*="interaction"], [class*="notice"], [class*="message-panel"], [class*="scroll"], [class*="popup"], [class*="popper"], [class*="drawer"]');
          for (const p of panels) {
            const t = p.innerText || '';
            if (t.includes('互动消息') || t.includes('全部消息')) return t;
          }
          return '(panel not found)';
        });
        console.log('[scan] --- 面板原始文本 ---');
        console.log(rawText.slice(0, 1500));
        console.log('[scan] --- 原始文本结束 ---');
        
        // Determine which event types to process
        const wantComments = (type === 'all');
        const wantLikes = true; // --type like or --type all
        
        for (const n of notifications) {
          // Skip non-like when only looking for likes (comments come from creator page)
          if (!wantComments && n.eventType === 'comment') continue;
          if (!wantLikes && n.eventType === 'like') continue;
          
          // Generate fingerprint
          const fp = generateFingerprint(
            n.eventType, n.username, '', n.content || n.action, n.timeText
          );
          
          const id = insertEvent({
            eventType: n.eventType,
            actorName: n.username,
            relation: n.relation,
            myWorkTitle: '',
            commentText: n.eventType === 'comment' ? n.content : null,
            eventTimeText: n.timeText,
            fingerprint: fp,
          });
          
          if (id) {
            if (n.eventType === 'like') {
              likeCount++;
              console.log(`[scan]   + ${n.username} [${n.relation}] ${n.action} ${n.timeText}`);
            } else {
              commentCount++;
              console.log(`[scan]   + ${n.username}: ${n.content.slice(0, 30)} ${n.timeText}`);
            }
          }
        }
        
        await closeNotificationPanel(page);
        console.log(`[scan] 通知扫描完成: ${likeCount} 赞 + ${commentCount} 评论入库`);
      }
    }

    // --- Summary ---
    console.log('');
    console.log('[scan] ====== 扫描完成 ======');
    const counts = getEventCounts();
    for (const row of counts) {
      console.log(`[scan] ${row.event_type}/${row.status}: ${row.count}`);
    }

  } catch (err) {
    console.error('[scan] 错误:', err.message);
    process.exitCode = 1;
  } finally {
    if (browser) {
      console.log('[scan] 关闭浏览器...');
      await browser.close();
    }
  }
}

main().catch((err) => {
  console.error('[scan] 未捕获错误:', err.message);
  process.exit(1);
});
