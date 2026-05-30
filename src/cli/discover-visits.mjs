import { getEvents } from '../db/interaction-repository.mjs';
import { generatePlan } from './plan-actions.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { createBrowserContext } from '../browser/browser-context.mjs';
import { findLatestNonPinnedVideo } from '../adapters/user-profile-page.mjs';
import { navigateToVideo, checkLikeState, getVideoTitle } from '../adapters/video-page.mjs';
import { parseCommonArgs, createRunContext, saveRunSummary, resolveBrowserClose } from '../browser/run-context.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';

async function processCandidate(page, candidate) {
  const name = candidate.actorName || 'unknown';
  const r = {
    actorName: name,
    actorProfileUrl: candidate.actorProfileUrl || '',
    actorProfileKey: candidate.actorProfileKey || '',
    canonicalActorProfileUrl: candidate.canonicalActorProfileUrl || '',
    relation: candidate.relation || 'unknown',
    sourceEventIds: candidate.sourceEventIds || [],
    sourceEventTypes: candidate.sourceEventTypes || [],
    dedupConfidenceSummary: candidate.dedupConfidenceSummary || 'weak',
    targetVideoUrl: '',
    targetVideoId: null,
    targetVideoTitle: '',
    likeState: 'unknown',
    status: 'blocked',
    reason: '',
    commentRequired: false,
    likeRequired: false,
    executeAllowed: false,
    requiresManualReview: candidate.requiresManualReview !== false,
  };

  console.error(`\n[discover] ${name} [${r.relation}]`);

  if (!r.actorProfileUrl) {
    r.reason = '缺少主页 URL';
    console.error(`[discover]   ${r.reason}`);
    return r;
  }

  console.error(`[discover]   主页: ${r.actorProfileUrl.slice(0, 60)}...`);
  await page.goto(r.actorProfileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  const videoResult = await findLatestNonPinnedVideo(page);
  if (!videoResult.ok) {
    r.reason = videoResult.message || '未找到非置顶视频';
    console.error(`[discover]   ${r.reason}`);
    return r;
  }

  r.targetVideoUrl = videoResult.data.videoUrl;
  r.targetVideoId = videoResult.data.videoId || null;
  console.error(`[discover]   视频: ${r.targetVideoUrl.slice(0, 60)} (id=${r.targetVideoId})`);

  await page.waitForTimeout(2000);

  const navResult = await navigateToVideo(page, r.targetVideoUrl);
  if (!navResult.ok) {
    r.reason = navResult.message || '无法导航到视频页面';
    console.error(`[discover]   ${r.reason}`);
    return r;
  }

  const likeResult = await checkLikeState(page);
  if (!likeResult.ok) {
    r.reason = likeResult.message || '无法确定点赞状态';
    r.likeState = 'unknown';
    console.error(`[discover]   ${r.reason}`);
    return r;
  }

  if (likeResult.data.alreadyLiked) {
    r.likeState = 'already_liked';
    r.status = 'skipped';
    r.reason = '已点赞';
    console.error('[discover]   已点赞，跳过');
    return r;
  }

  r.likeState = 'not_liked';
  r.status = 'planned_preview';
  r.commentRequired = true;
  r.likeRequired = true;
  r.reason = '';

  const titleResult = await getVideoTitle(page);
  if (titleResult.ok && titleResult.data.title) {
    r.targetVideoTitle = titleResult.data.title;
  }

  console.error(`[discover]   未点赞 → 候选: "${r.targetVideoTitle.slice(0, 40)}"`);
  return r;
}

async function main() {
  runMigrations();

  const commonArgs = parseCommonArgs(process.argv.slice(2));
  const useJson = commonArgs.options.json;
  const maxItems = commonArgs.options.maxItems || 10;

  console.error('[discover] 读取好友/互关事件...');
  const allEvents = getEvents({ status: 'new', limit: 100 });
  const candidates = generatePlan(allEvents).visitWorkCandidates;

  if (candidates.length === 0) {
    console.error('[discover] 没有好友回访候选。先运行 npm run actions:plan');
    if (useJson) {
      printJsonResult('visits:discover', { visitDiscoveries: [] }, { total: 0, planned: 0, skipped: 0, blocked: 0 });
    }
    return;
  }

  const slice = candidates.slice(0, maxItems);
  console.error(`[discover] ${candidates.length} 个候选，本轮处理 ${slice.length} 个`);

  const run = createRunContext('visits:discover', commonArgs.options);
  let browser = null;
  let page = null;
  const discoveries = [];

  try {
    console.error('[discover] 启动浏览器...');
    const ctx = await createBrowserContext({ headless: false, enableReuse: commonArgs.options.keepOpen });
    browser = ctx.browser;
    const pages = ctx.context.pages();
    page = pages.length > 0 ? pages[0] : await ctx.context.newPage();
  } catch (err) {
    console.error('[discover] 浏览器启动失败:', err.message);
    if (useJson) {
      printJsonError('visits:discover', RESULT_CODES.UNKNOWN_ERROR, '浏览器启动失败: ' + err.message);
    }
    return;
  }

  try {
    for (let i = 0; i < slice.length; i++) {
      const item = await processCandidate(page, slice[i]);
      discoveries.push(item);
      run.scanned++;
      if (item.status === 'planned_preview') run.planned++;
      else if (item.status === 'skipped') run.skipped++;
      else run.blocked++;
    }
  } catch (err) {
    console.error('[discover] 处理异常:', err.message);
  } finally {
    saveRunSummary(run);
    const shouldClose = resolveBrowserClose(run);
    if (shouldClose && browser) {
      console.error('[discover] 关闭浏览器...');
      await browser.close().catch(() => {});
    }
  }

  const planned = discoveries.filter(d => d.status === 'planned_preview').length;
  const skipped = discoveries.filter(d => d.status === 'skipped').length;
  const blocked = discoveries.filter(d => d.status === 'blocked').length;

  console.error(`\n===== 汇总 =====`);
  console.error(`  候选: ${planned} | 跳过: ${skipped} | 阻塞: ${blocked} | 合计: ${discoveries.length}`);
  for (const d of discoveries) {
    if (d.status === 'planned_preview') {
      console.error(`  [${d.sourceEventIds.join(',')}] ${d.actorName} → ${d.targetVideoUrl}`);
    } else if (d.status === 'skipped') {
      console.error(`  - ${d.actorName}: ${d.reason}`);
    } else {
      console.error(`  x ${d.actorName}: ${d.reason}`);
    }
  }

  const data = { visitDiscoveries: discoveries };
  const summary = { total: discoveries.length, planned, skipped, blocked };

  if (useJson) {
    printJsonResult('visits:discover', data, summary);
  }
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/discover-visits.mjs') || process.argv[1].endsWith('\\discover-visits.mjs')
);
if (isMain) {
  main().catch(err => {
    console.error('[discover] 错误:', err.message);
    printJsonError('visits:discover', RESULT_CODES.UNKNOWN_ERROR, err.message);
    process.exit(1);
  });
}
