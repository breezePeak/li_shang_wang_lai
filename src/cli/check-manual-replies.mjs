// 扫描自己主页作品，检查是否有未回复的评论
//
// 用法：
//   npm run check:manual-replies -- --profile https://www.douyin.com/user/xxxx
//   npm run check:manual-replies -- --profile-url https://www.douyin.com/user/xxxx --days 7 --count 20

import { createBrowserContext } from '../browser/browser-context.mjs';
import { createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { markCommentManuallyReplied, findCommentByWorkActorAndText } from '../db/work-comment-repository.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { normalizeDouyinUrl } from '../utils/douyin-url.mjs';
import {
  collectVisibleWorkCommentCandidates,
  expandVisibleWorkCommentReplies,
  waitForWorkCommentArea,
  waitForWorkModal,
} from '../adapters/work-modal-page.mjs';
import { closeCurrentWorkModalToProfile, openProfileWorkByAwemeIdFromPostApi } from '../services/return-visit-work-collector.mjs';
import { pathToFileURL } from 'url';

function parseArgs(argv) {
  const args = { profileUrl: '', days: 7, count: 20, json: false, keepOpen: false, apply: false, auto: false };
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--profile' || argv[i] === '--profile-url') && argv[i + 1]) {
      args.profileUrl = String(argv[++i] || '').trim();
    }
    if (argv[i] === '--days' && argv[i + 1]) args.days = Number(argv[++i] || 0) || 7;
    if (argv[i] === '--count' && argv[i + 1]) args.count = Number(argv[++i] || 0) || 20;
    if (argv[i] === '--json') args.json = true;
    if (argv[i] === '--keep-open') args.keepOpen = true;
    if (argv[i] === '--apply') args.apply = true;
    if (argv[i] === '--auto') args.auto = true;
  }
  return args;
}

async function detectOwnProfileUrl(page) {
  console.error('[check] 自动检测主页 URL...');

  try {
    await page.goto('https://www.douyin.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
  } catch {
    console.error('[check] 无法打开抖音首页，请确认已登录');
    return '';
  }

  const url = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="/user/"]');
    const candidates = [];
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const rect = link.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue;
      const hasAvatar = link.querySelector('img, [class*="avatar"], [class*="Avatar"]');
      const text = (link.innerText || '').trim();
      const isMy = text.includes('我') || text.includes('个人') || text === '';
      candidates.push({ href, x: rect.x, y: rect.y, hasAvatar: !!hasAvatar, isMy });
    }
    candidates.sort((a, b) => a.x - b.x || a.y - b.y);
    const withAvatar = candidates.filter(c => c.hasAvatar);
    if (withAvatar.length > 0) return withAvatar[0].href;
    if (candidates.length > 0) return candidates[0].href;
    return '';
  });

  if (url) {
    const full = url.startsWith('http') ? url : `https://www.douyin.com${url}`;
    console.error(`[check] 检测到主页: ${full}`);
    return full;
  }

  console.error('[check] 未能从页面提取主页 URL');
  return '';
}

function createProfilePostApiCollector(page) {
  const awemes = [];
  const seenIds = new Set();
  const seenUrls = new Set();

  async function onResponse(response) {
    const url = typeof response.url === 'function' ? response.url() : '';
    if (!url.includes('/aweme/v1/web/aweme/post/')) return;
    if (typeof response.status === 'function' && response.status() !== 200) return;
    if (seenUrls.has(url)) return;
    seenUrls.add(url);

    try {
      const json = await response.json();
      const list = Array.isArray(json?.aweme_list) ? json.aweme_list : [];
      for (const aweme of list) {
        const id = String(aweme?.aweme_id || '');
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        awemes.push(aweme);
      }
    } catch { /* parse error */ }
  }

  page.on('response', onResponse);

  return {
    getAwemes() { return [...awemes]; },
    async waitForAwemes({ beforeCount = 0, timeoutMs = 5000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && awemes.length <= beforeCount) {
        await page.waitForTimeout(200);
      }
      return awemes.length;
    },
    getStats() { return { responseCount: seenUrls.size, awemeCount: awemes.length }; },
    stop() { page.off('response', onResponse); },
  };
}

