'use strict';
(function (root) {
  // These two functions run in isolated extension worlds. They are self-contained
  // so Chrome can serialize them, and never execute code received from a page.
  function inspectGhostDocument(archiveId = '') {
    const url = new URL(location.href);
    if (url.origin !== 'https://ghostarchive.org') return { kind: 'untrusted' };
    const text = (document.body?.innerText || '').slice(0, 12000);
    const challenge = /verify (?:that )?you are human|checking your browser|just a moment|error code: 1010|attention required/i.test(text) ||
      Boolean(document.querySelector('iframe[src*="challenges.cloudflare.com"],input[name="cf-turnstile-response"]'));
    if (url.pathname === '/') {
      const input = document.querySelector('input#archive[name="archive"]'), form = input?.form;
      return { kind: challenge ? 'blocked' : form && form.action === 'https://ghostarchive.org/archive2' && form.method.toLowerCase() === 'post' ? 'form' : 'changed' };
    }
    if (url.pathname === '/search') {
      const receipts = [...document.querySelectorAll('a[href]')].map(a => {
        try { const u = new URL(a.href); return u.origin === url.origin && /^\/archive\/[A-Za-z0-9]+$/.test(u.pathname) ? u.href : ''; } catch (_) { return ''; }
      }).filter(Boolean);
      return { kind: challenge ? 'blocked' : 'search', receipts: [...new Set(receipts)].slice(0, 10) };
    }
    const match = url.pathname.match(/^\/archive\/([A-Za-z0-9]+)\/?$/);
    if (match && (!archiveId || match[1] === archiveId)) {
      if (challenge) return { kind: 'blocked', receipt: url.origin + url.pathname };
      const replay = document.querySelector('replay-web-page');
      const original = document.querySelector('#searchInput')?.value || replay?.getAttribute('url') || '';
      const stamp = text.match(/Archive date:\s*([^\n]+)/i)?.[1];
      const captured = stamp ? Date.parse(stamp) : NaN;
      const fallback = [...document.querySelectorAll('a[href]')].map(a => a.href).find(v => {
        try { const u = new URL(v); return u.origin === url.origin && u.pathname === url.pathname && u.search === '?wr=false'; } catch (_) { return false; }
      });
      return { kind: /Archiving in progress|When the archival process is finished|^Loading\./i.test(document.title + '\n' + text) ? 'processing' : 'archive',
        receipt: url.origin + url.pathname, original_url: original, captured_at: Number.isFinite(captured) ? new Date(captured).toISOString() : '', fallback: fallback || '' };
    }
    if (archiveId && new RegExp('^/news[0-9]*/' + archiveId + '/web/ghost/?$').test(url.pathname)) {
      const primary = document.querySelector('[data-testid="primaryColumn"]');
      const header = primary?.querySelector('[data-testid="UserName"]');
      if (!header) return { kind: 'empty' };
      const headerText = header.innerText.trim(), h = headerText.match(/(?:^|\s)@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/);
      if (!h) return { kind: 'empty' };
      const name = headerText.slice(0, h.index).trim();
      const actions = primary.querySelector('[data-testid="userActions"]');
      const idNode = actions?.querySelector('[data-testid$="-follow"],[data-testid$="-unfollow"]');
      const id = idNode?.getAttribute('data-testid')?.match(/^(\d+)-(?:un)?follow$/)?.[1] || '';
      function original(href) {
        const rewritten = href.match(/\/a\/href\/(https?:\/\/.+)$/);
        try { const u = new URL(rewritten ? rewritten[1] : href); return ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(u.hostname) ? u.pathname.toLowerCase() : ''; }
        catch (_) { return ''; }
      }
      const following = [...primary.querySelectorAll('a[href]')].some(a => original(a.href) === '/' + h[1].toLowerCase() + '/following');
      const post_ids = [...primary.querySelectorAll('article[data-testid="tweet"]')].flatMap(article => {
        const a = article.querySelector('time')?.closest('a[href]');
        const path = a && original(a.href);
        const m = path && path.match(new RegExp('^/' + h[1].toLowerCase() + '/status/(\\d+)$'));
        return m && article.querySelector('[data-testid="tweetText"]')?.innerText.trim() ? [m[1]] : [];
      });
      return { kind: 'profile', handle: h[1], name, bio: primary.querySelector('[data-testid="UserDescription"]')?.innerText || '', user_id: id, following, post_ids: post_ids.slice(0, 20) };
    }
    return { kind: 'untrusted' };
  }
  function submitGhostDocument(target, jobId) {
    if (location.href !== 'https://ghostarchive.org/' || !/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}$/.test(target)) return { submitted: false, reason: '対象URLを確認できません' };
    if (/verify (?:that )?you are human|checking your browser|just a moment|error code: 1010/i.test(document.body?.innerText || '') ||
      document.querySelector('iframe[src*="challenges.cloudflare.com"],input[name="cf-turnstile-response"]')) return { submitted: false, reason: '保存先で人間確認が必要です' };
    const input = document.querySelector('input#archive[name="archive"]'), form = input?.form;
    if (!form || form.action !== 'https://ghostarchive.org/archive2' || form.method.toLowerCase() !== 'post') return { submitted: false, reason: '保存フォームの構造が変わっています' };
    if (form.dataset.xTrackerSubmitted) return { submitted: false, uncertain: true, reason: 'このページでは既に送信が開始されています' };
    form.dataset.xTrackerSubmitted = jobId;
    input.value = target;
    form.requestSubmit();
    return { submitted: true };
  }
  class Ghost {
    constructor(chrome) { this.chrome = chrome; }
    async binding(job) {
      const key = 'autoArchiveTab:' + job.job_id;
      const id = (await this.chrome.storage.session.get(key))[key];
      if (!Number.isInteger(id)) return null;
      try {
        const tab = await this.chrome.tabs.get(id);
        const u = new URL(tab.url || tab.pendingUrl);
        if (u.origin !== 'https://ghostarchive.org' && tab.url !== 'about:blank') return null;
        return tab;
      } catch (_) { return null; }
    }
    async open(job, url) {
      const existing = await this.binding(job);
      if (existing) return existing;
      const tab = await this.chrome.tabs.create({ url: 'about:blank', active: false });
      await this.chrome.storage.session.set({ ['autoArchiveTab:' + job.job_id]: tab.id });
      return this.chrome.tabs.update(tab.id, { url });
    }
    async inspect(job) {
      let tab = await this.binding(job);
      if (!tab) {
        if (job.state === 'submitting' || job.state === 'submission_unknown') return { kind: 'missing' };
        tab = await this.open(job, job.receipt ? job.receipt + '?wr=false' : 'https://ghostarchive.org/');
      }
      if (tab.status !== 'complete' || tab.pendingUrl) return { kind: 'loading' };
      const archiveId = job.receipt?.split('/').pop() || '';
      const results = await this.chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: inspectGhostDocument, args: [archiveId] });
      const top = results.find(r => r.frameId === 0)?.result;
      if (!top) return { kind: 'loading' };
      if (top.kind === 'archive' && top.fallback && new URL(tab.url).search !== '?wr=false') {
        await this.chrome.tabs.update(tab.id, { url: top.fallback });
        return { ...top, kind: 'loading' };
      }
      return { ...top, frames: results.filter(r => r.frameId !== 0).map(r => r.result).filter(Boolean) };
    }
    async submit(job) {
      const tab = await this.binding(job);
      if (!tab) throw Error('送信先のタブを確認できません');
      const result = await this.chrome.scripting.executeScript({ target: { tabId: tab.id }, func: submitGhostDocument, args: [job.target_url, job.job_id] });
      return result[0]?.result || { uncertain: true };
    }
    async reconcile(job) {
      const state = await this.inspect(job);
      if (state.receipt) return state;
      // An unknown POST is never retried. Show the service's read-only search
      // for human reconciliation instead of choosing an arbitrary old capture.
      return { kind: 'unresolved', reason: '受付URLを確認できません。保存先の検索結果から結果URLを指定してください' };
    }
    async show(job) {
      const tab = await this.binding(job) || await this.open(job, job.receipt || 'https://ghostarchive.org/search?term=' + encodeURIComponent(job.target_url));
      await this.chrome.tabs.update(tab.id, { active: true });
      await this.chrome.windows.update(tab.windowId, { focused: true });
    }
    async close(job) {
      const tab = await this.binding(job);
      if (tab) await this.chrome.tabs.remove(tab.id).catch(() => {});
      await this.chrome.storage.session.remove('autoArchiveTab:' + job.job_id);
    }
  }
  const api = { Ghost, inspectGhostDocument, submitGhostDocument };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AutoArchiveGhost = api;
})(globalThis);
