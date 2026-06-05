import { describe, expect, it } from 'vitest';
import {
  extractWorkIdFromUrl,
  findAwemeIndexInList,
  normalizeAwemeForVisit,
  normalizeAwemeIdForMatching,
  openProfileWorkByAwemeIdFromPostApi,
} from '../../src/services/return-visit-work-collector.mjs';

describe('return-visit work collector url normalization', () => {
  it('aweme_type=68 的图文优先生成 note 地址', () => {
    const result = normalizeAwemeForVisit({
      aweme_id: '7636032429409601465',
      aweme_type: 68,
      desc: '图文作品',
      share_url: 'https://www.douyin.com/note/7636032429409601465?previous_page=web_code_link',
    });

    expect(result.awemeId).toBe('7636032429409601465');
    expect(result.workId).toBe('7636032429409601465');
    expect(result.workUrl).toBe('https://www.douyin.com/note/7636032429409601465');
    expect(result.shareUrl).toBe('https://www.douyin.com/note/7636032429409601465');
  });

  it('普通视频优先生成 video 地址', () => {
    const result = normalizeAwemeForVisit({
      aweme_id: '7647191897097693115',
      aweme_type: 0,
      media_type: 4,
      desc: '视频作品',
    });

    expect(result.workUrl).toBe('https://www.douyin.com/video/7647191897097693115');
  });

  it('无法区分类型时回退 modal_id 地址', () => {
    const result = normalizeAwemeForVisit({
      aweme_id: '7647191897097693115',
      desc: '未知类型作品',
    });

    expect(result.workUrl).toBe('https://www.douyin.com/jingxuan?modal_id=7647191897097693115');
  });

  it('extractWorkIdFromUrl 支持从 modal_id 提取纯 awemeId', () => {
    expect(extractWorkIdFromUrl('https://www.douyin.com/jingxuan?modal_id=7647191897097693115')).toBe('7647191897097693115');
    expect(extractWorkIdFromUrl('https://www.douyin.com/video/7647191897097693115')).toBe('7647191897097693115');
    expect(extractWorkIdFromUrl('https://www.douyin.com/note/7647191897097693115')).toBe('7647191897097693115');
  });

  it('normalizeAwemeIdForMatching 兼容 video/note/modal 前缀', () => {
    expect(normalizeAwemeIdForMatching('123')).toBe('123');
    expect(normalizeAwemeIdForMatching('video-123')).toBe('123');
    expect(normalizeAwemeIdForMatching('note-123')).toBe('123');
    expect(normalizeAwemeIdForMatching('modal-123')).toBe('123');
  });

  it('findAwemeIndexInList 能从 post API aweme_list 找到目标 index', () => {
    expect(findAwemeIndexInList([
      { aweme_id: '111' },
      { aweme_id: '222' },
      { aweme_id: '333' },
    ], '222')).toBe(1);
    expect(findAwemeIndexInList([{ aweme_id: '123' }], 'video-123')).toBe(0);
  });

  it('openProfileWorkByAwemeIdFromPostApi 在卡片数量不足时失败', async () => {
    const fakePage = {
      waitForTimeout: async () => {},
      url: () => 'https://www.douyin.com/user/author-a',
    };
    const result = await openProfileWorkByAwemeIdFromPostApi(fakePage, 'https://www.douyin.com/user/author-a', '222', {
      collectorFactory: () => ({
        getAwemes: () => [{ aweme_id: '111' }, { aweme_id: '222' }],
        getStats: () => ({ responseCount: 1, awemeCount: 2 }),
        waitForAwemes: async () => true,
        stop: () => {},
      }),
      gotoProfile: async () => ({ ok: true }),
      detectPrivate: async () => false,
      listCards: async () => [{ href: 'https://www.douyin.com/video/111' }],
      clickCard: async () => ({ ok: true, href: 'https://www.douyin.com/video/111' }),
      scrollProfile: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('profile_card_index_out_of_range');
  });

  it('openProfileWorkByAwemeIdFromPostApi 在卡片 id 不匹配时失败，不误点', async () => {
    const fakePage = {
      waitForTimeout: async () => {},
      url: () => 'https://www.douyin.com/user/author-a',
    };
    let clicked = false;
    const result = await openProfileWorkByAwemeIdFromPostApi(fakePage, 'https://www.douyin.com/user/author-a', '222', {
      collectorFactory: () => ({
        getAwemes: () => [{ aweme_id: '111' }, { aweme_id: '222' }],
        getStats: () => ({ responseCount: 1, awemeCount: 2 }),
        waitForAwemes: async () => true,
        stop: () => {},
      }),
      gotoProfile: async () => ({ ok: true }),
      detectPrivate: async () => false,
      listCards: async () => [
        { href: 'https://www.douyin.com/video/111' },
        { href: 'https://www.douyin.com/video/999' },
      ],
      clickCard: async () => {
        clicked = true;
        return { ok: true };
      },
      scrollProfile: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('profile_card_id_mismatch');
    expect(clicked).toBe(false);
  });

  it('openProfileWorkByAwemeIdFromPostApi 找不到目标作品时失败', async () => {
    const fakePage = {
      waitForTimeout: async () => {},
      mouse: { wheel: async () => {} },
      url: () => 'https://www.douyin.com/user/author-a',
    };
    const result = await openProfileWorkByAwemeIdFromPostApi(fakePage, 'https://www.douyin.com/user/author-a', '222', {
      maxScrollCount: 2,
      collectorFactory: () => ({
        getAwemes: () => [{ aweme_id: '111' }],
        getStats: () => ({ responseCount: 1, awemeCount: 1 }),
        waitForAwemes: async () => false,
        stop: () => {},
      }),
      gotoProfile: async () => ({ ok: true }),
      detectPrivate: async () => false,
      listCards: async () => [{ href: 'https://www.douyin.com/video/111' }],
      clickCard: async () => ({ ok: true }),
      scrollProfile: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('target_work_not_found_in_profile_post_api');
  });
});
