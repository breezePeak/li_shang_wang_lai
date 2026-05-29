// 统一 CLI 日志分流工具
// 在 --json 模式下，所有非 JSON 输出必须走 stderr。
// 此工具供所有 CLI 命令和 adapter 使用，避免直接 console.log。

/**
 * 创建 CLI 日志实例
 * @param {{ json?: boolean }} [options]
 * @returns {{ info: Function, warn: Function, error: Function, debug: Function }}
 */
export function createCliLogger({ json = false } = {}) {
  return {
    info: (...args) => json ? console.error(...args) : console.log(...args),
    warn: (...args) => console.error(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => json ? console.error(...args) : console.log(...args),
  };
}
