document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

let statsData = {};
let reviewTasks = [];
let pendingComments = [];
let unhandledEvents = [];
let selectedStageId = null;
let selectedWorkKey = null;

const STAGE_IDS = {
  COLLECT: 'collect',
  REPLIES: 'replies',
  REPLY_PENDING: 'replyPending',
  REPLY_EXCEPTIONS: 'replyExceptions',
  REPLY_DONE: 'replyDone',
  REPLY_SKIPPED: 'replySkipped',
  REPLY_EVENTS: 'replyEvents',
  FOLLOW_EVENTS: 'followEvents',
  VISITS: 'visits',
  VISIT_UNHANDLED: 'visitUnhandled',
  VISIT_RETRY: 'visitRetry',
  EXECUTE_ERRORS: 'executeErrors',
  VISIT_DONE: 'done',
  VISIT_SKIPPED: 'visitSkipped',
};

async function initApp() {
  bindEvents();
  await refreshAll();
  window.setInterval(fetchStatsAndRefreshHeader, 10000);
}

function bindEvents() {
  document.getElementById('btn-refresh').addEventListener('click', refreshAll);
  document.getElementById('btn-close-drawer').addEventListener('click', closeDrawer);
  document.getElementById('btn-back-work').addEventListener('click', () => {
    selectedWorkKey = null;
    renderDrawer();
  });
}

async function refreshAll() {
  await Promise.all([
    fetchStats(),
    fetchReviewTasks(),
    fetchPendingComments(),
    fetchUnhandledEvents(),
  ]);
  renderHeaderStats();
  renderFlowGraph();
  renderDrawer();
}

async function fetchStatsAndRefreshHeader() {
  await fetchStats();
  renderHeaderStats();
  renderFlowGraph();
  renderDrawer();
}

async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const json = await res.json();
    if (json.ok) statsData = json.data || {};
  } catch (err) {
    console.error('获取统计失败:', err);
  }
}

async function fetchReviewTasks() {
  try {
    const res = await fetch('/api/revisit-tasks?page=1&limit=500');
    const json = await res.json();
    if (json.ok) reviewTasks = json.data || [];
  } catch (err) {
    console.error('获取回访任务失败:', err);
    showToast('获取回访任务失败', 'error');
  }
}

async function fetchPendingComments() {
  try {
    const res = await fetch('/api/pending-comments?page=1&limit=5000');
    const json = await res.json();
    if (json.ok) pendingComments = json.data || [];
  } catch (err) {
    console.error('获取回评评论失败:', err);
  }
}

async function fetchUnhandledEvents() {
  try {
    const res = await fetch('/api/unhandled-events?page=1&limit=500');
    const json = await res.json();
    if (json.ok) unhandledEvents = json.data || [];
  } catch (err) {
    console.error('获取未处理事件失败:', err);
  }
}

function renderHeaderStats() {
  const waitingCount = (statsData.pendingReplies || 0) + getUnhandledEventCount() + getExecutableVisitCount();
  const errorCount = (statsData.replyExceptions || 0) + getVisitErrorCount();
  setText('hero-collected-total', statsData.collectedTotal || 0);
  setText('hero-total-tasks', waitingCount);
  setText('hero-error-total', errorCount);

  setText('summary-collected-total', statsData.collectedTotal || 0);
  setText('summary-reply-total', pendingComments.length);
  setText('summary-visit-total', reviewTasks.length + unhandledEvents.length);
}

