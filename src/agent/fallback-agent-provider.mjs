export class FallbackAgentProvider {
  constructor(primary, fallback, options = {}) {
    this.primary = primary;
    this.fallback = fallback;
    this.options = options;
    this.name = options.name || 'primary';
  }

  async runWithFallback(method, args = []) {
    try {
      return await this.primary[method](...args);
    } catch (error) {
      const message = error?.message || String(error);
      console.error(`[agent] ${this.name} ${method} failed, fallback to cli reason=${message}`);
      return this.fallback[method](...args);
    }
  }

  async generateComment(context) {
    return this.runWithFallback('generateComment', [context]);
  }

  async generateReply(context) {
    return this.runWithFallback('generateReply', [context]);
  }

  async generateReplies(contexts) {
    return this.runWithFallback('generateReplies', [contexts]);
  }

  async close() {
    await this.primary?.close?.();
    await this.fallback?.close?.();
  }
}
