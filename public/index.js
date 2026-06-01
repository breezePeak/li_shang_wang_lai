document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

let statsData = {};
let reviewTasks = [];
let pendingComments = [];
let currentViewMode = localStorage.getItem('viewMode') || 'grid';
let selectedTaskIds = new Set();
let selectedStageId = 'collect';

const STAGE_LAYOUT = [
  {
    id: 'collect',
    x: 100,
    y: 120,
    icon: 'fa-inbox',
    label: '通知入库',
    branch: { id: 'fallback', label: '回退', icon: 'fa-triangle-exclamation', color: 'orange' }
  },
  {
    id: 'tasks',
    x: 320,
    y: 65,
    icon: 'fa-seedling',
    label: '生成回访任务',
    branch: { id: 'hold', label: '暂缓', icon: 'fa-pause', color: 'orange' }
  },
  {
    id: 'review',
    x: 560,
    y: 120,
    icon: 'fa-comment-medical',
    label: '评论审核',
    branch: { id: 'risk', label: '风险', icon: 'fa-triangle-exclamation', color: 'orange' }
  },
  {
    id: 'execute',
    x: 800,
    y: 100,
    icon: 'fa-bolt',
    label: '执行互动',
    branch: { id: 'retry', label: '失败', icon: 'fa-circle-xmark', color: 'red' }
  },
  {
    id: 'done',
    x: 1040,
    y: 85,
    icon: 'fa-circle-check',
    label: '完成归档',
    branch: { id: 'archive', label: '归档完成', icon: 'fa-circle-check', color: 'green' }
  }
];

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
    console.error('获取暂缓评论失败:', err);
  }
}

function renderHeroStats() {
  setText('hero-collected-total', statsData.collectedTotal || 0);
  setText('hero-total-tasks', statsData.totalTasks || 0);
  setText('hero-completed-tasks', statsData.completedTasks || 0);
}