function buildStageMeta() {
  const replyExceptions = countCommentsByStatus(['blocked', 'sent_unverified']);
  return {
    [STAGE_IDS.COLLECT]: {
      id: STAGE_IDS.COLLECT,
      label: '扫描入库',
      icon: 'fa-database',
      tone: 'gold',
      count: statsData.collectedTotal || 0,
      description: '所有互动先进入数据库，再分流到回评与回访。',
    },
    [STAGE_IDS.REPLIES]: {
      id: STAGE_IDS.REPLIES,
      label: '评论我的',
      icon: 'fa-comment-dots',
      tone: 'reply',
      count: pendingComments.length,
      description: '别人评论我的作品，进入回评链路。',
    },
    [STAGE_IDS.REPLY_PENDING]: {
      id: STAGE_IDS.REPLY_PENDING,
      label: '待回评',
      icon: 'fa-reply',
      tone: 'reply',
      count: countCommentsByStatus(['pending']),
      description: '等待自动或人工回复的评论。',
    },
    [STAGE_IDS.REPLY_EXCEPTIONS]: {
      id: STAGE_IDS.REPLY_EXCEPTIONS,
      label: '回评异常',
      icon: 'fa-triangle-exclamation',
      tone: 'warning',
      count: replyExceptions,
      description: '被阻塞或发送未确认，需要人工确认。',
    },
    [STAGE_IDS.REPLY_DONE]: {
      id: STAGE_IDS.REPLY_DONE,
      label: '回评成功',
      icon: 'fa-circle-check',
      tone: 'done',
      count: countCommentsByStatus(['succeeded']),
      description: '已经成功回复过的评论。',
    },
    [STAGE_IDS.REPLY_SKIPPED]: {
      id: STAGE_IDS.REPLY_SKIPPED,
      label: '忽略回评',
      icon: 'fa-ban',
      tone: 'muted',
      count: countCommentsByStatus(['skipped']),
      description: '已人工忽略，不再自动进入回评。',
    },
    [STAGE_IDS.REPLY_EVENTS]: {
      id: STAGE_IDS.REPLY_EVENTS,
      label: '回复我的',
      icon: 'fa-message',
      tone: 'muted',
      count: filterEventsByType(['reply']).length,
      description: '别人回复我的评论，作为独立节点查看。',
    },
    [STAGE_IDS.FOLLOW_EVENTS]: {
      id: STAGE_IDS.FOLLOW_EVENTS,
      label: '关注',
      icon: 'fa-user-plus',
      tone: 'muted',
      count: filterEventsByType(['follow']).length,
      description: '关注类互动，也能按作品/用户查看明细。',
    },
    [STAGE_IDS.VISITS]: {
      id: STAGE_IDS.VISITS,
      label: '待回访',
      icon: 'fa-route',
      tone: 'visit',
      count: reviewTasks.length + unhandledEvents.length,
      description: '回访线索与回访任务的总入口。',
    },
    [STAGE_IDS.VISIT_UNHANDLED]: {
      id: STAGE_IDS.VISIT_UNHANDLED,
      label: '未处理线索',
      icon: 'fa-inbox',
      tone: 'visit',
      count: unhandledEvents.length,
      description: '还未转成回访任务的点赞/评论/回复/关注线索。',
    },
    [STAGE_IDS.VISIT_RETRY]: {
      id: STAGE_IDS.VISIT_RETRY,
      label: '待重试',
      icon: 'fa-rotate-left',
      tone: 'warning',
      count: getRetryVisitTasks().length,
      description: '作品收集或评论生成失败，可重新执行。',
    },
    [STAGE_IDS.EXECUTE_ERRORS]: {
      id: STAGE_IDS.EXECUTE_ERRORS,
      label: '回访异常',
      icon: 'fa-circle-xmark',
      tone: 'danger',
      count: getErrorVisitTasks().length,
      description: '点赞、评论或最终确认失败的回访任务。',
    },
    [STAGE_IDS.VISIT_DONE]: {
      id: STAGE_IDS.VISIT_DONE,
      label: '回访成功',
      icon: 'fa-flag-checkered',
      tone: 'done',
      count: reviewTasks.filter((task) => task.status === 'done').length,
      description: '回访点赞与评论都落地后的归档任务。',
    },
    [STAGE_IDS.VISIT_SKIPPED]: {
      id: STAGE_IDS.VISIT_SKIPPED,
      label: '其他',
      icon: 'fa-user-slash',
      tone: 'muted',
      count: getSkippedVisitTasks().length,
      description: '无法回访或已跳过的终态任务。',
    },
  };
}

function renderFlowGraph() {
  const root = document.getElementById('graph-root');
  const stages = buildStageMeta();
  root.innerHTML = `
    <div class="graph-origin">
      ${renderNode(stages[STAGE_IDS.COLLECT], true)}
      <div class="source-pills">
        ${renderMiniSource('评论', statsData.collectedComments || 0, 'fa-comment')}
        ${renderMiniSource('点赞', statsData.collectedLikes || 0, 'fa-heart')}
        ${renderMiniSource('回复', statsData.collectedReplies || 0, 'fa-reply')}
        ${renderMiniSource('关注', statsData.collectedFollows || 0, 'fa-user-plus')}
      </div>
    </div>

    <div class="graph-lanes">
      <section class="lane-card lane-reply">
        <div class="lane-head">
          <span class="lane-tag">Reply Lane</span>
          <h3>回评线</h3>
          <p>节点统一走“阶段信息 → 作品列表 → 评论明细”。</p>
        </div>
        <div class="lane-track">
          ${renderLane([
            stages[STAGE_IDS.REPLIES],
            stages[STAGE_IDS.REPLY_PENDING],
            stages[STAGE_IDS.REPLY_EXCEPTIONS],
            stages[STAGE_IDS.REPLY_DONE],
            stages[STAGE_IDS.REPLY_SKIPPED],
          ])}
        </div>
      </section>

      <section class="lane-card lane-visit">
        <div class="lane-head">
          <span class="lane-tag">Visit Lane</span>
          <h3>回访线</h3>
          <p>从线索、重试、异常到归档，全部统一从作品维度推进。</p>
        </div>
        <div class="lane-track">
          ${renderLane([
            stages[STAGE_IDS.VISITS],
            stages[STAGE_IDS.VISIT_UNHANDLED],
            stages[STAGE_IDS.VISIT_RETRY],
            stages[STAGE_IDS.EXECUTE_ERRORS],
            stages[STAGE_IDS.VISIT_DONE],
            stages[STAGE_IDS.VISIT_SKIPPED],
          ])}
        </div>
      </section>
    </div>

    <div class="aux-row">
      ${renderNode(stages[STAGE_IDS.REPLY_EVENTS], false, true)}
      ${renderNode(stages[STAGE_IDS.FOLLOW_EVENTS], false, true)}
    </div>
  `;
}

