document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

let statsData = {};
let reviewTasks = [];
let pendingComments = [];
let currentViewMode = localStorage.getItem('viewMode') || 'grid';
let selectedTaskIds = new Set();
let selectedStageId = 'collect';
let selectedDetailBranchIndex = null;

const REPLY_STAGE_IDS = new Set(['replies', 'replyPending', 'replyExceptions', 'replySkipped', 'replyDone']);
const VISIT_STAGE_IDS = new Set(['visits', 'visitUnhandled', 'visitRetry', 'execute', 'executeErrors', 'visitSkipped', 'done', 'archive']);

async function initApp() {
  bindEvents();
  applyViewButtons();
  await refreshAll();
  setInterval(fetchStats, 10000);
}

function bindEvents() {
  document.getElementById('btn-refresh').addEventListener('click', refreshAll);
  document.getElementById('search-input').addEventListener('input', renderStageWorkspace);
  document.getElementById('filter-status').addEventListener('change', renderStageWorkspace);
  document.getElementById('filter-relation').addEventListener('change', renderStageWorkspace);
  document.getElementById('btn-view-grid').addEventListener('click', () => setViewMode('grid'));
  document.getElementById('btn-view-table').addEventListener('click', () => setViewMode('table'));
  document.getElementById('btn-bulk-approve').addEventListener('click', bulkApproveTasks);
  document.getElementById('btn-bulk-skip').addEventListener('click', bulkSkipTasks);
  document.getElementById('btn-bulk-cancel').addEventListener('click', clearSelectedTasks);
}

function setViewMode(mode) {
  currentViewMode = mode;
  localStorage.setItem('viewMode', mode);
  applyViewButtons();
  renderStageWorkspace();
}

function applyViewButtons() {
  document.getElementById('btn-view-grid').classList.toggle('active', currentViewMode === 'grid');
  document.getElementById('btn-view-table').classList.toggle('active', currentViewMode === 'table');
}

async function refreshAll() {
  await Promise.all([fetchStats(), fetchReviewTasks(), fetchPendingComments()]);
  renderHeroStats();
  renderRiverTimeline();
  renderStageDetail();
}

async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const json = await res.json();
    if (json.ok) {
      statsData = json.data;
    }
  } catch (err) {
    console.error('获取统计失败:', err);
  }
}

async function fetchReviewTasks() {
  try {
    const res = await fetch('/api/revisit-tasks');
    const json = await res.json();
    if (json.ok) {
      reviewTasks = json.data;
    }
  } catch (err) {
    console.error('获取回访任务失败:', err);
    showToast('获取回访任务失败', 'error');
  }
}

async function fetchPendingComments() {
  try {
    const res = await fetch('/api/pending-comments');
    const json = await res.json();
    if (json.ok) {
      pendingComments = json.data;
    }
  } catch (err) {
    console.error('获取回评评论失败:', err);
  }
}

function renderHeroStats() {
  const waitingCount = (statsData.pendingReplies || 0) + getUnhandledEventCount();
  const errorCount = (statsData.replyExceptions || 0) + getVisitStatusCount('failed_collect', 'failed_generate_comment', 'failed_like', 'failed_comment', 'failed');
  setText('hero-collected-total', statsData.collectedTotal || 0);
  setText('hero-total-tasks', waitingCount);
  setText('hero-completed-tasks', errorCount);
}

function renderRiverTimeline() {
  const container = document.getElementById('river-nodes-container');
  if (!container) return;
  const stageMap = buildStageMap();
  const activeStageId = selectedStageId;

  const replyLane = [
    timelinePoint('replies', '回评入口', 'fa-comments', stageMap.replies?.count || 0, '评论入库后进入 reply_status 队列', 'main'),
    timelinePoint('replyPending', '待回评', 'fa-reply', statsData.pendingReplies || 0, 'pending 会被 comments:execute 处理', 'work'),
    timelinePoint('replyExceptions', '回评异常', 'fa-triangle-exclamation', statsData.replyExceptions || 0, 'blocked / sent_unverified 需要人工介入', 'warning'),
    timelinePoint('replySkipped', '忽略回评', 'fa-ban', statsData.skippedReplies || 0, '人工忽略或不再处理的回复', 'muted'),
    timelinePoint('replyDone', '回评完成', 'fa-circle-check', statsData.succeededReplies || 0, '已回复成功写入 DB', 'done'),
  ];

  const visitLane = [
    timelinePoint('visits', '回访入口', 'fa-route', stageMap.visits?.count || 0, '点赞/评论/关注/回复沉淀为回访线索', 'main'),
    timelinePoint('visitUnhandled', '未处理线索', 'fa-inbox', getUnhandledEventCount(), 'new 状态的关注、回复、点赞、评论', 'work'),
    timelinePoint('visitRetry', '匹配/生成重试', 'fa-rotate-left', stageMap.visitRetry?.count || 0, '作品收集或评论生成失败，可重试', 'warning'),
    timelinePoint('execute', '执行回访', 'fa-bolt', stageMap.execute?.count || 0, 'visit:run --execute 真实点赞/评论', 'work'),
    timelinePoint('executeErrors', '执行异常', 'fa-circle-xmark', stageMap.executeErrors?.count || 0, '点赞、评论或状态确认失败', 'danger'),
    timelinePoint('visitSkipped', '无法回访', 'fa-user-slash', statsData.skippedVisitTasks || 0, '私密、无作品、无合适作品等跳过', 'muted'),
    timelinePoint('done', '回访完成', 'fa-circle-check', statsData.completedTasks || 0, '回访任务 done', 'done'),
  ];

  container.innerHTML = `
    <div class="timeline-overview">
      <button class="timeline-origin ${activeStageId === 'collect' ? 'is-active' : ''}" onclick="selectStage('collect')">
        <span class="origin-icon"><i class="fa-solid fa-database"></i></span>
        <span class="origin-copy">
          <strong>扫描入库</strong>
          <small>通知先入库，再分成回评 / 回访两条线</small>
        </span>
        <span class="origin-count">${statsData.collectedTotal || 0}</span>
      </button>
      <div class="timeline-splitter" aria-hidden="true"></div>
    </div>
    ${renderTimelineLane({ id: 'reply', title: '回评时间线', subtitle: '处理别人评论我的作品', icon: 'fa-reply-all', points: replyLane, activeStageId })}
    ${renderTimelineLane({ id: 'visit', title: '回访时间线', subtitle: '回访点赞/评论/关注/回复线索', icon: 'fa-route', points: visitLane, activeStageId })}
  `;
}

