import { describe, it, expect, beforeEach } from 'vitest';
import { checkWorkOwner, getSelfProfile, resetSelfProfileCache } from '../../src/adapters/work-context-page.mjs';

describe('checkWorkOwner', () => {
  beforeEach(() => {
    resetSelfProfileCache();
    delete process.env.LSWL_SELF_PROFILE_KEY;
    delete process.env.LSWL_SELF_PROFILE_URL;
    delete process.env.LSWL_SELF_NICKNAME;
  });

  it('authorProfileKey 等于 self key => isOwnWork true high', () => {
    const self = { profileKey: 'MS4wLjABAAAA_self_key', profileUrl: '', nickname: '' };
    const result = checkWorkOwner({ authorProfileKey: 'MS4wLjABAAAA_self_key', authorProfileUrl: '', authorName: '' }, self);
    expect(result.isOwnWork).toBe(true);
    expect(result.ownerCheckMethod).toBe('author_profile_key');
    expect(result.ownerCheckConfidence).toBe('high');
  });

  it('authorProfileKey 不等于 self key => isOwnWork false high', () => {
    const self = { profileKey: 'MS4wLjABAAAA_self_key', profileUrl: '', nickname: '' };
    const result = checkWorkOwner({ authorProfileKey: 'MS4wLjABAAAA_other_key', authorProfileUrl: '', authorName: '' }, self);
    expect(result.isOwnWork).toBe(false);
    expect(result.ownerCheckMethod).toBe('author_profile_key_mismatch');
    expect(result.ownerCheckConfidence).toBe('high');
  });

  it('authorProfileUrl normalize 后等于 self url => isOwnWork true high', () => {
    const self = { profileKey: '', profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAA_self_key', nickname: '' };
    const result = checkWorkOwner({
      authorProfileKey: '',
      authorProfileUrl: '//www.douyin.com/user/MS4wLjABAAAA_self_key',
      authorName: '',
    }, self);
    expect(result.isOwnWork).toBe(true);
    expect(result.ownerCheckMethod).toBe('author_profile_url');
    expect(result.ownerCheckConfidence).toBe('high');
  });

  it('authorProfileUrl 明确不同 => isOwnWork false high', () => {
    const self = { profileKey: '', profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAA_self_key', nickname: '' };
    const result = checkWorkOwner({
      authorProfileKey: '',
      authorProfileUrl: '//www.douyin.com/user/MS4wLjABAAAA_other_key',
      authorName: '',
    }, self);
    expect(result.isOwnWork).toBe(false);
    expect(result.ownerCheckMethod).toBe('author_profile_url_mismatch');
    expect(result.ownerCheckConfidence).toBe('high');
  });

  it('只有 authorName 等于 self nickname => isOwnWork true medium', () => {
    const self = { profileKey: '', profileUrl: '', nickname: '我的昵称' };
    const result = checkWorkOwner({ authorProfileKey: '', authorProfileUrl: '', authorName: '我的昵称' }, self);
    expect(result.isOwnWork).toBe(true);
    expect(result.ownerCheckMethod).toBe('author_name');
    expect(result.ownerCheckConfidence).toBe('medium');
    expect(result.warnings).toContain('owner_check_medium_confidence');
  });

  it('authorName 不等于 self nickname => isOwnWork false medium', () => {
    const self = { profileKey: '', profileUrl: '', nickname: '我的昵称' };
    const result = checkWorkOwner({ authorProfileKey: '', authorProfileUrl: '', authorName: '别人的昵称' }, self);
    expect(result.isOwnWork).toBe(false);
    expect(result.ownerCheckMethod).toBe('author_name_mismatch');
    expect(result.ownerCheckConfidence).toBe('medium');
  });

  it('无作者信息 => isOwnWork null low', () => {
    const self = { profileKey: 'some_key', profileUrl: '', nickname: '' };
    const result = checkWorkOwner({ authorProfileKey: '', authorProfileUrl: '', authorName: '' }, self);
    expect(result.isOwnWork).toBeNull();
    expect(result.ownerCheckConfidence).toBe('low');
    expect(result.warnings).toContain('owner_not_verified');
  });

  it('未配置 self 信息 => isOwnWork null low', () => {
    const self = { profileKey: '', profileUrl: '', nickname: '' };
    const result = checkWorkOwner({ authorProfileKey: 'some_key', authorProfileUrl: 'some_url', authorName: 'some_name' }, self);
    expect(result.isOwnWork).toBeNull();
    expect(result.ownerCheckMethod).toBe('unknown');
    expect(result.ownerCheckConfidence).toBe('low');
    expect(result.warnings).toContain('owner_not_verified_no_self_config');
  });

  it('isOwnWork false 时，不允许调用 sendReply（结构约束）', () => {
    const self = { profileKey: 'self_key', profileUrl: '', nickname: '' };
    const result = checkWorkOwner({ authorProfileKey: 'other_key', authorProfileUrl: '', authorName: '' }, self);
    expect(result.isOwnWork).toBe(false);
    const canAutoReply = result.isOwnWork === true;
    expect(canAutoReply).toBe(false);
  });

  it('isOwnWork null 时，不允许调用 sendReply（结构约束）', () => {
    const self = { profileKey: '', profileUrl: '', nickname: '' };
    const result = checkWorkOwner({ authorProfileKey: '', authorProfileUrl: '', authorName: '' }, self);
    expect(result.isOwnWork).toBeNull();
    const canAutoReply = result.isOwnWork === true;
    expect(canAutoReply).toBe(false);
  });

  it('profileKey 优先于 profileUrl', () => {
    const self = { profileKey: 'self_key', profileUrl: 'https://www.douyin.com/user/other_key', nickname: '' };
    const result = checkWorkOwner({ authorProfileKey: 'self_key', authorProfileUrl: '//www.douyin.com/user/other_key', authorName: '' }, self);
    expect(result.isOwnWork).toBe(true);
    expect(result.ownerCheckMethod).toBe('author_profile_key');
  });

  it('profileUrl 优先于 authorName', () => {
    const self = { profileKey: '', profileUrl: 'https://www.douyin.com/user/self_key', nickname: '不同昵称' };
    const result = checkWorkOwner({
      authorProfileKey: '',
      authorProfileUrl: '//www.douyin.com/user/self_key',
      authorName: '不同昵称',
    }, self);
    expect(result.isOwnWork).toBe(true);
    expect(result.ownerCheckMethod).toBe('author_profile_url');
  });
});

describe('getSelfProfile', () => {
  beforeEach(() => {
    resetSelfProfileCache();
    delete process.env.LSWL_SELF_PROFILE_KEY;
    delete process.env.LSWL_SELF_PROFILE_URL;
    delete process.env.LSWL_SELF_NICKNAME;
  });

  it('从环境变量读取', () => {
    process.env.LSWL_SELF_PROFILE_KEY = 'env_key';
    process.env.LSWL_SELF_PROFILE_URL = 'https://www.douyin.com/user/env_key';
    process.env.LSWL_SELF_NICKNAME = 'env_nick';
    const profile = getSelfProfile();
    expect(profile.profileKey).toBe('env_key');
    expect(profile.profileUrl).toBe('https://www.douyin.com/user/env_key');
    expect(profile.nickname).toBe('env_nick');
  });

  it('环境变量为空时返回空', () => {
    const profile = getSelfProfile();
    expect(profile.profileKey).toBe('');
    expect(profile.profileUrl).toBe('');
    expect(profile.nickname).toBe('');
  });
});