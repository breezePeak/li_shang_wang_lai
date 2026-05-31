// 礼尚往来驾驶舱交互逻辑 - 工业级高通量极速审核加固
document.addEventListener('DOMContentLoaded', () => {
  // 初始化加载
  initApp();
  setupTabs();
  setupFiltersAndActions();
});

// 全局状态
let statsData = {};
let reviewTasks = [];
let pendingComments = [];
let currentViewMode = localStorage.getItem('viewMode') || 'grid';
let selectedTaskIds = new Set();

// 初始化
async function initApp() {
  await refreshAll();
  // 开启每 10 秒自动静默轮询统计
  setInterval(fetchStats, 10000);
}

// 刷新全量数据
async function refreshAll() {
  await Promise.all([
    fetchStats(),
    fetchReviewTasks(),
    fetchPendingComments()
  ]);
}

// 1. 获取并渲染大盘统计
async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const json = await res.json();
    if (json.ok) {
      statsData = json.data;
      renderStats();
    }
  } catch (err) {
    console.error('获取统计大盘失败:', err);
  }
}

function renderStats() {
  document.getElementById('stat-total-tasks').textContent = statsData.totalTasks || 0;
  document.getElementById('stat-pending-likes').textContent = statsData.pendingLikes || 0;
  document.getElementById('stat-pending-comments').textContent = statsData.pendingComments || 0;
  document.getElementById('stat-pending-replies').textContent = statsData.pendingReplies || 0;
}

// 2. 获取回访审核任务
async function fetchReviewTasks() {
  try {
    const res = await fetch('/api/revisit-tasks');
    const json = await res.json();
    if (json.ok) {
      reviewTasks = json.data;
      filterAndRenderTasks();
    }
  } catch (err) {
    console.error('获取待审核任务失败:', err);
    showToast('获取审核任务失败，请检查服务连接', 'error');
  }
}

// 2.1 多维实时过滤器逻辑
function getFilteredTasks() {
  const searchQuery = document.getElementById('search-input').value.toLowerCase().trim();
  const statusFilter = document.getElementById('filter-status').value;
  const relationFilter = document.getElementById('filter-relation').value;

  return reviewTasks.filter(task => {
    // 文本模糊搜索 (昵称、作品标题、评论推荐)
    const userName = (task.userName || '').toLowerCase();
    const workTitle = (task.targetWork?.workTitle || '').toLowerCase();
    const commentDraft = (task.generatedComment || '').toLowerCase();
    const matchSearch = !searchQuery || 
      userName.includes(searchQuery) || 
      workTitle.includes(searchQuery) || 
      commentDraft.includes(searchQuery);

    // 任务状态筛选
    let matchStatus = true;
    if (statusFilter === 'pending') {
      matchStatus = task.status !== 'pending_execute' && task.status !== 'executing' && !task.status.startsWith('failed');
    } else if (statusFilter === 'ready') {
      matchStatus = task.status === 'pending_execute' || task.status === 'executing';
    } else if (statusFilter === 'failed') {
      matchStatus = task.status.startsWith('failed');
    }

    // 关系筛选
    let matchRelation = true;
    if (relationFilter === 'follow') {
      matchRelation = task.sourceType === 'follow';
    } else if (relationFilter === 'other') {
      matchRelation = task.sourceType !== 'follow';
    }

    return matchSearch && matchStatus && matchRelation;
  });
}

// 2.2 调谐并渲染过滤器子集列表
function filterAndRenderTasks() {
  const filtered = getFilteredTasks();
  
  // 清理不再可见的被勾选 ID，防止提交不可见的行
  const filteredIds = new Set(filtered.map(t => t.id));
  selectedTaskIds = new Set([...selectedTaskIds].filter(id => filteredIds.has(id)));

  renderReviewTasks(filtered);
  updateBulkBar();
}

