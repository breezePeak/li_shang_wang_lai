document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

let statsData = {};
let reviewTasks = [];
let pendingComments = [];
let unhandledEvents = [];
let scanSchedules = [];
let selectedStageId = null;
let selectedWorkKey = null;
const EXECUTION_BATCH_GAP_MS = 2 * 60 * 1000;

const STAGE_IDS = {
  SCAN_SCHEDULES: 'scanSchedules',
  REPLY_SCHEDULES: 'replySchedules',
  VISIT_SCHEDULES: 'visitSchedules',
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
  window.setInterval(refreshAll, 10000);
}

function bindEvents() {
  document.getElementById('btn-refresh').addEventListener('click', refreshAll);
  document.getElementById('btn-close-drawer').addEventListener('click', closeDrawer);
  document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);
  document.getElementById('detail-modal-backdrop').addEventListener('click', () => {
    selectedWorkKey = null;
    renderDrawer();
  });
  document.getElementById('btn-back-work').addEventListener('click', () => {
    selectedWorkKey = null;
    renderDrawer();
  });
}

async function refreshAll() {
  await Promise.all([
    fetchStats(),
    fetchScanSchedules(),
    fetchReviewTasks(),
    fetchPendingComments(),
    fetchUnhandledEvents(),
  ]);
  renderHeaderStats();
  renderFlowGraph();
  renderOpsBoards();
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

async function fetchScanSchedules() {
  try {
    const res = await fetch('/api/scan-schedules?limit=40');
    const json = await res.json();
    if (json.ok) scanSchedules = json.data || [];
  } catch (err) {
    console.error('获取扫描批次失败:', err);
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
  if (!root || root.hasAttribute('hidden')) return;
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
          <p>像编辑流水台一样推进评论处理，先聚合作品，再下钻到每条回复动作。</p>
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
          <p>从线索汇入执行链，强调状态推进和结果落点，避免和回评线混成一团。</p>
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

function renderOpsBoards() {
  renderScanScheduleBoard();
  renderReplyOverviewBoard();
  renderVisitOverviewBoard();
}

function renderScanScheduleBoard() {
  setText('scan-schedule-count', `${scanSchedules.length} 批`);
  const el = document.getElementById('scan-schedule-table');
  if (!el) return;
  if (!scanSchedules.length) {
    el.innerHTML = '<div class="overview-empty">暂时还没有扫描批次数据。</div>';
    return;
  }

  el.innerHTML = `
    <div class="overview-table-head">
      <span>批次</span>
      <span>通知</span>
      <span>待回评</span>
      <span>待回访</span>
    </div>
    ${scanSchedules.slice(0, 8).map((batch) => `
      <button class="overview-row scan-accent" onclick="openScanBatch('${encodeURIComponent(batch.key)}')">
        <div>
          <strong>${escapeHtml(formatTime(batch.scannedEndAt || batch.scannedStartAt) || batch.key)}</strong>
          <span>${escapeHtml(formatNamedTimeRange(batch.scannedStartAt, batch.scannedEndAt))}</span>
        </div>
        <div>
          <strong class="overview-cell-count">${batch.totalEvents || 0}</strong>
          <small>${escapeHtml(renderEventTypeSummary(batch))}</small>
        </div>
        <div>
          <strong class="overview-cell-count">${batch.pendingReplies || 0}</strong>
          <small>共 ${batch.linkedReplyCount || 0} 条回评</small>
        </div>
        <div>
          <strong class="overview-cell-count">${batch.pendingVisits || 0}</strong>
          <small>共 ${batch.linkedVisitCount || 0} 条回访</small>
        </div>
      </button>
    `).join('')}
  `;
}

function renderReplyOverviewBoard() {
  const rows = buildReplyScheduleRows();
  setText('reply-board-count', `${rows.length} 批`);
  const el = document.getElementById('reply-overview-table');
  if (!el) return;
  el.innerHTML = `
    <div class="overview-table-head">
      <span>批次</span>
      <span>状态</span>
      <span>评论</span>
      <span>作品</span>
    </div>
    ${rows.map((row) => `
      <button class="overview-row reply-accent" onclick="openScheduleBatch('${STAGE_IDS.REPLY_SCHEDULES}', '${encodeURIComponent(row.key)}')">
        <div>
          <strong>${escapeHtml(formatTime(row.anchorAt) || row.key)}</strong>
          <span>${escapeHtml(formatNamedTimeRange(row.startAt, row.endAt))}</span>
        </div>
        <div>
          <strong class="overview-status">${escapeHtml(row.summary)}</strong>
          <small>${escapeHtml(row.helper)}</small>
        </div>
        <div>
          <strong class="overview-cell-count">${row.count}</strong>
          <small>${escapeHtml(row.secondary)}</small>
        </div>
        <div>
          <strong>${row.workCount}</strong>
          <small>按作品聚合</small>
        </div>
      </button>
    `).join('')}
  `;
}

function renderVisitOverviewBoard() {
  const rows = buildVisitScheduleRows();
  setText('visit-board-count', `${rows.length} 批`);
  const el = document.getElementById('visit-overview-table');
  if (!el) return;
  el.innerHTML = `
    <div class="overview-table-head">
      <span>批次</span>
      <span>状态</span>
      <span>任务</span>
      <span>对象</span>
    </div>
    ${rows.map((row) => `
      <button class="overview-row visit-accent" onclick="openScheduleBatch('${STAGE_IDS.VISIT_SCHEDULES}', '${encodeURIComponent(row.key)}')">
        <div>
          <strong>${escapeHtml(formatTime(row.anchorAt) || row.key)}</strong>
          <span>${escapeHtml(formatNamedTimeRange(row.startAt, row.endAt))}</span>
        </div>
        <div>
          <strong class="overview-status">${escapeHtml(row.summary)}</strong>
          <small>${escapeHtml(row.helper)}</small>
        </div>
        <div>
          <strong class="overview-cell-count">${row.count}</strong>
          <small>${escapeHtml(row.secondary)}</small>
        </div>
        <div>
          <strong>${row.groupCount}</strong>
          <small>${escapeHtml(row.groupLabel)}</small>
        </div>
      </button>
    `).join('')}
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

window.openBoardStage = function openBoardStage(stageId) {
  window.selectStage(stageId);
};

window.openScanBatch = function openScanBatch(encodedKey) {
  selectedStageId = STAGE_IDS.SCAN_SCHEDULES;
  selectedWorkKey = decodeURIComponent(encodedKey);
  renderFlowGraph();
  renderDrawer();
};

window.openScheduleBatch = function openScheduleBatch(stageId, encodedKey) {
  selectedStageId = stageId;
  selectedWorkKey = decodeURIComponent(encodedKey);
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
  const backdrop = document.getElementById('drawer-backdrop');
  const empty = document.getElementById('drawer-empty');
  const frame = document.getElementById('drawer-frame');
  const shell = document.getElementById('drawer-shell');
  const detailBackdrop = document.getElementById('detail-modal-backdrop');
  const detailPanel = document.getElementById('detail-modal-panel');

  if (!selectedStageId) {
    drawer.classList.remove('is-open', 'is-detail-open');
    backdrop.classList.remove('is-visible');
    shell.classList.remove('has-detail-open');
    detailBackdrop.classList.remove('is-visible');
    detailPanel.classList.remove('is-visible');
    empty.style.display = 'flex';
    frame.style.display = 'none';
    return;
  }

  const dataset = buildStageDataset(selectedStageId);
  const groups = dataset.groups || [];
  const workGroup = selectedWorkKey ? groups.find((group) => group.key === selectedWorkKey) : null;

  drawer.classList.add('is-open');
  drawer.classList.toggle('is-detail-open', Boolean(workGroup));
  backdrop.classList.add('is-visible');
  empty.style.display = 'none';
  frame.style.display = 'flex';
  shell.classList.toggle('has-detail-open', Boolean(workGroup));
  detailBackdrop.classList.toggle('is-visible', Boolean(workGroup));
  detailPanel.classList.toggle('is-visible', Boolean(workGroup));
  detailPanel.setAttribute('aria-hidden', workGroup ? 'false' : 'true');

  setText('drawer-kicker', dataset.kicker);
  setText('drawer-title', dataset.title);
  setText('drawer-subtitle', dataset.subtitle);
  setText('list-title', dataset.listTitle || '作品列表');
  setText('works-count-text', `${groups.length} ${dataset.countUnit || '个作品'}`);

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
    const metaLabel = parseDateValue(group.meta) ? formatTime(group.meta) : group.meta;
    return `
      <button class="work-card ${active}" onclick="selectWork('${encodedKey}')">
        <div class="work-card-top">
          <span class="work-chip">${group.kindLabel}</span>
          <strong>${group.count}</strong>
        </div>
        <h4>${escapeHtml(group.title)}</h4>
        <p>${escapeHtml(group.subtitle || '点击查看该作品下的评论/回访明细')}</p>
        <div class="work-card-foot">
          <span>${escapeHtml(metaLabel || '')}</span>
          <span class="work-card-action">展开详情 <i class="fa-solid fa-arrow-right"></i></span>
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

  const summaryChips = [`${workGroup.count} 条明细`];
  const rangeText = workGroup.startAt || workGroup.endAt
    ? formatNamedTimeRange(workGroup.startAt, workGroup.endAt)
    : '';
  if (rangeText) summaryChips.push(rangeText);
  else if (workGroup.meta) summaryChips.push(workGroup.meta);
  if (Number.isInteger(workGroup.workCount) && workGroup.workCount > 0) summaryChips.push(`${workGroup.workCount} 个作品`);
  if (Number.isInteger(workGroup.groupCount) && workGroup.groupCount > 0) summaryChips.push(`${workGroup.groupCount} 位对象`);

  meta.innerHTML = `
    <div class="detail-title-inline">
      <span class="work-chip">${workGroup.kindLabel}</span>
      <h4>${escapeHtml(workGroup.title)}</h4>
    </div>
    <div class="detail-summary detail-summary-compact">
      ${summaryChips.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}
    </div>
    <p class="detail-inline-note">${escapeHtml(workGroup.subtitle || dataset.title)}</p>
  `;

  const items = (workGroup.items || []).slice().sort(sortByCreatedDesc);
  list.innerHTML = items.length
    ? items.map(renderDetailItem).join('')
    : renderEmpty('当前作品下没有可展示的明细。');
}

function buildStageDataset(stageId) {
  switch (stageId) {
    case STAGE_IDS.SCAN_SCHEDULES:
      return buildScanScheduleDataset();
    case STAGE_IDS.REPLY_SCHEDULES:
      return buildReplyScheduleDataset();
    case STAGE_IDS.VISIT_SCHEDULES:
      return buildVisitScheduleDataset();
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
    listTitle: '作品列表',
    countUnit: '个作品',
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
    listTitle: mode === 'unhandled' ? '回访列表' : '作品列表',
    countUnit: mode === 'unhandled' ? '位好友' : '个对象',
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
  const groups = buildVisitActionGroups(tasks, events, mode);
  return {
    kicker,
    shortLabel: title,
    title,
    subtitle: '先看回访好友，再进入这位好友的互动详情与我的回复记录。',
    listTitle: '回访列表',
    countUnit: '位好友',
    metrics: [
      { label: '任务数', value: tasks.length, helper: '回访任务总量', tone: 'visit' },
      { label: '线索数', value: events.length, helper: '未处理互动线索', tone: 'muted' },
      { label: '好友数', value: groups.length, helper: '按好友聚合后的数量', tone: 'visit' },
      { label: '完成数', value: reviewTasks.filter((task) => task.status === 'done').length, helper: '全局回访完成', tone: 'done' },
    ],
    groups,
  };
}

function buildScanScheduleDataset() {
  return {
    kicker: 'Scan Schedule',
    shortLabel: '扫描批次',
    title: '扫描时间表',
    subtitle: '每一批扫描都能反查到对应回评、回访和通知明细。',
    listTitle: '扫描批次',
    countUnit: '批扫描',
    metrics: [
      { label: '扫描批次', value: scanSchedules.length, helper: '按扫描秒级批次聚合', tone: 'gold' },
      { label: '待回评', value: sumBy(scanSchedules, 'pendingReplies'), helper: '批次关联的待回评', tone: 'reply' },
      { label: '待回访', value: sumBy(scanSchedules, 'pendingVisits'), helper: '批次关联的待回访', tone: 'visit' },
      { label: '通知总量', value: sumBy(scanSchedules, 'totalEvents'), helper: '批次内通知入库数', tone: 'muted' },
    ],
    groups: buildScanScheduleGroups(),
  };
}

function buildScanScheduleGroups() {
  return scanSchedules.map((batch) => {
    const items = buildScanJourneyItems(batch);

    return {
      key: batch.key,
      anchorAt: batch.scannedEndAt || batch.scannedStartAt,
      startAt: batch.scannedStartAt,
      endAt: batch.scannedEndAt,
      title: `${formatTime(batch.scannedStartAt) || batch.key} 扫描批次`,
      subtitle: `${renderEventTypeSummary(batch)}，整理成 ${items.length} 条互动链`,
      meta: `线索时间 ${formatTimeRange(batch.eventWindowStartAt, batch.eventWindowEndAt)}`,
      kindLabel: '扫描',
      count: items.length,
      items: items.sort(sortByCreatedDesc),
    };
  });
}

function buildScanJourneyItems(batch) {
  const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  const comments = Array.isArray(batch.comments) ? batch.comments : [];
  const events = Array.isArray(batch.events) ? batch.events : [];
  const items = [];
  const usedEventIds = new Set();
  const usedCommentIds = new Set();

  for (const task of tasks) {
    const sourceEvents = Array.isArray(task.sourceEvents) ? task.sourceEvents : [];
    const sourceEventIds = sourceEvents
      .map((event) => Number(event?.id))
      .filter((id) => Number.isInteger(id) && id > 0);
    sourceEventIds.forEach((id) => usedEventIds.add(id));

    const relatedComments = comments.filter((comment) => {
      const sourceEventId = Number(comment.source_event_id);
      return Number.isInteger(sourceEventId) && sourceEventIds.includes(sourceEventId);
    });
    relatedComments.forEach((comment) => usedCommentIds.add(comment.id));

    items.push({
      kind: 'scanJourney',
      createdAt: task.updatedAt || task.createdAt || sourceEvents[0]?.created_at || '',
      data: {
        primaryEvent: sourceEvents[0] || null,
        sourceEvents,
        comments: relatedComments,
        task,
      },
    });
  }

  for (const comment of comments) {
    if (usedCommentIds.has(comment.id)) continue;
    const sourceEvent = events.find((event) => Number(event.id) === Number(comment.source_event_id)) || null;
    if (sourceEvent?.id) usedEventIds.add(Number(sourceEvent.id));
    items.push({
      kind: 'scanJourney',
      createdAt: comment.last_seen_at || comment.first_seen_at || sourceEvent?.created_at || '',
      data: {
        primaryEvent: sourceEvent,
        sourceEvents: sourceEvent ? [sourceEvent] : [],
        comments: [comment],
        task: null,
      },
    });
  }

  for (const event of events) {
    if (usedEventIds.has(Number(event.id))) continue;
    items.push({
      kind: 'scanJourney',
      createdAt: event.created_at || event.scanned_at || '',
      data: {
        primaryEvent: event,
        sourceEvents: [event],
        comments: [],
        task: null,
      },
    });
  }

  return items;
}

function buildReplyScheduleDataset() {
  const groups = buildReplyScheduleGroups();
  return {
    kicker: 'Reply Schedule',
    shortLabel: '回评批次',
    title: '回评时间表',
    subtitle: '按回评时间批次汇总，点开就能看到当批次下的评论与回复明细。',
    listTitle: '回评批次',
    countUnit: '批回评',
    metrics: [
      { label: '回评批次', value: groups.length, helper: '按时间秒级聚合', tone: 'reply' },
      { label: '回评总数', value: pendingComments.length, helper: '当前所有回评记录', tone: 'reply' },
      { label: '成功回评', value: countCommentsByStatus(['succeeded']), helper: '已成功回复', tone: 'done' },
      { label: '异常 / 待处理', value: countCommentsByStatus(['pending', 'blocked', 'sent_unverified']), helper: '还需关注的回评', tone: 'warning' },
    ],
    groups,
  };
}

function buildReplyScheduleRows() {
  return buildReplyScheduleGroups().map((group) => ({
    key: group.key,
    anchorAt: group.anchorAt,
    startAt: group.startAt,
    endAt: group.endAt,
    count: group.count,
    workCount: group.workCount,
    summary: group.summary,
    helper: group.helper,
    secondary: group.secondary,
  }));
}

function buildReplyScheduleGroups() {
  const batches = clusterItemsByExecutionWindow(
    pendingComments,
    (comment) => getReplyBatchTime(comment),
    'reply-batch'
  );

  return batches.map((batch) => {
    const group = {
      key: batch.key,
      anchorAt: batch.anchorAt,
      startAt: batch.startAt,
      endAt: batch.endAt,
      count: 0,
      workKeys: new Set(),
      pendingCount: 0,
      exceptionCount: 0,
      doneCount: 0,
      skippedCount: 0,
      items: [],
    };

    for (const comment of batch.items) {
      const timeValue = getReplyBatchTime(comment);
      const workKey = String(comment.joined_work_url || comment.work_url || comment.work_id || comment.modal_id || comment.id);
      group.count += 1;
      group.workKeys.add(workKey);
      if (['succeeded', 'manually_replied'].includes(comment.reply_status)) group.doneCount += 1;
      else if (comment.reply_status === 'skipped') group.skippedCount += 1;
      else if (['blocked', 'sent_unverified'].includes(comment.reply_status)) group.exceptionCount += 1;
      else group.pendingCount += 1;
      group.items.push({ kind: 'comment', createdAt: timeValue, data: comment });
    }

    return {
      key: group.key,
      anchorAt: group.anchorAt,
      startAt: group.startAt,
      endAt: group.endAt,
      title: `${formatTime(group.anchorAt) || group.key} 回评批次`,
      subtitle: summarizeReplySchedule(group),
      meta: formatTimeRange(group.startAt, group.endAt),
      kindLabel: '回评',
      count: group.count,
      workCount: group.workKeys.size,
      summary: summarizeReplySchedule(group),
      helper: buildReplyScheduleHelper(group),
      secondary: `本次回评 ${group.count} 条`,
      items: group.items.sort(sortByCreatedDesc),
    };
  });
}

function buildVisitScheduleDataset() {
  const groups = buildVisitScheduleGroups();
  return {
    kicker: 'Visit Schedule',
    shortLabel: '回访批次',
    title: '回访时间表',
    subtitle: '按回访执行批次汇总，同一次命令处理了多少任务、成功多少、异常多少一眼可见。',
    listTitle: '回访批次',
    countUnit: '批回访',
    metrics: [
      { label: '回访批次', value: groups.length, helper: '按时间秒级聚合', tone: 'visit' },
      { label: '回访总量', value: reviewTasks.length, helper: '回访任务总数', tone: 'visit' },
      { label: '成功回访', value: reviewTasks.filter((task) => task.status === 'done').length, helper: '已完成回访', tone: 'done' },
      { label: '待推进 / 异常', value: getExecutableVisitCount() + getVisitErrorCount(), helper: '仍需处理的回访', tone: 'warning' },
    ],
    groups,
  };
}

function buildVisitScheduleRows() {
  return buildVisitScheduleGroups().map((group) => ({
    key: group.key,
    anchorAt: group.anchorAt,
    startAt: group.startAt,
    endAt: group.endAt,
    count: group.count,
    groupCount: group.groupCount,
    groupLabel: '位对象',
    summary: group.summary,
    helper: group.helper,
    secondary: group.secondary,
  }));
}

function buildVisitScheduleGroups() {
  const batches = clusterItemsByExecutionWindow(
    reviewTasks,
    (task) => task.updatedAt || task.createdAt || '',
    'visit-batch'
  );

  return batches.map((batch) => {
    const group = {
      key: batch.key,
      anchorAt: batch.anchorAt,
      startAt: batch.startAt,
      endAt: batch.endAt,
      count: 0,
      personKeys: new Set(),
      leadCount: 0,
      pendingCount: 0,
      doneCount: 0,
      failedCount: 0,
      skippedCount: 0,
      items: [],
    };

    for (const task of batch.items) {
      const status = String(task.status || '');
      const timeValue = task.updatedAt || task.createdAt || '';
      const personKey = String(task.userProfileUrl || task.identityKey || task.userName || task.id);
      group.count += 1;
      group.personKeys.add(personKey);
      group.pendingCount += !status || ['pending_visit', 'collecting_content', 'content_collected', 'comment_generated', 'pending_execute', 'executing'].includes(status) ? 1 : 0;
      group.doneCount += status === 'done' ? 1 : 0;
      group.failedCount += status.startsWith('failed') ? 1 : 0;
      group.skippedCount += status.startsWith('skipped') ? 1 : 0;
      group.items.push({ kind: 'task', createdAt: timeValue, data: task });
    }

    return {
      key: group.key,
      anchorAt: group.anchorAt,
      startAt: group.startAt,
      endAt: group.endAt,
      title: `${formatTime(group.anchorAt) || group.key} 回访批次`,
      subtitle: summarizeVisitSchedule(group),
      meta: formatTimeRange(group.startAt, group.endAt),
      kindLabel: '回访',
      count: group.count,
      groupCount: group.personKeys.size,
      summary: summarizeVisitSchedule(group),
      helper: buildVisitScheduleHelper(group),
      secondary: `本次回访 ${group.count} 条`,
      items: group.items.sort(sortByCreatedDesc),
    };
  });
}

function clusterItemsByExecutionWindow(items, getTimeValue, keyPrefix) {
  const sorted = (Array.isArray(items) ? items : [])
    .map((item) => ({ item, timeValue: getTimeValue(item), timeMs: parseDateValue(getTimeValue(item)) }))
    .sort((a, b) => (b.timeMs - a.timeMs) || sortByCreatedDesc({ createdAt: b.timeValue }, { createdAt: a.timeValue }));

  const groups = [];
  let current = null;

  for (const entry of sorted) {
    if (!current || !entry.timeMs || !current.lastTimeMs || Math.abs(current.lastTimeMs - entry.timeMs) > EXECUTION_BATCH_GAP_MS) {
      current = {
        key: `${keyPrefix}-${entry.timeValue || entry.item?.id || groups.length}`,
        anchorAt: entry.timeValue,
        startAt: entry.timeValue,
        endAt: entry.timeValue,
        lastTimeMs: entry.timeMs,
        items: [entry.item],
      };
      groups.push(current);
      continue;
    }

    current.items.push(entry.item);
    current.startAt = pickEarlierTime(current.startAt, entry.timeValue);
    current.endAt = pickLaterTime(current.endAt, entry.timeValue);
    current.anchorAt = pickLaterTime(current.anchorAt, entry.timeValue);
    current.lastTimeMs = entry.timeMs;
  }

  return groups;
}

function getReplyBatchTime(comment) {
  return comment.replied_at || comment.last_seen_at || comment.first_seen_at || '';
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

function buildVisitActionGroups(tasks, events, mode = 'all') {
  const groups = new Map();

  for (const task of tasks) {
    const sourceEvents = Array.isArray(task.sourceEvents) ? task.sourceEvents : [];
    const canonicalProfileUrl = sourceEvents.find((event) => event?.actor_profile_url)?.actor_profile_url;
    const canonicalName = sourceEvents.find((event) => event?.actor_name)?.actor_name;
    const key = String(canonicalProfileUrl || task.userProfileUrl || task.identityKey || canonicalName || task.userName || `task-${task.id}`);
    const actionSummary = summarizeVisitActions(sourceEvents, task.sourceTypes || [task.sourceType]);
    const latestTime = pickLatestVisitTime(sourceEvents, task.updatedAt || task.createdAt || '');
    const group = groups.get(key) || {
      key,
      title: canonicalName || task.userName || '未知好友',
      subtitle: actionSummary || '查看这位好友对你作品的互动和回访处理。',
      meta: latestTime ? formatTime(latestTime) : modeLabel(mode),
      kindLabel: '好友',
      count: 0,
      items: [],
    };
    group.count += sourceEvents.length || 1;
    group.items.push({
      kind: 'task',
      createdAt: latestTime || task.updatedAt || task.createdAt || '',
      data: task,
    });
    groups.set(key, group);
  }

  for (const event of events) {
    const key = String(event.actor_profile_url || event.actor_name || `lead-${event.id}`);
    const group = groups.get(key) || {
      key,
      title: event.actor_name || '未知好友',
      subtitle: describeSingleVisitEvent(event),
      meta: event.created_at ? formatTime(event.created_at) : '未处理线索',
      kindLabel: '好友',
      count: 0,
      items: [],
    };
    group.count += 1;
    group.title = group.title || event.actor_name || '未知好友';
    group.subtitle = summarizeVisitActions(group.items.map((item) => item.data).concat(event), []) || group.subtitle || describeSingleVisitEvent(event);
    group.meta = pickLatestVisitTime(group.items.map((item) => item.data).concat(event), event.created_at || group.meta);
    group.items.push({
      kind: 'event',
      createdAt: event.created_at || '',
      data: event,
    });
    groups.set(key, group);
  }

  return Array.from(groups.values()).sort((a, b) => sortByCreatedDesc({ createdAt: a.items?.[0]?.createdAt || '' }, { createdAt: b.items?.[0]?.createdAt || '' }) || a.title.localeCompare(b.title, 'zh-CN'));
}

function renderDetailItem(item) {
  if (item.kind === 'scanJourney') return renderScanJourneyItem(item.data);
  if (item.kind === 'comment') return renderCommentDetailItem(item.data);
  if (item.kind === 'task') return renderTaskDetailItem(item.data);
  if (item.kind === 'event') return renderEventDetailItem(item.data);
  return '';
}

function renderScanJourneyItem(journey) {
  const sourceEvents = Array.isArray(journey?.sourceEvents) ? journey.sourceEvents : [];
  const comments = Array.isArray(journey?.comments) ? journey.comments : [];
  const task = journey?.task || null;
  const primaryEvent = journey?.primaryEvent || sourceEvents[0] || null;
  const actorName = primaryEvent?.actor_name || task?.userName || comments[0]?.actor_name || '未知好友';
  const sourceWork = primaryEvent?.my_work_title || comments[0]?.joined_work_title || comments[0]?.work_id || '未识别到你的作品';
  const revisitWork = task?.targetWork?.workTitle || task?.targetWork?.contentSummary || task?.targetWork?.workText || '还没有找到回访作品';
  const journeyBadge = getScanJourneyBadge(task, comments);
  const replySnapshot = pickBestReplyRecord(task, comments);
  const replySummary = buildReplySummary(replySnapshot);
  const visitSummary = buildVisitSummary(task);

  return `
    <article class="detail-card-item journey-card">
      <div class="detail-item-head">
        <div>
          <span class="status-badge ${journeyBadge.className}">${journeyBadge.text}</span>
          <strong>${escapeHtml(actorName)}</strong>
        </div>
        <span class="detail-time">${escapeHtml(formatJourneyTime(primaryEvent, task, comments))}</span>
      </div>

      ${renderJourneyTimeline({
        actorName,
        sourceWork,
        revisitWork,
        sourceEvents,
        primaryEvent,
        replySnapshot,
        task,
      })}

      <div class="journey-grid">
        <section class="journey-panel journey-source">
          <div class="journey-panel-head">
            <span class="journey-step">1</span>
            <div>
              <strong>好友在你这里做了什么</strong>
              <p>${escapeHtml(sourceWork)}</p>
            </div>
          </div>
          <div class="journey-summary">
            <span>${escapeHtml(summarizeVisitActions(sourceEvents, task?.sourceTypes || []) || describeSingleVisitEvent(primaryEvent) || '发现了一条互动')}</span>
            <small>${escapeHtml(buildSourceEventTimeline(sourceEvents, primaryEvent))}</small>
          </div>
          ${renderSourceEventList(sourceEvents, primaryEvent)}
          ${replySummary ? `
            <div class="journey-note">
              <label>我在这条作品里的回复</label>
              <p>${escapeHtml(replySummary)}</p>
            </div>
          ` : ''}
        </section>

        <section class="journey-panel journey-target">
          <div class="journey-panel-head">
            <span class="journey-step">2</span>
            <div>
              <strong>我后来怎么处理</strong>
              <p>${escapeHtml(revisitWork)}</p>
            </div>
          </div>
          ${task ? `
            <div class="journey-summary">
              <span>${escapeHtml(visitSummary.title)}</span>
              <small>${escapeHtml(visitSummary.meta)}</small>
            </div>
            <div class="journey-status-chips">
              <span class="journey-chip ${getLikeStatusTone(task.likeStatus)}">点赞：${escapeHtml(humanizeLikeStatus(task.likeStatus))}</span>
              <span class="journey-chip ${getCommentStatusTone(task.commentStatus)}">评论：${escapeHtml(humanizeCommentStatus(task.commentStatus))}</span>
              <span class="journey-chip ${getTaskStatusTone(task.status)}">任务：${escapeHtml(humanizeTaskStatus(task.status))}</span>
            </div>
            ${task.generatedComment ? `
              <div class="journey-note">
                <label>本次回访评论</label>
                <p>${escapeHtml(task.generatedComment)}</p>
              </div>
            ` : ''}
          ` : `
            <div class="journey-summary empty">
              <span>这一条互动还没有进入回访任务</span>
              <small>${replySummary ? '目前只记录到回评处理。' : '目前只有扫描线索，还没有回访动作。'}</small>
            </div>
          `}
        </section>
      </div>
    </article>
  `;
}

function renderCommentDetailItem(comment) {
  const badge = getReplyBadge(comment.reply_status);
  const canEdit = comment.reply_status !== 'succeeded';
  const textareaId = `reply-text-${comment.id}`;
  const sourceWork = comment.joined_work_title || comment.work_id || comment.modal_id || '未识别到你的作品';

  return `
    <article class="detail-card-item journey-card">
      <div class="detail-item-head">
        <div>
          <span class="status-badge ${badge.className}">${badge.text}</span>
          <strong>${escapeHtml(comment.actor_name || '未知用户')}</strong>
        </div>
        <span class="detail-time">${escapeHtml(comment.event_time_text || '')}${comment.last_seen_at ? ` · ${formatTime(comment.last_seen_at)}` : ''}</span>
      </div>
      ${renderCommentTimeline(comment, sourceWork)}
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
  const sourceEvents = Array.isArray(task.sourceEvents) ? task.sourceEvents : [];
  const linkedReplies = Array.isArray(task.linkedReplies) ? task.linkedReplies.filter((item) => item.reply_text) : [];
  const workSummary = task.targetWork?.workTitle || task.targetWork?.contentSummary || task.targetWork?.workText || task.lastError || '暂无作品信息';
  const sourceWork = sourceEvents[0]?.my_work_title || linkedReplies[0]?.joined_work_title || '未识别到你的作品';
  return `
    <article class="detail-card-item journey-card">
      <div class="detail-item-head">
        <div>
          <span class="status-badge ${badge.className}">${badge.text}</span>
          <strong>${escapeHtml(task.userName || '未知用户')}</strong>
        </div>
        <span class="detail-time">${formatTime(task.updatedAt || task.createdAt)}</span>
      </div>
      ${renderVisitTaskTimeline(task, sourceWork, workSummary, sourceEvents, linkedReplies)}
      <div class="detail-item-block">
        <label>好友做了什么</label>
        <p>${escapeHtml(summarizeVisitActions(sourceEvents, task.sourceTypes || [task.sourceType]) || '暂无互动摘要')}</p>
      </div>
      <div class="detail-item-block">
        <label>我的作品</label>
        <p>${escapeHtml(workSummary)}</p>
      </div>
      <div class="detail-item-block">
        <label>互动详情</label>
        ${renderVisitSourceEvents(sourceEvents)}
      </div>
      <div class="detail-item-block">
        <label>我给这位好友回复过的话</label>
        ${renderLinkedReplies(linkedReplies)}
      </div>
      <div class="detail-item-block">
        <label>本次回访消息</label>
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

function renderCommentTimeline(comment, sourceWork) {
  const eventTime = comment.event_time_text || '';
  const touchedAt = formatTime(comment.last_seen_at || comment.replied_at || comment.first_seen_at || '');
  const hasReply = Boolean(comment.reply_text);
  const statusText = comment.reply_status === 'succeeded'
    ? '这条评论已经回评完成'
    : comment.reply_status === 'skipped'
      ? '这条评论已被忽略'
      : ['blocked', 'sent_unverified'].includes(comment.reply_status)
        ? '这条评论在回评时出现异常'
        : '这条评论正在等待你处理';

  return `
    <div class="journey-timeline">
      <div class="journey-timeline-item">
        <span class="journey-dot reply"></span>
        <div class="journey-line-copy">
          <label>收到评论</label>
          <strong>好友在你的作品《${escapeHtml(sourceWork)}》下留言</strong>
          <p>${escapeHtml(eventTime ? `${eventTime} 对方评论了你` : '对方评论了你')}</p>
        </div>
      </div>
      <div class="journey-timeline-item">
        <span class="journey-dot ${getReplyDotTone(comment.reply_status)}"></span>
        <div class="journey-line-copy">
          <label>生成回评</label>
          <strong>${hasReply ? '我已经准备好这条回评内容' : '我还没有产出清晰回评内容'}</strong>
          <p>${escapeHtml(hasReply ? comment.reply_text : '当前还没有可发送的回评文案')}</p>
        </div>
      </div>
      <div class="journey-timeline-item">
        <span class="journey-dot ${getReplyDotTone(comment.reply_status)}"></span>
        <div class="journey-line-copy">
          <label>回评结果</label>
          <strong>${escapeHtml(statusText)}</strong>
          <p>${escapeHtml(touchedAt ? `${touchedAt} 最近一次处理这条回评` : '这条回评还没有落地处理时间')}</p>
        </div>
      </div>
    </div>
  `;
}

function renderVisitTaskTimeline(task, sourceWork, revisitWork, sourceEvents, linkedReplies) {
  const actionText = summarizeVisitActions(sourceEvents, task.sourceTypes || [task.sourceType]) || '发现互动线索';
  const replySnapshot = linkedReplies[0] || null;
  const revisitAt = formatTime(task.updatedAt || task.createdAt || '');
  return `
    <div class="journey-timeline">
      <div class="journey-timeline-item">
        <span class="journey-dot reply"></span>
        <div class="journey-line-copy">
          <label>好友互动</label>
          <strong>好友先在你的作品《${escapeHtml(sourceWork)}》里有动作</strong>
          <p>${escapeHtml(actionText)}</p>
        </div>
      </div>
      <div class="journey-timeline-item">
        <span class="journey-dot ${replySnapshot ? 'done' : 'muted'}"></span>
        <div class="journey-line-copy">
          <label>原地回应</label>
          <strong>${replySnapshot ? '我在原作品侧回应过这位好友' : '原作品侧没有找到明确回评记录'}</strong>
          <p>${escapeHtml(replySnapshot ? `我回复过：${replySnapshot.reply_text}` : '这次回访链路里没有查到已保存的回评文本')}</p>
        </div>
      </div>
      <div class="journey-timeline-item">
        <span class="journey-dot ${getTaskStatusTone(task.status)}"></span>
        <div class="journey-line-copy">
          <label>回访落地</label>
          <strong>我去回访了作品《${escapeHtml(revisitWork)}》</strong>
          <p>${escapeHtml(`${revisitAt || '最近一次'} 处理了这条回访，${humanizeLikeStatus(task.likeStatus)}，${humanizeCommentStatus(task.commentStatus)}，任务${humanizeTaskStatus(task.status)}`)}</p>
        </div>
      </div>
    </div>
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
        <label>好友做了什么</label>
        <p>${describeSingleVisitEvent(event)}</p>
      </div>
      <div class="detail-item-block">
        <label>我的作品</label>
        <p>${escapeHtml(event.my_work_title || event.target_work_id || '暂未识别到作品')}</p>
      </div>
      <div class="detail-item-block">
        <label>互动详情</label>
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

function describeSingleVisitEvent(event) {
  if (!event) return '暂无互动';
  if (event.event_type === 'like') return '赞了你的作品';
  if (event.event_type === 'comment') return event.comment_text ? `评论了你的作品：${event.comment_text}` : '评论了你的作品';
  if (event.event_type === 'reply') return event.comment_text ? `回复了你的评论：${event.comment_text}` : '回复了你的评论';
  if (event.event_type === 'follow') return '关注了你';
  return event.comment_text || '产生了一次互动';
}

function summarizeVisitActions(events, sourceTypes = []) {
  const items = Array.isArray(events) ? events : [];
  const labels = [];
  const counts = { like: 0, comment: 0, reply: 0, follow: 0 };
  for (const event of items) {
    if (counts[event.event_type] !== undefined) counts[event.event_type] += 1;
  }
  if (counts.like) labels.push(`点赞 ${counts.like} 次`);
  if (counts.comment) labels.push(`评论 ${counts.comment} 次`);
  if (counts.reply) labels.push(`回复 ${counts.reply} 次`);
  if (counts.follow) labels.push(`关注 ${counts.follow} 次`);
  if (labels.length) return labels.join('，');
  const sourceText = (Array.isArray(sourceTypes) ? sourceTypes : [sourceTypes])
    .filter(Boolean)
    .map((type) => humanizeVisitSourceType(type))
    .join(' / ');
  return sourceText || '';
}

function humanizeVisitSourceType(type) {
  if (type === 'like') return '赞了你的作品';
  if (type === 'comment') return '评论了你的作品';
  if (type === 'reply') return '回复了你的评论';
  if (type === 'follow') return '关注了你';
  return type || '';
}

function pickLatestVisitTime(events, fallback = '') {
  const items = Array.isArray(events) ? events : [];
  const times = items
    .map((item) => item.created_at || item.event_time_text || '')
    .filter(Boolean);
  return times[0] || fallback;
}

function renderVisitSourceEvents(events) {
  if (!Array.isArray(events) || !events.length) {
    return '<p>暂未记录到源互动事件。</p>';
  }
  return events.map((event) => `
    <div class="detail-item-block subtle">
      <label>${escapeHtml(getEventBadge(event.event_type).text)} · ${escapeHtml(event.actor_name || '未知好友')}</label>
      <p>${getEventActionText(event)}</p>
      <p>${escapeHtml(event.my_work_title || event.target_work_id || '未识别作品')}${event.event_time_text ? ` · ${escapeHtml(event.event_time_text)}` : ''}</p>
    </div>
  `).join('');
}

function renderSourceEventList(events, fallbackEvent) {
  const items = Array.isArray(events) && events.length ? events : (fallbackEvent ? [fallbackEvent] : []);
  if (!items.length) {
    return '<div class="journey-event-list"><div class="journey-event-row"><span class="journey-event-type">线索</span><p>暂无源互动明细</p></div></div>';
  }
  return `
    <div class="journey-event-list">
      ${items.map((event) => `
        <div class="journey-event-row">
          <span class="journey-event-type">${escapeHtml(getEventBadge(event.event_type).text)}</span>
          <p>${getEventActionText(event)}${event.event_time_text ? ` · ${escapeHtml(event.event_time_text)}` : ''}</p>
        </div>
      `).join('')}
    </div>
  `;
}

function renderJourneyTimeline({ actorName, sourceWork, revisitWork, sourceEvents, primaryEvent, replySnapshot, task }) {
  const sourceText = summarizeVisitActions(sourceEvents, task?.sourceTypes || []) || describeSingleVisitEvent(primaryEvent) || '发现互动';
  const replyTime = formatTime(replySnapshot?.replied_at || replySnapshot?.last_seen_at || '');
  const replyText = replySnapshot?.reply_text
    ? `${replyTime ? `${replyTime} ` : ''}你回了对方一句：${replySnapshot.reply_text}`
    : '这条互动还没有形成明确回评记录';
  const visitTime = formatTime(task?.updatedAt || task?.createdAt || '');
  const visitText = task
    ? `${visitTime ? `${visitTime} ` : ''}你去回访了作品《${revisitWork}》，${humanizeLikeStatus(task.likeStatus)}，${humanizeCommentStatus(task.commentStatus)}`
    : '这条互动还没有进入回访任务';

  return `
    <div class="journey-timeline">
      <div class="journey-timeline-item">
        <span class="journey-dot reply"></span>
        <div class="journey-line-copy">
          <label>发现互动</label>
          <strong>${escapeHtml(actorName)} 在你的作品《${sourceWork}》里有互动</strong>
          <p>${escapeHtml(sourceText)}</p>
        </div>
      </div>
      <div class="journey-timeline-item">
        <span class="journey-dot ${replySnapshot?.reply_text ? 'done' : 'muted'}"></span>
        <div class="journey-line-copy">
          <label>回评处理</label>
          <strong>${replySnapshot?.reply_text ? '我已经在原作品里做过回应' : '原作品侧暂未完成清晰回应'}</strong>
          <p>${escapeHtml(replyText)}</p>
        </div>
      </div>
      <div class="journey-timeline-item">
        <span class="journey-dot ${task ? getTaskStatusTone(task.status) : 'muted'}"></span>
        <div class="journey-line-copy">
          <label>回访处理</label>
          <strong>${task ? `我回访了对方作品《${escapeHtml(revisitWork)}》` : '这条互动还没推进到回访'}</strong>
          <p>${escapeHtml(visitText)}</p>
        </div>
      </div>
    </div>
  `;
}

function renderLinkedReplies(replies) {
  if (!Array.isArray(replies) || !replies.length) {
    return '<p>暂时没有找到你回复给这位好友的记录。</p>';
  }
  return replies.map((reply) => `
    <div class="detail-item-block subtle">
      <label>${escapeHtml(reply.joined_work_title || '我的作品')} ${reply.replied_at ? `· ${formatTime(reply.replied_at)}` : ''}</label>
      <p>对方评论：${escapeHtml(reply.comment_text || '')}</p>
      <p>我的回复：${escapeHtml(reply.reply_text || '')}</p>
    </div>
  `).join('');
}

function getScanJourneyBadge(task, comments) {
  if (task?.status === 'done') return { text: '回访已完成', className: 'done' };
  if (task) {
    if (String(task.status || '').startsWith('failed')) return { text: '回访异常', className: 'danger' };
    if (String(task.status || '').startsWith('skipped')) return { text: '回访已跳过', className: 'muted' };
    return { text: '已生成回访', className: 'visit' };
  }
  if (comments.some((comment) => comment.reply_status === 'succeeded')) return { text: '已回评', className: 'done' };
  if (comments.some((comment) => ['blocked', 'sent_unverified'].includes(comment.reply_status))) return { text: '回评异常', className: 'warning' };
  if (comments.length) return { text: '待回评', className: 'reply' };
  return { text: '仅扫描到线索', className: 'muted' };
}

function formatJourneyTime(primaryEvent, task, comments) {
  const interactionAt = primaryEvent?.event_time_text || formatTime(primaryEvent?.created_at || '');
  const revisitAt = formatTime(task?.updatedAt || task?.createdAt || '');
  const replyAt = formatTime(comments[0]?.last_seen_at || comments[0]?.replied_at || '');
  const parts = [];
  if (interactionAt) parts.push(`互动 ${interactionAt}`);
  if (replyAt) parts.push(`回评 ${replyAt}`);
  if (revisitAt && task) parts.push(`回访 ${revisitAt}`);
  return parts.join(' · ');
}

function buildSourceEventTimeline(events, fallbackEvent) {
  const items = Array.isArray(events) && events.length ? events : (fallbackEvent ? [fallbackEvent] : []);
  return items
    .map((event) => `${getEventBadge(event.event_type).text}${event.event_time_text ? ` ${event.event_time_text}` : ''}`)
    .join(' / ');
}

function pickBestReplyRecord(task, comments) {
  const taskReplies = Array.isArray(task?.linkedReplies) ? task.linkedReplies.filter((item) => item.reply_text) : [];
  if (taskReplies.length) return taskReplies[0];
  return comments.find((comment) => comment.reply_text) || null;
}

function buildReplySummary(reply) {
  if (!reply) return '';
  const parts = [];
  if (reply.comment_text) parts.push(`对方说：${reply.comment_text}`);
  if (reply.reply_text) parts.push(`我回复：${reply.reply_text}`);
  return parts.join('；');
}

function buildVisitSummary(task) {
  const at = formatTime(task?.updatedAt || task?.createdAt || '');
  const work = task?.targetWork?.workTitle || task?.targetWork?.contentSummary || task?.targetWork?.workText || '未识别作品';
  return {
    title: at ? `${at} 开始处理这次回访` : '已经进入回访任务',
    meta: `回访作品：${work}`,
  };
}

function humanizeLikeStatus(status) {
  if (status === 'already_liked') return '原本已赞';
  if (status === 'liked') return '已点赞';
  if (status === 'failed') return '失败';
  return '待处理';
}

function humanizeCommentStatus(status) {
  if (status === 'posted') return '已评论';
  if (status === 'generated') return '已生成待发';
  if (status === 'failed') return '失败';
  return '待处理';
}

function humanizeTaskStatus(status) {
  if (status === 'done') return '完成';
  if (status === 'pending_execute') return '待执行';
  if (status === 'executing') return '执行中';
  if (status === 'comment_generated') return '已生成文案';
  if (status === 'content_collected') return '已收集作品';
  if (status === 'collecting_content') return '收集中';
  if (status === 'pending_visit') return '待回访';
  if (String(status || '').startsWith('failed')) return '异常';
  if (String(status || '').startsWith('skipped')) return '已跳过';
  return status || '未开始';
}

function getLikeStatusTone(status) {
  if (status === 'already_liked' || status === 'liked') return 'done';
  if (status === 'failed') return 'danger';
  return 'visit';
}

function getCommentStatusTone(status) {
  if (status === 'posted') return 'done';
  if (status === 'failed') return 'danger';
  return 'reply';
}

function getTaskStatusTone(status) {
  if (status === 'done') return 'done';
  if (String(status || '').startsWith('failed')) return 'danger';
  if (String(status || '').startsWith('skipped')) return 'muted';
  return 'visit';
}

function getReplyDotTone(status) {
  if (status === 'succeeded') return 'done';
  if (status === 'skipped') return 'muted';
  if (['blocked', 'sent_unverified'].includes(status)) return 'danger';
  return 'reply';
}

function renderEventTypeSummary(batch) {
  const parts = [];
  if (batch.totalComments) parts.push(`评论 ${batch.totalComments}`);
  if (batch.totalLikes) parts.push(`点赞 ${batch.totalLikes}`);
  if (batch.totalReplies) parts.push(`回复 ${batch.totalReplies}`);
  if (batch.totalFollows) parts.push(`关注 ${batch.totalFollows}`);
  return parts.join(' / ') || '暂无通知';
}

function summarizeReplySchedule(group) {
  const parts = [];
  if (group.pendingCount) parts.push(`待回评 ${group.pendingCount}`);
  if (group.exceptionCount) parts.push(`异常 ${group.exceptionCount}`);
  if (group.doneCount) parts.push(`成功 ${group.doneCount}`);
  if (group.skippedCount) parts.push(`忽略 ${group.skippedCount}`);
  return parts.join(' / ') || '暂无回评';
}

function buildReplyScheduleHelper(group) {
  if (group.pendingCount) return '这一批里还有待处理回评';
  if (group.exceptionCount) return '这一批里有异常回评';
  if (group.doneCount) return '这一批回评都已经成功';
  if (group.skippedCount) return '这一批已被忽略';
  return '暂无回评记录';
}

function summarizeVisitSchedule(group) {
  const parts = [];
  if (group.leadCount) parts.push(`线索 ${group.leadCount}`);
  if (group.pendingCount) parts.push(`待推进 ${group.pendingCount}`);
  if (group.doneCount) parts.push(`成功 ${group.doneCount}`);
  if (group.failedCount) parts.push(`异常 ${group.failedCount}`);
  if (group.skippedCount) parts.push(`跳过 ${group.skippedCount}`);
  return parts.join(' / ') || '暂无回访';
}

function buildVisitScheduleHelper(group) {
  if (group.pendingCount) return '这一批里还有待推进任务';
  if (group.failedCount) return '这一批里有异常任务';
  if (group.leadCount) return '这一批里还有未转任务线索';
  if (group.doneCount) return '这一批回访已经完成';
  if (group.skippedCount) return '这一批已进入跳过状态';
  return '暂无回访记录';
}

function getTimeBucketKey(value) {
  const ms = parseDateValue(value);
  if (ms) return new Date(ms).toISOString().slice(0, 19);
  return String(value || '').slice(0, 19);
}

function pickEarlierTime(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;
  return parseDateValue(candidate) < parseDateValue(current) ? candidate : current;
}

function pickLaterTime(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;
  return parseDateValue(candidate) > parseDateValue(current) ? candidate : current;
}

function formatTimeRange(start, end) {
  const startText = formatTime(start);
  const endText = formatTime(end);
  if (startText && endText) {
    return startText === endText ? startText : `${startText} - ${endText}`;
  }
  return startText || endText || '时间范围未知';
}

function formatNamedTimeRange(start, end) {
  const startText = formatTime(start);
  const endText = formatTime(end);
  if (startText && endText) return `开始 ${startText} · 结束 ${endText}`;
  if (startText) return `开始 ${startText}`;
  if (endText) return `结束 ${endText}`;
  return '开始/结束时间未知';
}

function findLatestValue(items, getter) {
  let winner = '';
  let winnerMs = 0;
  for (const item of items || []) {
    const value = getter(item);
    const ms = parseDateValue(value);
    if (ms >= winnerMs) {
      winner = value;
      winnerMs = ms;
    }
  }
  return winner;
}

function sumBy(items, key) {
  return (items || []).reduce((total, item) => total + Number(item?.[key] || 0), 0);
}

function toPercent(value, total) {
  if (!total) return '0%';
  return `${Math.round((value / total) * 100)}%`;
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