function timelinePoint(id, label, icon, count, helper, tone = 'work') {
  return { id, label, icon, count, helper, tone };
}

function renderTimelineLane({ id, title, subtitle, icon, points, activeStageId }) {
  const isLaneActive = id === 'reply'
    ? REPLY_STAGE_IDS.has(activeStageId)
    : VISIT_STAGE_IDS.has(activeStageId);
  return `
    <section class="timeline-lane ${isLaneActive ? 'is-active' : ''}">
        <div class="lane-title">
        <span><i class="fa-solid ${icon}"></i></span>
        <div>
          <strong>${title}</strong>
          <small>${subtitle}</small>
        </div>
      </div>
      <div class="lane-track">
        ${points.map(point => renderTimelinePoint(point, activeStageId)).join('')}
      </div>
    </section>
  `;
}

function renderTimelinePoint(point, activeStageId) {
  const activeClass = activeStageId === point.id ? 'is-active' : '';
  const countClass = Number(point.count || 0) > 0 ? 'has-count' : '';
  const focusClass = Number(point.count || 0) > 0 && (point.tone === 'warning' || point.tone === 'danger' || point.id === 'replyPending' || point.id === 'visitUnhandled') ? 'is-focus' : '';
  return `
    <button class="timeline-point ${point.tone} ${activeClass} ${countClass} ${focusClass}" onclick="selectStage('${point.id}')" title="${escapeAttribute(point.helper || point.label)}">
      <span class="point-dot"><i class="fa-solid ${point.icon}"></i></span>
      <span class="point-copy">
        <strong>${point.label}</strong>
        <small>${point.helper}</small>
      </span>
      <span class="point-count">${point.count || 0}</span>
    </button>
  `;
}

function buildStageMap() {
  const replyWorkCount = (statsData.pendingReplies || 0) + (statsData.replyExceptions || 0);
  const visitQueueCount = reviewTasks.filter((task) => ['pending_visit', 'collecting_content', 'content_collected', 'comment_generated', 'failed_collect', 'failed_generate_comment'].includes(task.status)).length;
  const executableCount = reviewTasks.filter((task) => ['pending_visit', 'pending_execute', 'executing', 'failed_collect', 'failed_generate_comment', 'failed_like', 'failed_comment'].includes(task.status)).length;
  const executeErrorCount = reviewTasks.filter((task) => ['failed_like', 'failed_comment', 'failed'].includes(task.status)).length;
  const retryCount = reviewTasks.filter((task) => ['failed_collect', 'failed_generate_comment'].includes(task.status)).length;

  return {
    collect: {
      label: '扫描入库',
      count: statsData.collectedTotal || 0,
      helper: `通知中心扫描入库，点赞 ${statsData.collectedLikes || 0} 条，评论 ${statsData.collectedComments || 0} 条。`,
      tag: '第一站',
    },
    replies: {
      label: '回评队列',
      count: replyWorkCount,
      helper: `${statsData.pendingReplies || 0} 条待回评，${statsData.replyExceptions || 0} 条异常待处理。`,
      tag: 'DB 队列',
    },
    replyPending: {
      label: '待回评',
      count: statsData.pendingReplies || 0,
      helper: 'pending 状态会被 comments:execute 自动处理。',
      tag: '可执行',
    },
    replyExceptions: {
      label: '回评异常',
      count: statsData.replyExceptions || 0,
      helper: 'blocked / sent_unverified 在这里人工处理后再回到 pending。',
      tag: '人工处理',
    },
    replySkipped: {
      label: '忽略回评',
      count: statsData.skippedReplies || 0,
      helper: '人工忽略或无需继续处理的回评。',
      tag: '止损',
    },
    replyDone: {
      label: '回评完成',
      count: statsData.succeededReplies || 0,
      helper: '已成功回复的评论。',
      tag: '完成',
    },
    visits: {
      label: '回访任务',
      count: visitQueueCount,
      helper: `${visitQueueCount} 条任务等待 visit:run 执行或重新匹配作品。`,
      tag: '主页匹配',
    },
    visitUnhandled: {
      label: '未处理线索',
      count: getUnhandledEventCount(),
      helper: 'new 状态的点赞、评论、回复、关注通知。',
      tag: '待准备',
    },
    visitRetry: {
      label: '待重试',
      count: retryCount,
      helper: '作品收集或评论生成失败的回访任务，可重新进入执行。',
      tag: '可重试',
    },
    execute: {
      label: '执行回访',
      count: executableCount,
      helper: `${executableCount} 条任务可由 visit:run --execute 继续推进。`,
      tag: '真实动作',
    },
    executeErrors: {
      label: '执行异常',
      count: executeErrorCount,
      helper: '点赞、评论或最终状态确认失败，需要人工判断是否重试。',
      tag: '风险分支',
    },
    visitSkipped: {
      label: '无法回访',
      count: statsData.skippedVisitTasks || 0,
      helper: '私密、无作品、无合适作品等跳过任务。',
      tag: '止损',
    },
    done: {
      label: '完成归档',
      count: statsData.completedTasks || 0,
      helper: '点赞和评论都落地后，任务最终汇入这里。',
      tag: '终点',
    },
  };
}

