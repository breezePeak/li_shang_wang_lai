// 等待与重试工具

/**
 * 等待指定毫秒
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带超时的 Promise 等待
 * @param {Promise} promise
 * @param {number} timeoutMs
 * @param {string} [errorMessage='操作超时']
 * @returns {Promise}
 */
export function withTimeout(promise, timeoutMs, errorMessage = '操作超时') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    ),
  ]);
}

/**
 * 重试执行异步函数
 * @param {Function} fn — 返回 Promise 的函数
 * @param {Object} options
 * @param {number} [options.maxRetries=3]
 * @param {number} [options.delayMs=1000]
 * @param {boolean} [options.exponential=true] — 是否指数退避
 * @returns {Promise}
 */
export async function retry(fn, options = {}) {
  const { maxRetries = 3, delayMs = 1000, exponential = true } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = exponential ? delayMs * Math.pow(2, attempt) : delayMs;
      console.warn(`[retry] 第 ${attempt + 1} 次尝试失败，${delay}ms 后重试:`, err.message);
      await wait(delay);
    }
  }
}
