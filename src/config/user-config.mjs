// 用户配置读取 — 从 config/local.json 加载并合并默认值
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULTS } from './defaults.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_CONFIG_PATH = resolve(__dirname, '../../config/local.json');
const EXAMPLE_CONFIG_PATH = resolve(__dirname, '../../config/example.json');

/**
 * 加载并合并用户配置
 * @returns {Object} 合并后的配置
 */
export function loadConfig() {
  let userConfig = {};

  // 优先读取 local.json，回退到 example.json
  const configPath = existsSync(LOCAL_CONFIG_PATH) ? LOCAL_CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8');
      userConfig = JSON.parse(raw);
    } catch (err) {
      console.warn('[config] 配置文件解析失败:', configPath, err.message);
    }
  }

  // 简单浅合并（用户配置覆盖默认值）
  return {
    ...DEFAULTS,
    ...userConfig,
    browser: { ...DEFAULTS.browser, ...(userConfig.browser || {}) },
    comments: { ...DEFAULTS.comments, ...(userConfig.comments || {}) },
    likes: { ...DEFAULTS.likes, ...(userConfig.likes || {}) },
    safety: { ...DEFAULTS.safety, ...(userConfig.safety || {}) },
  };
}