function isWithinDays(aweme, days) {
  const ct = Number(aweme?.create_time || 0);
  if (!ct) return false;
  return ct >= Math.floor(Date.now() / 1000) - days * 86400;
}

async function collectProfileWorks(page, profileUrl, { days = 7, maxScroll = 40 } = {}) {
  const collector = createProfilePostApiCollector(page);
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2500);

    await collector.waitForAwemes({ beforeCount: 0, timeoutMs: 5000 });

    const initial = collector.getAwemes();
    if (initial.length === 0) {
      console.error('[check] 未采集到作品 API 数据 (可能未登录或私密账号)');
      return [];
    }

    let scrollCount = 0;
    while (scrollCount < maxScroll) {
      const all = collector.getAwemes();
      const oldest = all.length > 0 ? Number(all[all.length - 1]?.create_time || 0) : 0;
      if (oldest > 0 && oldest < cutoff) break;

      const prev = all.length;
      await page.mouse.wheel(0, 1400);
      await page.waitForTimeout(1200);
      scrollCount++;

      const waited = await collector.waitForAwemes({ beforeCount: prev, timeoutMs: 4000 });
      if (waited === prev) break;
    }

    const filtered = collector.getAwemes().filter(a => isWithinDays(a, days));
    console.error(`[check] 采集作品: 总数=${collector.getAwemes().length} ${days}天内=${filtered.length} 滚动=${scrollCount}次`);
    return filtered;
  } finally {
    collector.stop();
  }
}

