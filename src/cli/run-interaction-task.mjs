import { runInteractionTask } from '../services/interaction-task-runner.mjs';
import { printJsonResult } from '../utils/cli-output.mjs';

function parseArgs(argv) {
  const args = {
    userInput: '',
    days: null,
    maxCount: null,
    json: false,
    execute: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input' && argv[i + 1]) args.userInput = argv[++i];
    else if (arg === '--days' && argv[i + 1]) args.days = Number(argv[++i]);
    else if ((arg === '--max-count' || arg === '--max-items') && argv[i + 1]) args.maxCount = Number(argv[++i]);
    else if (arg === '--execute') args.execute = true;
    else if (arg === '--json') args.json = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const result = runInteractionTask(args.userInput, {
  days: args.days,
  maxCount: args.maxCount,
  execute: args.execute,
});

if (args.json) {
  printJsonResult('interactions:run', result, { planned: true });
} else {
  console.log('[interactions:run] execution plan');
  console.log(JSON.stringify(result.plan, null, 2));
  for (const [name, command] of Object.entries(result.commands)) {
    if (command) console.log(`${name}: ${command}`);
  }
}
