// 文件系统工具
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * 确保目录存在（递归创建）
 * @param {string} dirPath
 */
export function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 确保目标文件的父目录存在
 * @param {string} filePath
 */
export function ensureParentDir(filePath) {
  ensureDir(dirname(filePath));
}

/**
 * 读 JSON 文件
 * @param {string} filePath
 * @returns {any}
 */
export function readJSON(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * 写 JSON 文件（自动创建目录）
 * @param {string} filePath
 * @param {any} data
 * @param {number} [space=2]
 */
export function writeJSON(filePath, data, space = 2) {
  ensureParentDir(filePath);
  writeFileSync(filePath, JSON.stringify(data, null, space), 'utf8');
}

export { existsSync as fileExists };
