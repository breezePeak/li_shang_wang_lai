import { runMigrations } from '../db/migrations.mjs';
import { listPendingCommentsGroupedByWork, markCommentReplyPrepared, markCommentSkipped } from '../db/work-comment-repository.mjs';
import { findWorkByWorkId, findWorkByModalId } from '../db/work-repository.mjs';
import { generateReplyText } from '../domain/reply-template.mjs';
import { fileURLToPath } from 'url';

function parseArgs(argv) {
  const args = {
    maxItems: 100,
    replyMaxLength: 40,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--max-items' && i + 1 < argv.length) args.maxItems = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (arg === '--reply-max-length' && i + 1 < argv.length) args.replyMaxLength = Math.max(10, parseInt(argv[++i], 10) || 40);
  }
  return args;
}

function shouldSkipPendingComment(comment) {
  const text = (comment.comment_text || '').trim();
  const actor = (comment.actor_name || '').trim();
  if (!text) return 'empty_comment_text';
  if (text === '...' || actor === '...' || text === '作者') return 'invalid_comment_placeholder';
  return null;
}

function clampReplyText(replyText, maxLength) {
  const text = (replyText || '').trim();
  if (!maxLength || text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

function resolveWork(workKey) {
  return findWorkByWorkId(workKey) || findWorkByModalId(workKey);
}

function parseRawWorkContext(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function buildWorkText(work) {
  const raw = parseRawWorkContext(work?.raw_context_json);
  return [
    raw.workText || '',
    raw.workTitle || '',
    work?.work_title || '',
    raw.publishedAtText ? `发布时间：${raw.publishedAtText}` : '',
  ].filter(Boolean).join('\n').slice(0, 1200);
}

function buildReferenceComments(work, pendingComments) {
  const raw = parseRawWorkContext(work?.raw_context_json);
  const scanned = Array.isArray(raw.scannedComments)
    ? raw.scannedComments.map(c => typeof c === 'string' ? c : c?.commentText).filter(Boolean)
    : [];
  const pending = pendingComments.map(c => c.comment_text).filter(Boolean);
  const merged = [];
  const seen = new Set();
  for (const text of [...scanned, ...pending]) {
    const value = String(text || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    merged.push(value);
  }
  return merged.slice(0, 12);
}

function main() {
  runMigrations();
  const args = parseArgs(process.argv.slice(2));
  const pendingGroups = listPendingCommentsGroupedByWork({ limit: args.maxItems });

  let totalPending = 0;
  for (const [, comments] of pendingGroups) totalPending += comments.length;
  console.log(`[comments:prepare-replies] 待读取 pending 评论: ${totalPending} 条, 作品 ${pendingGroups.size} 个`);

  let prepared = 0;
  let skipped = 0;

  for (const [workKey, comments] of pendingGroups) {
    const work = resolveWork(workKey);
    const workTitle = work?.work_title || '';
    const workText = buildWorkText(work);
    const referenceComments = buildReferenceComments(work, comments);

    console.log(`[comments:prepare-replies] 作品 ${workKey}: title="${workTitle.slice(0, 60)}" workText=${workText.length} comments=${comments.length}`);

    for (const comment of comments) {
      const skipReason = shouldSkipPendingComment(comment);
      if (skipReason) {
        markCommentSkipped(comment.id, skipReason);
        skipped++;
        continue;
      }

      const generated = generateReplyText(comment.comment_text, {
        workTitle,
        workText,
        referenceComments: referenceComments.filter(text => text !== comment.comment_text),
      });
      const replyText = clampReplyText(generated.replyText, args.replyMaxLength);
      const reason = replyText === generated.replyText
        ? generated.reason
        : `${generated.reason};truncated_to_${args.replyMaxLength}`;

      markCommentReplyPrepared(comment.id, replyText, reason);
      console.log(`[comments:prepare-replies]   ${comment.actor_name || '(unknown)'} "${String(comment.comment_text || '').slice(0, 30)}" -> "${replyText}" (${reason})`);
      prepared++;
    }
  }

  console.log(`[comments:prepare-replies] 完成: prepared=${prepared}, skipped=${skipped}`);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main();
}
