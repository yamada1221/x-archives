'use strict';
(() => {
  if (window.top !== window || location.origin !== 'https://yamada1221.github.io' || !['/x-archives/', '/x-archives/index.html'].includes(location.pathname)) return;
  let last = 0;
  window.addEventListener('message', async event => {
    const m = event.data;
    if (event.source !== window || event.origin !== location.origin || !['X_TRACKER_AUTO_STATUS', 'X_TRACKER_AUTO_REFRESH'].includes(m?.type) || typeof m.requestId !== 'string' || m.requestId.length > 80) return;
    if (Date.now() - last < 1000) return; last = Date.now();
    try {
      const result = await chrome.runtime.sendMessage({ type: m.type === 'X_TRACKER_AUTO_STATUS' ? 'AUTO_PAGE_STATUS' : 'AUTO_PAGE_REFRESH', owner: m.owner, repo: m.repo, path: m.path });
      window.postMessage({ type: 'X_TRACKER_AUTO_RESULT', requestId: m.requestId, result }, location.origin);
    } catch (_) { window.postMessage({ type: 'X_TRACKER_AUTO_RESULT', requestId: m.requestId, result: { ok: false, error: '拡張機能を再読み込みしてください' } }, location.origin); }
  });
})();