function renderRiverTimeline() {
  const container = document.getElementById('river-nodes-container');
  if (!container) return;
  const stageMap = buildStageMap();
  const activeStageId = selectedStageId;

  container.innerHTML = STAGE_LAYOUT.map((stage) => {
    const data = stageMap[stage.id] || { count: 0, label: stage.label };
    
    // 主节点激活状态：如果当前选中的是主节点本身，或者选中的是其挂载的分支，则主节点为激活态
    const isMainActive = activeStageId === stage.id || 
                         (stage.id === 'tasks' && activeStageId === 'hold') ||
                         (stage.id === 'execute' && activeStageId === 'retry');
    
    const activeClass = isMainActive ? 'is-active' : '';
    const selectedBadgeHtml = activeStageId === stage.id ? `<span class="selected-badge">当前节点 (已选中)</span>` : '';

    // 计算分支数据
    let branchCount = 0;
    if (stage.branch.id === 'hold') {
      branchCount = statsData.pendingReplies || 0;
    } else if (stage.branch.id === 'retry') {
      branchCount = reviewTasks.filter((task) => String(task.status || '').startsWith('failed')).length;
    }

    const isBranchActive = activeStageId === stage.branch.id;
    const branchActiveClass = isBranchActive ? 'is-active' : '';

    return `
      <div class="river-node-v2 ${activeClass}" style="left:${stage.x}px; top:${stage.y}px;">
        <div class="node-meta">
          <span class="node-label">${stage.label}</span>
          <span class="node-count">${data.count} 条</span>
        </div>
        
        <button class="node-circle-btn" onclick="selectStage('${stage.id}')" title="${stage.label}">
          <div class="node-circle-ripple"></div>
          <div class="node-circle-inner">
            <i class="fa-solid ${stage.icon}"></i>
          </div>
        </button>

        ${selectedBadgeHtml}

        <div class="node-branch-capsule" onclick="selectStage('${stage.branch.id}'); event.stopPropagation();">
          <div class="branch-connector"></div>
          <div class="branch-pill ${stage.branch.color} ${branchActiveClass}">
            <i class="fa-solid ${stage.branch.icon}"></i>
            <span>${stage.branch.label} ${branchCount} 条</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function buildStageMap() {
  const failedCount = reviewTasks.filter((task) => String(task.status || '').startsWith('failed')).length;
  const processingCount = reviewTasks.filter((task) => ['pending_visit', 'collecting_content', 'content_collected', 'comment_generated'].includes(task.status)).length;
  const readyCount = reviewTasks.filter((task) => ['pending_execute', 'executing'].includes(task.status)).length;

  return {
    collect: {
      label: '通知入库',
      count: statsData.collectedTotal || 0,
      helper: `点赞 ${statsData.collectedLikes || 0} 条，评论 ${statsData.collectedComments || 0} 条，全部从这里起流。`,
      tag: '第一站',
    },
    tasks: {
      label: '生成回访任务',
      count: statsData.totalTasks || 0,
      helper: `${processingCount} 条正在挑作品、抓上下文、拼装回访任务。`,
      tag: '主河道',
    },
    review: {
      label: '评论审核',
      count: statsData.pendingComments || 0,
      helper: '这里是 AI 评论草稿和待批准任务，适合人工把关。',
      tag: '需要点击',
    },
    hold: {
      label: '暂缓回复分支',
      count: statsData.pendingReplies || 0,
      helper: '这条支流只收“先别自动回复”的评论，提醒用户单独处理。',
      tag: '提醒分支',
    },
    execute: {
      label: '执行互访',
      count: statsData.pendingLikes || 0,
      helper: `${readyCount} 条进入待执行或执行中，等待真实动作落地。`,
      tag: '动作下发',
    },
    retry: {
      label: '失败回退分支',
      count: failedCount,
      helper: '执行失败、状态不稳、动作中断的任务会在这里回流提醒。',
      tag: '风险分支',
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
  const failedTasks = reviewTasks.filter((task) => String(task.status || '').startsWith('failed'));
  const inReviewTasks = reviewTasks.filter((task) => ['pending_visit', 'collecting_content', 'content_collected', 'comment_generated'].includes(task.status));
  const readyTasks = reviewTasks.filter((task) => ['pending_execute', 'executing'].includes(task.status));

  return {
    collect: {
      kicker: '起点',
      title: '通知入库阶段',
      description: '所有礼尚往来的线索都先流进这里。这个阶段关注的是入库量、来源结构，以及系统有没有把点赞和评论正确吸进来。',
      metrics: [
        { label: '总通知', value: statsData.collectedTotal || 0 },
        { label: '点赞通知', value: statsData.collectedLikes || 0 },
        { label: '评论通知', value: statsData.collectedComments || 0 },
        { label: '回访转化任务', value: statsData.totalTasks || 0 },
      ],
      branches: [
        buildBranchCard('回访任务生成', `${statsData.totalTasks || 0} 条任务已由通知沉淀而来。`, statsData.totalTasks || 0),
        buildBranchCard('暂缓回复', `${statsData.pendingReplies || 0} 条评论被引向人工判断分支。`, statsData.pendingReplies || 0),
      ],
      workspaceTitle: '通知源概览',
      workspaceSubtitle: '这里先展示流程说明，真正可操作的内容在后续阶段。',
      workspaceType: 'overview',
      workspaceContent: renderOverviewContent([
        ['主输入', `当前共入库 ${statsData.collectedTotal || 0} 条通知，其中点赞 ${statsData.collectedLikes || 0}，评论 ${statsData.collectedComments || 0}。`],
        ['关键判断', '如果这一站异常，后面的任务、审核、执行全部会缺料。'],
        ['建议关注', '先看通知采集量是否突然下降，再看后续任务是否同步增长。'],
      ]),
    },
    tasks: {
      kicker: '主河道',
      title: '回访任务生成阶段',
      description: '系统正在根据互动用户主页和作品上下文，筛出可回访作品，并准备后续评论草稿。',
      metrics: [
        { label: '总任务', value: statsData.totalTasks || 0 },
        { label: '处理中', value: inReviewTasks.length },
        { label: '待执行', value: readyTasks.length },
        { label: '失败回退', value: failedTasks.length },
      ],
      branches: [
        buildBranchCard('没有可回访作品', '如果主页抓不到作品，任务会在这里提前断流。', reviewTasks.filter(task => task.status === 'pending_visit').length),
        buildBranchCard('失败回退', '挑作品或抓内容失败时，会回流到失败分支。', failedTasks.length),
      ],
      workspaceTitle: '任务生成中的条目',
      workspaceSubtitle: '这里展示还在收集内容或等待生成评论的任务。',
      workspaceType: 'tasks',
      taskSource: 'processing',
    },
    review: {
      kicker: '人工审核',
      title: '评论审核阶段',
      description: '这是主驾驶区。你点击这个节点时，下方只保留需要人工看一眼的回访任务，并允许你直接批准或跳过。',
      metrics: [
        { label: '待审核评论', value: statsData.pendingComments || 0 },
        { label: '审核中任务', value: inReviewTasks.length },
        { label: '批量选择', value: selectedTaskIds.size },
        { label: '失败任务', value: failedTasks.length },
      ],
      branches: [
        buildBranchCard('暂缓回复评论', '有些评论不该直接回，应该分流到提醒支线。', statsData.pendingReplies || 0),
        buildBranchCard('失败回退', '如果评论草稿不稳定或上下文不足，会流去失败分支。', failedTasks.length),
      ],
      workspaceTitle: '需要人工审核的回访任务',
      workspaceSubtitle: '批准后进入待执行；跳过则在主河道止损。',
      workspaceType: 'tasks',
      taskSource: 'review',
    },
    hold: {
      kicker: '提醒分支',
      title: '暂缓回复评论分支',
      description: '这不是回访动作，而是需要提醒用户的旁路。这里专门承接自动规则暂缓下来的评论，让你单独决定回不回。',
      metrics: [
        { label: '暂缓评论', value: statsData.pendingReplies || 0 },
        { label: '待人工确认', value: pendingComments.length },
        { label: '主线任务', value: statsData.totalTasks || 0 },
        { label: '已完成回访', value: statsData.completedTasks || 0 },
      ],
      branches: [
        buildBranchCard('人工回复', '确定回复后，评论会重新汇入回复队列。', pendingComments.length),
        buildBranchCard('忽略离开', '不合适的评论可以在这里直接掐断。', pendingComments.length),
      ],
      workspaceTitle: '暂缓评论列表',
      workspaceSubtitle: '这里是支流，不进入回访审批卡片。',
      workspaceType: 'pending-comments',
    },
    execute: {
      kicker: '动作阶段',
      title: '执行互访阶段',
      description: '任务已经完成作品选择和评论审核，等待真实执行点赞与评论。这里适合看即将落地的动作量。',
      metrics: [
        { label: '待回访作品', value: statsData.pendingLikes || 0 },
        { label: '待执行任务', value: readyTasks.length },
        { label: '已完成任务', value: statsData.completedTasks || 0 },
        { label: '失败回退', value: failedTasks.length },
      ],
      branches: [
        buildBranchCard('失败回退', '动作失败会直接从这里冲出分支，提醒你重新介入。', failedTasks.length),
      ],
      workspaceTitle: '已准备好执行的任务',
      workspaceSubtitle: '这些任务已经通过审核，只差真实执行。',
      workspaceType: 'tasks',
      taskSource: 'ready',
    },
    retry: {
      kicker: '风险分支',
      title: '失败回退分支',
      description: '这条分支承接所有执行失败、状态确认失败、评论发送异常的任务。你可以把它看成河道边的告警堤坝。',
      metrics: [
        { label: '失败任务', value: failedTasks.length },
        { label: '点赞失败', value: reviewTasks.filter(task => task.status === 'failed_like').length },
        { label: '评论失败', value: reviewTasks.filter(task => task.status === 'failed_comment').length },
        { label: '待重新介入', value: failedTasks.length },
      ],
      branches: [
        buildBranchCard('重新审核', '失败任务通常需要回到审核视角重新看一遍评论和作品上下文。', failedTasks.length),
      ],
      workspaceTitle: '失败与回退任务',
      workspaceSubtitle: '这里不显示正常流程，只显示需要救火的任务。',
      workspaceType: 'tasks',
      taskSource: 'failed',
    },
    done: {
      kicker: '终点',
      title: '完成归档阶段',
      description: '所有点赞和评论都落地后，任务会汇入这里。这个节点更多是让你看闭环效率，而不是做人工操作。',
      metrics: [
        { label: '已完成', value: statsData.completedTasks || 0 },
        { label: '总任务', value: statsData.totalTasks || 0 },
        { label: '完成率', value: calcCompletionRate() },
        { label: '仍在流动', value: Math.max((statsData.totalTasks || 0) - (statsData.completedTasks || 0), 0) },
      ],
      branches: [
        buildBranchCard('继续扩流', '想提升完成率，就回去看审核和执行节点的堵点。', Math.max((statsData.totalTasks || 0) - (statsData.completedTasks || 0), 0)),
      ],
      workspaceTitle: '完成阶段说明',
      workspaceSubtitle: '这里展示闭环结果和效率，不展示待处理卡片。',
      workspaceType: 'overview',
      workspaceContent: renderOverviewContent([
        ['闭环结果', `当前已完成 ${statsData.completedTasks || 0} 条，总任务 ${statsData.totalTasks || 0} 条。`],
        ['完成率', `${calcCompletionRate()} 的任务已经走完全链路。`],
        ['下一步', '如果完成率低，优先点失败回退分支，再看审核节点。'],
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
  branchesEl.innerHTML = detailData.branches.map((branch) => `
    <article class="branch-card">
      <h5><i class="fa-solid fa-code-branch"></i>${branch.title}</h5>
      <p>${branch.description}</p>
      <strong><i class="fa-solid fa-bell"></i> 当前涉及 ${branch.count} 条</strong>
    </article>
  `).join('');

  renderStageWorkspace();
}

function renderStageWorkspace() {
  const detailData = buildStageDetailData()[selectedStageId];
  const workspace = document.getElementById('workspace-body');
  const toolbar = document.getElementById('workspace-actions');
  const filteredTasks = getFilteredTasksByStage(detailData.taskSource);

  if (detailData.workspaceType === 'pending-comments') {
    toolbar.style.display = 'none';
    workspace.className = 'workspace-body';
    workspace.innerHTML = renderPendingCommentsHtml();
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

function getFilteredTasksByStage(taskSource) {
  let tasks = reviewTasks.slice();
  if (taskSource === 'processing') {
    tasks = tasks.filter((task) => ['pending_visit', 'collecting_content', 'content_collected', 'comment_generated'].includes(task.status));
  } else if (taskSource === 'review') {
    tasks = tasks.filter((task) => ['pending_visit', 'collecting_content', 'content_collected', 'comment_generated'].includes(task.status));
  } else if (taskSource === 'ready') {
    tasks = tasks.filter((task) => ['pending_execute', 'executing'].includes(task.status));
  } else if (taskSource === 'failed') {
    tasks = tasks.filter((task) => String(task.status || '').startsWith('failed'));
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
          <button class="btn btn-primary" onclick="approveTask(${task.id})"><i class="fa-solid fa-circle-check"></i>批准</button>
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
                    <button class="btn-mini btn-mini-primary" onclick="approveTask(${task.id})"><i class="fa-solid fa-check"></i></button>
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

function renderPendingCommentsHtml() {
  if (!pendingComments.length) {
    return renderEmptyState('fa-face-smile-beam', '当前没有暂缓评论。');
  }

  return `
    <div class="pending-list">
      ${pendingComments.map((comment) => `
        <article class="pending-card">
          <div class="pending-main">
            <div class="pending-user">
              <div class="pending-user-avatar">${escapeHtml((comment.actor_name || '?').charAt(0))}</div>
              <div>
                <h4>${escapeHtml(comment.actor_name || '未知用户')}</h4>
                <span>${escapeHtml(comment.event_time_text || '不久前')}</span>
              </div>
            </div>
            <div class="pending-text"><strong>原留言：</strong>${escapeHtml(comment.comment_text || '')}</div>
            ${comment.work_url ? `<div class="pending-work-context"><a class="work-link" target="_blank" href="${comment.work_url}">打开原作品 <i class="fa-solid fa-arrow-up-right-from-square"></i></a></div>` : ''}
          </div>
          <div class="pending-actions">
            <button class="btn btn-primary" onclick="replyComment(${comment.id})"><i class="fa-solid fa-check"></i>确定回复</button>
            <button class="btn btn-danger" onclick="ignoreComment(${comment.id})"><i class="fa-solid fa-trash-can"></i>忽略</button>
          </div>
        </article>
      `).join('')}
    </div>
  `;
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

window.selectStage = function(stageId) {
  if (stageId === 'fallback') {
    showToast('当前入库通知暂无异常回退', 'success');
    stageId = 'collect';
  } else if (stageId === 'risk') {
    showToast('当前评论审核无额外告警风险', 'success');
    stageId = 'review';
  } else if (stageId === 'archive') {
    showToast('归档已闭环完成', 'success');
    stageId = 'done';
  }

  selectedStageId = stageId;
  renderRiverTimeline();
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
  const activeForTasks = detailData.workspaceType === 'tasks';
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
      showToast(json.error || '批准失败', 'error');
      return;
    }
    selectedTaskIds.delete(id);
    showToast(json.message || '任务已批准', 'success');
    await refreshAll();
  } catch (err) {
    showToast('批准请求失败', 'error');
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
      showToast(json.error || '批量批准失败', 'error');
      return;
    }
    selectedTaskIds.clear();
    showToast(json.message || '批量批准成功', 'success');
    await refreshAll();
  } catch (err) {
    showToast('批量批准请求失败', 'error');
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

window.replyComment = async function(id) {
  try {
    const res = await fetch(`/api/pending-comments/${id}/reply`, { method: 'POST' });
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