function renderLane(stageList) {
  return stageList.map((stage, index) => {
    const connector = index < stageList.length - 1
      ? `<div class="lane-connector"><span></span><i class="fa-solid fa-arrow-right"></i></div>`
      : '';
    return `${renderNode(stage)}${connector}`;
  }).join('');
}

function renderMiniSource(label, count, icon) {
  return `
    <div class="source-pill">
      <i class="fa-solid ${icon}"></i>
      <span>${label}</span>
      <strong>${count}</strong>
    </div>
  `;
}

function renderNode(stage, isRoot = false, isCompact = false) {
  const active = selectedStageId === stage.id ? 'is-active' : '';
  const rootClass = isRoot ? 'node-root' : '';
  const compactClass = isCompact ? 'node-compact' : '';
  return `
    <button class="flow-node ${stage.tone} ${active} ${rootClass} ${compactClass}" onclick="selectStage('${stage.id}')">
      <span class="node-icon"><i class="fa-solid ${stage.icon}"></i></span>
      <span class="node-copy">
        <strong>${stage.label}</strong>
        <small>${stage.description}</small>
      </span>
      <span class="node-count">${stage.count}</span>
    </button>
  `;
}

window.selectStage = function selectStage(stageId) {
  selectedStageId = stageId;
  selectedWorkKey = null;
  renderFlowGraph();
  renderDrawer();
};

window.selectWork = function selectWork(encodedKey) {
  selectedWorkKey = decodeURIComponent(encodedKey);
  renderDrawer();
};

window.clearSelectedWork = function clearSelectedWork() {
  selectedWorkKey = null;
  renderDrawer();
};

window.closeDrawer = closeDrawer;

function closeDrawer() {
  selectedStageId = null;
  selectedWorkKey = null;
  renderFlowGraph();
  renderDrawer();
}

function renderDrawer() {
  const drawer = document.getElementById('stage-drawer');
  const empty = document.getElementById('drawer-empty');
  const frame = document.getElementById('drawer-frame');
  const track = document.getElementById('drawer-track');

  if (!selectedStageId) {
    drawer.classList.remove('is-open', 'is-detail-open');
    empty.style.display = 'flex';
    frame.style.display = 'none';
    return;
  }

  const dataset = buildStageDataset(selectedStageId);
  const groups = dataset.groups || [];
  const workGroup = selectedWorkKey ? groups.find((group) => group.key === selectedWorkKey) : null;

  drawer.classList.add('is-open');
  drawer.classList.toggle('is-detail-open', Boolean(workGroup));
  empty.style.display = 'none';
  frame.style.display = 'flex';
  track.style.transform = workGroup ? 'translateX(-50%)' : 'translateX(0)';

  setText('drawer-kicker', dataset.kicker);
  setText('drawer-title', dataset.title);
  setText('drawer-subtitle', dataset.subtitle);
  setText('works-count-text', `${groups.length} 个作品`);

  renderBreadcrumbs(dataset, workGroup);
  renderDrawerStats(dataset.metrics || []);
  renderWorksList(groups);
  renderWorkDetail(dataset, workGroup);
}

function renderBreadcrumbs(dataset, workGroup) {
  const el = document.getElementById('drawer-breadcrumbs');
  el.innerHTML = `
    <button class="crumb ${workGroup ? '' : 'is-active'}" onclick="clearSelectedWork()">
      ${dataset.shortLabel}
    </button>
    ${workGroup ? `
      <span class="crumb-sep"><i class="fa-solid fa-chevron-right"></i></span>
      <button class="crumb is-active">${escapeHtml(workGroup.title)}</button>
    ` : ''}
  `;
}

