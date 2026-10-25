'use strict';
(function (root) {
  const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
  const ADAPTER_VERSION = 'ghostarchive-dom-1';
  const LABELS = { queued: '保存待ち', opening: '保存先を準備中', submitting: '保存依頼中', processing: '保存処理中',
    verifying: '内容確認中', succeeded: '保存済み', retry_wait: '再試行待ち', submission_unknown: '受付結果不明',
    needs_review: '手動確認が必要', canceled: '中止', skipped: '対象外' };
  const TERMINAL = new Set(['succeeded', 'canceled', 'skipped', 'needs_review']);
  const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const handle = s => typeof s === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(s) &&
    !/^(home|search|settings|i|intent|login|logout|explore|messages|notifications)$/i.test(s);
  function config(value = {}) {
    const v = { owner: 'yamada1221', repo: 'x-archives', path: 'data/artists.json', ...value };
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(v.owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(v.repo)) throw Error('GitHubのownerとrepoを確認してください');
    if (typeof v.path !== 'string' || !/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.json$/.test(v.path) || v.path.split('/').some(p => p === '.' || p === '..')) throw Error('データファイルのパスを確認してください');
    if (typeof v.token !== 'string' || !v.token.trim() || /[\s\r\n]/.test(v.token) || v.token.length > 300) throw Error('Fine-grained PATを入力してください');
    return { owner: v.owner, repo: v.repo, path: v.path, token: v.token, enabled: v.enabled === true,
      providerReady: v.providerReady || '', nextScanAt: Number(v.nextScanAt) || 0 };
  }
  const scope = c => `${c.owner.toLowerCase()}/${c.repo.toLowerCase()}:${c.path}`;
  function profileURL(value) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password || u.port || !['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(u.hostname)) return '';
      const h = u.pathname.replace(/^\//, '').replace(/\/$/, '');
      return handle(h) ? 'https://x.com/' + h.toLowerCase() : '';
    } catch (_) { return ''; }
  }
  function resultURL(value) {
    try { const u = new URL(value); return u.origin === 'https://ghostarchive.org' && !u.username && !u.password && /^\/archive\/[A-Za-z0-9]+\/?$/.test(u.pathname) ? u.origin + u.pathname.replace(/\/$/, '') : ''; }
    catch (_) { return ''; }
  }
  function eligible(a) {
    if (!a || typeof a.id !== 'string' || !handle(a.x_account) || a.tracking_mode !== 'record') return false;
    const c = a.auto_archive || {};
    return c.enabled !== 'off' && c.enabled !== false && (!c.policy || c.policy === 'first_only') &&
      (!c.target || c.target === 'profile') && (!c.provider || ['inherit', 'ghostarchive'].includes(c.provider));
  }
  function completed(a) {
    // Preserve legacy registrations without claiming that they passed new verification.
    return Boolean(a.archive_status === 'done' && a.archive_url) || (a.archives || []).some(e => e?.status === 'done');
  }
  function sameAccount(a, job) {
    if (!a || a.id !== job.artist_id || !eligible(a)) return false;
    if (job.expected_x_user_id && a.x_user_id) return a.x_user_id === job.expected_x_user_id;
    return a.x_account.toLowerCase() === job.registered_handle.toLowerCase();
  }
  function classifyProfile(payload, status, username, id = '') {
    if (status !== 200 || payload?.code !== 200 || payload.reason || !payload.user) throw Error('プロフィール取得は判定不能です');
    const u = payload.user;
    if (typeof u.id !== 'string' || !/^\d+$/.test(u.id) || !handle(u.screen_name)) throw Error('プロフィールの数値IDを確認できません');
    if (id ? id !== u.id : u.screen_name.toLowerCase() !== username.toLowerCase()) throw Error('アカウントの数値ID・ユーザー名が一致しません');
    if (u.protected === true) throw Error('非公開アカウントのため保存を待機しています');
    return { id: u.id, handle: u.screen_name, name: typeof u.name === 'string' ? u.name : '', bio: typeof u.description === 'string' ? u.description : null };
  }
  function validateArtists(doc) {
    if (!doc || !Array.isArray(doc.artists)) throw Error('アカウント一覧の形式が正しくありません');
    const ids = new Set();
    for (const a of doc.artists) {
      if (!a || typeof a.id !== 'string' || !a.id || ids.has(a.id)) throw Error('アカウントIDが不正・重複しています');
      ids.add(a.id);
      if (a.x_user_id != null && (typeof a.x_user_id !== 'string' || !/^\d+$/.test(a.x_user_id))) throw Error('数値ユーザーIDは文字列で保存してください');
      if (a.archives != null && !Array.isArray(a.archives)) throw Error('アーカイブ履歴の形式が正しくありません');
    }
    return doc;
  }
  function ledger(doc) {
    if (!doc) return { version: 1, jobs: [], reservations: [], provider: {} };
    if (doc.version !== 1 || !Array.isArray(doc.jobs) || !Array.isArray(doc.reservations) || !doc.provider) throw Error('共有ジョブ台帳の形式が正しくありません');
    const ids = new Set();
    for (const j of doc.jobs) {
      if (!j || typeof j.job_id !== 'string' || ids.has(j.job_id) || !LABELS[j.state]) throw Error('共有ジョブの形式が正しくありません');
      if (j.receipt && !resultURL(j.receipt)) throw Error('共有ジョブの保存結果URLが不正です');
      if (j.receipt) j.receipt = resultURL(j.receipt);
      if (j.target_url && !profileURL(j.target_url)) throw Error('共有ジョブの対象URLが不正です');
      if (j.expected_x_user_id && (typeof j.expected_x_user_id !== 'string' || !/^\d+$/.test(j.expected_x_user_id))) throw Error('共有ジョブの数値IDが不正です');
      ids.add(j.job_id);
    }
    return doc;
  }
  function verify(outer, frames, job, now) {
    if (!outer || profileURL(outer.original_url) !== profileURL(job.target_url)) return { ok: false, reason: '保存先の対象URLが一致しません' };
    const stamp = Date.parse(outer.captured_at);
    if (!Number.isFinite(stamp) || stamp > now + 5 * MINUTE) return { ok: false, reason: '保存先の取得時刻を確認できません' };
    const p = frames.find(f => f.kind === 'profile' && f.handle?.toLowerCase() === job.identity?.handle.toLowerCase());
    if (!p || !p.following || !p.name) return { ok: false, reason: 'プロフィール本文・対象ハンドルを確認できません' };
    if (p.user_id && p.user_id !== job.expected_x_user_id) return { ok: false, reason: '保存本文の数値IDが別のアカウントです' };
    if (!p.user_id && (!job.identity || norm(p.name) !== norm(job.identity.name) || job.identity.bio === null || norm(p.bio) !== norm(job.identity.bio))) {
      return { ok: false, reason: '本文から同じアカウントだと確認する証拠が不足しています' };
    }
    const reused = Boolean(job.adopted_existing) || stamp < Date.parse(job.submission_started_at) - 5 * MINUTE;
    if (reused && !p.user_id) return { ok: false, reason: '過去の保存を採用するには、保存本文の数値IDによる照合が必要です' };
    return { ok: true, captured_at: new Date(stamp).toISOString(), verified_at: new Date(now).toISOString(),
      method: 'archived_profile_body', scope: ['profile'], posts_verification: p.post_ids?.length ? 'confirmed' : 'unconfirmed',
      post_ids: (p.post_ids || []).slice(0, 20), archived_user_id: p.user_id || '', reused_existing: reused };
  }
  function applyResult(doc, job) {
    validateArtists(doc);
    const a = doc.artists.find(a => a.id === job.artist_id);
    if (!sameAccount(a, job)) return false;
    const e = { provider: 'ghostarchive', url: resultURL(job.receipt), target_url: job.target_url, status: 'done',
      job_id: job.job_id, event_key: job.event_key, x_user_id: job.expected_x_user_id, requested_at: job.adopted_existing ? null : job.submission_started_at,
      captured_at: job.verification.captured_at, saved_at: job.verification.verified_at, content_verified_at: job.verification.verified_at,
      verification_method: job.verification.method, verified_scope: job.verification.scope, posts_verification: job.verification.posts_verification,
      reused_existing: job.verification.reused_existing };
    if (!e.url || !job.verification.ok) throw Error('未検証の結果は保存済みにできません');
    a.archives = [...(a.archives || []).filter(p => p.url !== e.url), e];
    a.archive_status = 'done'; a.archive_url = e.url; a.archive_provider = e.provider;
    a.archive_target_url = e.target_url; a.archive_checked_at = e.content_verified_at;
    if (!a.x_user_id) a.x_user_id = job.expected_x_user_id;
    delete a.archive_error;
    return true;
  }
  const api = { MINUTE, HOUR, DAY, ADAPTER_VERSION, LABELS, TERMINAL, norm, handle, config, scope, profileURL, resultURL,
    eligible, completed, sameAccount, classifyProfile, validateArtists, ledger, verify, applyResult };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AutoArchiveCore = api;
})(globalThis);