// 2.3 核心渲染机制
function renderReviewTasks(tasks) {
  const container = document.getElementById('review-container');
  const countBadge = document.getElementById('review-count');
  countBadge.textContent = reviewTasks.length;

  if (tasks.length === 0) {
    container.className = 'view-grid';
    container.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-circle-check"></i>
        <p>目前没有待审核的回访任务，全部运转正常！</p>
      </div>
    `;
    return;
  }

  if (currentViewMode === 'grid') {
    container.className = 'view-grid';
    container.innerHTML = tasks.map(task => {
      let statusClass = 'badge-pending';
      let statusText = '准备中';
      if (task.status === 'pending_execute' || task.status === 'executing') {
        statusClass = 'badge-ready';
        statusText = '等待执行';
      } else if (task.status.startsWith('failed')) {
        statusClass = 'badge-fail';
        statusText = '执行失败';
      }

      const firstChar = task.userName ? task.userName.charAt(0) : '?';
      const commentsDraft = task.generatedComment || '';
      const workTitle = task.targetWork?.workTitle || '无标题最新作品';
      const workSummary = task.targetWork?.contentSummary || task.targetWork?.workText || '无内容摘要';
      const workUrl = task.targetWork?.workUrl || '#';
      const isChecked = selectedTaskIds.has(task.id) ? 'checked' : '';

      return `
        <div class="task-card has-checkbox" data-task-id="${task.id}">
          <!-- 复选框 -->
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
                <h4>${task.userName}</h4>
                <span>关系: ${task.sourceType === 'follow' ? '互关' : '朋友/粉丝'}</span>
              </div>
            </div>
            <span class="task-badge ${statusClass}">${statusText}</span>
          </div>

          <div class="work-block">
            <h5><i class="fa-solid fa-video"></i> ${workTitle}</h5>
            <p>${workSummary.length > 80 ? workSummary.slice(0, 80) + '...' : workSummary}</p>
            ${workUrl !== '#' ? `<a href="${workUrl}" target="_blank" class="work-link"><i class="fa-solid fa-arrow-up-right-from-square"></i> 打开抖音作品</a>` : ''}
          </div>

          <div class="comment-input-area">
            <label><i class="fa-solid fa-wand-magic-sparkles"></i> AI 推荐评论候选</label>
            <textarea class="comment-textarea" id="textarea-${task.id}" placeholder="输入评论内容...">${commentsDraft}</textarea>
          </div>

          <div class="card-actions">
            <button class="btn btn-primary" onclick="approveTask(${task.id})">
              <i class="fa-solid fa-circle-check"></i> 批准回访
            </button>
            <button class="btn btn-secondary" onclick="skipTask(${task.id})">
              <i class="fa-solid fa-circle-xmark"></i> 跳过
            </button>
          </div>
        </div>
      `;
    }).join('');
  } else {
    // 紧凑表格视图
    container.className = 'view-table';
    const allChecked = tasks.length > 0 && tasks.every(t => selectedTaskIds.has(t.id)) ? 'checked' : '';

    let tableHtml = `
      <table class="compact-table">
        <thead>
          <tr>
            <th class="th-checkbox">
              <label class="custom-checkbox">
                <input type="checkbox" id="master-checkbox" ${allChecked} onchange="toggleSelectAll(this)">
                <span class="checkbox-checkmark"></span>
              </label>
            </th>
            <th>用户/关系</th>
            <th>最新作品</th>
            <th>AI 推荐评论 (可双击/直接在输入框内修改)</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
    `;

    tableHtml += tasks.map(task => {
      let dotClass = 'pending';
      let statusText = '准备中';
      if (task.status === 'pending_execute' || task.status === 'executing') {
        dotClass = 'ready';
        statusText = '待执行';
      } else if (task.status.startsWith('failed')) {
        dotClass = 'failed';
        statusText = '失败';
      }

      const firstChar = task.userName ? task.userName.charAt(0) : '?';
      const commentsDraft = task.generatedComment || '';
      const workTitle = task.targetWork?.workTitle || '无标题最新作品';
      const workUrl = task.targetWork?.workUrl || '#';
      const isChecked = selectedTaskIds.has(task.id) ? 'checked' : '';

      return `
        <tr data-task-id="${task.id}">
          <td class="td-checkbox">
            <label class="custom-checkbox">
              <input type="checkbox" class="task-checkbox" data-id="${task.id}" ${isChecked} onchange="toggleSelect(${task.id})">
              <span class="checkbox-checkmark"></span>
            </label>
          </td>
          <td>
            <div class="table-user-cell">
              <div class="table-avatar">${firstChar}</div>
              <div class="table-user-meta">
                <h5>${task.userName}</h5>
                <span>关系: ${task.sourceType === 'follow' ? '互关' : '朋友/粉丝'}</span>
              </div>
            </div>
          </td>
          <td>
            ${workUrl !== '#' ? `
              <a href="${workUrl}" target="_blank" class="work-link table-work-link" title="${workTitle}">
                <i class="fa-solid fa-video"></i> ${workTitle}
              </a>
            ` : `
              <span class="table-work-link" title="${workTitle}"><i class="fa-solid fa-video"></i> ${workTitle}</span>
            `}
          </td>
          <td>
            <input type="text" class="table-comment-input" id="textarea-${task.id}" value="${commentsDraft.replace(/"/g, '&quot;')}" placeholder="输入评论内容...">
          </td>
          <td>
            <div class="status-dot-wrapper" title="状态: ${task.status}">
              <span class="status-dot ${dotClass}"></span>
              <span>${statusText}</span>
            </div>
          </td>
          <td>
            <div class="table-actions">
              <button class="btn-mini btn-mini-primary" onclick="approveTask(${task.id})" title="批准回访">
                <i class="fa-solid fa-check"></i>
              </button>
              <button class="btn-mini btn-mini-secondary" onclick="skipTask(${task.id})" title="跳过">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    tableHtml += `
        </tbody>
      </table>
    `;
    container.innerHTML = tableHtml;
  }
}