async function checkSingleWork(page, aweme, profileUrl, { apply = false } = {}) {
  const awemeId = String(aweme?.aweme_id || '');
  const title = String(aweme?.desc || aweme?.preview_title || '').slice(0, 45);
  const createTime = aweme?.create_time
    ? new Date(Number(aweme.create_time) * 1000).toISOString().slice(0, 10)
    : '?';

  try {
    const openResult = await openProfileWorkByAwemeIdFromPostApi(page, profileUrl, awemeId, {
      timeoutMs: 20000,
      maxScrollCount: 10,
      reuseCurrentProfile: true,
    });

    if (!openResult.ok) {
      return { awemeId, title, createTime, error: openResult.reason || 'open_failed', totalCandidates: 0, repliedCount: 0, unrepliedCount: 0, unreplied: [] };
    }

    const modalReady = await waitForWorkModal(page, { timeoutMs: 8000, closeAutoPlay: true });
    if (!modalReady.ok) {
      return { awemeId, title, createTime, error: 'modal_not_ready', totalCandidates: 0, repliedCount: 0, unrepliedCount: 0, unreplied: [] };
    }

    const areaReady = await waitForWorkCommentArea(page, { timeoutMs: 8000 });
    if (!areaReady.ok) {
      return { awemeId, title, createTime, error: 'no_comment_area', totalCandidates: 0, repliedCount: 0, unrepliedCount: 0, unreplied: [] };
    }

    await expandVisibleWorkCommentReplies(page, { maxClicks: 8 }).catch(() => null);

    const collected = await collectVisibleWorkCommentCandidates(page);
    const candidates = collected?.ok ? (collected.candidates || []) : [];

    const unreplied = candidates
      .filter(c => c.hasReplyButton && !c.hasAuthorReply)
      .map(c => ({
        actorName: c.actorName || '',
        commentText: c.commentText || '',
        cid: c.cid || '',
      }));

    const repliedCount = candidates.filter(c => c.hasAuthorReply).length;

    if (apply) {
      for (const uc of unreplied) {
        const existing = findCommentByWorkActorAndText({
          workId: awemeId,
          modalId: awemeId,
          actorName: uc.actorName,
          commentText: uc.commentText,
        });
        if (existing && existing.reply_status === 'pending') {
          markCommentManuallyReplied(existing.id, 'author already replied (check script)');
        }
      }
    }

    return { awemeId, title, createTime, totalCandidates: candidates.length, repliedCount, unrepliedCount: unreplied.length, unreplied, error: '' };
  } catch (err) {
    return { awemeId, title, createTime, error: err.message, totalCandidates: 0, repliedCount: 0, unrepliedCount: 0, unreplied: [] };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.profileUrl && !args.auto) {
    console.error([
      '用法: npm run check:manual-replies -- --auto',
      '      npm run check:manual-replies -- --profile <你的抖音主页URL>',
      '',
      '参数:',
      '  --auto     自动从抖音首页检测你的主页 URL',
      '  --profile  你的抖音主页 URL',
      '  --days     只检查最近 N 天的作品（默认 7）',
      '  --count    最多检查 N 个作品（默认 20）',
      '  --apply    将未回复评论在 DB 中标记为 manually_replied',
      '  --json     JSON 格式输出',
      '  --keep-open 保持浏览器不关闭',
    ].join('\n'));
    process.exit(1);
  }

  const profileUrl = normalizeDouyinUrl(args.profileUrl) || args.profileUrl;
  runMigrations();

  console.error(`[check] 主页: ${profileUrl}  范围: ${args.days}天  上限: ${args.count}个作品\n`);

  const run = createRunContext('check-manual-replies', {
    debug: true, execute: true, json: args.json,
    keepOpen: Boolean(args.keepOpen), writeRunFiles: false,
  });

  let browser = null;
  let page = null;
  const allResults = [];

  try {
    const ctx = await createBrowserContext({ headless: false, enableReuse: Boolean(args.keepOpen) });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();

    const works = await collectProfileWorks(page, profileUrl, { days: args.days });
    if (works.length === 0) {
      console.log('[check] 未找到作品');
      return;
    }

    const toCheck = works.slice(0, args.count);
    console.error(`[check] 检查 ${toCheck.length} 个作品\n`);

    for (let i = 0; i < toCheck.length; i++) {
      const aweme = toCheck[i];
      const result = await checkSingleWork(page, aweme, profileUrl, { apply: args.apply });
      allResults.push(result);

      const flag = result.error ? '!!' : result.unrepliedCount > 0 ? 'x' : '\u2713';
      const date = result.createTime || '?';
      const title = String(result.title || '').slice(0, 30);
      console.error(`  ${flag}  [${i + 1}/${toCheck.length}] ${date}  ${title}${' '.repeat(Math.max(0, 32 - title.length))} 评论${result.totalCandidates} 待回${result.unrepliedCount}`);

      const closeResult = await closeCurrentWorkModalToProfile(page, profileUrl, { timeoutMs: 6000 });
      if (!closeResult.ok) {
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);
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

  const totalUnreplied = allResults.reduce((s, r) => s + (r.unrepliedCount || 0), 0);
  const totalComments = allResults.reduce((s, r) => s + (r.totalCandidates || 0), 0);
  const errors = allResults.filter(r => r.error).length;

  if (args.json) {
    console.log(JSON.stringify({
      profileUrl, days: args.days,
      summary: { works: allResults.length, totalComments, unreplied: totalUnreplied, errors },
      works: allResults,
    }, null, 2));
  } else {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(` ${allResults.length}作品  ${totalComments}评论  ${allResults.reduce((s, r) => s + (r.repliedCount || 0), 0)}已回  ${totalUnreplied}待回  ${errors}错误`);
    if (args.apply) console.log(` (标记 ${allResults.filter(r => r.applied).length} 条)`);

    for (const r of allResults) {
      if (r.unrepliedCount > 0) {
        console.log(`\n作品 ${r.createTime} "${r.title}"  待回${r.unrepliedCount}条:`);
        for (const c of (r.unreplied || [])) {
          console.log(`  @${c.actorName}: ${String(c.commentText).slice(0, 70)}`);
        }
      }
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
