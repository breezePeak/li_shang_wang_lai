// 日志工具

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
let currentLevel = LEVELS.INFO;

function formatTime() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * @param {string} level
 * @param {string} message
 * @param  {...any} args
 */
function log(level, message, ...args) {
  if (LEVELS[level] < currentLevel) return;
  const timestamp = formatTime();
  const prefix = `[${timestamp}] [${level}]`;
  console.log(prefix, message, ...args);
}

export const logger = {
  setLevel(level) {
    if (LEVELS[level] !== undefined) currentLevel = LEVELS[level];
  },

  debug(...args) { log('DEBUG', ...args); },
  info(...args) { log('INFO', ...args); },
  warn(...args) { log('WARN', ...args); },
  error(...args) { log('ERROR', ...args); },
};

export default logger;
