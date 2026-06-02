import { buildExecutionPlan } from '../domain/interaction-task-plan.mjs';

export function runInteractionTask(userInput = '', options = {}) {
  const plan = buildExecutionPlan(userInput, options);
  const scanType = plan.collectTypes.includes('like') && !plan.collectTypes.includes('comment') ? 'like'
    : plan.collectTypes.includes('comment') && !plan.collectTypes.includes('like') ? 'comment'
      : 'all';

  const scanArgs = [
    'npm run interactions:scan --',
    `--type ${scanType}`,
    `--days ${plan.days}`,
    `--max-count ${plan.maxCount}`,
  ];
  if (plan.generateReplyJson) scanArgs.push('--generate-reply-json');
  if (plan.generateVisitJson) scanArgs.push('--generate-visit-json');
  if (plan.viewOnly) scanArgs.push('--display-only');

  return {
    plan,
    commands: {
      collect: scanArgs.join(' '),
      prepareReply: plan.generateReplyJson ? 'npm run comments:prepare -- --items-file <待回评JSON>' : null,
      executeReply: plan.generateReplyJson ? 'npm run comments:execute-all -- --items-file <待回评JSON> --execute' : null,
      prepareVisit: plan.generateVisitJson ? `npm run return-visit:prepare -- --items-file <待回访JSON> --days ${plan.days} --max-items ${plan.maxCount}` : null,
      executeVisit: plan.generateVisitJson ? 'npm run return-visit:execute -- --execute' : null,
    },
  };
}
