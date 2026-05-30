import {
  capturePageDiagnostics,
  extractVisibleText,
  captureFullScreenshot,
  captureDomFragment,
} from './page-diagnostics.mjs';
import { ensureDir, writeJSON } from '../utils/filesystem.mjs';
import { writeFileSync } from 'fs';
import path from 'path';

export async function captureEvidence(page, {
  outputDir,
  step,
  code,
  message,
  recoverable = true,
  extra = {},
}) {
  const evidenceDir = path.join(outputDir, 'evidence', step);
  ensureDir(evidenceDir);

  const evidenceInfo = {
    step,
    code,
    message,
    recoverable,
    capturedAt: new Date().toISOString(),
    url: '',
    extra,
  };

  try {
    const diagnostics = await capturePageDiagnostics(page);
    evidenceInfo.url = diagnostics.url;
  } catch {
    // non-fatal
  }

  try {
    const info = await capturePageDiagnostics(page);
    writeJSON(path.join(evidenceDir, 'page-info.json'), {
      ...info,
      collectedAt: new Date().toISOString(),
    });
  } catch {
    // non-fatal
  }

  try {
    const text = await extractVisibleText(page);
    const truncated = text.slice(0, 10000);
    writeFileSync(path.join(evidenceDir, 'page-text.txt'), truncated, 'utf8');
  } catch {
    // non-fatal
  }

  try {
    const html = await captureDomFragment(page);
    writeFileSync(path.join(evidenceDir, 'page.html'), html, 'utf8');
  } catch {
    // non-fatal
  }

  try {
    const screenshotOk = await captureFullScreenshot(page, path.join(evidenceDir, 'screenshot.png'));
    if (!screenshotOk) {
      console.error(`[evidence] 截图失败 — ${step}`);
    }
  } catch {
    // non-fatal
  }

  try {
    writeJSON(path.join(evidenceDir, 'failure.json'), evidenceInfo);
  } catch {
    // non-fatal
  }

  console.error(`[evidence] 现场证据已保存: ${evidenceDir}`);
  console.error(`[evidence]   步骤: ${step}`);
  console.error(`[evidence]   错误码: ${code}`);
  console.error(`[evidence]   可恢复: ${recoverable ? '是' : '否'}`);

  return {
    evidenceDir,
    evidenceInfo,
    screenshotPath: path.join(evidenceDir, 'screenshot.png'),
    htmlPath: path.join(evidenceDir, 'page.html'),
    metaPath: path.join(evidenceDir, 'failure.json'),
  };
}
