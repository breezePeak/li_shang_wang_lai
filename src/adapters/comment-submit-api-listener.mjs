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

function normalizeExpectedIds(expectedId = '') {
  const text = String(expectedId || '').trim();
  return text ? [text] : [];
}

function getRequestPostData(request) {
  if (!request || typeof request.postData !== 'function') return '';
  try {
    return String(request.postData() || '');
  } catch {
    return '';
  }
}

function getDecodedPostData(postData = '') {
  const raw = String(postData || '');
  if (!raw) return '';
  const parts = [raw];
  try {
    const params = new URLSearchParams(raw);
    for (const [key, value] of params.entries()) {
      parts.push(key, value);
    }
  } catch {}
  try {
    parts.push(decodeURIComponent(raw.replace(/\+/g, ' ')));
  } catch {}
  return parts.join('\n');
}

function getDecodedUrl(url = '') {
  const raw = String(url || '');
  if (!raw) return '';
  const parts = [raw];
  try {
    const parsed = new URL(raw);
    for (const [key, value] of parsed.searchParams.entries()) {
      parts.push(key, value);
    }
  } catch {}
  try {
    parts.push(decodeURIComponent(raw.replace(/\+/g, ' ')));
  } catch {}
  return parts.join('\n');
}

function includesAnyNeedle(haystack = '', needles = []) {
  if (!needles.length) return true;
  const text = String(haystack || '');
  return needles.some((needle) => needle && text.includes(needle));
}

function getResponseTargetIds(json = {}) {
  return [
    json?.comment?.reply_id,
    json?.comment?.reply_to_comment_id,
    json?.comment?.reply_to_reply_id,
    json?.comment?.parent_id,
    json?.comment?.reply_comment_id,
    json?.data?.reply_id,
    json?.data?.reply_to_comment_id,
    json?.data?.reply_to_reply_id,
    json?.data?.parent_id,
    json?.data?.reply_comment_id,
  ].map(value => String(value || '').trim()).filter(Boolean);
}

function getResponseWorkIds(json = {}) {
  return [
    json?.aweme_id,
    json?.item_id,
    json?.group_id,
    json?.comment?.aweme_id,
    json?.comment?.item_id,
    json?.comment?.group_id,
    json?.data?.aweme_id,
    json?.data?.item_id,
    json?.data?.group_id,
  ].map(value => String(value || '').trim()).filter(Boolean);
}

export function createCommentSubmitApiWatcher(page, { expectedText = '', expectedTargetCommentId = '', expectedAwemeId = '' } = {}) {
  const expectedNeedles = normalizeExpectedText(expectedText);
  const expectedTargetIds = normalizeExpectedIds(expectedTargetCommentId);
  const expectedWorkIds = normalizeExpectedIds(expectedAwemeId);
  const state = {
    success: null,
    requestCount: 0,
    responseCount: 0,
    non200Count: 0,
    parseFailed: 0,
    successWithoutCommentId: 0,
    textMismatchCount: 0,
    targetMismatchCount: 0,
    workMismatchCount: 0,
    lastUrl: '',
    lastStatus: 0,
    lastMatchedBy: '',
    lastPostDataPreview: '',
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

    state.requestCount += 1;
    state.lastSeenAt = Date.now();
    state.lastUrl = url;

    const status = typeof response?.status === 'function' ? Number(response.status()) : 0;
    state.lastStatus = status || 0;
    if (status && status !== 200) {
      state.non200Count += 1;
      return;
    }

    let json;
    try {
      json = await response.json();
    } catch {
      state.parseFailed += 1;
      return;
    }

    state.responseCount += 1;
    state.lastSeenAt = Date.now();
    const postData = getRequestPostData(request);
    const decodedPostData = getDecodedPostData(postData);
    const requestScope = [getDecodedUrl(url), decodedPostData].filter(Boolean).join('\n');
    const textMatched = includesAnyNeedle(requestScope, expectedNeedles);
    const responseTargetIds = getResponseTargetIds(json);
    const targetMatched = includesAnyNeedle(requestScope, expectedTargetIds)
      || expectedTargetIds.some((targetId) => responseTargetIds.includes(targetId));
    const responseWorkIds = getResponseWorkIds(json);
    const workMatched = includesAnyNeedle(requestScope, expectedWorkIds)
      || expectedWorkIds.some((workId) => responseWorkIds.includes(workId));
    const matchedParts = [
      expectedNeedles.length && textMatched ? 'text' : '',
      expectedTargetIds.length && targetMatched ? 'target_comment' : '',
      expectedWorkIds.length && workMatched ? 'work' : '',
    ].filter(Boolean);
    const matchedBy = matchedParts.length ? `request_${matchedParts.join('+')}` : 'request_scope';
    state.lastMatchedBy = matchedBy;
    state.lastPostDataPreview = postData.slice(0, 200);

    if (!textMatched) {
      state.textMismatchCount += 1;
      return;
    }

    if (!targetMatched) {
      state.targetMismatchCount += 1;
      return;
    }

    if (!workMatched) {
      state.workMismatchCount += 1;
      return;
    }

    if (!isSuccessPayload(json)) {
      const statusCode = json.status_code ?? json.statusCode ?? json.code ?? json.err_no ?? json.error_code;
      const maybeSuccess = Number(statusCode) === 0;
      if (maybeSuccess) state.successWithoutCommentId += 1;
      return;
    }

    state.success = {
      url,
      method: method || 'POST',
      status: status || 200,
      matchedBy,
      statusCode: json.status_code ?? json.statusCode ?? json.code ?? json.err_no ?? json.error_code ?? null,
      commentId: json?.comment?.cid || json?.comment?.comment_id || json?.data?.cid || json?.data?.comment_id || null,
      targetCommentId: expectedTargetIds[0] || null,
      targetWorkId: expectedWorkIds[0] || null,
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
