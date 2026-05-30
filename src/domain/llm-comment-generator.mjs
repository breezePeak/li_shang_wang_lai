import { RESULT_CODES, blocking } from './result-codes.mjs';

export async function generateAgentCommentCandidates(context, options = {}) {
  return blocking(
    RESULT_CODES.FEATURE_DISABLED,
    'agent comment mode is not yet implemented; use --comment-mode local or --comment-mode skill',
    { recoverable: false, data: { mode: 'agent' } }
  );
}
