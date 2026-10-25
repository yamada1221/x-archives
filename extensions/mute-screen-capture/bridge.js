'use strict';
(async () => {
  const url = new URL(location.href);
  if (url.origin !== 'https://yamada1221.github.io' || !['/x-archives/', '/x-archives/index.html'].includes(url.pathname)) return;
  const token = url.searchParams.get('mute_capture');
  if (!token || window.top !== window) return;
  try {
    await new Promise((resolve, reject) => {
      const listen = event => {
        if (event.source === window && event.origin === location.origin && event.data?.type === 'X_TRACKER_MUTE_SCREEN_READY') {
          cleanup(); resolve();
        }
      };
      const ping = () => window.postMessage({ type: 'X_TRACKER_MUTE_SCREEN_PING' }, location.origin);
      const interval = setInterval(ping, 250);
      const timeout = setTimeout(() => { cleanup(); reject(new Error('トラッカーが画像受信に対応していません。ページを再読み込みしてください')); }, 5000);
      function cleanup() { clearInterval(interval); clearTimeout(timeout); window.removeEventListener('message', listen); }
      window.addEventListener('message', listen); ping();
    });
    const result = await chrome.runtime.sendMessage({ type: 'CLAIM_MUTE_SCREEN', token });
    if (!result?.ok) throw new Error(result?.error || '画像を受け取れませんでした');
    url.searchParams.delete('mute_capture');
    history.replaceState(null, '', url.href);
    window.postMessage({ type: 'X_TRACKER_MUTE_SCREEN_IMAGE', imageData: result.imageData, sourceAccount: result.sourceAccount }, location.origin);
  } catch (error) {
    const message = document.createElement('p');
    message.setAttribute('role', 'alert');
    message.style.cssText = 'padding:16px;margin:16px;background:#fff4d6;color:#422;border:1px solid #c99;';
    message.textContent = '拡張機能からの取り込み: ' + error.message;
    document.body.prepend(message);
  }
})();