function buildStageDetailData() {
  const replyWorkCount = (statsData.pendingReplies || 0) + (statsData.replyExceptions || 0);
  const replyExceptionComments = pendingComments.filter(c => c.reply_status !== 'pending');
  const visitQueueTasks = reviewTasks.filter((task) => ['pending_visit', 'collecting_content', 'content_collected', 'comment_generated', 'failed_collect', 'failed_generate_comment'].includes(task.status));
  const visitRetryTasks = reviewTasks.filter((task) => ['failed_collect', 'failed_generate_comment'].includes(task.status));
  const executableTasks = reviewTasks.filter((task) => ['pending_visit', 'pending_execute', 'executing', 'failed_collect', 'failed_generate_comment', 'failed_like', 'failed_comment'].includes(task.status));
  const executeErrorTasks = reviewTasks.filter((task) => ['failed_like', 'failed_comment', 'failed'].includes(task.status));
  const unhandledEventCount = getUnhandledEventCount();
  const skippedVisitTasks = statsData.skippedVisitTasks || 0;

  return {
    collect: {
      kicker: '起点',
      title: '扫描后分成两条线',
      description: '先从通知中心把互动写入数据库，然后分流：评论进入回评线；点赞、评论、回复、关注进入回访线。这里主要看入库是否正常、有没有未处理、有没有异常。',
      metrics: [
        { label: '总通知', value: statsData.collectedTotal || 0 },
        { label: '点赞通知', value: statsData.collectedLikes || 0 },
        { label: '评论通知', value: statsData.collectedComments || 0 },
        { label: '回复/关注', value: (statsData.collectedReplies || 0) + (statsData.collectedFollows || 0) },
      ],
      branches: [
        buildBranchCard('回评线', `${statsData.pendingReplies || 0} 条待回评，${statsData.replyExceptions || 0} 条异常。`, (statsData.pendingReplies || 0) + (statsData.replyExceptions || 0)),
        buildBranchCard('回访线', `${unhandledEventCount} 条通知仍未处理，${visitRetryTasks.length + executeErrorTasks.length} 条任务异常/待重试。`, unhandledEventCount + visitRetryTasks.length + executeErrorTasks.length),
      ],
      workspaceTitle: '先看三件事',
      workspaceSubtitle: '入库量、待处理、异常。正常就分别点回评线和回访线处理。',
      workspaceType: 'overview',
      workspaceContent: renderOverviewContent([
        ['看入库', `当前入库 ${statsData.collectedTotal || 0} 条：点赞 ${statsData.collectedLikes || 0}，评论 ${statsData.collectedComments || 0}，回复 ${statsData.collectedReplies || 0}，关注 ${statsData.collectedFollows || 0}。`],
        ['看待处理', `回评待处理 ${statsData.pendingReplies || 0} 条；回访未处理线索 ${unhandledEventCount} 条。`],
        ['看异常', `回评异常 ${statsData.replyExceptions || 0} 条；回访异常/待重试 ${visitRetryTasks.length + executeErrorTasks.length} 条。`],
      ]),
    },
    fallback: {
      kicker: '采集异常',
      title: '扫描异常与降级提醒',
      description: '这里用于提示通知 API 采集、主页解析或 DOM 降级相关问题。目前前端没有单独异常表，主要看扫描命令输出日志。',
      metrics: [
        { label: '入库通知', value: statsData.collectedTotal || 0 },
        { label: '点赞通知', value: statsData.collectedLikes || 0 },
        { label: '评论通知', value: statsData.collectedComments || 0 },
        { label: '回复/关注', value: (statsData.collectedReplies || 0) + (statsData.collectedFollows || 0) },
      ],
      branches: [
        buildBranchCard('看命令输出', 'scan 会打印解析失败、主页缺失、重复跳过等统计。', 0),
      ],
      workspaceTitle: '采集异常说明',
      workspaceSubtitle: '如果这里长期没有数据但扫描异常，请先看终端日志。',
      workspaceType: 'overview',
      workspaceContent: renderOverviewContent([
        ['排查入口', 'npm run interactions:scan -- --display-only 可以先确认通知是否能读取。'],
        ['常见原因', '登录失效、通知接口变化、主页链接缺失、网络超时。'],
      ]),
    },
    replies: {
      kicker: '回评',
      title: '回评时间线入口',
      description: '回评和回访是同级流程。回评线只处理别人评论我的作品，comments:execute 会读取 reply_status=pending，并把异常留在人工节点。',
      metrics: [
        { label: '待回评', value: statsData.pendingReplies || 0 },
        { label: '异常回评', value: statsData.replyExceptions || 0 },
        { label: '忽略回评', value: statsData.skippedReplies || 0 },
        { label: '已完成回评', value: statsData.succeededReplies || 0 },
      ],
      branches: [
        buildBranchCard('待回评', 'pending 状态会进入下一次 comments:execute。', statsData.pendingReplies || 0),
        buildBranchCard('异常处理', 'blocked / sent_unverified 需要人工确认后再重试或忽略。', replyExceptionComments.length),
        buildBranchCard('完成与忽略', 'succeeded 和 skipped 是回评线的终点。', (statsData.succeededReplies || 0) + (statsData.skippedReplies || 0)),
      ],
      workspaceTitle: '待回评评论',
      workspaceSubtitle: '入口默认展示 pending；点击异常、忽略、完成可看对应时间点。',
      workspaceType: 'pending-comments',
      commentSource: 'pending',
    },
    replyPending: {
      kicker: '回评待处理',
      title: '待回评评论',
      description: '只要 reply_status=pending，就会被待回评查询查到；即使已有 reply_text，也会继续用于恢复中断执行。',
      metrics: [
        { label: '待回评', value: statsData.pendingReplies || 0 },
        { label: '已写草稿', value: statsData.preparedReplies || 0 },
        { label: '异常回评', value: statsData.replyExceptions || 0 },
        { label: '回评完成', value: statsData.succeededReplies || 0 },
      ],
      branches: [
        buildBranchCard('自动执行', 'comments:execute --days N --limit M 会打开作品页并回复。', statsData.pendingReplies || 0),
        buildBranchCard('临时失败可重试', '浏览器、网络、页面临时失败会保留 pending + reason。', statsData.pendingReplies || 0),
      ],
      workspaceTitle: '待回评评论',
      workspaceSubtitle: 'pending 会自动进入下次执行。',
      workspaceType: 'pending-comments',
      commentSource: 'pending',
    },
    replyExceptions: {
      kicker: '回评异常',
      title: '被阻塞或发送未确认的回评',
      description: '定位风险、目标找不到、发送未确认等不会自动重试。你可以在这里修改回复文本、重置为 pending，或忽略。',
      metrics: [
        { label: '阻塞', value: statsData.blockedReplies || 0 },
        { label: '未确认发送', value: statsData.sentUnverifiedReplies || 0 },
        { label: '异常回评', value: statsData.replyExceptions || 0 },
        { label: '待回评', value: statsData.pendingReplies || 0 },
      ],
      branches: [
        buildBranchCard('重新排队', '把 blocked 评论改回 pending 后，下次 comments:execute 会继续处理。', pendingComments.filter(c => c.reply_status === 'blocked').length),
        buildBranchCard('人工核查', 'sent_unverified 代表可能已发送，重试前应人工确认。', pendingComments.filter(c => c.reply_status === 'sent_unverified').length),
      ],
      workspaceTitle: '回评处理台',
      workspaceSubtitle: '异常项默认不会自动执行；点“重试”会改回 pending。',
      workspaceType: 'pending-comments',
      commentSource: 'exceptions',
    },
    replySkipped: {
      kicker: '回评止损',
      title: '已忽略回评',
      description: '这里显示时间线上的忽略终点。当前接口不加载 skipped 明细，只展示统计，避免把已止损项混回执行队列。',
      metrics: [
        { label: '忽略回评', value: statsData.skippedReplies || 0 },
        { label: '待回评', value: statsData.pendingReplies || 0 },
        { label: '异常回评', value: statsData.replyExceptions || 0 },
        { label: '已完成', value: statsData.succeededReplies || 0 },
      ],
      branches: [
        buildBranchCard('人工忽略', '通常由处理台点击忽略产生，状态为 skipped。', statsData.skippedReplies || 0),
      ],
      workspaceTitle: '忽略回评说明',
      workspaceSubtitle: 'skipped 不进入自动执行。',
      workspaceType: 'overview',
      workspaceContent: renderOverviewContent([
        ['状态含义', 'skipped 表示人工决定不再回复。'],
        ['恢复方式', '如需恢复，需要在数据库层或后续接口中重新改回 pending。'],
      ]),
    },
    replyDone: {
      kicker: '回评完成',
      title: '已完成回评',
      description: '回评发送成功后写入 succeeded，并清理 reply_reason。这里作为回评线的完成时间点。',
      metrics: [
        { label: '已完成回评', value: statsData.succeededReplies || 0 },
        { label: '待回评', value: statsData.pendingReplies || 0 },
        { label: '异常回评', value: statsData.replyExceptions || 0 },
        { label: '忽略回评', value: statsData.skippedReplies || 0 },
      ],
      branches: [
        buildBranchCard('完成闭环', '成功回复后不会再进入 pending 队列。', statsData.succeededReplies || 0),
      ],
      workspaceTitle: '回评完成说明',
      workspaceSubtitle: '已完成项不展示明细，避免重复操作。',
      workspaceType: 'overview',
      workspaceContent: renderOverviewContent([
        ['状态含义', 'succeeded 表示已成功回复。'],
        ['风险提示', '不要把 succeeded 项手动放回 pending，避免重复回复。'],
      ]),
    },
    visits: {
      kicker: '回访',
      title: '回访时间线入口',
      description: '回访线与回评线同级。点赞、评论、回复、关注通知都应在这条线上看到：未处理线索、任务准备、重试、执行、异常、跳过、完成。',
      metrics: [
        { label: '回访任务', value: statsData.totalTasks || 0 },
        { label: '未处理线索', value: unhandledEventCount },
        { label: '待重试', value: visitRetryTasks.length },
        { label: '已完成', value: statsData.completedTasks || 0 },
      ],
      branches: [
        buildBranchCard('点赞/评论线索', `${(statsData.unhandledLikes || 0) + (statsData.unhandledComments || 0)} 条点赞/评论通知仍是 new。`, (statsData.unhandledLikes || 0) + (statsData.unhandledComments || 0)),
        buildBranchCard('回复/关注线索', `${(statsData.unhandledReplies || 0) + (statsData.unhandledFollows || 0)} 条回复/关注通知仍是 new。`, (statsData.unhandledReplies || 0) + (statsData.unhandledFollows || 0)),
        buildBranchCard('作品匹配重试', '主页打开、作品列表匹配或评论生成失败时会回到这里。', visitRetryTasks.length),
      ],
      workspaceTitle: '回访任务',
      workspaceSubtitle: '展示 pending_visit / failed_collect / failed_generate_comment 等可继续推进任务。',
      workspaceType: 'tasks',
      taskSource: 'visitQueue',
    },
    visitUnhandled: {
      kicker: '回访未处理',
      title: '未处理关注、回复、点赞、评论线索',
      description: '这些是 interaction_events 中仍为 new 的通知。时间线上明确展示关注和回复，避免它们被点赞/评论主路径淹没。',
      metrics: [
        { label: '未处理点赞', value: statsData.unhandledLikes || 0 },
        { label: '未处理评论', value: statsData.unhandledComments || 0 },
        { label: '未处理回复', value: statsData.unhandledReplies || 0 },
        { label: '未处理关注', value: statsData.unhandledFollows || 0 },
      ],
      branches: [
        buildBranchCard('点赞通知', '可转为回访任务的点赞线索。', statsData.unhandledLikes || 0),
        buildBranchCard('评论通知', '既可能产生回评，也可能沉淀回访。', statsData.unhandledComments || 0),
        buildBranchCard('回复/关注通知', '当前时间线单独展示，便于发现未处理来源。', (statsData.unhandledReplies || 0) + (statsData.unhandledFollows || 0)),
      ],
      workspaceTitle: '未处理线索说明',
      workspaceSubtitle: '这里展示统计，不直接展示通知明细。',
      workspaceType: 'overview',
      workspaceContent: renderOverviewContent([
        ['推荐命令', 'npm run interactions:scan -- --days N --max-count M --prepare-visits'],
        ['关注/回复', `当前未处理关注 ${statsData.unhandledFollows || 0} 条，未处理回复 ${statsData.unhandledReplies || 0} 条。`],
        ['处理边界', '回访任务准备仍以 DB 状态为准，时间线只展示入口压力。'],
      ]),
    },
    visitRetry: {
      kicker: '回访重试',
      title: '作品收集或评论生成失败',
      description: '这些任务通常是页面加载、作品匹配或 Agent 生成评论失败。再次执行 visit:run 可重新尝试。',
      metrics: [
        { label: '待重试', value: visitRetryTasks.length },
        { label: '收集失败', value: reviewTasks.filter(task => task.status === 'failed_collect').length },
        { label: '生成失败', value: reviewTasks.filter(task => task.status === 'failed_generate_comment').length },
        { label: '可执行任务', value: executableTasks.length },
      ],
      branches: [
        buildBranchCard('重新执行', '通常直接再次运行 visit:run --execute。', visitRetryTasks.length),
      ],
      workspaceTitle: '待重试回访任务',
      workspaceSubtitle: '这里不是终态失败，可重新执行。',
      workspaceType: 'tasks',
      taskSource: 'visitRetry',
    },
    execute: {
      kicker: '动作阶段',
      title: '执行回访点赞与评论',
      description: 'visit:run --execute 会对 DB 任务执行真实动作：打开主页、进入作品、确认点赞状态、按需点赞、生成并发送评论。',
      metrics: [
        { label: '可执行任务', value: executableTasks.length },
        { label: '执行中/待执行', value: reviewTasks.filter(task => ['pending_execute', 'executing'].includes(task.status)).length },
        { label: '已完成任务', value: statsData.completedTasks || 0 },
        { label: '执行异常', value: executeErrorTasks.length },
      ],
      branches: [
        buildBranchCard('执行异常', '点赞失败、评论失败、最终状态确认失败会进入异常分支。', executeErrorTasks.length),
      ],
      workspaceTitle: '可执行回访任务',
      workspaceSubtitle: '执行前确认账号已登录；真实点赞/评论需要 --execute。',
      workspaceType: 'tasks',
      taskSource: 'executable',
    },
    executeErrors: {
      kicker: '风险分支',
      title: '执行异常任务',
      description: '这里承接动作层面的失败。需要结合页面截图、last_error 和账号状态判断是否重试或跳过。',
      metrics: [
        { label: '异常任务', value: executeErrorTasks.length },
        { label: '点赞失败', value: reviewTasks.filter(task => task.status === 'failed_like').length },
        { label: '评论失败', value: reviewTasks.filter(task => task.status === 'failed_comment').length },
        { label: '待人工判断', value: executeErrorTasks.length },
      ],
      branches: [
        buildBranchCard('谨慎重试', '如果已可能发出评论，先人工核查，避免重复互动。', executeErrorTasks.length),
      ],
      workspaceTitle: '失败与回退任务',
      workspaceSubtitle: '这里不显示正常流程，只显示需要救火的任务。',
      workspaceType: 'tasks',
      taskSource: 'executeErrors',
    },
    visitSkipped: {
      kicker: '回访止损',
      title: '无法回访或已跳过任务',
      description: '私密账号、无作品、无合适作品等任务会进入跳过终点。这些也是时间线分支，不应和异常重试混在一起。',
      metrics: [
        { label: '跳过总数', value: skippedVisitTasks },
        { label: '无作品', value: getVisitStatusCount('skipped_no_work') },
        { label: '私密', value: getVisitStatusCount('skipped_private') },
        { label: '无合适作品', value: getVisitStatusCount('skipped_no_suitable_work') },
      ],
      branches: [
        buildBranchCard('不再自动执行', '跳过任务是回访线的止损终点。', skippedVisitTasks),
      ],
      workspaceTitle: '跳过回访说明',
      workspaceSubtitle: '跳过状态不进入执行列表。',
      workspaceType: 'overview',
      workspaceContent: renderOverviewContent([
        ['状态含义', 'skipped_no_work / skipped_private / skipped_no_suitable_work 都是无法继续的回访结果。'],
        ['下一步', '如果跳过过多，优先看作品匹配逻辑和主页可访问性。'],
      ]),
    },
    done: {
      kicker: '终点',
      title: '完成归档阶段',
      description: '回访任务完成后进入 done。回评成功会写入 work_comments.succeeded，并同步 interaction_events 状态。',
      metrics: [
        { label: '已完成', value: statsData.completedTasks || 0 },
        { label: '总任务', value: statsData.totalTasks || 0 },
        { label: '完成率', value: calcCompletionRate() },
        { label: '回评完成', value: statsData.succeededReplies || 0 },
      ],
      branches: [
        buildBranchCard('回访完成', '回访 done 是回访线的完成终点。', statsData.completedTasks || 0),
        buildBranchCard('回评完成', '回评 succeeded 是回评线的完成终点。', statsData.succeededReplies || 0),
      ],
      workspaceTitle: '完成阶段说明',
      workspaceSubtitle: '这里展示闭环结果和效率，不展示待处理卡片。',
      workspaceType: 'overview',
      workspaceContent: renderOverviewContent([
        ['闭环结果', `当前已完成 ${statsData.completedTasks || 0} 条，总任务 ${statsData.totalTasks || 0} 条。`],
        ['完成率', `${calcCompletionRate()} 的任务已经走完全链路。`],
        ['下一步', '如果完成率低，优先查看回评异常、待重试和执行异常分支。'],
      ]),
    },
    archive: {
      kicker: '归档',
      title: '完成归档',
      description: '归档节点用于查看闭环结果。当前不提供人工操作。',
      metrics: [
        { label: '已完成', value: statsData.completedTasks || 0 },
        { label: '总任务', value: statsData.totalTasks || 0 },
        { label: '完成率', value: calcCompletionRate() },
        { label: '回评完成', value: statsData.succeededReplies || 0 },
      ],
      branches: [],
      workspaceTitle: '归档说明',
      workspaceSubtitle: '完成归档由执行结果自动写入。',
      workspaceType: 'overview',
      workspaceContent: renderOverviewContent([
        ['自动归档', '回访 done 与回评 succeeded 都由执行命令自动写入 DB。'],
        ['人工关注', '如果结果不符合预期，请看异常分支，而不是直接修改归档状态。'],
      ]),
    },
  };
}

