import { existsSync } from 'fs';
import { printJsonError, printJsonResult } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';

function parseArgs(argv) {
  const args = { execute: false, dryRun: false, plan: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--execute') args.execute = true;
    if (argv[i] === '--dry-run') args.dryRun = true;
    if (argv[i] === '--plan' && argv[i + 1]) args.plan = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.execute) {
    printJsonError('likes:reciprocate', 'FEATURE_DISABLED',
      '真实回赞默认禁用：clickLike 暂不实现，请使用 return-visit 流程。', { recoverable: false });
    process.exitCode = 1;
    return;
  }

  if (!args.plan || !existsSync(args.plan)) {
    printJsonError('likes:reciprocate', RESULT_CODES.BLOCKED,
      `计划文件不存在：${args.plan || ''}`, { recoverable: false });
    process.exitCode = 1;
    return;
  }

  printJsonResult('likes:reciprocate', {
    mode: args.dryRun ? 'dry-run' : 'preview',
    executed: 0,
    previewOnly: true,
    executeAllowed: false,
  }, { executed: 0 });
}

main();
