'use strict';
const captureButton = document.getElementById('capture');
const message = document.getElementById('status');
const source = document.getElementById('source');
chrome.storage.local.get('sourceAccount').then(data => { source.value = data.sourceAccount || ''; }).catch(() => {});
document.getElementById('open').addEventListener('click', () => chrome.tabs.create({ url: 'https://x.com/settings/muted/all' }));
captureButton.addEventListener('click', async () => {
  captureButton.disabled = true;
  message.textContent = '表示中の1画面を取得しています…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'CAPTURE_MUTE_SCREEN', sourceAccount: source.value });
    if (!result?.ok) throw new Error(result?.error || '取得できませんでした');
    message.textContent = 'トラッカーの確認画面を開きました。';
  } catch (error) { message.textContent = error.message; }
  finally { captureButton.disabled = false; }
});
