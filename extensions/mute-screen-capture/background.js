'use strict';
const TRACKER = 'https://yamada1221.github.io/x-archives/';
const PENDING = 'pendingMuteScreen';
let capturing = false;
function isMutePage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)
      && !url.port && !url.username && !url.password && /^\/settings\/muted(?:\/all)?\/?$/.test(url.pathname);
  } catch (_) { return false; }
}
function isTracker(value) {
  try { const url = new URL(value); return url.origin === 'https://yamada1221.github.io' && ['/x-archives/', '/x-archives/index.html'].includes(url.pathname); }
  catch (_) { return false; }
}
async function activeTab() { return (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]; }
async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error('送信元を確認できません');
  if (message?.type === 'CAPTURE_MUTE_SCREEN') {
    if (sender.tab || sender.url !== chrome.runtime.getURL('popup.html')) throw new Error('拡張機能のボタンから取得してください');
    if (capturing) throw new Error('取得中です。少し待ってください');
    capturing = true;
    let receiver;
    try {
      const source = String(message.sourceAccount || '').trim().replace(/^@/, '');
      if (source && !/^[A-Za-z0-9_]{1,15}$/.test(source)) throw new Error('自分のユーザー名を確認してください');
      const tab = await activeTab();
      if (!tab || !isMutePage(tab.url) || tab.pendingUrl || tab.status === 'loading') throw new Error('Xのミュート一覧を開き、読み込みが終わってから押してください');
      const imageData = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      const after = await activeTab();
      if (!after || after.id !== tab.id || after.windowId !== tab.windowId || after.url !== tab.url || after.pendingUrl || after.status === 'loading') throw new Error('取得中に表示タブが変わったため、画像を破棄しました。再度押してください');
      if (!imageData.startsWith('data:image/png;base64,') || imageData.length > 4 * 1024 * 1024) throw new Error('画像が大きすぎます。保存済みスクリーンショットをトラッカーで選択してください');
      const token = crypto.randomUUID();
      // Reserve the receiver before navigation, so only that tab can claim the image.
      receiver = await chrome.tabs.create({ url: 'about:blank', active: true });
      await chrome.storage.session.set({ [PENDING]: { token, targetTabId: receiver.id, imageData, sourceAccount: source, createdAt: Date.now() } });
      await chrome.storage.local.set({ sourceAccount: source });
      await chrome.tabs.update(receiver.id, { url: TRACKER + '?mute_capture=' + encodeURIComponent(token) });
      return { ok: true };
    } catch (error) {
      await chrome.storage.session.remove(PENDING).catch(() => {});
      if (receiver) await chrome.tabs.remove(receiver.id).catch(() => {});
      throw error;
    } finally { capturing = false; }
  }
  if (message?.type === 'CLAIM_MUTE_SCREEN') {
    if (!sender.tab || sender.frameId !== 0 || !isTracker(sender.url)) throw new Error('トラッカーの受信ページではありません');
    const pending = (await chrome.storage.session.get(PENDING))[PENDING];
    if (!pending) throw new Error('受け渡す画像がありません。Xで再度取得してください');
    if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
      await chrome.storage.session.remove(PENDING);
      throw new Error('画像の受け渡し期限が切れました。Xで再度取得してください');
    }
    if (pending.token !== message.token || pending.targetTabId !== sender.tab.id) throw new Error('画像の受信先が一致しません');
    await chrome.storage.session.remove(PENDING);
    return { ok: true, imageData: pending.imageData, sourceAccount: pending.sourceAccount };
  }
  throw new Error('対応していない操作です');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(async id => {
  const pending = (await chrome.storage.session.get(PENDING))[PENDING];
  if (pending?.targetTabId === id) await chrome.storage.session.remove(PENDING);
});
