'use strict';
(function (root) {
  // Read only public homepage form metadata. Never collect input values,
  // cookies, page HTML or query strings, and never submit or navigate a tab.
  function inspectFormDocument() {
    const hosts = ['archive.li', 'archive.md', 'archive.ph', 'archive.is', 'archive.today', 'archive.vn', 'archive.fo', 'ghostarchive.org'];
    const here = new URL(location.href);
    if (here.protocol !== 'https:' || here.port || here.username || here.password || !hosts.includes(here.hostname) || !['/', '/submit', '/submit/'].includes(here.pathname)) return { error: '保存先のトップページが対象です' };
    function address(value) {
      try {
        const u = new URL(value, document.baseURI);
        return { origin: u.origin, path: u.pathname.slice(0, 240), query: Boolean(u.search), credentials: Boolean(u.username || u.password) };
      } catch (_) { return { invalid: true }; }
    }
    return {
      page: address(here.href), title: document.title.slice(0, 120), ready: document.readyState,
      forms: [...document.forms].slice(0, 8).map(form => ({
        id: (form.getAttribute('id') || '').slice(0, 80), method: (form.getAttribute('method') || 'get').toLowerCase(),
        action: address(form.getAttribute('action') || here.href),
        fields: [...form.elements].filter(e => ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.tagName)).slice(0, 16).map(e => ({
          tag: e.tagName, name: (e.name || '').slice(0, 80), id: (e.id || '').slice(0, 80), type: e.type,
          disabled: Boolean(e.disabled), readOnly: Boolean(e.readOnly)
        }))
      }))
    };
  }
  async function collect(chrome) {
    const hosts = ['archive.li', 'archive.md', 'archive.ph', 'archive.is', 'archive.today', 'archive.vn', 'archive.fo', 'ghostarchive.org'];
    const tabs = await chrome.tabs.query({ url: hosts.map(h => 'https://' + h + '/*') });
    const pages = [];
    for (const tab of tabs) {
      if (pages.length >= 5) break;
      let u;
      try { u = new URL(tab.url || ''); } catch (_) { continue; }
      if (u.protocol !== 'https:' || u.port || u.username || u.password || !hosts.includes(u.hostname) || !['/', '/submit', '/submit/'].includes(u.pathname)) continue;
      if (!await chrome.permissions.contains({ permissions: ['scripting'], origins: [u.origin + '/*'] })) continue;
      try {
        const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: inspectFormDocument });
        if (result[0]?.result) pages.push(result[0].result);
      } catch (_) { pages.push({ page: { origin: u.origin, path: u.pathname }, error: 'ページを読み込んでから、もう一度診断してください' }); }
    }
    const diagnostics = { version: chrome.runtime.getManifest().version, checkedAt: Date.now(), pages };
    // This key is never included in the GitHub job ledger or tracker messages.
    await chrome.storage.local.set({ autoArchiveFormDiagnostics: diagnostics });
    return diagnostics;
  }
  const api = { inspectFormDocument, collect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AutoArchiveFormDiagnostics = api;
})(globalThis);
