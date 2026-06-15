import { describe, it, expect } from 'vitest';
import {
  resolveNotificationEventTime,
  isNotificationOutsideWindow,
  isNotificationOlderThanDays,
} from '../../src/cli/scan-interactions.mjs';

describe('scan interactions notification time window', () => {
  it('优先使用 create_time 判断是否超出天数窗口', () => {
    const nowMs = Date.UTC(2026, 5, 11, 12, 0, 0);
    const threeDaysAgoSec = Math.floor((nowMs - 3 * 86400000) / 1000);

    const result = isNotificationOlderThanDays({
      eventTimestamp: threeDaysAgoSec,
      timeText: '刚刚',
    }, 2, { nowMs });

    expect(result.older).toBe(true);
    expect(result.source).toBe('create_time');
    expect(result.detail).toBe(`create_time=${threeDaysAgoSec}`);
  });

  it('create_time 存在时不回退到文字时间', () => {
    const nowMs = Date.UTC(2026, 5, 11, 12, 0, 0);
    const oneHourAgoSec = Math.floor((nowMs - 3600000) / 1000);

    const result = resolveNotificationEventTime({
      eventTimestamp: oneHourAgoSec,
      timeText: '5天前',
    }, { nowMs });

    expect(result.source).toBe('create_time');
    expect(result.eventMs).toBe(oneHourAgoSec * 1000);
  });

  it('缺少 create_time 时不再退回到文字时间解析', () => {
    const nowMs = Date.UTC(2026, 5, 11, 12, 0, 0);

    const result = isNotificationOlderThanDays({
      timeText: '3天前',
    }, 2, { nowMs });

    expect(result.older).toBe(false);
    expect(result.source).toBe('unknown');
    expect(result.detail).toBe('缺少 create_time');
  });

  it('时间无法解析时不误判为超窗', () => {
    const nowMs = Date.UTC(2026, 5, 11, 12, 0, 0);

    const result = isNotificationOlderThanDays({
      timeText: '神秘时间',
    }, 2, { nowMs });

    expect(result.older).toBe(false);
    expect(result.source).toBe('unknown');
    expect(result.detail).toBe('缺少 create_time');
  });

  it('支持按小时窗口判断通知是否超窗', () => {
    const nowMs = Date.UTC(2026, 5, 11, 12, 0, 0);
    const threeHoursAgoSec = Math.floor((nowMs - 3 * 3600000) / 1000);

    const result = isNotificationOutsideWindow({
      eventTimestamp: threeHoursAgoSec,
      timeText: '刚刚',
    }, { hours: 2 }, { nowMs });

    expect(result.older).toBe(true);
    expect(result.outsideWindow).toBe(true);
    expect(result.source).toBe('create_time');
  });
});
