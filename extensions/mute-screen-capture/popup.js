'use strict';
document.getElementById('archiveSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
chrome.runtime.sendMessage({ type: 'AUTO_STATUS' }).then(s => {
  document.getElementById('archiveStatus').textContent = !s?.configured ? '自動保存は未設定です。' :
    `自動保存: ${s.enabled ? '有効' : '停止中'}\n${s.ready ? '保存先の接続テスト済み' : '接続テストが必要です'}` +
    (s.jobs?.some(j => j.sync_pending) ? '\nGitHub同期待ちの結果があります' : '') + (s.error ? '\n' + s.error : '');
}).catch(() => { document.getElementById('archiveStatus').textContent = '拡張機能を再読み込みしてください。'; });
const captureButton = document.getElementById('capture');
const message = document.getElementById('status');
const source = document.getElementById('source');
const startButton = document.getElementById('startDaily');
const stopButton = document.getElementById('stopDaily');
const dailyStatus = document.getElementById('dailyStatus');
const date = value => new Date(value).toLocaleString();
async function refreshDaily() {
  const result = await chrome.runtime.sendMessage({ type: 'GET_DAILY_STATUS' });
  if (!result?.ok) throw new Error(result?.error || '設定を読み込めませんでした');
  const settings = result.schedule;
  stopButton.disabled = !settings?.enabled;
  if (!settings?.enabled) { dailyStatus.textContent = '定期実行: 停止中'; return; }
  dailyStatus.textContent = `定期実行: 有効（24時間ごと）\n対象: @${settings.sourceAccount}\n次回予定: ${date(settings.nextRunAt)}`
    + (settings.lastCaptureAt ? `\n最終取得: ${date(settings.lastCaptureAt)}` : '')
    + (settings.lastError ? `\n前回の問題: ${settings.lastError}` : '')
    + (result.needsRegistration ? '\n再登録が必要です。ミュート一覧で開始ボタンを押してください。' : '')
    + '\n再起動後は開始し直してください。最小化・タブ切替・権限切れの場合は撮影せず通知します。';
}
refreshDaily().catch(error => { dailyStatus.textContent = error.message; });
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
startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'START_DAILY_MUTE', sourceAccount: source.value });
    if (!result?.ok) throw new Error(result?.error || '開始できませんでした');
    await refreshDaily();
    message.textContent = '専用ウィンドウに登録しました。初回の取得は24時間後です。';
  } catch (error) { message.textContent = error.message; }
  finally { startButton.disabled = false; }
});
stopButton.addEventListener('click', async () => {
  stopButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'STOP_DAILY_MUTE' });
    if (!result?.ok) throw new Error(result?.error || '停止できませんでした');
    await refreshDaily();
    message.textContent = '定期実行を停止しました。専用ウィンドウはそのまま残します。';
  } catch (error) { message.textContent = error.message; stopButton.disabled = false; }
});