function renderDrawerStats(metrics) {
  const el = document.getElementById('drawer-stats');
  el.innerHTML = metrics.map((metric) => `
    <article class="stat-card ${metric.tone || ''}">
      <span>${metric.label}</span>
      <strong>${metric.value}</strong>
      <small>${metric.helper || ''}</small>
    </article>
  `).join('');
}

function renderWorksList(groups) {
  const el = document.getElementById('works-list');
  if (!groups.length) {
    el.innerHTML = renderEmpty('这个节点下暂时没有作品。');
    return;
  }

  el.innerHTML = groups.map((group) => {
    const active = selectedWorkKey === group.key ? 'is-active' : '';
    const encodedKey = encodeURIComponent(group.key);
    return `
      <button class="work-card ${active}" onclick="selectWork('${encodedKey}')">
        <div class="work-card-top">
          <span class="work-chip">${group.kindLabel}</span>
          <strong>${group.count}</strong>
        </div>
        <h4>${escapeHtml(group.title)}</h4>
        <p>${escapeHtml(group.subtitle || '点击查看该作品下的评论/回访明细')}</p>
        <div class="work-card-foot">
          <span>${escapeHtml(group.meta || '')}</span>
          <i class="fa-solid fa-arrow-right"></i>
        </div>
      </button>
    `;
  }).join('');
}

function renderWorkDetail(dataset, workGroup) {
  const meta = document.getElementById('work-detail-meta');
  const list = document.getElementById('work-item-list');

  if (!workGroup) {
    meta.innerHTML = '';
    list.innerHTML = '';
    return;
  }

  meta.innerHTML = `
    <div class="detail-title-block">
      <span class="work-chip">${workGroup.kindLabel}</span>
      <h4>${escapeHtml(workGroup.title)}</h4>
      <p>${escapeHtml(workGroup.subtitle || dataset.title)}</p>
    </div>
    <div class="detail-summary">
      <span>${workGroup.count} 条明细</span>
      ${workGroup.meta ? `<span>${escapeHtml(workGroup.meta)}</span>` : ''}
    </div>
  `;

  const items = (workGroup.items || []).slice().sort(sortByCreatedDesc);
  list.innerHTML = items.length
    ? items.map(renderDetailItem).join('')
    : renderEmpty('当前作品下没有可展示的明细。');
}

function buildStageDataset(stageId) {
  switch (stageId) {
    case STAGE_IDS.COLLECT:
      return {
        kicker: 'Collect',
        shortLabel: '扫描入库',
        title: '扫描入库总览',
        subtitle: '按作品汇总所有已入库的评论、回访任务与未处理线索。',
        metrics: [
          { label: '总通知', value: statsData.collectedTotal || 0, helper: '通知入库总量', tone: 'gold' },
          { label: '回评评论', value: pendingComments.length, helper: 'work_comments 总数', tone: 'reply' },
          { label: '回访任务', value: reviewTasks.length, helper: 'return_visit_tasks 总数', tone: 'visit' },
          { label: '未处理线索', value: unhandledEvents.length, helper: 'interaction_events new', tone: 'muted' },
        ],
        groups: buildCollectGroups(),
      };
    case STAGE_IDS.REPLIES:
      return buildReplyDataset('回评总览', '评论我的作品', pendingComments.slice(), 'all');
    case STAGE_IDS.REPLY_PENDING:
      return buildReplyDataset('Reply Pending', '待回评', pendingComments.filter((item) => item.reply_status === 'pending'), 'pending');
    case STAGE_IDS.REPLY_EXCEPTIONS:
      return buildReplyDataset(
        'Reply Exceptions',
        '回评异常',
        pendingComments.filter((item) => item.reply_status === 'blocked' || item.reply_status === 'sent_unverified'),
        'exceptions'
      );
    case STAGE_IDS.REPLY_DONE:
      return buildReplyDataset('Reply Done', '回评成功', pendingComments.filter((item) => item.reply_status === 'succeeded'), 'done');
    case STAGE_IDS.REPLY_SKIPPED:
      return buildReplyDataset('Reply Skipped', '忽略回评', pendingComments.filter((item) => item.reply_status === 'skipped'), 'skipped');
    case STAGE_IDS.REPLY_EVENTS:
      return buildEventDataset('Reply Events', '回复我的', filterEventsByType(['reply']), 'reply');
    case STAGE_IDS.FOLLOW_EVENTS:
      return buildEventDataset('Follow Events', '关注', filterEventsByType(['follow']), 'follow');
    case STAGE_IDS.VISITS:
      return buildVisitDataset('Visit Entry', '回访总览', reviewTasks.slice(), unhandledEvents.slice(), 'all');
    case STAGE_IDS.VISIT_UNHANDLED:
      return buildEventDataset('Visit Leads', '未处理线索', unhandledEvents.slice(), 'unhandled');
    case STAGE_IDS.VISIT_RETRY:
      return buildVisitDataset('Visit Retry', '待重试', getRetryVisitTasks(), [], 'retry');
    case STAGE_IDS.EXECUTE_ERRORS:
      return buildVisitDataset('Visit Errors', '回访异常', getErrorVisitTasks(), [], 'errors');
    case STAGE_IDS.VISIT_DONE:
      return buildVisitDataset('Visit Done', '回访成功', reviewTasks.filter((task) => task.status === 'done'), [], 'done');
    case STAGE_IDS.VISIT_SKIPPED:
      return buildVisitDataset('Visit Skipped', '其他 / 已跳过', getSkippedVisitTasks(), [], 'skipped');
    default:
      return {
        kicker: 'Stage',
        shortLabel: '节点',
        title: '节点详情',
        subtitle: '暂无数据',
        metrics: [],
        groups: [],
      };
  }
}

