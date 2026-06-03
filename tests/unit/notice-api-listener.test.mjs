import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { createNoticeApiCollector } from '../../src/adapters/notice-api-listener.mjs';

function createMockPage() {
  const emitter = new EventEmitter();
  emitter.waitForTimeout = (ms) => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5)));
  return emitter;
}

describe('notice api collector', () => {
  it('collects unique notice items and meta from responses', async () => {
    const page = createMockPage();
    const collector = createNoticeApiCollector(page);

    page.emit('response', {
      url: () => 'https://www.douyin.com/aweme/v1/web/notice/?cursor=1',
      status: () => 200,
      json: async () => ({
        notice_list_v2: [{ nid_str: '1' }, { nid: 2 }],
        has_more: 1,
        max_time: 123,
        min_time: 100,
        status_code: 0,
        status_msg: 'ok',
      }),
    });

    await collector.waitForNewItems({ beforeCount: 0, timeoutMs: 50 });

    expect(collector.getItems()).toHaveLength(2);
    expect(collector.getStats().responseCount).toBe(1);
    expect(collector.getMeta().hasMore).toBe(1);

    page.emit('response', {
      url: () => 'https://www.douyin.com/aweme/v1/web/notice/?cursor=1',
      status: () => 200,
      json: async () => ({
        notice_list_v2: [{ nid_str: '1' }, { nid: 3 }],
        has_more: 0,
      }),
    });

    await page.waitForTimeout(10);
    expect(collector.getItems()).toHaveLength(2);
    collector.stop();
  });
});