// 2.4 复选逻辑的绑定与全选触发
window.toggleSelect = function(id) {
  if (selectedTaskIds.has(id)) {
    selectedTaskIds.delete(id);
  } else {
    selectedTaskIds.add(id);
  }

  // 刷新一键全选框勾选状态
  const master = document.getElementById('master-checkbox');
  if (master) {
    const filtered = getFilteredTasks();
    master.checked = filtered.length > 0 && filtered.every(t => selectedTaskIds.has(t.id));
  }

  updateBulkBar();
};

window.toggleSelectAll = function(masterCheckbox) {
  const filtered = getFilteredTasks();
  if (masterCheckbox.checked) {
    filtered.forEach(t => selectedTaskIds.add(t.id));
  } else {
    filtered.forEach(t => selectedTaskIds.delete(t.id));
  }

  // 更新当前所有 checkbox DOM 的渲染
  const checkboxes = document.querySelectorAll('.task-checkbox');
  checkboxes.forEach(cb => {
    const id = parseInt(cb.getAttribute('data-id'));
    cb.checked = selectedTaskIds.has(id);
  });

  updateBulkBar();
};

// 2.5 悬浮批量控制栏显示逻辑
function updateBulkBar() {
  const bar = document.getElementById('bulk-action-bar');
  const countEl = document.getElementById('selected-count');
  const size = selectedTaskIds.size;

  if (size > 0) {
    countEl.textContent = size;
    bar.classList.add('active');
  } else {
    bar.classList.remove('active');
  }
}

// 2.6 批准单条回访
async function approveTask(id) {
  const textarea = document.getElementById(`textarea-${id}`);
  const commentText = textarea ? textarea.value : '';

  if (!commentText.trim()) {
    showToast('评论内容不能为空', 'error');
    return;
  }

  try {
    const res = await fetch(`/api/revisit-tasks/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commentText })
    });
    const json = await res.json();
    if (json.ok) {
      showToast(json.message || '审核批准成功！', 'success');
      // 如果被批准的单项在复选集合里，移除它
      selectedTaskIds.delete(id);
      refreshAll();
    } else {
      showToast(json.error || '审核操作失败', 'error');
    }
  } catch (err) {
    showToast('审核请求发送异常', 'error');
  }
}

// 2.7 跳过单条回访
async function skipTask(id) {
  try {
    const res = await fetch(`/api/revisit-tasks/${id}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'user_manually_skipped' })
    });
    const json = await res.json();
    if (json.ok) {
      showToast('已跳过当前回访任务', 'success');
      selectedTaskIds.delete(id);
      refreshAll();
    } else {
      showToast(json.error || '跳过失败', 'error');
    }
  } catch (err) {
    showToast('请求发送异常', 'error');
  }
}

