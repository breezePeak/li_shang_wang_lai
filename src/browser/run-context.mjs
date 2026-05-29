import { ensureDir, writeJSON } from '../utils/filesystem.mjs';
import path from 'path';

const DEFAULT_OPTIONS = {
  debug: true,
  dryRun: true,
  execute: false,
  json: false,
  keepOpen: false,
  keepOpenOnError: true,
  pauseOnError: true,
  maxItems: 1,
};

export function chinaTimestamp() {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (type) => parts.find(p => p.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}_${get('hour')}-${get('minute')}-${get('second')}`;
}

export function parseCommonArgs(argv) {
  const options = { ...DEFAULT_OPTIONS };
  const remaining = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    const boolFlags = {
      '--debug': 'debug',
      '--dry-run': 'dryRun',
      '--execute': 'execute',
      '--json': 'json',
      '--keep-open': 'keepOpen',
      '--keep-open-on-error': 'keepOpenOnError',
      '--pause-on-error': 'pauseOnError',
    };

    if (boolFlags[arg]) {
      options[boolFlags[arg]] = true;
      if (arg === '--execute') options.dryRun = false;
      if (arg === '--dry-run') options.execute = false;
      continue;
    }

    if (arg === '--max-items' && i + 1 < argv.length) {
      const n = parseInt(argv[++i]);
      options.maxItems = isNaN(n) || n < 1 ? 1 : n;
      continue;
    }

    remaining.push(arg);
  }

  return { options, remaining };
}

export function validateOptions(options, command) {
  if (options.dryRun && options.execute) {
    console.error('参数冲突：--dry-run 与 --execute 不可同时使用。');
    process.exit(1);
  }
}

export function createRunContext(command, commonArgs) {
  const ts = chinaTimestamp();
  const runId = `${ts}_${command}`;

  validateOptions(commonArgs, command);

  const outputDir = path.resolve(process.cwd(), 'data', 'runs', runId);
  ensureDir(outputDir);

  const run = {
    runId,
    command,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    options: { ...commonArgs },
    hadError: false,
    hadBlocked: false,
    outputDir,
    scanned: 0,
    planned: 0,
    executed: 0,
    succeeded: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    parseFailed: 0,
    browserKeptOpen: false,
    evidenceDirectories: [],
  };

  console.log(`[run] 运行 ID: ${runId}`);
  console.log(`[run] 命令: ${command}`);
  console.log(`[run] 输出目录: ${outputDir}`);
  console.log(`[run] 参数: debug=${commonArgs.debug} dry-run=${commonArgs.dryRun} execute=${commonArgs.execute} max-items=${commonArgs.maxItems}`);

  return run;
}

export function saveRunSummary(run) {
  run.finishedAt = new Date().toISOString();
  const summaryPath = path.join(run.outputDir, 'summary.json');
  writeJSON(summaryPath, {
    command: run.command,
    mode: run.options.execute ? 'execute' : 'dry-run',
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    scanned: run.scanned,
    planned: run.planned,
    executed: run.executed,
    succeeded: run.succeeded,
    failed: run.failed,
    blocked: run.blocked,
    skipped: run.skipped,
    parseFailed: run.parseFailed,
    browserKeptOpen: run.browserKeptOpen,
    hadError: run.hadError,
    hadBlocked: run.hadBlocked,
    evidenceDirectories: run.evidenceDirectories,
  });
  console.log(`[run] 摘要已保存: ${summaryPath}`);
}

export function resolveBrowserClose(run) {
  if (run.options.keepOpen) {
    run.browserKeptOpen = true;
    return false;
  }

  if (run.hadError || run.hadBlocked) {
    if (run.options.keepOpenOnError) {
      run.browserKeptOpen = true;
      console.log('[run] 检测到错误/阻塞，根据 --keep-open-on-error 保留浏览器。');
      return false;
    }
  }

  return true;
}
