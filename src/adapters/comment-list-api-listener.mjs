import { normalizeCommentListItem } from '../domain/comment-list-normalization.mjs';

/**
 * 监听浏览器 /aweme/v1/web/comment/list/ 接口响应，收集评论数据。
 * 模式与 notice-api-listener.mjs 一致：
 *   - 通过 page.on('response') 监听
 *   - url 去重
 *   - 解析 JSON
 *   - 按 cid 去重
 *   - 提供 getByCid / waitForComment / getAllComments / getStats / stop
 */
export function createCommentListApiCollector(page) {
  const commentsByCid = new Map();
  const seenResponseUrls = new Set();

  const meta = {
    responseCount: 0,
    parseFailed: 0,
    commentCount: 0,
    lastResponseAt: 0,
    cursor: null,
    hasMore: null,
    total: null,
  };

  async function onResponse(response) {
    const url = typeof response.url === 'function' ? response.url() : '';
    if (!url.includes('/aweme/v1/web/comment/list/')) return;
    if (typeof response.status === 'function' && response.status() !== 200) return;
    if (seenResponseUrls.has(url)) return;

    seenResponseUrls.add(url);

    let json;
    try {
      json = await response.json();
    } catch (err) {
      meta.parseFailed++;
      console.error(`[comment-list-api] 解析 response 失败: ${err.message}`);
      return;
    }

    const list = Array.isArray(json?.comments) ? json.comments : [];
    let added = 0;

    for (const raw of list) {
      const normalized = normalizeCommentListItem(raw);
      if (!normalized.commentId) continue;
      if (commentsByCid.has(normalized.commentId)) continue;
      commentsByCid.set(normalized.commentId, normalized);
      added++;
    }

    meta.responseCount++;
    meta.commentCount = commentsByCid.size;
    meta.lastResponseAt = Date.now();
    meta.cursor = json?.cursor ?? null;
    meta.hasMore = json?.has_more ?? null;
    meta.total = json?.total ?? null;

    console.error(
      `[comment-list-api] 捕获评论列表: response=${meta.responseCount}, added=${added}, total=${commentsByCid.size}, has_more=${meta.hasMore}, cursor=${meta.cursor}`
    );
  }

  page.on('response', onResponse);

  return {
    getAllComments() {
      return Array.from(commentsByCid.values());
    },

    getByCid(cid) {
      return commentsByCid.get(String(cid || '')) || null;
    },

    getStats() {
      return { ...meta };
    },

    async waitForComment(cid, { timeoutMs = 5000 } = {}) {
      const target = String(cid || '').trim();
      if (!target) return null;

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = commentsByCid.get(target);
        if (found) return found;
        await page.waitForTimeout(200);
      }

      return commentsByCid.get(target) || null;
    },

    stop() {
      page.off('response', onResponse);
    },
  };
}
