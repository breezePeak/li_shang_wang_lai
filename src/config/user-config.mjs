// 用户配置读取 — 从 config/local.json 加载并合并默认值
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULTS } from './defaults.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_CONFIG_PATH = resolve(__dirname, '../../config/local.json');

/**
 * 加载并合并用户配置
 * @returns {Object} 合并后的配置
 */
export function loadConfig() {
  let userConfig = {};

  if (existsSync(LOCAL_CONFIG_PATH)) {
    try {
      const raw = readFileSync(LOCAL_CONFIG_PATH, 'utf8');
      userConfig = JSON.parse(raw);
    } catch (err) {
      console.warn('[config] 配置文件解析失败:', LOCAL_CONFIG_PATH, err.message);
    }
  }

  // 简单浅合并（用户配置覆盖默认值）
  return {
    ...DEFAULTS,
    ...userConfig,
    self: { ...DEFAULTS.self, ...(userConfig.self || {}) },
    browser: { ...DEFAULTS.browser, ...(userConfig.browser || {}) },
    scroll: {
      ...DEFAULTS.scroll,
      ...(userConfig.scroll || {}),
      mouseMove: { ...DEFAULTS.scroll.mouseMove, ...(userConfig.scroll?.mouseMove || {}) },
      wheel: { ...DEFAULTS.scroll.wheel, ...(userConfig.scroll?.wheel || {}) },
      notificationPanel: { ...DEFAULTS.scroll.notificationPanel, ...(userConfig.scroll?.notificationPanel || {}) },
      commentArea: { ...DEFAULTS.scroll.commentArea, ...(userConfig.scroll?.commentArea || {}) },
    },
    comments: { ...DEFAULTS.comments, ...(userConfig.comments || {}) },
    likes: { ...DEFAULTS.likes, ...(userConfig.likes || {}) },
    returnVisit: { ...DEFAULTS.returnVisit, ...(userConfig.returnVisit || {}) },
    safety: { ...DEFAULTS.safety, ...(userConfig.safety || {}) },
  };
}