// 2.8 过滤器事件与批量操作监听绑定
function setupFiltersAndActions() {
  const searchInput = document.getElementById('search-input');
  const filterStatus = document.getElementById('filter-status');
  const filterRelation = document.getElementById('filter-relation');

  // 输入搜索或改变过滤器时重新排版
  searchInput.addEventListener('input', filterAndRenderTasks);
  filterStatus.addEventListener('change', filterAndRenderTasks);
  filterRelation.addEventListener('change', filterAndRenderTasks);

  // 视图切换按键绑定
  const btnGrid = document.getElementById('btn-view-grid');
  const btnTable = document.getElementById('btn-view-table');

  if (currentViewMode === 'table') {
    btnGrid.classList.remove('active');
    btnTable.classList.add('active');
  } else {
    btnGrid.classList.add('active');
    btnTable.classList.remove('active');
  }

  btnGrid.addEventListener('click', () => {
    if (currentViewMode === 'grid') return;
    currentViewMode = 'grid';
    localStorage.setItem('viewMode', 'grid');
    btnTable.classList.remove('active');
    btnGrid.classList.add('active');
    filterAndRenderTasks();
  });

  btnTable.addEventListener('click', () => {
    if (currentViewMode === 'table') return;
    currentViewMode = 'table';
    localStorage.setItem('viewMode', 'table');
    btnGrid.classList.remove('active');
    btnTable.classList.add('active');
    filterAndRenderTasks();
  });

  // 批量批准
  document.getElementById('btn-bulk-approve').addEventListener('click', async () => {
    if (selectedTaskIds.size === 0) return;

    const tasksToApprove = [];
    let hasEmpty = false;

    for (const id of selectedTaskIds) {
      const inputEl = document.getElementById(`textarea-${id}`);
      const text = inputEl ? inputEl.value.trim() : '';
      if (!text) {
        hasEmpty = true;
      }
      tasksToApprove.push({ id, commentText: text });
    }

    if (hasEmpty) {
      showToast('被勾选的任务中存在评论为空的项，请先输入评论！', 'error');
      return;
    }

    try {
      showToast(`正在批量批准 ${selectedTaskIds.size} 项回访任务...`, 'success');
      const res = await fetch('/api/revisit-tasks/bulk-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: tasksToApprove })
      });
      const json = await res.json();
      if (json.ok) {
        showToast(json.message || '批量批准成功！', 'success');
        selectedTaskIds.clear();
        await refreshAll();
      } else {
        showToast(json.error || '批量审批发生异常', 'error');
      }
    } catch (err) {
      showToast('网络请求异常，无法提交批量审批', 'error');
    }
  });

  // 批量跳过
  document.getElementById('btn-bulk-skip').addEventListener('click', async () => {
    if (selectedTaskIds.size === 0) return;

    try {
      showToast(`正在批量跳过 ${selectedTaskIds.size} 项回访任务...`, 'success');
      const res = await fetch('/api/revisit-tasks/bulk-skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedTaskIds) })
      });
      const json = await res.json();
      if (json.ok) {
        showToast(json.message || '批量跳过成功！', 'success');
        selectedTaskIds.clear();
        await refreshAll();
      } else {
        showToast(json.error || '批量跳过发生异常', 'error');
      }
    } catch (err) {
      showToast('网络请求异常，无法提交批量跳过', 'error');
    }
  });

  // 取消选择
  document.getElementById('btn-bulk-cancel').addEventListener('click', () => {
    selectedTaskIds.clear();
    const checkboxes = document.querySelectorAll('.task-checkbox');
    checkboxes.forEach(cb => cb.checked = false);

    const master = document.getElementById('master-checkbox');
    if (master) master.checked = false;

    updateBulkBar();
  });
}

