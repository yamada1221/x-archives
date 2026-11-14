'use strict';
(function (root) {
  const C = typeof module !== 'undefined' && module.exports ? require('./auto-core.js') : root.AutoArchiveCore;
  const Today = typeof module !== 'undefined' && module.exports ? require('./auto-today.js') : root.AutoArchiveToday;
  const Ghost = typeof module !== 'undefined' && module.exports ? require('./auto-ghost.js') : root.AutoArchiveGhost;
  // Isolated-world, read-only lookup. Strip queries and never collect input
  // values, navigate a tab, follow a link or make a new save request.
  function readSearchResultLinks({ expectedURL, origins }) {
    const here = new URL(location.href), expected = new URL(expectedURL);
    if (here.origin !== expected.origin || here.pathname !== expected.pathname || here.search !== expected.search || !origins.includes(here.origin)) return [];
    const links = [];
    for (const a of [...document.querySelectorAll('a[href]')].slice(0, 300)) {
      try {
        const u = new URL(a.getAttribute('href'), location.href);
        if (u.protocol !== 'https:' || u.port || u.username || u.password || !origins.includes(u.origin)) continue;
        const text = a.closest('tr')?.innerText || a.innerText || a.textContent || '';
        links.push({ url: u.origin + u.pathname, label: text.replace(/\s+/g, ' ').trim().slice(0, 180) });
      } catch (_) { /* Ignore unrelated links. */ }
    }
    return links;
  }
  async function collect(chrome, job) {
    const target = C.targetURL(job.target_url), provider = job.provider || 'ghostarchive';
    if (!target) throw Error('対象のプロフィールURLを確認できません');
    const origins = provider === 'archive.today' ? C.ARCHIVE_HOSTS.map(h => 'https://' + h) : ['https://ghostarchive.org'];
    const tabs = await chrome.tabs.query({ url: origins.map(o => o + '/*') });
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const found = new Map();
    function add(value, label, source) {
      const url = C.resultURL(value);
      if (!url || C.resultProvider(url) !== provider || found.has(url) || found.size >= 20) return;
      found.set(url, { url, label: String(label || '').slice(0, 180), source });
    }
    let inspected = 0, directInspected = 0;
    for (const tab of tabs) {
      if (found.size >= 20) break;
      let u; try { u = new URL(tab.url || ''); } catch (_) { continue; }
      if (!origins.includes(u.origin) || u.username || u.password || u.port) continue;
      if (!await chrome.permissions.contains({ permissions: ['scripting'], origins: [u.origin + '/*'] })) continue;
      if (C.resultProvider(tab.url) === provider) {
        if (directInspected >= 40 || tab.pendingUrl || tab.status && tab.status !== 'complete') continue;
        directInspected++;
        try {
          const func = provider === 'archive.today' ? Today.inspectTodayDocument : Ghost.inspectGhostDocument;
          const frames = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func,
            args: provider === 'ghostarchive' ? [u.pathname.split('/').filter(Boolean).pop()] : [] });
          const page = frames[0]?.result;
          // A same-account replies capture can also contain its profile.
          // Read the wrapper target before offering it; body verification
          // still runs separately when the user adopts the selected result.
          const capturedTarget = C.targetURL(page?.original_url);
          if (page?.kind === 'archive' && C.targetCovers(target, capturedTarget) &&
              C.resultProvider(page.receipt) === provider && C.resultURL(page.receipt) === C.resultURL(tab.url)) {
            add(page.receipt, tab.title, capturedTarget !== target ?
              '返信タブの保存結果（プロフィール確認候補・本文未確認）' : '保存結果ページ（対象URL確認済み・本文未確認）');
          }
        } catch (_) { /* Missing metadata, challenges or a changed tab are excluded. */ }
        continue;
      }
      const searchTarget = C.searchTarget(tab.url);
      if (!C.targetCovers(target, searchTarget) || inspected >= 5) continue;
      inspected++;
      try {
        const frames = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readSearchResultLinks, args: [{ expectedURL: tab.url, origins }] });
        for (const link of frames[0]?.result || []) add(link.url, link.label, searchTarget !== target ?
          '返信タブの保存結果（プロフィール確認候補・本文未確認）' : '保存一覧のリンク（本文未確認）');
      } catch (_) { /* An unloaded/challenge page yields no selectable result. */ }
    }
    return [...found.values()];
  }
  const api = { readSearchResultLinks, collect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AutoArchiveReceiptPicker = api;
})(globalThis);