function calcCompletionRate() {
  const total = Number(statsData.totalTasks || 0);
  const done = Number(statsData.completedTasks || 0);
  if (!total) return '0%';
  return `${Math.round((done / total) * 100)}%`;
}

function getUnhandledEventCount() {
  return (statsData.unhandledLikes || 0) +
    (statsData.unhandledComments || 0) +
    (statsData.unhandledReplies || 0) +
    (statsData.unhandledFollows || 0);
}

function getVisitStatusCount(...statuses) {
  return statuses.reduce((sum, status) => sum + (statsData.statusDistribution?.[status] || 0), 0);
}

function buildBranchCard(title, description, count) {
  return { title, description, count };
}

function renderStageDetail() {
  const detailData = buildStageDetailData()[selectedStageId] || buildStageDetailData().collect;
  setText('detail-kicker', detailData.kicker);
  setText('detail-title', detailData.title);
  setText('detail-description', detailData.description);
  setText('workspace-title', detailData.workspaceTitle);
  setText('workspace-subtitle', detailData.workspaceSubtitle);

  const metricsEl = document.getElementById('detail-metrics');
  metricsEl.innerHTML = detailData.metrics.map((metric) => `
    <div class="metric-card">
      <span>${metric.label}</span>
      <strong>${metric.value}</strong>
    </div>
  `).join('');

  const branchesEl = document.getElementById('detail-branches');
  const branchCountEl = document.getElementById('detail-branch-count');
  branchCountEl.textContent = detailData.branches.length;
  branchesEl.innerHTML = detailData.branches.map((branch, index) => `
    <button class="branch-card ${selectedDetailBranchIndex === index ? 'is-active' : ''}" onclick="selectDetailBranch(${index})">
      <span class="branch-main"><i class="fa-solid fa-code-branch"></i>${branch.title}</span>
      <span class="branch-count">${branch.count} 条</span>
      <small>${branch.description}</small>
    </button>
  `).join('');

  renderStageWorkspace();
}

