import { getEvents } from '../db/interaction-repository.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';

export function stripUrlQuery(url) {
  if (!url) return '';
  const idx = url.indexOf('?');
  const base = idx > 0 ? url.slice(0, idx) : url;
  const hashIdx = base.indexOf('#');
  return hashIdx > 0 ? base.slice(0, hashIdx) : base;
}

export function getMergeKey(event) {
  if (event.actor_profile_key) return event.actor_profile_key;
  const url = event.actor_profile_url || '';
  const canonical = stripUrlQuery(url);
  if (canonical) return canonical;
  return event.actor_name || '';
}

function getMergeStrength(event) {
  if (event.actor_profile_key) return 'strong';
  if (event.actor_profile_url) return 'medium';
  return 'weak';
}

const RELATION_ORDER = { unknown: 0, friend: 1, mutual: 2 };
const CONFIDENCE_ORDER = { weak: 0, medium: 1, strong: 2 };

function bestRelation(a, b) {
  return (RELATION_ORDER[b] || 0) > (RELATION_ORDER[a] || 0) ? b : a;
}

export function generatePlan(events) {
  const replyCommentCandidates = [];
  const visitMap = new Map();
  const skipped = [];

  for (const event of events) {
    const relation = event.relation || 'unknown';
    const dedupConfidence = event.dedup_confidence || 'weak';
    const actorProfileUrl = event.actor_profile_url || '';
    const actorProfileKey = event.actor_profile_key || '';

    if (event.event_type === 'comment') {
      replyCommentCandidates.push({
        eventId: event.id,
        eventType: 'comment',
        actorName: event.actor_name,
        actorProfileUrl,
        actorProfileKey,
        relation,
        commentText: event.comment_text || '',
        targetWorkId: event.target_work_id || null,
        targetWorkUrl: event.target_work_url || null,
        dedupConfidence,
        replyMode: 'pending_review',
        actionType: 'reply_comment_candidate',
        requiresManualReview: dedupConfidence === 'weak',
      });
    }

    if (relation === 'friend' || relation === 'mutual') {
      if (!actorProfileUrl) {
        skipped.push({
          eventId: event.id, actorName: event.actor_name,
          eventType: event.event_type, relation,
          reason: 'no_actor_profile_url',
        });
        continue;
      }

      const mergeStrength = getMergeStrength(event);
      if (mergeStrength === 'weak') {
        skipped.push({
          eventId: event.id, actorName: event.actor_name,
          eventType: event.event_type, relation,
          reason: 'weak_identity',
        });
        continue;
      }

      const key = getMergeKey(event);
      const canonicalUrl = stripUrlQuery(actorProfileUrl);

      if (visitMap.has(key)) {
        const existing = visitMap.get(key);
        if (!existing.sourceEventTypes.includes(event.event_type)) {
          existing.sourceEventTypes.push(event.event_type);
        }
        existing.sourceEventIds.push(event.id);
        existing.sourceRelations.push(relation);
        existing.sourceDedupConfidences.push(dedupConfidence);
        existing.relation = bestRelation(existing.relation, relation);
        if ((CONFIDENCE_ORDER[dedupConfidence] || 0) > (CONFIDENCE_ORDER[existing.dedupConfidenceSummary] || 0)) {
          existing.dedupConfidenceSummary = dedupConfidence;
        }
        existing.requiresManualReview = existing.dedupConfidenceSummary === 'weak';
      } else {
        visitMap.set(key, {
          actorName: event.actor_name,
          actorProfileKey,
          actorProfileUrl,
          canonicalActorProfileUrl: canonicalUrl,
          relation,
          sourceEventIds: [event.id],
          sourceEventTypes: [event.event_type],
          sourceRelations: [relation],
          sourceDedupConfidences: [dedupConfidence],
          dedupConfidenceSummary: dedupConfidence,
          status: 'planned_preview',
          executeAllowed: false,
          requiresManualReview: dedupConfidence === 'weak',
        });
      }
    } else if (event.event_type !== 'comment') {
      skipped.push({
        eventId: event.id, actorName: event.actor_name,
        eventType: event.event_type, relation,
        reason: 'non_friend_non_mutual',
      });
    }
  }

  const visitWorkCandidates = Array.from(visitMap.values());

  return {
    replyCommentCandidates,
    visitWorkCandidates,
    skipped,
    summary: {
      totalEvents: events.length,
      replyCommentCandidates: replyCommentCandidates.length,
      visitWorkCandidates: visitWorkCandidates.length,
      skippedNonFriend: skipped.filter(s => s.reason === 'non_friend_non_mutual').length,
      skippedNoProfile: skipped.filter(s => s.reason === 'no_actor_profile_url').length,
      skippedWeakIdentity: skipped.filter(s => s.reason === 'weak_identity').length,
      weakCandidates: visitWorkCandidates.filter(v => v.requiresManualReview).length,
    },
  };
}

async function main() {
  runMigrations();

  const argv = process.argv.slice(2);
  const useJson = argv.includes('--json');
  const commitMode = argv.includes('--commit');

  if (commitMode) {
    console.error('[plan] --commit 模式暂未实现，默认以只读模式运行');
  }

  console.error('[plan] 读取待处理事件...');
  const events = getEvents({ status: 'new', limit: 200 });

  if (events.length === 0) {
    console.error('[plan] 没有待处理事件。先运行 npm run interactions:scan');
    if (useJson) {
      printJsonResult('actions:plan', {
        replyCommentCandidates: [], visitWorkCandidates: [], skipped: [],
        summary: { totalEvents: 0, replyCommentCandidates: 0, visitWorkCandidates: 0, skippedNonFriend: 0, skippedNoProfile: 0, weakCandidates: 0 },
      });
    }
    process.exit(0);
  }

  console.error(`[plan] 读取到 ${events.length} 条待处理事件`);

  const data = generatePlan(events);

  console.error(`[plan] 回复候选: ${data.replyCommentCandidates.length}, 回访候选: ${data.visitWorkCandidates.length}, 跳过: ${data.skipped.length}`);

  if (useJson) {
    printJsonResult('actions:plan', data, data.summary);
  } else {
    console.error('');
    console.error('===== 回复评论候选 =====');
    for (const c of data.replyCommentCandidates) {
      console.error(`  [${c.eventId}] ${c.actorName} [${c.relation}] ${c.dedupConfidence} "${c.commentText.slice(0, 40)}"`);
    }
    console.error('');
    console.error('===== 好友回访候选 =====');
    for (const v of data.visitWorkCandidates) {
      const sources = v.sourceEventTypes.join('/');
      const confs = v.sourceDedupConfidences.join('/');
      console.error(`  ${v.actorName} [${v.relation}] ${sources} conf:${confs} ${v.requiresManualReview ? '(需人工确认)' : ''}`);
    }
    console.error('');
    console.error('===== 跳过 =====');
    for (const s of data.skipped) {
      console.error(`  ${s.actorName} [${s.relation}] ${s.eventType} → ${s.reason}`);
    }
    console.error('');
    console.error(`总计: ${events.length} 事件 → ${data.replyCommentCandidates.length} 回复候选 + ${data.visitWorkCandidates.length} 回访候选 + ${data.skipped.length} 跳过`);
  }
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/plan-actions.mjs') || process.argv[1].endsWith('\\plan-actions.mjs')
);
if (isMain) {
  main().catch(err => {
    console.error('[plan] 错误:', err.message);
    printJsonError('actions:plan', RESULT_CODES.UNKNOWN_ERROR, err.message);
    process.exit(1);
  });
}
