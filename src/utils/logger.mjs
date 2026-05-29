// 日志工具 — 所有日志统一输出到 stderr，不污染 stdout JSON 输出
let currentLevel = 1; // INFO

function formatTime() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function log(level, message, ...args) {
  if (level < currentLevel) return;
  const timestamp = formatTime();
  const prefix = `[${timestamp}]`;
  console.error(prefix, message, ...args);
}

export const logger = {
  setLevel(label) {
    const map = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
    if (map[label] !== undefined) currentLevel = map[label];
  },
  debug(...args) { log(0, ...args); },
  info(...args) { log(1, ...args); },
  warn(...args) { log(2, ...args); },
  error(...args) { log(3, ...args); },
};

export default logger;
