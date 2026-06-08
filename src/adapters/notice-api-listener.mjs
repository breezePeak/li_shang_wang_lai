export function createNoticeApiCollector(page) {
  const pendingItems = [];
  const seenResponseUrls = new Set();
  const seenNoticeIds = new Set();

  const meta = {
    hasMore: null,
    maxTime: null,
    minTime: null,
    statusCode: null,
    statusMsg: '',
    lastResponseAt: 0,
    responseCount: 0,
    parseFailed: 0,
    totalItemCount: 0,
  };

  function rememberResponseUrl(url) {
    seenResponseUrls.add(url);
    if (seenResponseUrls.size <= 500) return;
    const oldest = seenResponseUrls.values().next().value;
    seenResponseUrls.delete(oldest);
  }

  async function onResponse(response) {
    const url = typeof response.url === 'function' ? response.url() : '';
    if (!url.includes('/aweme/v1/web/notice/')) return;
    if (typeof response.status === 'function' && response.status() !== 200) return;
    if (seenResponseUrls.has(url)) return;

    rememberResponseUrl(url);

    let json;
    try {
      json = await response.json();
    } catch (err) {
      meta.parseFailed++;
      console.error(`[notice-api] 解析 response 失败: ${err.message}`);
      return;
    }

    const list = Array.isArray(json?.notice_list_v2) ? json.notice_list_v2 : [];
    let added = 0;

    for (const item of list) {
      const noticeId = item?.nid_str || String(item?.nid || '');
      if (!noticeId) continue;
      if (seenNoticeIds.has(noticeId)) continue;
      seenNoticeIds.add(noticeId);
      pendingItems.push(item);
      meta.totalItemCount++;
      added++;
    }

    meta.hasMore = json?.has_more ?? null;
    meta.maxTime = json?.max_time ?? null;
    meta.minTime = json?.min_time ?? null;
    meta.statusCode = json?.status_code ?? null;
    meta.statusMsg = json?.status_msg || '';
    meta.lastResponseAt = Date.now();
    meta.responseCount++;

    console.error(
      `[notice-api] 捕获 notice 接口: response=${meta.responseCount}, added=${added}, pending=${pendingItems.length}, total=${meta.totalItemCount}, has_more=${meta.hasMore}, max_time=${meta.maxTime}`
    );
  }

  page.on('response', onResponse);

  return {
    getItems() {
      return pendingItems.slice();
    },
    drainItems() {
      if (pendingItems.length === 0) return [];
      return pendingItems.splice(0, pendingItems.length);
    },
    getMeta() {
      return { ...meta };
    },
    getStats() {
      return {
        itemCount: pendingItems.length,
        totalItemCount: meta.totalItemCount,
        responseCount: meta.responseCount,
        parseFailed: meta.parseFailed,
        hasMore: meta.hasMore,
        maxTime: meta.maxTime,
        minTime: meta.minTime,
        statusCode: meta.statusCode,
        statusMsg: meta.statusMsg,
      };
    },
    async waitForNewItems({ beforeCount = 0, timeoutMs = 3000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pendingItems.length > beforeCount) return true;
        await page.waitForTimeout(200);
      }
      return pendingItems.length > beforeCount;
    },
    stop() {
      page.off('response', onResponse);
    },
  };
}
