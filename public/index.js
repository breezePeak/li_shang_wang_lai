// 礼尚往来驾驶舱交互逻辑

document.addEventListener('DOMContentLoaded', () => {
  // 初始化加载
  initApp();
  setupTabs();
});

// 全局状态
let statsData = {};
let reviewTasks = [];
let pendingComments = [];

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

// 2. 获取并渲染回访审核大厅
async function fetchReviewTasks() {
  try {
    const res = await fetch('/api/revisit-tasks');
    const json = await res.json();
    if (json.ok) {
      reviewTasks = json.data;
      renderReviewTasks();
    }
  } catch (err) {
    console.error('获取待审核任务失败:', err);
    showToast('获取审核任务失败，请检查服务连接', 'error');
  }
}

function renderReviewTasks() {
  const grid = document.getElementById('review-task-grid');
  const countBadge = document.getElementById('review-count');
  countBadge.textContent = reviewTasks.length;

  if (reviewTasks.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-circle-check"></i>
        <p>目前没有待审核的回访任务，全部运转正常！</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = reviewTasks.map(task => {
    // 状态样式
    let statusClass = 'badge-pending';
    let statusText = '准备中';
    if (task.status === 'pending_execute') {
      statusClass = 'badge-ready';
      statusText = '等待执行';
    } else if (task.status.startsWith('failed')) {
      statusClass = 'badge-fail';
      statusText = '执行失败';
    }

    const firstChar = task.userName ? task.userName.charAt(0) : '?';
    const commentsDraft = task.generatedComment || '';
    const workTitle = task.targetWork?.workTitle || '无标题最新作品';
    const workSummary = task.targetWork?.contentSummary || task.targetWork?.workText || '点击右下角按钮直接导航前往作品页';
    const workUrl = task.targetWork?.workUrl || '#';

    return `
      <div class="task-card" data-task-id="${task.id}">
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
}

// 批准回访
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
      refreshAll();
    } else {
      showToast(json.error || '审核操作失败', 'error');
    }
  } catch (err) {
    showToast('审核请求发送异常', 'error');
  }
}

// 跳过回访
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
      refreshAll();
    } else {
      showToast(json.error || '跳过失败', 'error');
    }
  } catch (err) {
    showToast('请求发送异常', 'error');
  }
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