function renderStageWorkspace() {
  const detailData = buildStageDetailData()[selectedStageId] || buildStageDetailData().collect;
  const workspace = document.getElementById('workspace-body');
  const toolbar = document.getElementById('workspace-actions');

  if (selectedDetailBranchIndex !== null && detailData.branches[selectedDetailBranchIndex]) {
    toolbar.style.display = 'none';
    workspace.className = 'workspace-body';
    workspace.innerHTML = renderBranchDetail(detailData.branches[selectedDetailBranchIndex], detailData);
    updateBulkBar();
    return;
  }

  if (detailData.workspaceType === 'pending-comments') {
    toolbar.style.display = 'none';
    workspace.className = 'workspace-body';
    workspace.innerHTML = renderPendingCommentsHtml(detailData.commentSource || 'all');
    updateBulkBar();
    return;
  }

  if (detailData.workspaceType === 'overview') {
    toolbar.style.display = 'none';
    workspace.className = 'workspace-body';
    workspace.innerHTML = detailData.workspaceContent;
    updateBulkBar();
    return;
  }

  const filteredTasks = getFilteredTasksByStage(detailData.taskSource);
  toolbar.style.display = 'flex';
  const visibleIds = new Set(filteredTasks.map((task) => task.id));
  selectedTaskIds = new Set([...selectedTaskIds].filter((id) => visibleIds.has(id)));

  if (currentViewMode === 'table') {
    workspace.className = 'workspace-body view-table';
    workspace.innerHTML = renderTaskTableHtml(filteredTasks);
  } else {
    workspace.className = 'workspace-body view-grid';
    workspace.innerHTML = renderTaskCardsHtml(filteredTasks);
  }

  updateBulkBar();
}