function buildReplyDataset(kicker, title, comments, mode) {
  return {
    kicker,
    shortLabel: title,
    title,
    subtitle: '先看作品，再进入作品下的评论明细。',
    metrics: [
      { label: '评论数', value: comments.length, helper: '当前节点的评论总量', tone: 'reply' },
      { label: '作品数', value: groupCommentsByWork(comments).length, helper: '按作品聚合', tone: 'reply' },
      { label: '异常数', value: countCommentsByStatus(['blocked', 'sent_unverified']), helper: '全局回评异常', tone: 'warning' },
      { label: '成功数', value: countCommentsByStatus(['succeeded']), helper: '全局回评成功', tone: 'done' },
    ],
    groups: groupCommentsByWork(comments, mode),
  };
}

function buildEventDataset(kicker, title, events, mode) {
  return {
    kicker,
    shortLabel: title,
    title,
    subtitle: '按作品或用户聚合事件，点击进入明细。',
    metrics: [
      { label: '线索数', value: events.length, helper: '当前节点事件总量', tone: mode === 'unhandled' ? 'visit' : 'muted' },
      { label: '作品数', value: groupEventsByWork(events).length, helper: '可继续展开的作品/用户', tone: 'muted' },
      { label: '点赞', value: events.filter((item) => item.event_type === 'like').length, helper: '当前节点中的点赞', tone: 'visit' },
      { label: '评论', value: events.filter((item) => item.event_type === 'comment').length, helper: '当前节点中的评论', tone: 'reply' },
    ],
    groups: groupEventsByWork(events, mode),
  };
}

function buildVisitDataset(kicker, title, tasks, events, mode) {
  return {
    kicker,
    shortLabel: title,
    title,
    subtitle: '先看作品，再进入该作品下的回访任务或线索明细。',
    metrics: [
      { label: '任务数', value: tasks.length, helper: '回访任务总量', tone: 'visit' },
      { label: '线索数', value: events.length, helper: '未处理互动线索', tone: 'muted' },
      { label: '作品数', value: buildVisitGroups(tasks, events).length, helper: '按作品聚合后的数量', tone: 'visit' },
      { label: '完成数', value: reviewTasks.filter((task) => task.status === 'done').length, helper: '全局回访完成', tone: 'done' },
    ],
    groups: buildVisitGroups(tasks, events, mode),
  };
}

function buildCollectGroups() {
  const groups = new Map();

  for (const group of groupCommentsByWork(pendingComments)) {
    mergeGroup(groups, group, '回评');
  }
  for (const group of buildVisitGroups(reviewTasks, [])) {
    mergeGroup(groups, group, '回访任务');
  }
  for (const group of groupEventsByWork(unhandledEvents)) {
    mergeGroup(groups, group, '未处理线索');
  }

  return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, 'zh-CN'));
}

function mergeGroup(map, incoming, kindLabel) {
  const key = incoming.key;
  const existing = map.get(key) || {
    key,
    title: incoming.title,
    subtitle: incoming.subtitle,
    meta: incoming.meta,
    kindLabel: '混合',
    count: 0,
    items: [],
  };
  existing.count += incoming.count;
  existing.items = existing.items.concat(incoming.items || []);
  existing.subtitle = existing.subtitle || incoming.subtitle;
  existing.meta = existing.meta || incoming.meta;
  existing.kindLabel = existing.kindLabel === '混合' ? kindLabel : '混合';
  map.set(key, existing);
}

