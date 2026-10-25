(function (root) {
  'use strict';
  const valid = /^[A-Za-z0-9_]{1,15}$/;
  function account(value) {
    const name = String(value || '').trim().replace(/^[@＠]/, '');
    if (!valid.test(name)) throw new Error('ユーザー名は英数字・_の1〜15文字で入力してください');
    return name;
  }
  // Only standalone handle lines: never turn mentions in a bio into mute records.
  function extract(text) {
    const found = new Map();
    for (const line of String(text || '').split(/\r?\n/)) {
      const match = line.trim().match(/^[@＠]([A-Za-z0-9_]{1,15})\s*$/);
      if (match) found.set(match[1].toLowerCase(), match[1]);
    }
    return [...found.values()];
  }
  function parseReviewed(text) {
    const found = new Map();
    for (const line of String(text || '').split(/\r?\n/).filter(v => v.trim())) {
      const name = account(line);
      found.set(name.toLowerCase(), name);
    }
    if (!found.size) throw new Error('確認済みユーザー名を1行に1件入力してください');
    return [...found.values()];
  }
  function merge(artists, names, source, at, makeId) {
    const owner = account(source).toLowerCase();
    const next = JSON.parse(JSON.stringify(artists));
    let added = 0, updated = 0;
    for (const value of names) {
      const name = account(value);
      let artist = next.find(a => String(a.x_account || '').trim().replace(/^@/, '').toLowerCase() === name.toLowerCase());
      if (!artist) {
        artist = { id: makeId(), name, x_account: name, tracking_mode: 'monitor_only', works: [], threads_posts: [], added_at: at.slice(0, 10), fetch_status: 'none' };
        next.push(artist); added++;
      } else updated++;
      // Separate observations by the user's own X account; never infer unmute.
      artist.x_mute_observations = { ...artist.x_mute_observations,
        [owner]: { muted: true, observed_at: at, source: 'screenshot_reviewed' } };
      artist.x_muted = true;
    }
    return { artists: next, added, updated };
  }
  const api = { account, extract, parseReviewed, merge };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MuteImportUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