function renderBranchDetail(branch, detailData) {
  return `
    <article class="branch-detail-card">
      <span class="detail-kicker">${escapeHtml(detailData.kicker || 'DETAIL')}</span>
      <h4>${escapeHtml(branch.title)}</h4>
      <strong>${escapeHtml(String(branch.count ?? 0))} 条</strong>
      <p>${escapeHtml(branch.description || '')}</p>
      <button class="btn btn-secondary" onclick="clearDetailBranch()">
        <i class="fa-solid fa-arrow-left"></i> 返回 ${escapeHtml(detailData.workspaceTitle || '详情')}
      </button>
    </article>
  `;
}

function getFilteredTasksByStage(taskSource) {
  let tasks = reviewTasks.slice();
  if (taskSource === 'visitQueue') {
    tasks = tasks.filter((task) => ['pending_visit', 'collecting_content', 'content_collected', 'comment_generated', 'failed_collect', 'failed_generate_comment'].includes(task.status));
  } else if (taskSource === 'visitRetry') {
    tasks = tasks.filter((task) => ['failed_collect', 'failed_generate_comment'].includes(task.status));
  } else if (taskSource === 'executable') {
    tasks = tasks.filter((task) => ['pending_visit', 'pending_execute', 'executing', 'failed_collect', 'failed_generate_comment', 'failed_like', 'failed_comment'].includes(task.status));
  } else if (taskSource === 'ready') {
    tasks = tasks.filter((task) => ['pending_execute', 'executing'].includes(task.status));
  } else if (taskSource === 'executeErrors') {
    tasks = tasks.filter((task) => ['failed_like', 'failed_comment', 'failed'].includes(task.status));
  }

  const searchQuery = document.getElementById('search-input').value.toLowerCase().trim();
  const statusFilter = document.getElementById('filter-status').value;
  const relationFilter = document.getElementById('filter-relation').value;

  return tasks.filter((task) => {
    const userName = (task.userName || '').toLowerCase();
    const workTitle = (task.targetWork?.workTitle || '').toLowerCase();
    const commentDraft = (task.generatedComment || '').toLowerCase();
    const matchSearch = !searchQuery || userName.includes(searchQuery) || workTitle.includes(searchQuery) || commentDraft.includes(searchQuery);

    let matchStatus = true;
    if (statusFilter === 'pending') {
      matchStatus = !String(task.status || '').startsWith('failed') && task.status !== 'pending_execute' && task.status !== 'executing';
    } else if (statusFilter === 'ready') {
      matchStatus = task.status === 'pending_execute' || task.status === 'executing';
    } else if (statusFilter === 'failed') {
      matchStatus = String(task.status || '').startsWith('failed');
    }

    let matchRelation = true;
    if (relationFilter === 'follow') {
      matchRelation = task.sourceType === 'follow';
    } else if (relationFilter === 'other') {
      matchRelation = task.sourceType !== 'follow';
    }

    return matchSearch && matchStatus && matchRelation;
  });
}

function renderTaskCardsHtml(tasks) {
  if (!tasks.length) {
    return renderEmptyState('fa-water', '当前阶段没有可展示的任务。');
  }

  return tasks.map((task) => {
    const { badgeClass, badgeText } = getTaskBadge(task);
    const firstChar = task.userName ? task.userName.charAt(0) : '?';
    const isChecked = selectedTaskIds.has(task.id) ? 'checked' : '';
    return `
      <article class="task-card">
        <div class="card-checkbox-wrapper">
          <label class="custom-checkbox">
            <input type="checkbox" class="task-checkbox" data-id="${task.id}" ${isChecked} onchange="toggleSelect(${task.id})">
            <span class="checkbox-checkmark"></span>
          </label>
        </div>
        <div class="card-header">
          <div class="user-info">
            <div class="user-avatar">${firstChar}</div>
            <div class="user-meta">
              <h4>${escapeHtml(task.userName || '未知用户')}</h4>
              <span>来源: ${task.sourceType === 'follow' ? '互关' : '朋友/粉丝'} · 重试 ${task.retryCount || 0} 次</span>
            </div>
          </div>
          <span class="task-badge ${badgeClass}">${badgeText}</span>
        </div>
        <div class="work-block">
          <h5><i class="fa-solid fa-video"></i> ${escapeHtml(task.targetWork?.workTitle || '等待作品识别')}</h5>
          <p>${escapeHtml((task.targetWork?.contentSummary || task.targetWork?.workText || task.lastError || '暂无摘要').slice(0, 120))}</p>
          ${task.targetWork?.workUrl ? `<a class="work-link" target="_blank" href="${task.targetWork.workUrl}">打开作品 <i class="fa-solid fa-arrow-up-right-from-square"></i></a>` : ''}
        </div>
        <div class="comment-input-area">
          <label>回访评论草稿</label>
          <textarea class="comment-textarea" id="textarea-${task.id}" placeholder="输入评论内容...">${escapeHtml(task.generatedComment || '')}</textarea>
        </div>
        <div class="card-actions">
          <button class="btn btn-primary" onclick="approveTask(${task.id})"><i class="fa-solid fa-floppy-disk"></i>保存待执行</button>
          <button class="btn btn-secondary" onclick="skipTask(${task.id})"><i class="fa-solid fa-circle-xmark"></i>跳过</button>
        </div>
      </article>
    `;
  }).join('');
}

