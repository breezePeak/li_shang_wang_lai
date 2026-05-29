// 统一 CLI JSON 输出工具
// 所有由 Skill 调用的命令，启用 --json 后应使用此工具输出机器可读结果。
// 控制台日志通过 console.error 输出，不污染 stdout JSON。

/**
 * 输出成功结果到 stdout
 * @param {string} command - 命令名称
 * @param {Object} data - 业务数据
 * @param {Object} [summary={}] - 摘要信息
 * @param {Array} [warnings=[]] - 警告列表
 * @param {Object} [extra={}] - 其他字段
 */
export function printJsonResult(command, data, summary = {}, warnings = [], extra = {}) {
  const result = {
    ok: true,
    command,
    data,
    summary,
    warnings,
    ...extra,
  };
  console.log(JSON.stringify(result, null, 2));
}

/**
 * 输出错误结果到 stderr
 * @param {string} command - 命令名称
 * @param {string} code - 错误码（来自 RESULT_CODES）
 * @param {string} message - 错误描述
 * @param {Object} [options] - 可选字段
 * @param {boolean} [options.recoverable=true] - 是否可重试
 * @param {*} [options.data=null] - 额外数据
 * @param {*} [options.evidence=null] - 证据路径
 */
export function printJsonError(command, code, message, { recoverable = true, data = null, evidence = null } = {}) {
  const result = {
    ok: false,
    command,
    code,
    message,
    recoverable,
    evidence,
    ...(data ? { data } : {}),
  };
  console.error(JSON.stringify(result, null, 2));
}
