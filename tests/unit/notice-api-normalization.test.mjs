import { describe, it, expect } from 'vitest';
import {
  normalizeNoticeApiItem,
  normalizeRelation,
  getNoticeCreateTimeMs,
} from '../../src/domain/notice-api-normalization.mjs';

describe('notice api normalization', () => {
  it('normalizes comment notice', () => {
    const item = {
      type: 31,
      nid_str: 'n-1',
      create_time: 1710000000,
      aweme_id: '123456',
      comment: {
        label_text: '朋友',
        comment: {
          cid: 'c-1',
          text: '你好',
          aweme_id: '123456',
          user: {
            uid: 'u1',
            sec_uid: 'sec1',
            nickname: '张三',
          },
        },
        aweme: {
          aweme_id: '123456',
          desc: '作品标题',
          aweme_type: 0,
          create_time: 1700000000,
          video: {
            cover: {
              uri: 'cover-uri',
              url_list: ['https://img.example.com/1.jpg'],
            },
          },
        },
      },
    };

    const result = normalizeNoticeApiItem(item);
    expect(result.eventType).toBe('comment');
    expect(result.notificationAction).toBe('comment_on_my_work');
    expect(result.notificationId).toBe('n-1');
    expect(result.platformEventId).toBe('c-1');
    expect(result.actorName).toBe('张三');
    expect(result.actorProfileKey).toBe('sec1');
    expect(result.actorProfileUrl).toBe('https://www.douyin.com/user/sec1');
    expect(result.relation).toBe('friend');
    expect(result.workId).toBe('123456');
    expect(result.workUrl).toBe('https://www.douyin.com/jingxuan?modal_id=123456');
    expect(result.thumbnailKey).toBe('cover-uri');
  });

  it('normalizes digg notice', () => {
    const item = {
      type: 41,
      nid: 99,
      create_time: 1710000001,
      digg: {
        label_list: [{ text: '互相关注' }],
        real_cid: 'rc1',
        aweme: {
          aweme_id: '654321',
          desc: '被赞作品',
          images: [{ uri: 'img-uri', url_list: ['https://img.example.com/2.jpg'] }],
        },
        from_user: [{
          uid: 'u2',
          nickname: '李四',
        }],
      },
    };

    const result = normalizeNoticeApiItem(item);
    expect(result.eventType).toBe('like');
    expect(result.notificationAction).toBe('like_received');
    expect(result.notificationId).toBe('99');
    expect(result.platformEventId).toBe('99');
    expect(result.actorName).toBe('李四');
    expect(result.actorProfileKey).toBe('u2');
    expect(result.actorProfileUrl).toBe('');
    expect(result.relation).toBe('mutual');
    expect(result.workId).toBe('654321');
    expect(result.commentId).toBe('rc1');
    expect(result.thumbnailKey).toBe('img-uri');
  });

  it('returns null for unsupported notice type', () => {
    expect(normalizeNoticeApiItem({ type: 88 })).toBeNull();
  });

  it('normalizes relation and create_time helpers', () => {
    expect(normalizeRelation('互相关注')).toBe('mutual');
    expect(normalizeRelation('朋友')).toBe('friend');
    expect(normalizeRelation('')).toBe('unknown');
    expect(getNoticeCreateTimeMs({ create_time: 1710000000 })).toBe(1710000000000);
  });
});
