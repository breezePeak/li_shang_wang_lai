import { describe, it, expect } from 'vitest';
import {
  normalizeNoticeApiItem,
  normalizeRelation,
  getNoticeCreateTimeMs,
  classifyCommentNotice,
  getNoticeCommentText,
} from '../../src/domain/notice-api-normalization.mjs';

describe('notice api normalization', () => {
  // 1. 评论了你的作品
  it('classifies comment_on_my_work by interactive_biz_id 1003101', () => {
    const item = {
      type: 31,
      interactive_biz_id: 1003101,
      aweme_id: '7647191897097693115',
      comment: {
        comment_type: 1,
        forward_id: '7647191897097693115',
        parent_id: '7647191897097693115',
        comment: {
          cid: 'c1',
          text: '[赞][赞][赞]',
          aweme_id: '7647191897097693115',
          user: {
            nickname: '张张张',
            sec_uid: 'sec_xxx',
          },
        },
        aweme: {
          aweme_id: '7647191897097693115',
          desc: '测试作品',
          author: {
            nickname: '作品作者',
            sec_uid: 'author_sec_xxx',
            uid: 'author_uid_xxx',
          },
        },
        label_text: '朋友',
      },
      nid_str: 'n1',
    };

    const kind = classifyCommentNotice(item);
    expect(kind).toBe('comment_on_my_work');

    const result = normalizeNoticeApiItem(item);
    expect(result.eventType).toBe('comment');
    expect(result.notificationAction).toBe('comment_on_my_work');
    expect(result.commentText).toBe('[赞][赞][赞]');
    expect(result.commentId).toBe('c1');
    expect(result.actorName).toBe('张张张');
    expect(result.workId).toBe('7647191897097693115');
    expect(result.workUrl).toBe('https://www.douyin.com/jingxuan?modal_id=7647191897097693115');
    expect(result.authorName).toBe('作品作者');
    expect(result.authorProfileKey).toBe('author_sec_xxx');
    expect(result.authorProfileUrl).toBe('https://www.douyin.com/user/author_sec_xxx');
  });

  // 2. 回复了你的评论
  it('classifies reply_to_my_comment by interactive_biz_id 1003102', () => {
    const item = {
      type: 31,
      interactive_biz_id: 1003102,
      aweme_id: '7647249157875494307',
      comment: {
        comment_type: 2,
        forward_id: '7647249157875494307',
        parent_id: '7647315660007686961',
        reply_comment: {
          text: '[赞][赞][赞]',
        },
        comment: {
          cid: 'c2',
          text: '[玫瑰][玫瑰][玫瑰]',
          aweme_id: '7647249157875494307',
          user: {
            nickname: '橘宝鱼丸🐱🐱',
            sec_uid: 'sec_yyy',
          },
        },
        aweme: {
          aweme_id: '7647249157875494307',
          desc: '测试作品2',
        },
        label_text: '朋友',
      },
      nid_str: 'n2',
    };

    const kind = classifyCommentNotice(item);
    expect(kind).toBe('reply_to_my_comment');

    const result = normalizeNoticeApiItem(item);
    expect(result.eventType).toBe('reply');
    expect(result.notificationAction).toBe('reply_to_my_comment');
    expect(result.commentText).toBe('[玫瑰][玫瑰][玫瑰]');
    expect(result.originalCommentText).toBe('[赞][赞][赞]');
    expect(result.commentId).toBe('c2');
    expect(result.actorName).toBe('橘宝鱼丸🐱🐱');
    expect(result.workId).toBe('7647249157875494307');
  });

  // 3. reply_to_my_comment by comment_type=2 (fallback without bizId)
  it('classifies reply_to_my_comment by comment_type=2 fallback', () => {
    const item = {
      type: 31,
      aweme_id: '7647249157875494307',
      comment: {
        comment_type: 2,
        forward_id: '7647249157875494307',
        parent_id: '7647315660007686961',
        comment: {
          cid: 'c3',
          text: '谢谢',
          aweme_id: '7647249157875494307',
          user: { nickname: '测试', sec_uid: 'sec_t' },
        },
        aweme: { aweme_id: '7647249157875494307', desc: '测试' },
      },
      nid_str: 'n3',
    };

    const kind = classifyCommentNotice(item);
    expect(kind).toBe('reply_to_my_comment');

    const result = normalizeNoticeApiItem(item);
    expect(result.eventType).toBe('reply');
    expect(result.notificationAction).toBe('reply_to_my_comment');
  });

  // 4. comment_on_my_work when parent_id equals aweme_id
  it('classifies comment_on_my_work by parent_id equals aweme_id', () => {
    const item = {
      type: 31,
      aweme_id: '7647191897097693115',
      comment: {
        comment_type: 1,
        forward_id: '7647191897097693115',
        parent_id: '7647191897097693115',
        comment: {
          cid: 'c4',
          text: '你好',
          aweme_id: '7647191897097693115',
          user: { nickname: '李四', sec_uid: 'sec_l' },
        },
        aweme: { aweme_id: '7647191897097693115', desc: '测试' },
      },
      nid_str: 'n4',
    };

    const kind = classifyCommentNotice(item);
    expect(kind).toBe('comment_on_my_work');

    const result = normalizeNoticeApiItem(item);
    expect(result.eventType).toBe('comment');
    expect(result.notificationAction).toBe('comment_on_my_work');
  });

  // 5. 表情评论（文本为空、有 sticker）
  it('normalizes sticker-only comment as [表情]', () => {
    expect(getNoticeCommentText({ text: '', sticker: { id: 136703782 } })).toBe('[表情]');
    expect(getNoticeCommentText({ text: '', content_type: 2, sticker: { id: 1 } })).toBe('[表情]');

    const item = {
      type: 31,
      interactive_biz_id: 1003101,
      aweme_id: '7647191897097693115',
      comment: {
        comment_type: 1,
        forward_id: '7647191897097693115',
        parent_id: '7647191897097693115',
        comment: {
          cid: 'c5',
          text: '',
          content_type: 2,
          sticker: { id: 136703782 },
          aweme_id: '7647191897097693115',
          user: { nickname: '手机壁纸', sec_uid: 'sec_zzz' },
        },
        aweme: { aweme_id: '7647191897097693115', desc: '测试作品3' },
      },
      nid_str: 'n5',
    };

    const result = normalizeNoticeApiItem(item);
    expect(result.eventType).toBe('comment');
    expect(result.notificationAction).toBe('comment_on_my_work');
    expect(result.commentText).toBe('[表情]');
  });

  // 6. 图片评论（文本为空、有 image_list）
  it('normalizes image-only comment as [图片]', () => {
    expect(getNoticeCommentText({ text: '', image_list: [{ url: 'img.jpg' }] })).toBe('[图片]');
  });

  // 7. 视频评论（文本为空、有 video_list）
  it('normalizes video-only comment as [视频]', () => {
    expect(getNoticeCommentText({ text: '', video_list: [{ url: 'vid.mp4' }] })).toBe('[视频]');
  });

  // 8. 普通文本评论
  it('returns text comment as-is', () => {
    expect(getNoticeCommentText({ text: '你好世界' })).toBe('你好世界');
    expect(getNoticeCommentText({ text: '  hello  ' })).toBe('hello');
  });

  // 9. 点赞通知保持不变
  it('normalizes digg notice as like_received', () => {
    const item = {
      type: 41,
      interactive_biz_id: 1004100,
      aweme_id: '7647191897097693115',
      digg: {
        from_user: [{ nickname: '欢乐蛙', sec_uid: 'sec_like' }],
        aweme: { aweme_id: '7647191897097693115', desc: '测试作品' },
        label_text: '朋友',
      },
      nid_str: 'n6',
    };

    const result = normalizeNoticeApiItem(item);
    expect(result.eventType).toBe('like');
    expect(result.notificationAction).toBe('like_received');
    expect(result.actorName).toBe('欢乐蛙');
  });

  // 10. 原有基本测试（保持兼容）
  it('normalizes comment notice (legacy)', () => {
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
          user: { uid: 'u1', sec_uid: 'sec1', nickname: '张三' },
        },
        aweme: {
          aweme_id: '123456',
          desc: '作品标题',
          aweme_type: 0,
          create_time: 1700000000,
          author: { uid: 'owner1', sec_uid: 'owner-sec-1', nickname: '作者甲' },
          video: { cover: { uri: 'cover-uri', url_list: ['https://img.example.com/1.jpg'] } },
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
    expect(result.authorName).toBe('作者甲');
    expect(result.authorProfileKey).toBe('owner-sec-1');
    expect(result.authorProfileUrl).toBe('https://www.douyin.com/user/owner-sec-1');
  });

  it('normalizes digg notice (legacy)', () => {
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
        from_user: [{ uid: 'u2', nickname: '李四' }],
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

  // 11. classifyCommentNotice 兜底：无 parent_id 也归为 comment_on_my_work
  it('classifies as comment_on_my_work when no parent_id', () => {
    expect(classifyCommentNotice({
      type: 31,
      aweme_id: 'W1',
      comment: {
        comment: { cid: 'c', text: 'hi', aweme_id: 'W1', user: { nickname: 'T', sec_uid: 's' } },
        aweme: { aweme_id: 'W1', desc: 'D' },
      },
    })).toBe('comment_on_my_work');
  });
});
