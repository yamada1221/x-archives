'use strict';
(function (root) {
  const C = typeof module !== 'undefined' && module.exports ? require('./auto-core.js') : root.AutoArchiveCore;
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
    let inspected = 0;
    for (const tab of tabs) {
      let u; try { u = new URL(tab.url || ''); } catch (_) { continue; }
      if (!origins.includes(u.origin) || u.username || u.password || u.port) continue;
      if (!await chrome.permissions.contains({ permissions: ['scripting'], origins: [u.origin + '/*'] })) continue;
      if (C.resultProvider(tab.url) === provider) {
        add(tab.url, tab.title, '保存結果ページ'); continue;
      }
      if (C.searchTarget(tab.url) !== target || inspected >= 5) continue;
      inspected++;
      try {
        const frames = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readSearchResultLinks, args: [{ expectedURL: tab.url, origins }] });
        for (const link of frames[0]?.result || []) add(link.url, link.label, '保存一覧のリンク');
      } catch (_) { /* An unloaded/challenge page yields no selectable result. */ }
    }
    return [...found.values()];
  }
  const api = { readSearchResultLinks, collect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AutoArchiveReceiptPicker = api;
})(globalThis);
