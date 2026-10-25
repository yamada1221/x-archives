'use strict';
let autoArchiveExtensionStatus = null;
function autoArchiveJobText(id) {
  const j = autoArchiveExtensionStatus?.jobs?.filter(j => j.artist_id === id).at(-1);
  return j ? j.label + (j.sync_pending ? '／GitHub同期待ち' : '') + (j.error ? '：' + j.error : '') :
    autoArchiveExtensionStatus?.configured ? '拡張機能の次回走査で確認します' : '拡張機能の接続・起動待ち';
}
function autoArchiveControls(artist) {
  const mode = artist.auto_archive?.enabled || 'inherit';
  return `<div class="record-box"><strong>自動アーカイブ</strong>
    <p data-auto-archive-id="${esc(artist.id)}">${esc(autoArchiveJobText(artist.id))}</p>
    <label>初回保存 <select onchange="setAutoArchiveMode('${esc(artist.id)}',this.value)">
      <option value="inherit"${mode === 'inherit' ? ' selected' : ''}>拡張機能の設定に従う</option>
      <option value="on"${mode === 'on' ? ' selected' : ''}>有効</option>
      <option value="off"${mode === 'off' ? ' selected' : ''}>停止</option></select></label>
    <button class="small" onclick="requestAutoArchive(true)">拡張機能に走査を依頼</button>
    <small>変更は「GitHubに保存」で反映します。実行するPCの拡張機能を設定してください。</small></div>`;
}
function setAutoArchiveMode(id, enabled) {
  if (!['inherit', 'on', 'off'].includes(enabled)) return;
  const a = artists.find(a => a.id === id); if (!a || a.tracking_mode !== 'record') return;
  a.auto_archive = { ...(a.auto_archive || {}), enabled, policy: 'first_only', target: 'profile' };
  saveLocal(); showToast('自動保存の設定を変更しました。GitHubへ保存してください');
}
function requestAutoArchive(refresh = false) {
  const cfg = getConfig(), requestId = 'auto-' + Math.random().toString(36).slice(2);
  window.postMessage({ type: refresh ? 'X_TRACKER_AUTO_REFRESH' : 'X_TRACKER_AUTO_STATUS', requestId, owner: cfg.owner, repo: cfg.repo, path: cfg.path }, location.origin);
  if (refresh) showToast('拡張機能へ走査を依頼しました。稼働していない場合は次回起動時に確認します');
}
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'X_TRACKER_AUTO_RESULT') return;
  const result = event.data.result;
  if (!result?.ok || !Array.isArray(result.jobs)) return;
  autoArchiveExtensionStatus = result;
  // Update status text only: live extension updates must not destroy draft notes.
  document.querySelectorAll('[data-auto-archive-id]').forEach(el => { el.textContent = autoArchiveJobText(el.dataset.autoArchiveId); });
  const status = document.getElementById('autoArchiveStatus');
  if (status) status.textContent = !result.configured ? '拡張機能の接続・起動待ち' :
    `自動保存: ${result.enabled ? '有効' : '停止中'}${result.ready ? '' : '／接続テストが必要'}` + (result.error ? '／' + result.error : '');
});
window.addEventListener('x-tracker-github-saved', () => requestAutoArchive(true));
document.addEventListener('DOMContentLoaded', () => { requestAutoArchive(); setInterval(() => requestAutoArchive(), 30000); });
