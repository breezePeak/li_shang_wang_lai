function isCommentSubmitUrl(url = '') {
  const text = String(url || '');
  return text.includes('/comment/publish');
}

function isSuccessPayload(json) {
  if (!json || typeof json !== 'object') return false;
  const statusCode = json.status_code ?? json.statusCode ?? json.code ?? json.err_no ?? json.error_code;
  const commentId = json?.comment?.cid || json?.comment?.comment_id || json?.data?.cid || json?.data?.comment_id || null;
  return Number(statusCode) === 0 && Boolean(commentId);
}

function normalizeExpectedText(expectedText = '') {
  const trimmed = String(expectedText || '').trim();
  if (!trimmed) return [];
  const prefix = trimmed.slice(0, Math.min(trimmed.length, 12));
  return Array.from(new Set([trimmed, prefix].filter(Boolean)));
}

function getRequestPostData(request) {
  if (!request || typeof request.postData !== 'function') return '';
  try {
    return String(request.postData() || '');
  } catch {
    return '';
  }
}

export function createCommentSubmitApiWatcher(page, { expectedText = '' } = {}) {
  const expectedNeedles = normalizeExpectedText(expectedText);
  const state = {
    success: null,
    responseCount: 0,
    parseFailed: 0,
    lastSeenAt: 0,
  };

  if (!page || typeof page.on !== 'function' || typeof page.off !== 'function') {
    return {
      getStats() {
        return { ...state };
      },
      async waitForSuccess() {
        return null;
      },
      stop() {},
    };
  }

  async function onResponse(response) {
    const url = typeof response?.url === 'function' ? response.url() : '';
    if (!isCommentSubmitUrl(url)) return;

    const request = typeof response?.request === 'function' ? response.request() : null;
    const method = typeof request?.method === 'function' ? String(request.method() || '').toUpperCase() : '';
    if (method && method !== 'POST') return;

    const status = typeof response?.status === 'function' ? Number(response.status()) : 0;
    if (status && status !== 200) return;

    let json;
    try {
      json = await response.json();
    } catch {
      state.parseFailed += 1;
      return;
    }

    state.responseCount += 1;
    state.lastSeenAt = Date.now();
    if (!isSuccessPayload(json)) return;

    const postData = getRequestPostData(request);
    const matchedBy = expectedNeedles.length > 0 && expectedNeedles.some((needle) => postData.includes(needle))
      ? 'request_payload'
      : 'request_scope';

    state.success = {
      url,
      method: method || 'POST',
      status: status || 200,
      matchedBy,
      statusCode: json.status_code ?? json.statusCode ?? json.code ?? json.err_no ?? json.error_code ?? null,
      commentId: json?.comment?.cid || json?.comment?.comment_id || json?.data?.cid || json?.data?.comment_id || null,
    };
  }

  page.on('response', onResponse);

  return {
    getStats() {
      return { ...state };
    },

    async waitForSuccess({ timeoutMs = 2500 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (state.success) return state.success;
        if (typeof page.waitForTimeout === 'function') {
          await page.waitForTimeout(100);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      return state.success;
    },

    stop() {
      page.off('response', onResponse);
    },
  };
}
