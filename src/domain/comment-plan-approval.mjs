export function approveCommentPlan(plan, options = {}) {
  if (!plan || plan.type !== 'comment_reply') {
    return { ok: false, error: 'plan.type 必须为 comment_reply' };
  }
  if (!Array.isArray(plan.items)) {
    return { ok: false, error: 'plan.items 必须是数组' };
  }

  const { mode, eventIds = [], indices = [], reason = '' } = options;

  let changed = 0;

  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i];
    let shouldChange = false;
    let newApproved;

    if (mode === 'all') {
      shouldChange = true;
      newApproved = true;
    } else if (mode === 'none') {
      shouldChange = true;
      newApproved = false;
    } else if (mode === 'selected') {
      const matchEventId = eventIds.length > 0 && eventIds.some(id => String(id) === String(item.eventId));
      const matchIndex = indices.length > 0 && indices.includes(i + 1);
      if (matchEventId || matchIndex) {
        shouldChange = true;
        newApproved = true;
      }
    }

    if (shouldChange) {
      const beforeApproved = item.approved === true;
      const beforeReason = item.approvalReason || '';

      item.approved = newApproved;
      if (reason) {
        item.approvalReason = reason;
      } else {
        delete item.approvalReason;
      }

      const afterApproved = item.approved === true;
      const afterReason = (reason || '');
      if (beforeApproved !== afterApproved || beforeReason !== afterReason) {
        changed++;
      }
    }
  }

  const approvedCount = plan.items.filter(it => it.approved === true).length;
  plan.summary = {
    ...plan.summary,
    approved: approvedCount,
    pendingApproval: plan.items.length - approvedCount,
    total: plan.items.length,
    updatedAt: new Date().toISOString(),
  };

  return { ok: true, changed, approved: approvedCount, pendingApproval: plan.items.length - approvedCount };
}