// 3. 获取并渲染暂缓回复评论列表
async function fetchPendingComments() {
  try {
    const res = await fetch('/api/pending-comments');
    const json = await res.json();
    if (json.ok) {
      pendingComments = json.data;
      renderPendingComments();
    }
  } catch (err) {
    console.error('获取暂缓评论失败:', err);
  }
}

function renderPendingComments() {
  const list = document.getElementById('pending-comment-list');
  const countBadge = document.getElementById('pending-count');
  countBadge.textContent = pendingComments.length;

  if (pendingComments.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-face-smile-beam"></i>
        <p>目前没有被暂缓回复的好友评论，干净清爽！</p>
      </div>
    `;
    return;
  }

  list.innerHTML = pendingComments.map(comment => {
    const firstChar = comment.actor_name ? comment.actor_name.charAt(0) : '?';
    const timeText = comment.event_time_text || '不久前';
    const workUrl = comment.work_url || '#';

    return `
      <div class="pending-card" data-comment-id="${comment.id}">
        <div class="pending-main">
          <div class="pending-user">
            <div class="pending-user-avatar">${firstChar}</div>
            <div>
              <h4>${comment.actor_name}</h4>
              <span>时间: ${timeText}</span>
            </div>
          </div>
          <div class="pending-text">
            <strong>原留言：</strong>${comment.comment_text}
          </div>
          ${workUrl !== '#' ? `
            <div class="pending-work-context">
              <i class="fa-solid fa-link"></i> 作品原链: 
              <a href="${workUrl}" target="_blank" class="work-link">${workUrl.slice(0, 70)}...</a>
            </div>
          ` : ''}
        </div>
        <div class="pending-actions">
          <button class="btn btn-primary" onclick="replyComment(${comment.id})">
            <i class="fa-solid fa-check"></i> 确定回复
          </button>
          <button class="btn btn-danger" onclick="ignoreComment(${comment.id})">
            <i class="fa-solid fa-trash-can"></i> 忽略
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// 确定回复挂起评论
async function replyComment(id) {
  try {
    const res = await fetch(`/api/pending-comments/${id}/reply`, {
      method: 'POST'
    });
    const json = await res.json();
    if (json.ok) {
      showToast('已将该评论移入待回复队列！', 'success');
      refreshAll();
    } else {
      showToast(json.error || '移入待回复队列失败', 'error');
    }
  } catch (err) {
    showToast('提交操作发生网络异常', 'error');
  }
}

// 忽略挂起评论
async function ignoreComment(id) {
  try {
    const res = await fetch(`/api/pending-comments/${id}/ignore`, {
      method: 'POST'
    });
    const json = await res.json();
    if (json.ok) {
      showToast('已忽略该条留言', 'success');
      refreshAll();
    } else {
      showToast(json.error || '忽略失败', 'error');
    }
  } catch (err) {
    showToast('忽略操作网络异常', 'error');
  }
}

// 4. 全局 Toast 提示
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const icon = type === 'success' ? 'fa-solid fa-circle-check' : 'fa-solid fa-triangle-exclamation';
  
  toast.innerHTML = `
    <i class="${icon}"></i>
    <span class="toast-message">${message}</span>
  `;
  
  container.appendChild(toast);
  
  // 3秒后淡出并移除
  setTimeout(() => {
    toast.classList.add('fadeOut');
    toast.addEventListener('animationend', () => {
      toast.remove();
    });
  }, 3000);
}

// 5. 选项卡点击切换逻辑
function setupTabs() {
  const buttons = document.querySelectorAll('.tab-btn');
  const panes = document.querySelectorAll('.tab-pane');

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      
      buttons.forEach(b => b.classList.remove('active'));
      panes.forEach(p => p.classList.remove('active'));
      
      btn.classList.add('active');
      document.getElementById(tabId).classList.add('active');
    });
  });
}