function renderTaskTableHtml(tasks) {
  if (!tasks.length) {
    return renderEmptyState('fa-water', '当前阶段没有可展示的任务。');
  }

  const allChecked = tasks.length > 0 && tasks.every((task) => selectedTaskIds.has(task.id)) ? 'checked' : '';
  return `
    <div class="compact-table-wrap">
      <table class="compact-table">
        <thead>
          <tr>
            <th>
              <label class="custom-checkbox">
                <input type="checkbox" id="master-checkbox" ${allChecked} onchange="toggleSelectAll(this)">
                <span class="checkbox-checkmark"></span>
              </label>
            </th>
            <th>用户</th>
            <th>作品</th>
            <th>草稿</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${tasks.map((task) => {
            const { dotClass, badgeText } = getTaskBadge(task);
            const isChecked = selectedTaskIds.has(task.id) ? 'checked' : '';
            return `
              <tr>
                <td>
                  <label class="custom-checkbox">
                    <input type="checkbox" class="task-checkbox" data-id="${task.id}" ${isChecked} onchange="toggleSelect(${task.id})">
                    <span class="checkbox-checkmark"></span>
                  </label>
                </td>
                <td>
                  <div class="table-user-cell">
                    <div class="table-avatar">${escapeHtml((task.userName || '?').charAt(0))}</div>
                    <div class="table-user-meta">
                      <h5>${escapeHtml(task.userName || '未知用户')}</h5>
                      <span>${task.sourceType === 'follow' ? '互关' : '朋友/粉丝'}</span>
                    </div>
                  </div>
                </td>
                <td>${task.targetWork?.workUrl ? `<a class="work-link" target="_blank" href="${task.targetWork.workUrl}">${escapeHtml(task.targetWork?.workTitle || '打开作品')}</a>` : escapeHtml(task.targetWork?.workTitle || '等待识别')}</td>
                <td><input id="textarea-${task.id}" class="table-comment-input" value="${escapeAttribute(task.generatedComment || '')}" placeholder="输入评论内容..."></td>
                <td><div class="status-dot-wrapper"><span class="status-dot ${dotClass}"></span>${badgeText}</div></td>
                <td>
                  <div class="table-actions">
                    <button class="btn-mini btn-mini-primary" onclick="approveTask(${task.id})"><i class="fa-solid fa-floppy-disk"></i></button>
                    <button class="btn-mini btn-mini-secondary" onclick="skipTask(${task.id})"><i class="fa-solid fa-xmark"></i></button>
                  </div>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderPendingCommentsHtml(commentSource = 'all') {
  let comments = pendingComments.slice();
  if (commentSource === 'pending') {
    comments = comments.filter(comment => comment.reply_status === 'pending');
  } else if (commentSource === 'exceptions') {
    comments = comments.filter(comment => comment.reply_status !== 'pending');
  }

  if (!comments.length) {
    return renderEmptyState('fa-face-smile-beam', '当前没有待处理或异常回评。');
  }

  return `
    <div class="pending-list">
      ${comments.map((comment) => {
        const badge = getReplyBadge(comment.reply_status);
        const textareaId = `reply-text-${comment.id}`;
        const workUrl = comment.joined_work_url || comment.work_url || '';
        const workTitle = comment.joined_work_title || comment.work_id || comment.modal_id || '原作品';
        const reason = comment.reply_reason || '';
        return `
        <article class="pending-card reply-${escapeHtml(comment.reply_status || 'pending')}">
          <div class="pending-main">
            <div class="pending-user">
              <div class="pending-user-avatar">${escapeHtml((comment.actor_name || '?').charAt(0))}</div>
              <div>
                <h4>${escapeHtml(comment.actor_name || '未知用户')}</h4>
                <span>${escapeHtml(comment.event_time_text || '不久前')} · <span class="reply-badge ${badge.className}">${badge.text}</span></span>
              </div>
            </div>
            <div class="pending-text"><strong>原留言：</strong>${escapeHtml(comment.comment_text || '')}</div>
            ${reason ? `<div class="pending-reason"><strong>异常：</strong>${escapeHtml(reason)}</div>` : ''}
            <div class="pending-reply-editor">
              <label for="${textareaId}">回评文本</label>
              <textarea id="${textareaId}" class="comment-textarea" placeholder="可手动填写或修改回评文本...">${escapeHtml(comment.reply_text || '')}</textarea>
            </div>
            ${workUrl ? `<div class="pending-work-context"><a class="work-link" target="_blank" href="${escapeAttribute(workUrl)}">打开${escapeHtml(workTitle)} <i class="fa-solid fa-arrow-up-right-from-square"></i></a></div>` : ''}
          </div>
          <div class="pending-actions">
            <button class="btn btn-primary" onclick="retryComment(${comment.id})"><i class="fa-solid fa-rotate-right"></i>重试</button>
            <button class="btn btn-secondary" onclick="saveCommentReply(${comment.id})"><i class="fa-solid fa-floppy-disk"></i>保存</button>
            <button class="btn btn-danger" onclick="ignoreComment(${comment.id})"><i class="fa-solid fa-trash-can"></i>忽略</button>
          </div>
        </article>
      `;}).join('')}
    </div>
  `;
}

function getReplyBadge(status) {
  if (status === 'blocked') return { text: '已阻塞', className: 'reply-badge-blocked' };
  if (status === 'sent_unverified') return { text: '发送未确认', className: 'reply-badge-unverified' };
  return { text: '待回评', className: 'reply-badge-pending' };
}

function renderOverviewContent(items) {
  return `
    <div class="pending-list">
      ${items.map(([title, text]) => `
        <article class="pending-card">
          <div class="pending-main">
            <div class="pending-user">
              <div class="pending-user-avatar"><i class="fa-solid fa-location-arrow"></i></div>
              <div>
                <h4>${title}</h4>
                <span>流程说明</span>
              </div>
            </div>
            <div class="pending-text">${text}</div>
          </div>
        </article>
      `).join('')}
    </div>
  `;
}

function renderEmptyState(icon, text) {
  return `
    <div class="empty-state">
      <i class="fa-solid ${icon}"></i>
      <p>${text}</p>
    </div>
  `;
}

function getTaskBadge(task) {
  if (task.status === 'pending_execute' || task.status === 'executing') {
    return { badgeClass: 'badge-ready', badgeText: '待执行', dotClass: 'ready' };
  }
  if (String(task.status || '').startsWith('failed')) {
    return { badgeClass: 'badge-fail', badgeText: '失败', dotClass: 'failed' };
  }
  return { badgeClass: 'badge-pending', badgeText: '处理中', dotClass: 'pending' };
}

window.closeDetailCabin = function() {};

window.selectStage = function(stageId) {
  selectedStageId = stageId;
  selectedDetailBranchIndex = null;
  renderRiverTimeline();
  renderStageDetail();
};

window.selectDetailBranch = function(index) {
  selectedDetailBranchIndex = Number(index);
  renderStageDetail();
};

window.clearDetailBranch = function() {
  selectedDetailBranchIndex = null;
  renderStageDetail();
};

window.toggleSelect = function(id) {
  if (selectedTaskIds.has(id)) selectedTaskIds.delete(id);
  else selectedTaskIds.add(id);
  updateBulkBar();
};

window.toggleSelectAll = function(masterCheckbox) {
  const detailData = buildStageDetailData()[selectedStageId];
  const tasks = getFilteredTasksByStage(detailData.taskSource);
  if (masterCheckbox.checked) tasks.forEach((task) => selectedTaskIds.add(task.id));
  else tasks.forEach((task) => selectedTaskIds.delete(task.id));
  renderStageWorkspace();
};

function updateBulkBar() {
  const bar = document.getElementById('bulk-action-bar');
  const countEl = document.getElementById('selected-count');
  const detailData = buildStageDetailData()[selectedStageId];
  const activeForTasks = selectedDetailBranchIndex === null && detailData.workspaceType === 'tasks';
  const size = selectedTaskIds.size;
  countEl.textContent = size;
  bar.classList.toggle('active', activeForTasks && size > 0);
}

window.approveTask = async function(id) {
  const input = document.getElementById(`textarea-${id}`);
  const commentText = input ? input.value.trim() : '';
  if (!commentText) {
    showToast('评论内容不能为空', 'error');
    return;
  }

  try {
    const res = await fetch(`/api/revisit-tasks/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commentText }),
    });
    const json = await res.json();
    if (!json.ok) {
      showToast(json.error || '保存失败', 'error');
      return;
    }
    selectedTaskIds.delete(id);
    showToast(json.message || '任务已保存为待执行', 'success');
    await refreshAll();
  } catch (err) {
    showToast('保存请求失败', 'error');
  }
};

window.skipTask = async function(id) {
  try {
    const res = await fetch(`/api/revisit-tasks/${id}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'user_manually_skipped' }),
    });
    const json = await res.json();
    if (!json.ok) {
      showToast(json.error || '跳过失败', 'error');
      return;
    }
    selectedTaskIds.delete(id);
    showToast(json.message || '任务已跳过', 'success');
    await refreshAll();
  } catch (err) {
    showToast('跳过请求失败', 'error');
  }
};

