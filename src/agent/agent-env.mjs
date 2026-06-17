import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

export function parseSimpleEnv(content = '') {
  const values = {};
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

export function resolveHermesEnvPaths(env = process.env) {
  const paths = [];
  const localAppData = String(env?.LOCALAPPDATA || '').trim();
  const userProfile = String(env?.USERPROFILE || '').trim();
  const home = String(env?.HOME || (env === process.env ? homedir() : '') || '').trim();

  if (localAppData) paths.push(join(localAppData, 'hermes', '.env'));
  if (userProfile) paths.push(join(userProfile, '.hermes', '.env'));
  if (home) paths.push(join(home, '.hermes', '.env'));

  return [...new Set(paths.map(filePath => resolve(filePath)))];
}

export function readFirstExistingEnvFile(paths = []) {
  for (const filePath of Array.isArray(paths) ? paths : []) {
    const normalizedPath = String(filePath || '').trim();
    if (!normalizedPath || !existsSync(normalizedPath)) continue;
    try {
      return {
        path: normalizedPath,
        config: parseSimpleEnv(readFileSync(normalizedPath, 'utf8')),
      };
    } catch {}
  }
  return { path: '', config: {} };
}

export function readHermesEnvConfig(env = process.env, options = {}) {
  const paths = Array.isArray(options.paths) && options.paths.length > 0
    ? options.paths
    : resolveHermesEnvPaths(env);
  return readFirstExistingEnvFile(paths).config;
}

export function mergeAgentEnv(env = process.env, options = {}) {
  return {
    ...readHermesEnvConfig(env, options),
    ...env,
  };
}
