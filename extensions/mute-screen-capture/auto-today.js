'use strict';
(function (root) {
  const C = typeof module !== 'undefined' && module.exports ? require('./auto-core.js') : root.AutoArchiveCore;
  const { Ghost } = typeof module !== 'undefined' && module.exports ? require('./auto-ghost.js') : root.AutoArchiveGhost;
  // Serialized into the isolated world. Inspect only archive.today's wrapper
  // and the saved body, never execute scripts or follow instructions from it.
  function inspectTodayDocument() {
    const url = new URL(location.href);
    const hosts = ['archive.li', 'archive.md', 'archive.ph', 'archive.is', 'archive.today', 'archive.vn', 'archive.fo'];
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.port) return { kind: 'untrusted' };
    const content = document.querySelector('#CONTENT');
    const text = (document.body?.innerText || '').slice(0, 16000);
    const challenge = Boolean(document.querySelector('iframe[src*="challenges.cloudflare.com"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"],input[name="cf-turnstile-response"],.g-recaptcha,.h-captcha,#challenge-form')) ||
      !content && /verify (?:that )?you are human|checking your browser|just a moment|captcha|unusual traffic|too many requests|access denied/i.test(document.title + '\n' + text);
    const receiptPath = /^\/[A-Za-z0-9]{5}\/?$/.test(url.pathname) && url.pathname.replace(/\/$/, '') !== '/about' ||
      /^\/wip\/(?:[A-Za-z0-9]+|\d{4}\.\d{2}\.\d{2}-\d{6}(?:\/https?:\/\/.+)?)\/?$/.test(url.pathname) ||
      /^\/(?:\d{8,14}|\d{4}\.\d{2}\.\d{2}-\d{6})\/https?:\/\/.+/.test(url.pathname);
    const receipt = receiptPath ? url.origin + url.pathname.replace(/\/$/, '') : '';
    if (challenge) return { kind: 'blocked', receipt };
    if (url.pathname === '/' || url.pathname === '/submit') {
      const input = document.querySelector('form#submit_form input[name="url"],form[action$="/submit"] input[name="url"]');
      const form = input?.form, action = form && new URL(form.action);
      return { kind: form && action.origin === url.origin && action.pathname === '/submit' && !action.search && form.method.toLowerCase() === 'post' ? 'form' : 'changed' };
    }
    if (!receipt) return { kind: 'untrusted' };
    if (url.pathname.startsWith('/wip/')) return { kind: 'processing', receipt };
    // The long share link contains the service's capture time in UTC and the
    // original URL. Metadata alone is never treated as a verified saved body.
    const values = [url.href, ...document.querySelectorAll('#SHARE_LONGLINK,#SHARE_ORIGINAL,#HEADER a[href],#HEADER input[value],link[rel="canonical"]')].map(v => typeof v === 'string' ? v : v.value || v.href || '');
    let original_url = '', captured_at = '';
    for (const value of values) {
      try {
        const u = new URL(value, url.href);
        if (u.protocol !== 'https:' || !hosts.includes(u.hostname) || u.port || u.username || u.password) continue;
        const m = u.pathname.match(/^\/(\d{4})\.?(\d{2})\.?(\d{2})-?(\d{2})(\d{2})(\d{2})\/(https?:\/\/.+)$/);
        if (!m) continue;
        const date = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
        if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date) continue;
        original_url = m[7]; captured_at = date; break;
      } catch (_) { /* Leave unverifiable metadata pending. */ }
    }
    const primary = content?.querySelector('[data-testid="primaryColumn"]') || content;
    const header = primary?.querySelector('[data-testid="UserName"]');
    let profile;
    if (header) {
      const value = header.innerText.trim(), h = value.match(/(?:^|\s)@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/);
      if (h) {
        const idNode = primary.querySelector('[data-testid="userActions"] [data-testid$="-follow"],[data-testid="userActions"] [data-testid$="-unfollow"]');
        const user_id = idNode?.getAttribute('data-testid')?.match(/^(\d+)-(?:un)?follow$/)?.[1] || '';
        function original(href) {
          // Accept the original X URL in archive.today's rewritten links.
          const match = href.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com(\/[^?#\s]*)/i);
          return match ? match[1].replace(/\/$/, '').toLowerCase() : '';
        }
        const following = [...primary.querySelectorAll('a[href]')].some(a => original(a.href) === '/' + h[1].toLowerCase() + '/following');
        const post_ids = [...primary.querySelectorAll('article[data-testid="tweet"]')].flatMap(article => {
          const link = article.querySelector('time')?.closest('a[href]');
          const m = link && original(link.href).match(new RegExp('^/' + h[1].toLowerCase() + '/status/(\\d+)$'));
          return m && article.querySelector('[data-testid="tweetText"]')?.innerText.trim() ? [m[1]] : [];
        });
        profile = { kind: 'profile', handle: h[1], name: value.slice(0, h.index).trim(),
          bio: primary.querySelector('[data-testid="UserDescription"]')?.innerText || '', user_id, following, post_ids: post_ids.slice(0, 20) };
      }
    }
    return { kind: 'archive', receipt, original_url, captured_at, profile };
  }
  function submitTodayDocument(target, jobId) {
    const url = new URL(location.href);
    const hosts = ['archive.li', 'archive.md', 'archive.ph', 'archive.is', 'archive.today', 'archive.vn', 'archive.fo'];
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.port || !['/', '/submit'].includes(url.pathname) || !/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}$/.test(target)) return { submitted: false, reason: '対象URLを確認できません' };
    if (/verify (?:that )?you are human|checking your browser|just a moment|captcha|unusual traffic|too many requests|access denied/i.test(document.title + '\n' + (document.body?.innerText || '')) ||
      document.querySelector('iframe[src*="challenges.cloudflare.com"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"],input[name="cf-turnstile-response"],.g-recaptcha,.h-captcha,#challenge-form')) return { submitted: false, reason: '保存先で人間確認・アクセス制限が必要です' };
    const input = document.querySelector('form#submit_form input[name="url"],form[action$="/submit"] input[name="url"]');
    const form = input?.form, action = form && new URL(form.action);
    if (!form || action.origin !== url.origin || action.pathname !== '/submit' || action.search || action.username || action.password || form.method.toLowerCase() !== 'post') return { submitted: false, reason: '保存フォームの構造が変わっています' };
    if (form.dataset.xTrackerSubmitted) return { submitted: false, uncertain: true, reason: 'このページでは既に送信が開始されています' };
    form.dataset.xTrackerSubmitted = jobId;
    input.value = target;
    form.target = '_self';
    // Preserve hidden service fields (including its current submit token).
    form.requestSubmit();
    return { submitted: true };
  }
  class Today extends Ghost {
    constructor(chrome) { super(chrome); this.home = 'https://archive.li/'; this.inspectDocument = inspectTodayDocument; this.submitDocument = submitTodayDocument; }
    trusted(url) { return url.protocol === 'https:' && !url.port && !url.username && !url.password && C.ARCHIVE_HOSTS.includes(url.hostname); }
    pageURL(receipt) { return receipt; }
    archiveId() { return ''; }
    matchesReceipt(current, receipt) { return super.matchesReceipt(current, receipt) || C.receiptTransition(receipt.href, current.href); }
    searchURL(target) { return 'https://archive.li/' + target; }
  }
  class Providers {
    constructor(chrome) { this.adapters = { 'archive.today': new Today(chrome), ghostarchive: new Ghost(chrome) }; }
    forJob(job) {
      const adapter = this.adapters[job.provider || 'ghostarchive'];
      if (!adapter) throw Error('保存先を確認してください');
      return adapter;
    }
  }
  for (const method of ['open', 'inspect', 'submit', 'reconcile', 'show', 'close']) Providers.prototype[method] = function (job, ...args) { return this.forJob(job)[method](job, ...args); };
  const api = { Today, Providers, inspectTodayDocument, submitTodayDocument };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AutoArchiveToday = api;
})(globalThis);