async function bulkApproveTasks() {
  if (!selectedTaskIds.size) return;
  const tasks = [];
  for (const id of selectedTaskIds) {
    const input = document.getElementById(`textarea-${id}`);
    const commentText = input ? input.value.trim() : '';
    if (!commentText) {
      showToast('选中的任务里有空评论，请先补齐。', 'error');
      return;
    }
    tasks.push({ id, commentText });
  }

  try {
    const res = await fetch('/api/revisit-tasks/bulk-approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks }),
    });
    const json = await res.json();
    if (!json.ok) {
      showToast(json.error || '批量保存失败', 'error');
      return;
    }
    selectedTaskIds.clear();
    showToast(json.message || '批量保存成功', 'success');
    await refreshAll();
  } catch (err) {
    showToast('批量保存请求失败', 'error');
  }
}

async function bulkSkipTasks() {
  if (!selectedTaskIds.size) return;
  try {
    const res = await fetch('/api/revisit-tasks/bulk-skip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from(selectedTaskIds) }),
    });
    const json = await res.json();
    if (!json.ok) {
      showToast(json.error || '批量跳过失败', 'error');
      return;
    }
    selectedTaskIds.clear();
    showToast(json.message || '批量跳过成功', 'success');
    await refreshAll();
  } catch (err) {
    showToast('批量跳过请求失败', 'error');
  }
}

function clearSelectedTasks() {
  selectedTaskIds.clear();
  renderStageWorkspace();
}

window.retryComment = async function(id) {
  const input = document.getElementById(`reply-text-${id}`);
  const replyText = input ? input.value.trim() : '';
  try {
    const res = await fetch(`/api/pending-comments/${id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyText }),
    });
    const json = await res.json();
    if (!json.ok) {
      showToast(json.error || '移入回复队列失败', 'error');
      return;
    }
    showToast(json.message || '评论已移入待回复队列', 'success');
    await refreshAll();
  } catch (err) {
    showToast('操作失败', 'error');
  }
};

window.saveCommentReply = async function(id) {
  const input = document.getElementById(`reply-text-${id}`);
  const replyText = input ? input.value.trim() : '';
  try {
    const res = await fetch(`/api/pending-comments/${id}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyText }),
    });
    const json = await res.json();
    if (!json.ok) {
      showToast(json.error || '保存失败', 'error');
      return;
    }
    showToast(json.message || '回评文本已保存', 'success');
    await refreshAll();
  } catch (err) {
    showToast('保存失败', 'error');
  }
};

window.ignoreComment = async function(id) {
  try {
    const res = await fetch(`/api/pending-comments/${id}/ignore`, { method: 'POST' });
    const json = await res.json();
    if (!json.ok) {
      showToast(json.error || '忽略失败', 'error');
      return;
    }
    showToast(json.message || '评论已忽略', 'success');
    await refreshAll();
  } catch (err) {
    showToast('操作失败', 'error');
  }
};

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <i class="fa-solid ${type === 'success' ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
    <span>${message}</span>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fadeOut');
    setTimeout(() => toast.remove(), 180);
  }, 2600);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/\n/g, '&#10;');
}
