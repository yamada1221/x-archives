'use strict';
const byId = id => document.getElementById(id), message = byId('message');
let latest;
async function send(type, more = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...more });
  if (!result?.ok) throw Error(result?.error || '操作を完了できませんでした');
  return result;
}
function render(data) {
  latest = data;
  byId('summary').textContent = !data.configured ? 'GitHub接続設定を保存してください。' :
    `自動保存: ${data.enabled ? '有効' : '停止中'}\n保存先: ${data.ready ? '本文確認済み' : '接続テストが必要'}\n未保存候補: ${data.candidates || 0}件` +
    (data.lastRunAt ? '\n最終実行: ' + new Date(data.lastRunAt).toLocaleString() : '') +
    (data.nextScanAt && data.enabled ? '\n次回走査予定: ' + new Date(data.nextScanAt).toLocaleString() : '') +
    (data.error ? '\n同期・実行の問題: ' + data.error : '');
  const jobs = byId('jobs'); jobs.replaceChildren();
  for (const j of (data.jobs || []).filter(j => !byId('reviewOnly').checked || ['needs_review', 'submission_unknown'].includes(j.state)).reverse()) {
    const box = document.createElement('div'); box.className = 'job';
    const name = document.createElement('strong'); name.textContent = `@${j.handle} — ${j.label}${j.test ? '（接続テスト）' : ''}`; box.append(name);
    const detail = document.createElement('p'); detail.textContent = [j.sync_pending ? 'GitHub同期待ち' : '', j.error,
      j.captured_at ? '取得日時: ' + new Date(j.captured_at).toLocaleString() : '',
      j.scope?.length ? 'プロフィール確認済み／投稿本文' + (j.posts === 'confirmed' ? 'も確認' : 'は未確認') : ''].filter(Boolean).join('\n'); box.append(detail);
    if (j.receipt) { const link = document.createElement('a'); link.href = j.receipt; link.target = '_blank'; link.rel = 'noopener'; link.textContent = '保存結果を開く'; box.append(link); }
    if (['needs_review', 'submission_unknown'].includes(j.state)) {
      const show = document.createElement('button'); show.textContent = '保存先で確認'; show.className = 'secondary';
      show.onclick = () => action('AUTO_SHOW', { job_id: j.job_id }); box.append(show);
      const input = document.createElement('input'); input.type = 'url'; input.placeholder = 'https://ghostarchive.org/archive/…'; input.setAttribute('aria-label', '@' + j.handle + ' の結果URL'); box.append(input);
      const adopt = document.createElement('button'); adopt.textContent = 'この結果の本文を再確認'; adopt.onclick = () => action('AUTO_ADOPT', { job_id: j.job_id, receipt: input.value }); box.append(adopt);
    }
    jobs.append(box);
  }
}
async function refresh() { render(await send('AUTO_STATUS')); }
async function action(type, more) {
  const buttons = [...document.querySelectorAll('button')]; buttons.forEach(b => b.disabled = true); message.textContent = '処理しています…';
  try { await send(type, more); await refresh(); message.textContent = '反映しました。保存・確認が必要な処理はバックグラウンドで続きます。'; }
  catch (e) { message.textContent = e.message; }
  finally { buttons.forEach(b => b.disabled = false); }
}
byId('connection').addEventListener('submit', async event => {
  event.preventDefault();
  // Call request directly in the user's gesture; never ask a content script to
  // grant permissions or pass a repository credential through the tracker page.
  try {
    const granted = await chrome.permissions.request({ permissions: ['scripting'], origins: ['https://api.github.com/*', 'https://api.fxtwitter.com/*', 'https://ghostarchive.org/*'] });
    if (!granted) throw Error('アクセス権限が許可されませんでした');
    await action('AUTO_SAVE', { config: { owner: byId('owner').value.trim(), repo: byId('repo').value.trim(), path: byId('path').value.trim(), token: byId('token').value.trim() } });
    byId('token').value = '';
  } catch (e) { message.textContent = e.message; }
});
for (const [id, type] of [['claim', 'AUTO_CLAIM'], ['test', 'AUTO_TEST'], ['start', 'AUTO_START'], ['stop', 'AUTO_STOP'], ['run', 'AUTO_RUN']]) byId(id).addEventListener('click', () => action(type));
byId('reviewOnly').addEventListener('change', () => latest && render(latest));
send('AUTO_STATUS').then(data => { if (data.config) for (const key of ['owner', 'repo', 'path']) byId(key).value = data.config[key]; render(data); }).catch(e => { message.textContent = e.message; });
// Only this open UI refreshes on a timer. The worker's actual scheduler uses alarms.
setInterval(() => refresh().catch(() => {}), 15000);
