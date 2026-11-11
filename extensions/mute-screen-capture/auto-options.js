'use strict';
const byId = id => document.getElementById(id), message = byId('message');
const C = globalThis.AutoArchiveCore;
let latest;
const receiptDrafts = new Map(), receiptCandidates = new Map();
let jobsRenderKey = '';
async function send(type, more = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...more });
  if (!result?.ok) throw Error(result?.error || '操作を完了できませんでした');
  return result;
}
function render(data) {
  latest = data;
  byId('token').required = !data.configured;
  byId('summary').textContent = !data.configured ? 'GitHub接続設定を保存してください。' :
    `自動保存: ${data.enabled ? '有効' : '停止中'}\n保存先: ${C.providerLabel(data.provider)}（${data.ready ? '本文確認済み' : '接続テストが必要'}）\n未保存候補: ${data.candidates || 0}件\n手動確認が必要: ${data.reviewCount || 0}件` +
    (data.submissionHeld ? '\n新規依頼: 保存先の確認が必要な依頼があるため待機中' : '') +
    (data.lastRunAt ? '\n最終実行: ' + new Date(data.lastRunAt).toLocaleString() : '') +
    (data.nextScanAt && data.enabled ? '\n次回走査予定: ' + new Date(data.nextScanAt).toLocaleString() : '') +
    (data.error ? '\n同期・実行の問題: ' + data.error : '');
  const jobs = byId('jobs');
  const needsAttention = j => j.attention || C.attention(j);
  const ordered = [...(data.jobs || [])].reverse();
  const shown = byId('reviewOnly').checked ? ordered.filter(needsAttention) :
    [...ordered.filter(needsAttention), ...ordered.filter(j => !needsAttention(j))];
  const viewKey = JSON.stringify([shown, [...receiptCandidates]]);
  if (viewKey === jobsRenderKey) return;
  if (jobs.contains(document.activeElement) && document.activeElement.matches('input[data-job-id]')) return;
  for (const input of jobs.querySelectorAll('input[data-job-id]')) {
    if (input.value || receiptDrafts.has(input.dataset.jobId)) receiptDrafts.set(input.dataset.jobId, input.value);
  }
  jobsRenderKey = viewKey; jobs.replaceChildren();
  for (const j of shown) {
    const box = document.createElement('div'); box.className = 'job';
    const name = document.createElement('strong'); name.textContent = `@${j.handle}${j.target_kind === 'replies' ? '（返信タブ）' : ''} — ${j.label} / ${C.providerLabel(j.provider)}${j.test ? '（接続テスト）' : ''}`; box.append(name);
    const detail = document.createElement('p'); detail.textContent = [j.sync_pending ? 'GitHub同期待ち' : '', j.error,
      j.captured_at ? '取得日時: ' + new Date(j.captured_at).toLocaleString() : '',
      j.scope?.length ? (j.scope.includes('replies') ? '返信タブ確認済み' : 'プロフィール確認済み') + '／投稿本文' + (j.posts === 'confirmed' ? 'も確認' : 'は未確認') : ''].filter(Boolean).join('\n'); box.append(detail);
    if (j.receipt) { const link = document.createElement('a'); link.href = j.receipt; link.target = '_blank'; link.rel = 'noopener'; link.textContent = '保存結果を開く'; box.append(link); }
    if (j.attention || C.attention(j)) {
      const show = document.createElement('button'); show.textContent = '保存先で確認'; show.className = 'secondary';
      show.onclick = () => action('AUTO_SHOW', { job_id: j.job_id }); box.append(show);
      if (j.can_recheck) {
        const recheck = document.createElement('button'); recheck.type = 'button'; recheck.className = 'secondary';
        recheck.textContent = '確認後に再確認'; recheck.onclick = () => action('AUTO_RECHECK', { job_id: j.job_id }); box.append(recheck);
      }
      const input = document.createElement('input'); input.type = 'url'; input.placeholder = j.provider === 'ghostarchive' ? 'https://ghostarchive.org/archive/…' : 'https://archive.li/…'; input.setAttribute('aria-label', '@' + j.handle + ' の結果URL');
      input.dataset.jobId = j.job_id; input.value = receiptDrafts.has(j.job_id) ? receiptDrafts.get(j.job_id) : (j.receipt || '');
      input.addEventListener('input', () => receiptDrafts.set(j.job_id, input.value));
      const picker = document.createElement('button'); picker.type = 'button'; picker.className = 'secondary'; picker.textContent = '開いている保存ページから選ぶ';
      picker.onclick = async () => {
        picker.disabled = true;
        try {
          const result = await send('AUTO_RECEIPT_CANDIDATES', { job_id: j.job_id });
          receiptCandidates.set(j.job_id, result.candidates || []); jobsRenderKey = ''; render(latest);
          message.textContent = result.candidates?.length ? '候補から保存結果を選び、本文を再確認してください。' : '候補が見つかりません。保存一覧または個別の保存結果のタブを開いたまま、もう一度押してください。';
        } catch (e) { message.textContent = e.message; }
        finally { picker.disabled = false; }
      };
      box.append(picker);
      for (const candidate of receiptCandidates.get(j.job_id) || []) {
        const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'secondary';
        choose.textContent = [candidate.label || candidate.source, candidate.url].filter(Boolean).join('\n');
        choose.onclick = () => { input.value = candidate.url; receiptDrafts.set(j.job_id, candidate.url); input.focus(); message.textContent = '結果URLを入力しました。「この結果の本文を再確認」を押してください。'; };
        box.append(choose);
      }
      box.append(input);
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
    const granted = await chrome.permissions.request({ permissions: ['scripting'], origins: C.origins(byId('provider').value) });
    if (!granted) throw Error('アクセス権限が許可されませんでした');
    await action('AUTO_SAVE', { config: { owner: byId('owner').value.trim(), repo: byId('repo').value.trim(), path: byId('path').value.trim(), token: byId('token').value.trim(), provider: byId('provider').value } });
    byId('token').value = '';
  } catch (e) { message.textContent = e.message; }
});
for (const [id, type] of [['claim', 'AUTO_CLAIM'], ['test', 'AUTO_TEST'], ['start', 'AUTO_START'], ['stop', 'AUTO_STOP'], ['run', 'AUTO_RUN']]) byId(id).addEventListener('click', () => action(type));
byId('reviewOnly').addEventListener('change', () => latest && render(latest));
byId('diagnoseForms').addEventListener('click', async () => {
  const output = byId('formDiagnostics'), button = byId('diagnoseForms');
  button.disabled = true; output.textContent = '診断しています…';
  try {
    const { diagnostics: d } = await send('AUTO_FORM_DIAGNOSTICS');
    const lines = [`フォーム診断 v${d.version}（端末内のみ）`];
    if (!d.pages.length) lines.push('保存先のトップページが見つかりません。「保存先で確認」でページを開いてから診断してください。');
    for (const [n, p] of d.pages.entries()) {
      lines.push(`\nページ${n + 1}: ${p.page?.origin || ''}${p.page?.path || ''}`);
      if (p.error) { lines.push(p.error); continue; }
      lines.push(`画面: ${p.title} / ${p.ready}`);
      if (!p.forms.length) lines.push('フォームなし');
      for (const [i, f] of p.forms.entries()) {
        lines.push(`フォーム${i + 1}: ${f.id || 'IDなし'}`, `送信: ${f.method.toUpperCase()} ${f.action.origin || ''}${f.action.path || ''}${f.action.query ? '（クエリあり）' : ''}`);
        for (const e of f.fields) lines.push(`  ${e.tag} type=${e.type} name=${e.name || 'なし'} id=${e.id || 'なし'}${e.disabled ? ' 無効' : ''}${e.readOnly ? ' 読取専用' : ''}`);
      }
    }
    output.textContent = lines.join('\n');
  } catch (e) { output.textContent = e.message; }
  finally { button.disabled = false; }
});
send('AUTO_STATUS').then(data => { if (data.config) for (const key of ['owner', 'repo', 'path', 'provider']) byId(key).value = data.config[key]; if (data.configured) byId('token').required = false; render(data); }).catch(e => { message.textContent = e.message; });
// Only this open UI refreshes on a timer. The worker's actual scheduler uses alarms.
setInterval(() => refresh().catch(() => {}), 15000);
