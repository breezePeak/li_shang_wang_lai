/**
 * Unified Douyin URL normalization.
 * Strips protocol prefixes, double-domain patterns, query params, and hash fragments.
 *
 * Examples:
 *   /user/MS4wLjAB...                        → https://www.douyin.com/user/MS4wLjAB...
 *   //www.douyin.com/user/MS4wLjAB...         → https://www.douyin.com/user/MS4wLjAB...
 *   www.douyin.com/user/MS4wLjAB...?from=...  → https://www.douyin.com/user/MS4wLjAB...
 *   https://www.douyin.com//www.douyin.com/user/... → https://www.douyin.com/user/...
 *   https://www.douyin.com/https://www.douyin.com/user/... → https://www.douyin.com/user/...
 *   /video/12345?tab=like                     → https://www.douyin.com/video/12345
 */

export function normalizeDouyinUrl(href) {
  if (!href) return '';
  let s = href.trim();
  if (!s) return '';

  // Phase 1: strip protocol/host prefixes (loop for double-domain patterns)
  let changed = true;
  while (changed) {
    changed = false;
    if (s.startsWith('https://www.douyin.com')) { s = s.slice(22); changed = true; continue; }
    if (s.startsWith('http://www.douyin.com'))  { s = s.slice(21); changed = true; continue; }
    if (s.startsWith('/https://www.douyin.com')) { s = s.slice(23); changed = true; continue; }
    if (s.startsWith('/http://www.douyin.com'))  { s = s.slice(22); changed = true; continue; }
    if (s.startsWith('https://'))               { s = s.slice(8);  changed = true; continue; }
    if (s.startsWith('http://'))                { s = s.slice(7);  changed = true; continue; }
    if (s.startsWith('//www.douyin.com'))       { s = s.slice(16); changed = true; continue; }
    if (s.startsWith('//'))                     { s = s.slice(2);  changed = true; continue; }
    if (s.startsWith('www.douyin.com'))         { s = s.slice(14); changed = true; continue; }
    if (s.startsWith('douyin.com'))             { s = s.slice(10); changed = true; continue; }
  }

  // Phase 2: strip leading slash (already handled by phase 1 for //www.douyin.com)
  if (s.startsWith('/')) s = s.slice(1);

  // Phase 3: strip query params
  const qIdx = s.indexOf('?');
  if (qIdx > 0) s = s.slice(0, qIdx);

  // Phase 4: strip hash
  const hIdx = s.indexOf('#');
  if (hIdx > 0) s = s.slice(0, hIdx);

  if (!s) return '';

  return 'https://www.douyin.com/' + s;
}
