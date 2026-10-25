'use strict';
(function (root) {
  const C = root.AutoArchiveCore, SETTINGS = 'autoArchiveSettings', DEVICE = 'autoArchiveDevice';
  const SCAN = 'auto-archive-scan', STEP = 'auto-archive-step';
  const ORIGINS = ['https://api.github.com/*', 'https://api.fxtwitter.com/*', 'https://ghostarchive.org/*'];
  const store = new root.AutoArchiveStore();
  let running = null;
  async function settings() { return (await chrome.storage.local.get(SETTINGS))[SETTINGS]; }
  async function device() {
    let id = (await chrome.storage.local.get(DEVICE))[DEVICE];
    if (!id) { id = crypto.randomUUID(); await chrome.storage.local.set({ [DEVICE]: id }); }
    return id;
  }
  async function profile(handle, id = '') {
    const fetchOne = async target => {
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 25000);
      try {
        const r = await fetch('https://api.fxtwitter.com/2/profile/' + encodeURIComponent(target).replace('%3A', ':'), { signal: ctrl.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
        const text = await r.text(); if (text.length > 524288) throw Error('プロフィール応答が大きすぎます');
        return C.classifyProfile(JSON.parse(text), r.status, handle, id);
      } finally { clearTimeout(timer); }
    };
    try { return await fetchOne(id ? 'id:' + id : handle); }
    catch (error) { if (id) return fetchOne(handle); throw error; }
  }
  async function engine() {
    const value = await settings(); if (!value?.token) return null;
    const config = C.config(value), id = await device();
    return new root.AutoArchiveEngine.Engine({ config, store, git: new root.AutoArchiveGitHub(config), ghost: new root.AutoArchiveGhost.Ghost(chrome), profile, device: id,
      ready: async version => { const latest = await settings(); if (latest && C.scope(latest) === C.scope(config)) await chrome.storage.local.set({ [SETTINGS]: { ...latest, providerReady: version } }); },
      canSubmit: async job => {
        const latest = await settings();
        return Boolean(latest && C.scope(latest) === C.scope(config) && (job.kind === 'connection_test' || latest.enabled && latest.providerReady === C.ADAPTER_VERSION));
      } });
  }
  async function ensure() {
    const cfg = await settings();
    if (!cfg?.token) return;
    const e = await engine(), state = await e.state();
    if (cfg.enabled) {
      if (!await chrome.alarms.get(SCAN)) await chrome.alarms.create(SCAN, { when: Math.max(Date.now() + 1000, state.nextScanAt || Date.now()), periodInMinutes: 360 });
    } else await chrome.alarms.clear(SCAN);
    const pending = state.jobs.some(j => !C.TERMINAL.has(j.state) &&
      (cfg.enabled || j.submission_started_at || j.kind === 'connection_test')) || state.jobs.some(j => j.dirty || j.state === 'succeeded' && !j.applied);
    if (pending) {
      if (!await chrome.alarms.get(STEP)) await chrome.alarms.create(STEP, { delayInMinutes: 1, periodInMinutes: 1 });
    } else await chrome.alarms.clear(STEP);
  }
  async function kick(forceScan = false) {
    if (running) { await ensure(); return running; }
    running = (async () => {
      const e = await engine(); if (!e) return;
      if (!await chrome.permissions.contains({ permissions: ['scripting'], origins: ORIGINS })) throw Error('設定画面から保存先・GitHubへのアクセス権限を許可してください');
      await e.run({ forceScan });
      const state = await e.state(), attention = state.jobs.filter(j => ['needs_review', 'submission_unknown'].includes(j.state)).length;
      if (attention || state.lastError) {
        await chrome.action.setBadgeText({ text: 'A!' }); await chrome.action.setBadgeBackgroundColor({ color: '#a33d13' });
      } else if ((await settings())?.enabled) await chrome.action.setBadgeText({ text: '' });
    })();
    try { await running; }
    catch (error) {
      const e = await engine();
      if (e) { const s = await e.state(); s.lastError = error.message; await e.save(s); }
      await chrome.action.setBadgeText({ text: 'A!' }).catch(() => {});
      throw error;
    } finally { running = null; await ensure(); }
  }
  function privileged(sender) {
    return sender.id === chrome.runtime.id && !sender.tab && ['popup.html', 'auto-options.html'].some(p => sender.url === chrome.runtime.getURL(p));
  }
  function tracker(sender) {
    if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0) return false;
    try { const u = new URL(sender.url); return u.origin === 'https://yamada1221.github.io' && ['/x-archives/', '/x-archives/index.html'].includes(u.pathname); } catch (_) { return false; }
  }
  async function status(full = false) {
    const cfg = await settings(), e = await engine();
    if (!e) return { ok: true, configured: false, enabled: false, jobs: [] };
    const state = await e.state();
    return { ok: true, configured: true, enabled: cfg.enabled, ready: cfg.providerReady === C.ADAPTER_VERSION,
      device: full ? await device() : undefined, nextScanAt: state.nextScanAt, lastRunAt: state.lastRunAt, error: state.lastError,
      candidates: state.candidateCount || 0,
      config: full ? { owner: cfg.owner, repo: cfg.repo, path: cfg.path } : undefined,
      jobs: state.jobs.slice(-100).map(j => ({ job_id: j.job_id, artist_id: j.artist_id, handle: j.identity?.handle || j.registered_handle,
        state: j.state, label: C.LABELS[j.state], error: j.last_error || '', receipt: C.resultURL(j.receipt),
        scope: j.verification?.scope, posts: j.verification?.posts_verification, captured_at: j.verification?.captured_at,
        next_attempt_at: j.next_attempt_at, sync_pending: Boolean(j.dirty || j.state === 'succeeded' && !j.applied),
        test: j.kind === 'connection_test' })) };
  }
  async function handle(message, sender) {
    if (message?.type?.startsWith('AUTO_PAGE_')) {
      if (!tracker(sender)) throw Error('トラッカーの送信元を確認できません');
      const cfg = await settings();
      if (!cfg || message.owner !== cfg.owner || message.repo !== cfg.repo || message.path !== cfg.path) return { ok: true, configured: false, enabled: false, jobs: [] };
      if (message.type === 'AUTO_PAGE_REFRESH') {
        if (cfg && message.owner === cfg.owner && message.repo === cfg.repo && message.path === cfg.path) await kick(true);
        return status(false);
      }
      if (message.type === 'AUTO_PAGE_STATUS') return status(false);
      throw Error('対応していない操作です');
    }
    if (!privileged(sender)) throw Error('拡張機能の画面から操作してください');
    if (message.type === 'AUTO_STATUS') return status(true);
    if (message.type === 'AUTO_SAVE') {
      const old = await settings(); const next = C.config({ ...message.config, enabled: false });
      if (old && C.scope(old) === C.scope(next)) next.providerReady = old.providerReady || '';
      if (!await chrome.permissions.contains({ permissions: ['scripting'], origins: ORIGINS })) throw Error('設定画面で必要なアクセス権限を許可してください');
      await chrome.storage.local.set({ [SETTINGS]: next });
      await (await engine()).claim(false); await ensure(); return status(true);
    }
    const e = await engine(); if (!e) throw Error('先にGitHub接続設定を保存してください');
    if (message.type === 'AUTO_CLAIM') { await e.claim(true); return { ok: true }; }
    if (message.type === 'AUTO_TEST') { await e.enqueueTest(); await kick(false); return status(true); }
    if (message.type === 'AUTO_START' || message.type === 'AUTO_STOP') {
      const cfg = await settings();
      if (message.type === 'AUTO_START') {
        if (cfg.providerReady !== C.ADAPTER_VERSION) throw Error('先に「接続テスト」を完了してください。本文確認後に開始できます');
        await e.claim(false);
      }
      await chrome.storage.local.set({ [SETTINGS]: { ...cfg, enabled: message.type === 'AUTO_START' } });
      await ensure(); if (message.type === 'AUTO_START') await kick(true); return status(true);
    }
    if (message.type === 'AUTO_RUN') { await kick(true); return status(true); }
    if (message.type === 'AUTO_ADOPT') { await e.adopt(message.job_id, message.receipt); await kick(); return status(true); }
    if (message.type === 'AUTO_SHOW') {
      const state = await e.state(), job = state.jobs.find(j => j.job_id === message.job_id);
      if (!job) throw Error('確認対象が見つかりません');
      await e.ghost.show(job); return { ok: true };
    }
    throw Error('対応していない操作です');
  }
  chrome.alarms.onAlarm.addListener(alarm => { if ([SCAN, STEP].includes(alarm.name)) kick(alarm.name === SCAN).catch(() => {}); });
  chrome.runtime.onStartup.addListener(() => { ensure().then(() => kick(false)).catch(() => {}); });
  chrome.runtime.onInstalled.addListener(() => { ensure().catch(() => {}); });
  // Lost alarms are reconstructed on every worker start. Configured jobs are
  // resumed by their persisted due times, not by keeping this worker alive.
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
  ensure().catch(() => {});
  root.AutoArchiveRuntime = { handle, status, kick, ensure, ORIGINS };
})(globalThis);
