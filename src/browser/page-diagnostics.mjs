/**
 * 采集当前页面的基本诊断信息
 * @param {import('playwright').Page} page
 * @returns {Promise<{url: string, title: string, timestamp: string}>}
 */
export async function capturePageDiagnostics(page) {
  return {
    url: page.url(),
    title: await page.title(),
    timestamp: new Date().toISOString(),
  };
}
