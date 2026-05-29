// 评论分类 CLI 命令
// 本地分类器，不依赖 Agent。
//
// 用法：
//   npm run comments:classify -- --text "<评论>" --json

import { classifyComment } from '../domain/comment-classifier.mjs';

function parseArgs(argv) {
  const args = { text: '', json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--text' && argv[i + 1]) args.text = argv[++i];
    if (argv[i] === '--json') args.json = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.text.trim()) {
    console.log(JSON.stringify({
      ok: false, code: 'BLOCKED', message: '缺少 --text 参数',
    }));
    process.exit(1);
  }

  const result = classifyComment(args.text);
  const output = {
    ok: true,
    command: 'comments:classify',
    data: {
      input: args.text,
      ...result,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(output));
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
}

main();
