import { generateCommentWithHermes, generateRepliesWithHermes, generateReplyWithHermes } from './comment-agent-server.mjs';

export class LocalAgentProvider {
  constructor(options = {}) {
    this.options = options;
  }

  async generateComment(context) {
    return generateCommentWithHermes(context, this.options);
  }

  async generateReply(context) {
    return generateReplyWithHermes(context, this.options);
  }

  async generateReplies(contexts) {
    return generateRepliesWithHermes(contexts, this.options);
  }
}
