// 检查是否已手动回复的脚本
// 打开作品评论区，检测每条待回评的评论是否已有作者回复
//
// 用法：
//   npm run check:manual-replies -- --days 7 --limit 10
//   npm run check:manual-replies -- --comment-id 123
//   npm run check:manual-replies -- --days 7 --limit 10 --apply
//   npm run check:manual-replies -- --days 7 --limit 10 --json

import { runMigrations } from '../db/migrations.mjs';
import { getWorkComment, listPendingCommentsGroupedByHomepageAndWork, markCommentManuallyReplied } from '../db/work-comment-repository.mjs';
import { findWorkByIdentity } from '../db/work-repository.mjs';
import { createBrowserContext } from '../browser/browser-context.mjs';
import { createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { buildDouyinWorkUrl } from '../utils/douyin-url.mjs';
import { extractTargetCommentId } from './execute-comment-replies.mjs';
import {
  collectVisibleWorkCommentCandidates,
  expandVisibleWorkCommentReplies,
  pickWorkCommentCandidate,
  buildWorkReplyTarget,
  waitForWorkCommentArea,
  waitForWorkModal,
} from '../adapters/work-modal-page.mjs';
import { createCommentListApiCollector } from '../adapters/comment-list-api-listener.mjs';
import { openProfileWorkByAwemeIdFromPostApi } from '../services/return-visit-work-collector.mjs';
import { pathToFileURL } from 'url';

function parseArgs(argv) {
  const args = { limit: 10, days: 7, commentId: null, json: false, keepOpen: false, apply: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit' && argv[i + 1]) args.limit = Number(argv[++i] || 0) || 10;
    if (argv[i] === '--days' && argv[i + 1]) args.days = Number(argv[++i] || 0) || 7;
    if (argv[i] === '--comment-id' && argv[i + 1]) args.commentId = Number(argv[++i] || 0) || null;
    if (argv[i] === '--json') args.json = true;
    if (argv[i] === '--keep-open') args.keepOpen = true;
    if (argv[i] === '--apply') args.apply = true;
  }
  return args;
}

function buildItemsFromCommentId(commentId) {
  const row = getWorkComment(commentId);
  if (!row) {
    console.error(`[check:manual-replies] 找不到 work_comments.id=${commentId}`);
    return [];
  }

  const knownWork = findWorkByIdentity({ workId: row.work_id, modalId: row.modal_id });
  const homepageUrl = knownWork?.author_profile_url || '';

  return [{
    commentId: row.id,
    workId: row.work_id || '',
    modalId: row.modal_id || '',
    homepageUrl,
    authorProfileUrl: homepageUrl,
    authorProfileKey: knownWork?.author_profile_key || '',
    actorName: row.actor_name || '',
    commentText: row.comment_text || '',
    eventTimeText: row.event_time_text || '',
    targetCommentId: extractTargetCommentId({}, row),
  }];
}

function buildItemsFromPending(limit, days) {
  const rows = listPendingCommentsGroupedByHomepageAndWork({ limit, days });
  return rows.map(row => {
    const homepageUrl = row.joined_author_profile_url || '';
    return {
      commentId: row.id,
      workId: row.joined_work_id || row.work_id || '',
      modalId: row.joined_modal_id || row.modal_id || '',
      homepageUrl,
      authorProfileUrl: homepageUrl,
      authorProfileKey: row.joined_author_profile_key || '',
      actorName: row.actor_name || '',
      commentText: row.comment_text || '',
      eventTimeText: row.event_time_text || '',
      targetCommentId: extractTargetCommentId({}, row),
    };
  });
}

function formatCandidateBrief(c, maxTextLen = 50) {
  const text = String(c.commentText || '').slice(0, maxTextLen);
  const cid = c.cid ? ` cid=${c.cid}` : '';
  const author = c.actorName ? ` @${c.actorName}` : '';
  const reply = c.hasAuthorReply ? ' [作者已回]' : '';
  return `dom#${c.domIndex}${cid}${author} "${text}"${reply}`;
}

async function checkWorkComments(page, items, { apply = false } = {}) {
  const commentListCollector = createCommentListApiCollector(page);

  try {
    const modalReady = await waitForWorkModal(page, { timeoutMs: 12000, closeAutoPlay: true });
    if (!modalReady.ok) {
      return items.map(item => ({ ...item, error: `modal_not_ready:${modalReady.code || ''}` }));
    }

    const areaReady = await waitForWorkCommentArea(page, { timeoutMs: 10000 });
    if (!areaReady.ok) {
      return items.map(item => ({ ...item, error: `comment_area_not_ready:${areaReady.code || ''}` }));
    }

    await expandVisibleWorkCommentReplies(page, { maxClicks: 6 }).catch(() => null);

    const collected = await collectVisibleWorkCommentCandidates(page);
    const candidates = collected?.ok ? (collected.candidates || []) : [];

    console.error(`[check:manual-replies] 可见候选评论 ${candidates.length} 条`);
    for (const c of candidates) {
      console.error(`  ${formatCandidateBrief(c)}`);
    }

    const results = [];
    for (const item of items) {
      const apiComment = commentListCollector.getByCid(item.targetCommentId) || null;
      const target = buildWorkReplyTarget(item, apiComment);

      const picked = pickWorkCommentCandidate(candidates, target);

      if (!picked.ok) {
        console.error(`[check:manual-replies] commentId=${item.commentId} 未匹配到候选: ${picked.reason}`);
        results.push({
          commentId: item.commentId,
          actorName: item.actorName,
          commentText: item.commentText,
          matched: false,
          matchReason: picked.reason,
          hasAuthorReply: false,
        });
        continue;
      }

      const candidate = picked.candidate;
      const hasAuthorReply = !!candidate.hasAuthorReply;

      console.error(`[check:manual-replies] commentId=${item.commentId} 匹配成功: ${formatCandidateBrief(candidate)} matchedBy=${picked.matchedBy}`);

      if (hasAuthorReply && apply) {
        markCommentManuallyReplied(item.commentId, 'author already replied (check script)');
        console.error(`[check:manual-replies] commentId=${item.commentId} → 已标记为 manually_replied`);
      }

      results.push({
        commentId: item.commentId,
        actorName: item.actorName,
        commentText: item.commentText,
        matched: true,
        matchedBy: picked.matchedBy,
        matchedCandidate: {
          cid: candidate.cid || '',
          actorName: candidate.actorName || '',
          commentText: candidate.commentText || '',
          hasReplyButton: candidate.hasReplyButton,
          hasAuthorReply: candidate.hasAuthorReply,
        },
        hasAuthorReply,
        applied: apply && hasAuthorReply,
      });
    }

    return results;
  } finally {
    commentListCollector.stop();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  runMigrations();

  let items;
  if (args.commentId) {
    items = buildItemsFromCommentId(args.commentId);
    if (items.length === 0) {
      console.error('[check:manual-replies] 未找到对应评论');
      process.exit(1);
    }
    console.error(`[check:manual-replies] 检查单条评论 commentId=${args.commentId}`);
  } else {
    items = buildItemsFromPending(args.limit, args.days);
    console.error(`[check:manual-replies] 加载 pending 评论 ${items.length} 条 (days=${args.days}, limit=${args.limit})`);
  }

  if (items.length === 0) {
    console.log('[check:manual-replies] 没有待检查的评论');
    return;
  }

  const run = createRunContext('check-manual-replies', {
    debug: true,
    execute: true,
    json: args.json,
    keepOpen: Boolean(args.keepOpen),
    writeRunFiles: false,
  });

  let browser = null;
  let page = null;
  const allResults = [];

  try {
    const ctx = await createBrowserContext({ headless: false, enableReuse: Boolean(args.keepOpen) });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    const workGroups = new Map();
    for (const item of items) {
      const key = `${item.homepageUrl || ''}::${item.workId || item.modalId || 'no-work'}`;
      if (!workGroups.has(key)) workGroups.set(key, []);
      workGroups.get(key).push(item);
    }

    for (const [key, group] of workGroups) {
      const first = group[0];
      console.error(`\n[check:manual-replies] === 作品 work_id=${first.workId || first.modalId} 待查 ${group.length} 条 ===`);

      try {
        const openResult = await openProfileWorkByAwemeIdFromPostApi(
          page,
          first.homepageUrl || first.authorProfileUrl || '',
          first.workId || first.modalId,
          { timeoutMs: 30000 }
        );

        if (!openResult.ok) {
          const fallbackUrl = buildDouyinWorkUrl(first.workId || first.modalId);
          if (fallbackUrl) {
            console.error(`[check:manual-replies] 打开主页失败, 直接导航作品 url=${fallbackUrl}`);
            await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(1500);
          } else {
            for (const item of group) {
              allResults.push({ commentId: item.commentId, error: 'open_work_failed', hasAuthorReply: false, matched: false });
            }
            continue;
          }
        }

        const groupResults = await checkWorkComments(page, group, { apply: args.apply });
        allResults.push(...groupResults);
      } catch (err) {
        console.error(`[check:manual-replies] 检查失败: ${err.message}`);
        for (const item of group) {
          allResults.push({ commentId: item.commentId, error: err.message, hasAuthorReply: false, matched: false });
        }
      }
    }
  } finally {
    saveRunSummary(run);
    if (browser) {
      const shouldClose = resolveBrowserClose(run);
      if (shouldClose) await browser.close();
      else if (typeof browser.disconnect === 'function') await browser.disconnect();
    }
  }

  const withAuthorReply = allResults.filter(r => r.hasAuthorReply);
  const unmatched = allResults.filter(r => !r.matched && !r.error);
  const errors = allResults.filter(r => r.error);

  if (args.json) {
    console.log(JSON.stringify({
      summary: {
        total: allResults.length,
        hasAuthorReply: withAuthorReply.length,
        noAuthorReply: allResults.filter(r => r.matched && !r.hasAuthorReply).length,
        unmatched: unmatched.length,
        errors: errors.length,
      },
      results: allResults.map(r => ({
        commentId: r.commentId,
        actorName: r.actorName,
        commentText: String(r.commentText || '').slice(0, 80),
        matched: r.matched,
        matchReason: r.matchReason || '',
        hasAuthorReply: r.hasAuthorReply,
        error: r.error || '',
      })),
    }, null, 2));
  } else {
    console.log(`\n${'='.repeat(60)}`);
    console.log(` 总计 ${allResults.length}  已手动回复 ${withAuthorReply.length}  未回复 ${allResults.filter(r => r.matched && !r.hasAuthorReply).length}  未匹配 ${unmatched.length}  错误 ${errors.length}`);
    if (args.apply) console.log(` (已写入标记 ${allResults.filter(r => r.applied).length} 条)`);
    console.log(`${'='.repeat(60)}`);

    for (const r of allResults) {
      const prefix = r.error ? '[错误]'
        : !r.matched ? '[缺失]'
        : r.hasAuthorReply ? '[已回]'
        : '[待回]';
      const text = String(r.commentText || '').slice(0, 50);
      const extra = r.error ? ` ${r.error}`
        : r.matchReason ? ` 原因:${r.matchReason}`
        : '';
      console.log(` ${prefix} #${r.commentId} @${r.actorName} "${text}"${extra}`);
    }
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch(err => {
    console.error('[check:manual-replies]', err);
    process.exit(1);
  });
}