function groupCommentsByWork(comments, mode = 'all') {
  const groups = new Map();
  for (const comment of comments) {
    const key = String(comment.joined_work_url || comment.work_url || comment.work_id || comment.modal_id || comment.actor_name || `comment-${comment.id}`);
    const title = comment.joined_work_title || comment.work_id || comment.modal_id || `${comment.actor_name || '未知用户'} 的评论`;
    const group = groups.get(key) || {
      key,
      title,
      subtitle: comment.joined_work_desc || '展开查看这条作品下的评论处理情况。',
      meta: comment.joined_work_published_at ? formatTime(comment.joined_work_published_at) : `${comment.actor_name || '未知用户'} · ${modeLabel(mode)}`,
      kindLabel: '回评',
      count: 0,
      items: [],
    };
    group.count += 1;
    group.items.push({
      kind: 'comment',
      createdAt: comment.last_seen_at || comment.first_seen_at || '',
      data: comment,
    });
    groups.set(key, group);
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, 'zh-CN'));
}

function groupEventsByWork(events, mode = 'events') {
  const groups = new Map();
  for (const event of events) {
    const key = String(event.my_work_title || event.target_work_id || event.actor_profile_url || event.actor_name || `event-${event.id}`);
    const title = event.my_work_title || event.target_work_id || `${event.actor_name || '未知用户'} 的互动`;
    const badge = event.event_type === 'comment' ? '评论线索' : event.event_type === 'like' ? '点赞线索' : event.event_type === 'reply' ? '回复线索' : '关注线索';
    const group = groups.get(key) || {
      key,
      title,
      subtitle: '点击查看该作品/用户下的互动线索。',
      meta: badge,
      kindLabel: mode === 'unhandled' ? '线索' : '事件',
      count: 0,
      items: [],
    };
    group.count += 1;
    group.items.push({
      kind: 'event',
      createdAt: event.created_at || '',
      data: event,
    });
    groups.set(key, group);
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, 'zh-CN'));
}

function buildVisitGroups(tasks, events, mode = 'all') {
  const groups = new Map();

  for (const task of tasks) {
    const key = String(task.targetWork?.workUrl || task.targetWork?.workId || task.userProfileUrl || `${task.identityKey}-${task.id}`);
    const title = task.targetWork?.workTitle || task.targetWork?.workId || task.userName || '待识别作品';
    const group = groups.get(key) || {
      key,
      title,
      subtitle: task.targetWork?.contentSummary || task.targetWork?.workText || '点击查看该作品下的回访任务。',
      meta: task.targetWork?.publishTime ? formatTime(task.targetWork.publishTime) : `${task.userName || '未知用户'} · ${modeLabel(mode)}`,
      kindLabel: '回访',
      count: 0,
      items: [],
    };
    group.count += 1;
    group.items.push({
      kind: 'task',
      createdAt: task.updatedAt || task.createdAt || '',
      data: task,
    });
    groups.set(key, group);
  }

  for (const event of events) {
    const key = String(event.my_work_title || event.target_work_id || event.actor_profile_url || `lead-${event.id}`);
    const title = event.my_work_title || event.target_work_id || `${event.actor_name || '未知用户'} 的线索`;
    const group = groups.get(key) || {
      key,
      title,
      subtitle: '点击查看该作品下的未处理线索。',
      meta: '未处理线索',
      kindLabel: '线索',
      count: 0,
      items: [],
    };
    group.count += 1;
    group.items.push({
      kind: 'event',
      createdAt: event.created_at || '',
      data: event,
    });
    groups.set(key, group);
  }

  return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, 'zh-CN'));
}

function renderDetailItem(item) {
  if (item.kind === 'comment') return renderCommentDetailItem(item.data);
  if (item.kind === 'task') return renderTaskDetailItem(item.data);
  if (item.kind === 'event') return renderEventDetailItem(item.data);
  return '';
}

function renderCommentDetailItem(comment) {
  const badge = getReplyBadge(comment.reply_status);
  const canEdit = comment.reply_status !== 'succeeded';
  const textareaId = `reply-text-${comment.id}`;

  return `
    <article class="detail-card-item">
      <div class="detail-item-head">
        <div>
          <span class="status-badge ${badge.className}">${badge.text}</span>
          <strong>${escapeHtml(comment.actor_name || '未知用户')}</strong>
        </div>
        <span class="detail-time">${escapeHtml(comment.event_time_text || '')}${comment.last_seen_at ? ` · ${formatTime(comment.last_seen_at)}` : ''}</span>
      </div>
      <div class="detail-item-block">
        <label>原评论</label>
        <p>${escapeHtml(comment.comment_text || '')}</p>
      </div>
      ${comment.reply_reason ? `
        <div class="detail-item-block subtle danger-text">
          <label>异常原因</label>
          <p>${escapeHtml(comment.reply_reason)}</p>
        </div>
      ` : ''}
      <div class="detail-item-block">
        <label>回评文本</label>
        ${canEdit ? `
          <textarea id="${textareaId}" class="inline-textarea" placeholder="可直接修改回评内容...">${escapeHtml(comment.reply_text || '')}</textarea>
        ` : `
          <p class="reply-readonly">${escapeHtml(comment.reply_text || '已成功，但没有保存回复文本')}</p>
        `}
      </div>
      ${canEdit ? `
        <div class="item-actions">
          <button class="mini-btn primary" onclick="retryComment(${comment.id})"><i class="fa-solid fa-paper-plane"></i> 重试发送</button>
          <button class="mini-btn" onclick="saveCommentReply(${comment.id})"><i class="fa-solid fa-floppy-disk"></i> 保存文本</button>
          <button class="mini-btn ghost" onclick="ignoreComment(${comment.id})"><i class="fa-solid fa-ban"></i> 忽略</button>
        </div>
      ` : ''}
    </article>
  `;
}

