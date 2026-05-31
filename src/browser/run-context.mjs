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
  commentMode: 'skill',
  selectedCommentText: null,
  replyMode: null,
  riskLevel: null,
  manualReviewMethod: null,
  observeMs: 5000,
  profileSettleMs: 6000,
  videoSettleMs: 5000,
  revisit: false,
  noRevisit: false,
  preview: false,
  aiReply: false,
  maxRevisits: 20,
  maxNotifications: 50,
  maxScrollRounds: 5,
  aiMaxComments: 10,
  aiTimeoutMs: 30000,
  replyMaxLength: 40,
  revisitLikeOnly: true,
  days: null,
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
      '--revisit': 'revisit',
      '--no-revisit': 'noRevisit',
      '--preview': 'preview',
      '--ai-reply': 'aiReply',
      '--revisit-like-only': 'revisitLikeOnly',
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

    if (arg === '--max-revisits' && i + 1 < argv.length) {
      const n = parseInt(argv[++i]);
      options.maxRevisits = isNaN(n) || n < 1 ? 20 : n;
      continue;
    }

    if (arg === '--max-notifications' && i + 1 < argv.length) {
      const n = parseInt(argv[++i]);
      options.maxNotifications = isNaN(n) || n < 1 ? DEFAULT_OPTIONS.maxNotifications : n;
      continue;
    }

    if (arg === '--max-scroll-rounds' && i + 1 < argv.length) {
      const n = parseInt(argv[++i]);
      options.maxScrollRounds = isNaN(n) || n < 1 ? DEFAULT_OPTIONS.maxScrollRounds : n;
      continue;
    }

    if (arg === '--ai-max-comments' && i + 1 < argv.length) {
      const n = parseInt(argv[++i]);
      options.aiMaxComments = isNaN(n) || n < 1 ? DEFAULT_OPTIONS.aiMaxComments : n;
      continue;
    }

    if (arg === '--ai-timeout-ms' && i + 1 < argv.length) {
      const n = parseInt(argv[++i]);
      options.aiTimeoutMs = isNaN(n) || n < 1 ? DEFAULT_OPTIONS.aiTimeoutMs : n;
      continue;
    }

    if (arg === '--reply-max-length' && i + 1 < argv.length) {
      const n = parseInt(argv[++i]);
      options.replyMaxLength = isNaN(n) || n < 1 ? DEFAULT_OPTIONS.replyMaxLength : n;
      continue;
    }

    if (arg === '--days' && i + 1 < argv.length) {
      const n = parseInt(argv[++i]);
      options.days = isNaN(n) || n < 1 ? null : n;
      continue;
    }

    const stringFlags = {
      '--comment-mode': 'commentMode',
      '--selected-comment-text': 'selectedCommentText',
      '--reply-mode': 'replyMode',
      '--risk-level': 'riskLevel',
      '--manual-review-method': 'manualReviewMethod',
    };

    if (stringFlags[arg] && i + 1 < argv.length) {
      options[stringFlags[arg]] = argv[++i];
      continue;
    }

    const intFlags = {
      '--observe-ms': 'observeMs',
      '--profile-settle-ms': 'profileSettleMs',
      '--video-settle-ms': 'videoSettleMs',
    };

    if (intFlags[arg] && i + 1 < argv.length) {
      const n = parseInt(argv[++i]);
      options[intFlags[arg]] = isNaN(n) || n < 0 ? DEFAULT_OPTIONS[intFlags[arg]] : n;
      continue;
    }

    if (arg === '--safe-observe') {
      options.observeMs = 5000;
      options.profileSettleMs = 8000;
      options.videoSettleMs = 8000;
      options.keepOpen = true;
      options.maxItems = 1;
      continue;
    }

    remaining.push(arg);
  }

  // --json mode forces keep* flags to false so the command exits cleanly.
  if (options.json) {
    options.keepOpen = false;
    options.keepOpenOnError = false;
    options.pauseOnError = false;
    options.observeMs = Math.min(options.observeMs, 1000);
    options.profileSettleMs = Math.max(Math.min(options.profileSettleMs, 3000), 3000);
    options.videoSettleMs = Math.max(Math.min(options.videoSettleMs, 3000), 3000);
  }

  if (options.aiReply) {
    options.replyMode = 'ai';
  }

  return { options, remaining };
}

export function validateOptions(options, command) {
  if (options.dryRun && options.execute) {
    console.error('参数冲突：--dry-run 与 --execute 不可同时使用。');
    process.exit(1);
  }
}

export function createRunContext(command, options) {
  const ts = chinaTimestamp();
  const runId = `${ts}_${command}`;

  validateOptions(options, command);

  const outputDir = path.resolve(process.cwd(), 'data', 'runs', runId);
  ensureDir(outputDir);

  const run = {
    runId,
    command,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    options: { ...options },
    hadError: false,
    hadBlocked: false,
    outputDir,
    scanned: 0,
    planned: 0,
    executed: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    scanFailed: 0,
    parseFailed: 0,
    enriched: 0,
    browserKeptOpen: false,
    evidenceDirectories: [],
  };

  console.error(`[run] 运行 ID: ${runId}`);
  console.error(`[run] 命令: ${command}`);
  console.error(`[run] 输出目录: ${outputDir}`);
  console.error(`[run] 参数: debug=${options.debug} dry-run=${options.dryRun} execute=${options.execute} max-items=${options.maxItems}`);

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
    processed: run.processed,
    succeeded: run.succeeded,
    failed: run.failed,
    blocked: run.blocked,
    skipped: run.skipped,
    parseFailed: run.parseFailed,
    enriched: run.enriched || 0,
    browserKeptOpen: run.browserKeptOpen,
    hadError: run.hadError,
    hadBlocked: run.hadBlocked,
    evidenceDirectories: run.evidenceDirectories,
  });
  console.error(`[run] 摘要已保存: ${summaryPath}`);
}

export function resolveBrowserClose(run) {
  // --json mode must always close the browser (Agent cannot interact).
  if (run.options.json) return true;

  if (run.options.keepOpen) {
    run.browserKeptOpen = true;
    return false;
  }

  if (run.hadError || run.hadBlocked) {
    if (run.options.keepOpenOnError) {
      run.browserKeptOpen = true;
      console.error('[run] 检测到错误/阻塞，根据 --keep-open-on-error 保留浏览器。');
      return false;
    }
  }

  return true;
}
