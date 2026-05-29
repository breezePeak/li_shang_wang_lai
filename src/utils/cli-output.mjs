// 统一 CLI JSON 输出工具
// 所有由 Skill 调用的命令，启用 --json 后应使用此工具输出机器可读结果。
//
// 规则（--json 模式）：
//   stdout: 只能有一次 JSON 输出（printJsonResult 或 printJsonError）
//   stderr: 所有调试日志、迁移信息、进度信息
//   exitCode: 成功为 0，失败为非 0

/**
 * 输出成功结果到 stdout
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
  console.log(JSON.stringify(result));
}

/**
 * 输出错误结果到 stdout（Agent 统一从 stdout 读取）
 * 同时设置 exitCode 为 1
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
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = 1;
}