function renderTaskDetailItem(task) {
  const badge = getTaskBadge(task);
  const textareaId = `task-text-${task.id}`;
  return `
    <article class="detail-card-item">
      <div class="detail-item-head">
        <div>
          <span class="status-badge ${badge.className}">${badge.text}</span>
          <strong>${escapeHtml(task.userName || '未知用户')}</strong>
        </div>
        <span class="detail-time">${formatTime(task.updatedAt || task.createdAt)}</span>
      </div>
      <div class="detail-item-block">
        <label>作品摘要</label>
        <p>${escapeHtml(task.targetWork?.contentSummary || task.targetWork?.workText || task.lastError || '暂无摘要')}</p>
      </div>
      <div class="detail-item-block">
        <label>回访评论草稿</label>
        <textarea id="${textareaId}" class="inline-textarea" placeholder="输入回访评论...">${escapeHtml(task.generatedComment || '')}</textarea>
      </div>
      <div class="task-status-line">
        <span>点赞：${escapeHtml(task.likeStatus || 'pending')}</span>
        <span>评论：${escapeHtml(task.commentStatus || 'pending')}</span>
        <span>状态：${escapeHtml(task.status || '-')}</span>
      </div>
      <div class="item-actions">
        <button class="mini-btn primary" onclick="approveTask(${task.id})"><i class="fa-solid fa-floppy-disk"></i> 保存待执行</button>
        <button class="mini-btn ghost" onclick="skipTask(${task.id})"><i class="fa-solid fa-circle-xmark"></i> 跳过</button>
      </div>
    </article>
  `;
}

function renderEventDetailItem(event) {
  const badge = getEventBadge(event.event_type);
  return `
    <article class="detail-card-item">
      <div class="detail-item-head">
        <div>
          <span class="status-badge ${badge.className}">${badge.text}</span>
          <strong>${escapeHtml(event.actor_name || '未知用户')}</strong>
        </div>
        <span class="detail-time">${escapeHtml(event.event_time_text || '')}${event.created_at ? ` · ${formatTime(event.created_at)}` : ''}</span>
      </div>
      <div class="detail-item-block">
        <label>互动内容</label>
        <p>${getEventActionText(event)}</p>
      </div>
      <div class="task-status-line">
        <span>关系：${escapeHtml(event.relation || 'unknown')}</span>
        <span>状态：${escapeHtml(event.status || 'new')}</span>
      </div>
    </article>
  `;
}

window.approveTask = async function approveTask(id) {
  const textarea = document.getElementById(`task-text-${id}`) || document.getElementById(`textarea-${id}`);
  const commentText = textarea ? textarea.value.trim() : '';
  if (!commentText) {
    showToast('回访评论内容不能为空', 'error');
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
    showToast(json.message || '任务已保存为待执行', 'success');
    await refreshAll();
  } catch (err) {
    showToast('保存回访任务失败', 'error');
  }
};

window.skipTask = async function skipTask(id) {
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
    showToast(json.message || '任务已跳过', 'success');
    await refreshAll();
  } catch (err) {
    showToast('跳过回访任务失败', 'error');
  }
};

