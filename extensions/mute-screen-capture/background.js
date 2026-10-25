'use strict';
if (typeof importScripts === 'function') importScripts('auto-core.js', 'auto-storage.js', 'auto-github.js', 'auto-ghost.js', 'auto-engine.js', 'auto-runtime.js');
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
const SCHEDULE = 'dailyMuteSchedule';
const BINDING = 'dailyMuteBinding';
const ALARM = 'daily-mute-capture';
const DAY = 24 * 60 * 60 * 1000;
async function activeTab(windowId) {
  return (await chrome.tabs.query(windowId === undefined ? { active: true, lastFocusedWindow: true } : { active: true, windowId }))[0];
}
async function getSchedule() { return (await chrome.storage.local.get(SCHEDULE))[SCHEDULE]; }
function sourceAccount(value, required = false) {
  const source = String(value || '').trim().replace(/^@/, '');
  if ((required && !source) || (source && !/^[A-Za-z0-9_]{1,15}$/.test(source))) throw new Error('自分のXユーザー名を入力してください');
  return source;
}
async function notify(id, title, message, badge = '!') {
  await chrome.action.setBadgeText({ text: badge }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color: badge === '!' ? '#a33d13' : '#245c7b' }).catch(() => {});
  await chrome.notifications.create(id, { type: 'basic', iconUrl: 'icon128.png', title, message }).catch(() => {});
}
async function ensureAlarm() {
  const schedule = await getSchedule();
  if (!schedule?.enabled) return;
  if (!(await chrome.alarms.get(ALARM))) {
    await chrome.alarms.create(ALARM, { when: Math.max(Date.now() + 1000, schedule.nextRunAt || Date.now()), periodInMinutes: 1440 });
  }
}
async function captureImage(tab) {
  const before = await activeTab(tab?.windowId);
  if (!tab || !before || before.id !== tab.id || !isMutePage(before.url) || before.pendingUrl || before.status === 'loading' || before.discarded) {
    throw new Error('対象のミュート一覧を確認できません。専用タブを表示し、必要なら拡張機能で定期実行を開始し直してください');
  }
  const win = await chrome.windows.get(tab.windowId);
  if (win.state === 'minimized') throw new Error('専用ウィンドウが最小化されています。通常の表示状態に戻してください');
  const imageData = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const after = await activeTab(tab.windowId);
  if (!after || after.id !== tab.id || after.url !== before.url || after.pendingUrl || after.status === 'loading' || after.discarded) {
    throw new Error('取得中に表示タブが変わったため、画像を破棄しました。再度押してください');
  }
  if (!imageData.startsWith('data:image/png;base64,') || imageData.length > 4 * 1024 * 1024) throw new Error('画像が大きすぎます。保存済みスクリーンショットをトラッカーで選択してください');
  return imageData;
}
async function deliver(imageData, source, sourceTab, background) {
  let receiver;
  try {
    const pending = (await chrome.storage.session.get(PENDING))[PENDING];
    if (pending && Date.now() - pending.createdAt < 10 * 60 * 1000) throw new Error('前回の画像が受け渡し待ちです。前回の受信タブを確認するか、閉じてから再度取得してください');
    const token = crypto.randomUUID();
    if (background) {
      const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      const other = windows.find(win => win.id !== sourceTab.windowId && Boolean(win.incognito) === Boolean(sourceTab.incognito));
      if (other) receiver = await chrome.tabs.create({ url: 'about:blank', active: false, windowId: other.id });
      else {
        const win = await chrome.windows.create({ url: 'about:blank', focused: false, type: 'normal', incognito: Boolean(sourceTab.incognito) });
        receiver = win.tabs[0];
      }
    } else receiver = await chrome.tabs.create({ url: 'about:blank', active: true });
    await chrome.storage.session.set({ [PENDING]: { token, targetTabId: receiver.id, imageData, sourceAccount: source, createdAt: Date.now() } });
    await chrome.tabs.update(receiver.id, { url: TRACKER + '?mute_capture=' + encodeURIComponent(token) });
    return receiver.id;
  } catch (error) {
    if (receiver) {
      const pending = (await chrome.storage.session.get(PENDING))[PENDING];
      if (pending?.targetTabId === receiver.id) await chrome.storage.session.remove(PENDING);
      await chrome.tabs.remove(receiver.id).catch(() => {});
    }
    throw error;
  }
}
async function updateOutcome(token, changes) {
  const latest = await getSchedule();
  if (!latest?.enabled || latest.token !== token) return false;
  await chrome.storage.local.set({ [SCHEDULE]: { ...latest, ...changes } });
  return true;
}
async function runDaily() {
  const schedule = await getSchedule();
  if (!schedule?.enabled || capturing || schedule.nextRunAt > Date.now() + 1000) return;
  capturing = true;
  const attemptedAt = Date.now();
  try {
    // Advance before taking a picture: duplicate alarms and wake-up never cause a burst.
    if (!(await updateOutcome(schedule.token, { nextRunAt: attemptedAt + DAY, lastAttemptAt: attemptedAt }))) return;
    await chrome.alarms.create(ALARM, { when: attemptedAt + DAY, periodInMinutes: 1440 });
    const binding = (await chrome.storage.session.get(BINDING))[BINDING];
    if (!binding || binding.token !== schedule.token) throw new Error('再起動または拡張機能の更新で権限が切れています。ミュート一覧で定期実行を開始し直してください');
    const tab = await activeTab(binding.windowId);
    if (!tab || tab.id !== binding.tabId) throw new Error('専用ウィンドウでミュート一覧が選択されていません。対象タブを表示してください');
    const imageData = await captureImage(tab);
    const latest = await getSchedule();
    if (!latest?.enabled || latest.token !== schedule.token) return;
    const receiverId = await deliver(imageData, schedule.sourceAccount, tab, true);
    if (await updateOutcome(schedule.token, { lastResult: 'success', lastError: '', lastCaptureAt: Date.now(), reviewTabId: receiverId })) {
      await notify('mute-review:' + receiverId, 'ミュート一覧を1画面取得しました', '画像から読み取った候補を確認してください。続きがある場合は手動スクロールが必要です。', '1');
    }
  } catch (error) {
    if (await updateOutcome(schedule.token, { lastResult: 'failed', lastError: error.message })) {
      await notify('mute-daily-error', 'ミュート一覧の定期取得を実行できませんでした', error.message);
    }
  } finally {
    capturing = false;
    if (!(await getSchedule())?.enabled) await chrome.alarms.clear(ALARM);
  }
}
async function startDaily(source) {
  if (capturing) throw new Error('画像を取得中です。完了後に開始してください');
  const tab = await activeTab();
  if (!tab || !isMutePage(tab.url) || tab.pendingUrl || tab.status === 'loading') throw new Error('ミュート一覧を開き、読み込みが終わってから開始してください');
  const token = crypto.randomUUID();
  const win = await chrome.windows.create({ tabId: tab.id, focused: true, type: 'normal' });
  const schedule = { enabled: true, token, sourceAccount: source, nextRunAt: Date.now() + DAY, lastResult: 'waiting', lastError: '' };
  await chrome.storage.session.set({ [BINDING]: { token, tabId: tab.id, windowId: win.id } });
  await chrome.storage.local.set({ [SCHEDULE]: schedule, sourceAccount: source });
  await chrome.alarms.clear(ALARM);
  await ensureAlarm();
  await notify('mute-daily-enabled', '1日1回の取得を開始しました', '初回は24時間後です。この専用ウィンドウのミュート一覧を表示したまま保持してください。', 'ON');
  return { ok: true, schedule };
}
async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error('送信元を確認できません');
  if (message?.type?.startsWith('AUTO_')) return AutoArchiveRuntime.handle(message, sender);
  if (['CAPTURE_MUTE_SCREEN', 'START_DAILY_MUTE', 'STOP_DAILY_MUTE', 'GET_DAILY_STATUS'].includes(message?.type)) {
    if (sender.tab || sender.url !== chrome.runtime.getURL('popup.html')) throw new Error('拡張機能のボタンから操作してください');
    if (message.type === 'GET_DAILY_STATUS') {
      const schedule = await getSchedule();
      const binding = (await chrome.storage.session.get(BINDING))[BINDING];
      return { ok: true, schedule, needsRegistration: Boolean(schedule?.enabled && binding?.token !== schedule.token) };
    }
    if (message.type === 'STOP_DAILY_MUTE') {
      const schedule = await getSchedule();
      await chrome.storage.local.set({ [SCHEDULE]: { ...schedule, enabled: false } });
      await chrome.storage.session.remove(BINDING);
      await chrome.alarms.clear(ALARM);
      await chrome.action.setBadgeText({ text: '' }).catch(() => {});
      return { ok: true };
    }
    if (message.type === 'START_DAILY_MUTE') return startDaily(sourceAccount(message.sourceAccount, true));
    if (capturing) throw new Error('取得中です。少し待ってください');
    capturing = true;
    try {
      const source = sourceAccount(message.sourceAccount);
      const tab = await activeTab();
      const imageData = await captureImage(tab);
      const binding = (await chrome.storage.session.get(BINDING))[BINDING];
      await deliver(imageData, source, tab, binding?.tabId === tab.id);
      await chrome.storage.local.set({ sourceAccount: source });
      return { ok: true };
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
  const binding = (await chrome.storage.session.get(BINDING))[BINDING];
  if (binding?.tabId === id) {
    await chrome.storage.session.remove(BINDING);
    if (await updateOutcome(binding.token, { lastResult: 'failed', lastError: '専用のミュート一覧タブが閉じられました。開始し直してください' })) {
      await notify('mute-daily-error', 'ミュート一覧の専用タブが閉じられました', '定期取得を再開するには、ミュート一覧で拡張機能の開始ボタンを押してください。');
    }
  }
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) runDaily().catch(() => {});
});
chrome.runtime.onStartup.addListener(async () => {
  const schedule = await getSchedule();
  if (schedule?.enabled) {
    await chrome.storage.session.remove(BINDING);
    if (await updateOutcome(schedule.token, { lastResult: 'failed', lastError: '再起動後はミュート一覧で定期実行を開始し直してください' })) {
      await notify('mute-daily-error', '定期取得の再登録が必要です', 'ミュート一覧で拡張機能を開き、定期実行を開始し直してください。');
    }
  }
  await ensureAlarm();
});
chrome.runtime.onInstalled.addListener(() => ensureAlarm().catch(() => {}));
chrome.notifications.onClicked.addListener(async id => {
  if (id.startsWith('mute-review:')) {
    try {
      const tab = await chrome.tabs.update(Number(id.split(':')[1]), { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (_) { await chrome.tabs.create({ url: TRACKER }); }
  } else if (id.startsWith('mute-daily-')) await chrome.tabs.create({ url: 'https://x.com/settings/muted/all' });
  await chrome.notifications.clear(id);
});
ensureAlarm().catch(() => {});
