import { getEvents, updateEventStatus } from '../db/interaction-repository.mjs';
import { runMigrations } from '../db/migrations.mjs';
import { printJsonResult, printJsonError } from '../utils/cli-output.mjs';
import { RESULT_CODES } from '../domain/result-codes.mjs';

async function main() {
  runMigrations();

  const argv = process.argv.slice(2);
  const useJson = argv.includes('--json');

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

  const replyCommentCandidates = [];
  const visitMap = new Map();
  const skipped = [];
  const weakConfidences = new Set();

  for (const event of events) {
    const ev = {
      actorName: event.actor_name,
      actorProfileUrl: event.actor_profile_url || '',
      relation: event.relation || 'unknown',
      dedupConfidence: event.dedup_confidence || 'weak',
    };

    if (ev.dedupConfidence === 'weak') weakConfidences.add(event.id);

    if (event.event_type === 'comment') {
      replyCommentCandidates.push({
        eventId: event.id,
        actorName: ev.actorName,
        commentText: event.comment_text || '',
        relation: ev.relation,
        dedupConfidence: ev.dedupConfidence,
        replyMode: 'pending_review',
        actionType: 'reply_comment_candidate',
      });
    }

    if (ev.relation === 'friend' || ev.relation === 'mutual') {
      if (!ev.actorProfileUrl) {
        skipped.push({
          eventId: event.id, actorName: ev.actorName,
          eventType: event.event_type, relation: ev.relation,
          reason: 'no_actor_profile_url',
        });
        continue;
      }

      const key = ev.actorProfileUrl;
      if (visitMap.has(key)) {
        const existing = visitMap.get(key);
        if (!existing.sourceEventTypes.includes(event.event_type)) {
          existing.sourceEventTypes.push(event.event_type);
        }
        existing.sourceEventIds.push(event.id);
        const order = { weak: 0, medium: 1, strong: 2 };
        if ((order[event.dedup_confidence] || 0) > (order[existing.dedupConfidenceSummary] || 0)) {
          existing.dedupConfidenceSummary = event.dedup_confidence;
          existing.requiresManualReview = existing.dedupConfidenceSummary === 'weak';
        }
      } else {
        visitMap.set(key, {
          actorName: ev.actorName,
          actorProfileUrl: ev.actorProfileUrl,
          relation: ev.relation,
          sourceEventTypes: [event.event_type],
          sourceEventIds: [event.id],
          dedupConfidenceSummary: event.dedup_confidence || 'weak',
          status: 'planned_preview',
          executeAllowed: false,
          requiresManualReview: (event.dedup_confidence || 'weak') === 'weak',
        });
      }
    } else if (event.event_type !== 'comment') {
      skipped.push({
        eventId: event.id, actorName: ev.actorName,
        eventType: event.event_type, relation: ev.relation,
        reason: 'non_friend_non_mutual',
      });
    }
  }

  const visitWorkCandidates = Array.from(visitMap.values());

  const plannedIds = new Set();
  for (const c of replyCommentCandidates) plannedIds.add(c.eventId);
  for (const v of visitWorkCandidates) {
    for (const id of v.sourceEventIds) plannedIds.add(id);
  }
  for (const s of skipped) plannedIds.add(s.eventId);

  for (const eventId of plannedIds) {
    updateEventStatus(eventId, 'planned');
  }

  console.error(`[plan] 回复候选: ${replyCommentCandidates.length}, 回访候选: ${visitWorkCandidates.length}, 跳过: ${skipped.length}`);

  const data = {
    replyCommentCandidates,
    visitWorkCandidates,
    skipped,
    summary: {
      totalEvents: events.length,
      replyCommentCandidates: replyCommentCandidates.length,
      visitWorkCandidates: visitWorkCandidates.length,
      skippedNonFriend: skipped.filter(s => s.reason === 'non_friend_non_mutual').length,
      skippedNoProfile: skipped.filter(s => s.reason === 'no_actor_profile_url').length,
      weakCandidates: visitWorkCandidates.filter(v => v.requiresManualReview).length,
    },
  };

  if (useJson) {
    printJsonResult('actions:plan', data, data.summary);
  } else {
    console.error('');
    console.error('===== 回复评论候选 =====');
    for (const c of replyCommentCandidates) {
      console.error(`  [${c.eventId}] ${c.actorName} [${c.relation}] ${c.commentText.slice(0, 40)}`);
    }
    console.error('');
    console.error('===== 好友回访候选 =====');
    for (const v of visitWorkCandidates) {
      console.error(`  ${v.actorName} [${v.relation}] 来源:${v.sourceEventTypes.join('/')} ${v.requiresManualReview ? '(需人工确认)' : ''}`);
    }
    console.error('');
    console.error('===== 跳过 =====');
    for (const s of skipped) {
      console.error(`  ${s.actorName} [${s.relation}] ${s.eventType} → ${s.reason}`);
    }
    console.error('');
    console.error(`总计: ${events.length} 事件 → ${replyCommentCandidates.length} 回复候选 + ${visitWorkCandidates.length} 回访候选 + ${skipped.length} 跳过`);
  }
}

main().catch(err => {
  console.error('[plan] 错误:', err.message);
  printJsonError('actions:plan', RESULT_CODES.UNKNOWN_ERROR, err.message);
  process.exit(1);
});