window.retryComment = async function retryComment(id) {
  const textarea = document.getElementById(`reply-text-${id}`);
  const replyText = textarea ? textarea.value.trim() : '';
  try {
    const res = await fetch(`/api/pending-comments/${id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyText }),
    });
    const json = await res.json();
    if (!json.ok) {
      showToast(json.error || '重试失败', 'error');
      return;
    }
    showToast(json.message || '已重新加入待回复队列', 'success');
    await refreshAll();
  } catch (err) {
    showToast('重试回评失败', 'error');
  }
};

window.saveCommentReply = async function saveCommentReply(id) {
  const textarea = document.getElementById(`reply-text-${id}`);
  const replyText = textarea ? textarea.value : '';
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
    showToast('保存回评文本失败', 'error');
  }
};

window.ignoreComment = async function ignoreComment(id) {
  try {
    const res = await fetch(`/api/pending-comments/${id}/ignore`, {
      method: 'POST',
    });
    const json = await res.json();
    if (!json.ok) {
      showToast(json.error || '忽略失败', 'error');
      return;
    }
    showToast(json.message || '已忽略该评论', 'success');
    await refreshAll();
  } catch (err) {
    showToast('忽略评论失败', 'error');
  }
};

function getRetryVisitTasks() {
  return reviewTasks.filter((task) => ['failed_collect', 'failed_generate_comment'].includes(task.status));
}

function getErrorVisitTasks() {
  return reviewTasks.filter((task) => ['failed_like', 'failed_comment', 'failed'].includes(task.status));
}

function getSkippedVisitTasks() {
  return reviewTasks.filter((task) => ['skipped_no_work', 'skipped_private', 'skipped_no_suitable_work'].includes(task.status));
}

function getExecutableVisitCount() {
  return reviewTasks.filter((task) => ['pending_visit', 'pending_execute', 'executing', 'failed_collect', 'failed_generate_comment', 'failed_like', 'failed_comment'].includes(task.status)).length;
}

function getVisitErrorCount() {
  return getRetryVisitTasks().length + getErrorVisitTasks().length;
}

function getUnhandledEventCount() {
  return unhandledEvents.length;
}

function filterEventsByType(types) {
  return unhandledEvents.filter((event) => types.includes(event.event_type));
}

function countCommentsByStatus(statuses) {
  return pendingComments.filter((comment) => statuses.includes(comment.reply_status)).length;
}

function modeLabel(mode) {
  if (mode === 'pending') return '待回评';
  if (mode === 'exceptions') return '异常回评';
  if (mode === 'done') return '回评成功';
  if (mode === 'skipped') return '忽略回评';
  if (mode === 'retry') return '待重试';
  if (mode === 'errors') return '回访异常';
  if (mode === 'unhandled') return '未处理线索';
  if (mode === 'done') return '已完成';
  return '当前节点';
}

function sortByCreatedDesc(a, b) {
  return parseDateValue(b.createdAt) - parseDateValue(a.createdAt);
}

function parseDateValue(value) {
  if (!value) return 0;
  const num = Number(value);
  if (Number.isFinite(num) && num > 1000000000 && String(value).trim().length <= 13) {
    return num < 1000000000000 ? num * 1000 : num;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function getReplyBadge(status) {
  if (status === 'blocked') return { text: '已阻塞', className: 'warning' };
  if (status === 'sent_unverified') return { text: '发送未确认', className: 'danger' };
  if (status === 'skipped') return { text: '已跳过', className: 'muted' };
  if (status === 'succeeded') return { text: '已成功', className: 'done' };
  return { text: '待回评', className: 'reply' };
}

function getTaskBadge(task) {
  if (task.status === 'done') return { text: '已完成', className: 'done' };
  if (String(task.status || '').startsWith('failed')) return { text: task.status, className: 'danger' };
  if (String(task.status || '').startsWith('skipped')) return { text: task.status, className: 'muted' };
  if (task.status === 'pending_execute' || task.status === 'executing') return { text: '待执行', className: 'visit' };
  return { text: task.status || 'pending_visit', className: 'visit' };
}

function getEventBadge(type) {
  if (type === 'comment') return { text: '评论', className: 'reply' };
  if (type === 'like') return { text: '点赞', className: 'visit' };
  if (type === 'reply') return { text: '回复', className: 'muted' };
  if (type === 'follow') return { text: '关注', className: 'warning' };
  return { text: type || '事件', className: 'muted' };
}

function getEventActionText(event) {
  if (event.event_type === 'like') return '赞了你的作品';
  if (event.event_type === 'follow') return '关注了你';
  if (event.event_type === 'reply') return event.comment_text ? `回复内容：${escapeHtml(event.comment_text)}` : '回复了你';
  if (event.event_type === 'comment') return event.comment_text ? `评论内容：${escapeHtml(event.comment_text)}` : '评论了你的作品';
  return escapeHtml(event.comment_text || '');
}

function renderEmpty(text) {
  return `
    <div class="empty-state">
      <i class="fa-solid fa-box-open"></i>
      <p>${escapeHtml(text)}</p>
    </div>
  `;
}

function formatTime(value) {
  const ms = parseDateValue(value);
  if (!ms) return '';
  return new Date(ms).toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, tone = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${tone}`;
  toast.textContent = message;
  container.appendChild(toast);
  window.setTimeout(() => toast.classList.add('show'), 10);
  window.setTimeout(() => {
    toast.classList.remove('show');
    window.setTimeout(() => toast.remove(), 220);
  }, 2600);
}
