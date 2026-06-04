import { describe, it, expect } from 'vitest';
import { normalizeCommentListItem } from '../../src/domain/comment-list-normalization.mjs';
import { getNoticeCommentText } from '../../src/domain/notice-api-normalization.mjs';

describe('comment list api normalization', () => {
  it('normalizes plain text comment', () => {
    const raw = {
      cid: '7647304443654013738',
      text: '[赞][赞][赞]',
      aweme_id: '7647191897097693115',
      create_time: 1780526817,
      user: {
        uid: '97695027456',
        nickname: '张张张🍓',
        sec_uid: 'MS4wLjABAAAAzdkzZ5lQDmblBJGikB011zDYkNBqphgXxf_b4XOT4Pc',
        follow_status: 2,
        follower_status: 1,
      },
      label_text: '互相关注',
      content_type: 1,
    };

    const result = normalizeCommentListItem(raw);
    expect(result.commentId).toBe('7647304443654013738');
    expect(result.cid).toBe('7647304443654013738');
    expect(result.commentText).toBe('[赞][赞][赞]');
    expect(result.rawText).toBe('[赞][赞][赞]');
    expect(result.actorName).toBe('张张张🍓');
    expect(result.relation).toBe('mutual');
    expect(result.actorProfileKey).toBe('MS4wLjABAAAAzdkzZ5lQDmblBJGikB011zDYkNBqphgXxf_b4XOT4Pc');
    expect(result.actorProfileUrl).toBe('https://www.douyin.com/user/MS4wLjABAAAAzdkzZ5lQDmblBJGikB011zDYkNBqphgXxf_b4XOT4Pc');
    expect(result.contentType).toBe(1);
    expect(result.diggCount).toBe(0);
    expect(result.replyCommentTotal).toBe(0);
    expect(result.userDigged).toBe(0);
    expect(result.isAuthorDigged).toBe(false);
    expect(result.labelText).toBe('互相关注');
    expect(result.ipLabel).toBe('');
    expect(result.rawCommentJson).toBeTruthy();
  });

  it('normalizes sticker comment', () => {
    const raw = {
      cid: '7647314294875112250',
      text: '',
      aweme_id: '7647191897097693115',
      sticker: { id: 136703782 },
      content_type: 2,
      user: {
        uid: '103159971132',
        nickname: '手机壁纸（关，赞必回）',
        sec_uid: 'MS4wLjABAAAA8zLnd83qnR673-i48Tw_43UtzjJk_E7VQ1h1CpHVO8s',
      },
      label_text: '互相关注',
    };

    const result = normalizeCommentListItem(raw);
    expect(result.commentId).toBe('7647314294875112250');
    expect(result.commentText).toBe('[表情]');
    expect(result.contentType).toBe(2);
    expect(result.relation).toBe('mutual');
    expect(result.actorName).toBe('手机壁纸（关，赞必回）');
  });

  it('normalizes sticker comment in notice api text', () => {
    const raw = {
      text: '',
      sticker: { id: 136703782 },
    };
    expect(getNoticeCommentText(raw)).toBe('[表情]');
  });

  it('normalizes image comment', () => {
    const raw = {
      cid: 'img-1',
      text: '',
      image_list: [{ url: 'http://example.com/img.png' }],
      content_type: 3,
      user: {
        uid: 'u1',
        nickname: '图片用户',
        sec_uid: 'sec-img',
      },
    };

    const result = normalizeCommentListItem(raw);
    expect(result.commentText).toBe('[图片]');
    expect(result.actorName).toBe('图片用户');
  });

  it('normalizes video comment', () => {
    const raw = {
      cid: 'vid-1',
      text: '',
      video_list: [{ url: 'http://example.com/vid.mp4' }],
      user: {
        uid: 'u2',
        nickname: '视频用户',
        sec_uid: 'sec-vid',
      },
    };

    const result = normalizeCommentListItem(raw);
    expect(result.commentText).toBe('[视频]');
  });

  it('returns empty text when no text/sticker/image/video', () => {
    const raw = {
      cid: 'empty-1',
      text: '',
      user: {
        uid: 'u3',
        nickname: '无语',
      },
    };

    const result = normalizeCommentListItem(raw);
    expect(result.commentText).toBe('');
  });

  it('handles missing user gracefully', () => {
    const raw = {
      cid: 'no-user',
      text: '匿名评论',
    };

    const result = normalizeCommentListItem(raw);
    expect(result.commentId).toBe('no-user');
    expect(result.commentText).toBe('匿名评论');
    expect(result.actorName).toBe('');
    expect(result.actorProfileUrl).toBe('');
  });

  it('handles follow/follower status and digg fields', () => {
    const raw = {
      cid: 'digg-1',
      text: '点赞测试',
      user: {
        uid: 'u-digg',
        nickname: '点赞用户',
        sec_uid: 'sec-digg',
        follow_status: 1,
        follower_status: 2,
      },
      digg_count: 5,
      reply_comment_total: 3,
      user_digged: 1,
      is_author_digged: true,
      ip_label: '北京',
    };

    const result = normalizeCommentListItem(raw);
    expect(result.diggCount).toBe(5);
    expect(result.replyCommentTotal).toBe(3);
    expect(result.userDigged).toBe(1);
    expect(result.isAuthorDigged).toBe(true);
    expect(result.ipLabel).toBe('北京');
    expect(result.actorFollowStatus).toBe(1);
    expect(result.actorFollowerStatus).toBe(2);
  });

  it('uses uid as fallback for actorProfileKey when sec_uid missing', () => {
    const raw = {
      cid: 'no-sec-uid',
      text: '无sec_uid',
      user: {
        uid: 'only-uid',
        nickname: '只有uid',
      },
    };

    const result = normalizeCommentListItem(raw);
    expect(result.actorProfileKey).toBe('only-uid');
    expect(result.actorProfileUrl).toBe('');
  });
});
