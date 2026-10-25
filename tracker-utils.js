(function (root) {
  'use strict';
  const xHosts = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'm.twitter.com']);
  const reserved = new Set(['home', 'explore', 'search', 'notifications', 'messages', 'settings', 'i', 'intent', 'share', 'login', 'logout', 'signup', 'compose', 'tos', 'privacy', 'about', 'help', 'download', 'hashtag']);
  function parseXInput(value) {
    const raw = String(value || '').trim();
    if (!raw) return { account: '', postUrl: '' };
    let account = raw.replace(/^@/, ''), postUrl = '';
    if (/^[\w.-]+\.[a-z]+\//i.test(raw) || raw.includes('://')) {
      let url;
      try { url = new URL(raw.includes('://') ? raw : 'https://' + raw); } catch (_) { throw new Error('XのプロフィールURLまたは投稿URLを入力してください'); }
      if (!['http:', 'https:'].includes(url.protocol) || !xHosts.has(url.hostname) || url.username || url.password || url.port) {
        throw new Error('x.com または twitter.com のURLを入力してください');
      }
      const parts = url.pathname.split('/').filter(Boolean);
      try { account = decodeURIComponent(parts[0] || '').replace(/^@/, ''); } catch (_) { account = ''; }
      const profileTab = parts.length === 2 && ['with_replies', 'media', 'likes', 'highlights', 'articles', 'followers', 'following', 'verified_followers'].includes(parts[1]);
      const post = parts.length >= 3 && parts[1] === 'status' && /^\d+$/.test(parts[2]) &&
        (parts.length === 3 || (parts.length === 5 && ['photo', 'video'].includes(parts[3]) && /^\d+$/.test(parts[4])));
      if (parts.length !== 1 && !profileTab && !post) throw new Error('ユーザー名を含むプロフィールURLまたは投稿URLを入力してください');
      if (post) postUrl = `https://x.com/${account}/status/${parts[2]}`;
    }
    if (!/^[a-zA-Z0-9_]{1,15}$/.test(account) || reserved.has(account.toLowerCase())) {
      throw new Error('有効なXユーザー名（英数字・_、15文字以内）またはプロフィールURLを入力してください');
    }
    return { account, postUrl };
  }

  function normalizePhrases(values) {
    return [...new Set(values.filter(v => typeof v === 'string').map(v => v.trim()).filter(v => v && v.length <= 160))].slice(0, 20);
  }
  function suggestPhrases(artists) {
    const counts = new Map();
    for (const artist of artists) {
      const note = String(artist.note || '').trim();
      if (note && note.length <= 160 && !/[\r\n]/.test(note)) counts.set(note, (counts.get(note) || 0) + 1);
    }
    const repeated = [...counts].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([note]) => note);
    return repeated.length ? repeated : ['要確認', '継続確認', '保存予定'];
  }
  function appendPhrase(value, phrase) {
    const note = String(value || '');
    const trimmed = note.trim();
    // Only whole phrases count as duplicates; substrings must still be insertable.
    if (trimmed === phrase || trimmed.startsWith(phrase + ' / ') || trimmed.endsWith(' / ' + phrase) ||
        trimmed.includes(' / ' + phrase + ' / ') || trimmed.split(/[\r\n]+/).includes(phrase)) return note;
    return trimmed ? `${note} / ${phrase}` : phrase;
  }

  const archiveHosts = ['archive.md','archive.li','archive.ph','archive.is','archive.today','archive.vn','archive.fo'];
  const providers = {
    gyotaku: { label: 'ウェブ魚拓', home: 'https://megalodon.jp/', hint: '対象URLを入力済みの取得画面を開きます。人間確認後に「取得」を押してください。取得開始後は画面を閉じても続行されます。結果URLを登録するとプロフィール本文を自動確認します。' },
    'archive.md': { label: 'archive.md', home: 'https://archive.md/', hint: 'archive.today系の保存サービスです。コピーしたURLを保存欄へ貼り付けてください。' },
    'archive.li': { label: 'archive.li', home: 'https://archive.li/', hint: 'archive.mdと同じarchive.today系です。別系統の保存先には下のサービスを選べます。' },
    ghostarchive: { label: 'Ghostarchive', home: 'https://ghostarchive.org/', hint: '無料・アカウント不要。コピーしたURLを保存欄へ貼り付けます。Xの本文まで保存できたか結果を確認してください。' },
    wayback: { label: 'Wayback Machine', home: 'https://web.archive.org/save/', hint: 'Save Page Nowの入力欄へ貼り付けます。Xは取得制限で保存できない場合があります。「過去の保存を探す」も利用できます。' },
    perma: { label: 'Perma.cc', home: 'https://perma.cc/', hint: 'アカウントと保存枠が必要です。ログイン後にコピーしたURLを保存してください。Xの保存可否は結果の確認が必要です。' },
  };
  function archiveResult(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
      const path = url.pathname;
      // Parsing an address proves its shape, never the archived page content.
      let provider = '', status = 'pending';
      if (archiveHosts.includes(url.hostname)) {
        if (/^\/wip\/(?:[a-zA-Z0-9]+|\d{4}\.\d{2}\.\d{2}-\d{6}(?:\/https?:\/\/.+)?)\/?$/.test(path)) status = 'pending';
        else if (!/^\/[a-zA-Z0-9]{5}\/?$/.test(path) && !/^\/(?:\d{8,14}|\d{4}\.\d{2}\.\d{2}-\d{6})\/https?:\/\/.+/.test(path)) return null;
        if (['/about'].includes(path.replace(/\/$/, ''))) return null;
        provider = 'archive.today';
      } else if (['ghostarchive.org', 'www.ghostarchive.org'].includes(url.hostname) && /^\/archive\/[a-zA-Z0-9]+\/?$/.test(path)) provider = 'ghostarchive';
      else if (url.hostname === 'web.archive.org' && /^\/web\/\d{14}(?:[a-z]+_)?\/https?:\/\/.+/.test(path)) provider = 'wayback';
      else if (['perma.cc', 'www.perma.cc'].includes(url.hostname) && /^\/[A-Z0-9]{4}-[A-Z0-9]{4}\/?$/i.test(path)) provider = 'perma';
      else if (url.hostname === 'megalodon.jp') {
        const match = path.match(/^\/\d{4}-\d{4}-\d{4}-\d{2}\/(https?:\/\/.+)$/);
        if (!match) return null;
        const original = new URL(match[1]);
        if (!original.hostname || original.username || original.password) return null;
        provider = 'gyotaku';
        // The same URL is issued before capture finishes; a URL is not proof of success.
        status = 'pending';
      } else return null;
      return { url: url.href, provider, status };
    } catch (_) { return null; }
  }
  function archiveLabel(provider) {
    return provider === 'archive.today' ? 'archive.today系' : (providers[provider]?.label || 'Archive');
  }
  function archiveResults(artist) {
    const results = [], seen = new Set();
    const entries = Array.isArray(artist.archives) ? artist.archives : [];
    for (const entry of [...entries, { url: artist.archive_url, target_url: artist.archive_target_url, saved_at: artist.archive_checked_at, status: artist.archive_status }]) {
      const parsed = entry && archiveResult(entry.url);
      if (!parsed || seen.has(parsed.url)) continue;
      const done = entry.status === 'done' && !new URL(parsed.url).pathname.startsWith('/wip/');
      results.push({ ...entry, ...parsed, status: done ? 'done' : 'pending', ...(done && !entry.content_verified_at ? { legacy_unverified: true } : {}) });
      seen.add(parsed.url);
    }
    return results;
  }
  function recordArchive(artist, url, target, now, contentVerified = false) {
    const parsed = archiveResult(url);
    if (!parsed) throw new Error('保存結果のURLを入力してください（サービスのトップ・検索・保存画面は登録できません）');
    const existing = archiveResults(artist);
    if (!new URL(parsed.url).pathname.startsWith('/wip/') && (contentVerified || existing.some(entry => entry.url === parsed.url && entry.status === 'done'))) {
      parsed.status = 'done';
      parsed.content_verified_at = existing.find(entry => entry.url === parsed.url)?.content_verified_at || now;
      parsed.verification_method = existing.find(entry => entry.url === parsed.url)?.verification_method || 'manual';
    }
    const results = existing.filter(entry => entry.url !== parsed.url &&
      !(parsed.status === 'done' && entry.status === 'pending' && entry.provider === parsed.provider && entry.target_url === target));
    results.push({ ...parsed, target_url: target, saved_at: now });
    artist.archives = results;
    // A second service still processing must not hide an already completed capture.
    const primary = [...results].reverse().find(entry => entry.status === 'done') || results[results.length - 1];
    artist.archive_status = primary.status;
    artist.archive_url = primary.url;
    artist.archive_provider = primary.provider;
    artist.archive_target_url = primary.target_url;
    artist.archive_checked_at = now;
    delete artist.archive_error;
    return parsed;
  }
  const api = { parseXInput, normalizePhrases, suggestPhrases, appendPhrase, providers, archiveResult, archiveLabel, archiveResults, recordArchive };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TrackerUtils = api;
})(globalThis);
