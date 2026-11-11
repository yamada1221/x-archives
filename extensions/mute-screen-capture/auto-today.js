'use strict';
(function (root) {
  const C = typeof module !== 'undefined' && module.exports ? require('./auto-core.js') : root.AutoArchiveCore;
  const { Ghost } = typeof module !== 'undefined' && module.exports ? require('./auto-ghost.js') : root.AutoArchiveGhost;
  // Serialized into the isolated world. Inspect only archive.today's wrapper
  // and the saved body, never execute scripts or follow instructions from it.
  function inspectTodayDocument() {
    const url = new URL(location.href);
    const hosts = ['archive.li', 'archive.md', 'archive.ph', 'archive.is', 'archive.today', 'archive.vn', 'archive.fo'];
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.port || url.username || url.password) return { kind: 'untrusted' };
    const content = document.querySelector('#CONTENT');
    const text = (document.body?.innerText || '').slice(0, 16000);
    const challenge = Boolean(document.querySelector('iframe[src*="challenges.cloudflare.com"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"],input[name="cf-turnstile-response"],.g-recaptcha,.h-captcha,#challenge-form')) ||
      !content && /verify (?:that )?you are human|checking your browser|just a moment|captcha|unusual traffic|too many requests|access denied|\brate[- ]?limit(?:ed|ing)?\b|\b(?:error|http(?: status)?|status(?: code)?)\s*[:=-]?\s*(?:403|429|503)\b/i.test(document.title + '\n' + text);
    const receiptPath = /^\/[A-Za-z0-9]{5}\/?$/.test(url.pathname) && url.pathname.replace(/\/$/, '') !== '/about' ||
      /^\/wip\/(?:[A-Za-z0-9]+|\d{4}\.\d{2}\.\d{2}-\d{6}(?:\/https?:\/\/.+)?)\/?$/.test(url.pathname) ||
      /^\/(?:\d{8,14}|\d{4}\.\d{2}\.\d{2}-\d{6})\/https?:\/\/.+/.test(url.pathname);
    const receipt = receiptPath ? url.origin + url.pathname.replace(/\/$/, '') : '';
    if (challenge) return { kind: 'blocked', receipt,
      block_type: /too many requests|\brate[- ]?limit|\b(?:error|http(?: status)?|status(?: code)?)\s*[:=-]?\s*429\b/i.test(document.title + '\n' + text) ? 'rate_limit' : 'human' };
    if (url.pathname === '/' || /^\/submit\/?$/.test(url.pathname)) {
      // Follow the native form association, including an input's form="id".
      // Keep legacy POST forms and the GET form observed by local diagnostics.
      const inputs = [...document.querySelectorAll('input[name="url"]')].filter(input => {
        const form = input.form;
        if (!form || !['text', 'url'].includes(input.type) || input.disabled || input.readOnly) return false;
        try {
          const action = new URL(form.action);
          const method = form.method.toLowerCase();
          const supported = method === 'post' || method === 'get' && action.pathname === '/submit/' &&
            form.getAttribute('id') === 'submiturl' && input.id === 'url';
          return action.origin === url.origin && /^\/submit\/?$/.test(action.pathname) &&
            !action.search && !action.hash && !action.username && !action.password && supported;
        } catch (_) { return false; }
      });
      return { kind: inputs.length === 1 ? 'form' : 'changed' };
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
    if (!profile && content) {
      // archive.today removes X's data-testid attributes in real captures.
      // Identify the non-post profile card from its following/follower links
      // and a non-linked name/handle header, strictly inside the saved body.
      const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
      function pathOf(href) {
        const match = String(href || '').match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com(\/[^?#\s]*)/i);
        return match ? match[1].replace(/\/$/, '').toLowerCase() : '';
      }
      const follows = [...content.querySelectorAll('a[href]')].map(a => ({ a, match: pathOf(a.href).match(/^\/([a-z0-9_]{1,15})\/following$/) }))
        .filter(v => v.match && !v.a.closest('article,[role="article"]'));
      if (new Set(follows.map(v => v.match[1])).size === 1) {
        const { a: following, match } = follows[0], handle = match[1];
        for (let card = following.parentElement, depth = 0; card && card !== content && depth < 8; card = card.parentElement, depth++) {
          if (card.querySelector('article,[role="article"]')) break;
          const follower = [...card.querySelectorAll('a[href]')].some(a => ['/' + handle + '/followers', '/' + handle + '/verified_followers'].includes(pathOf(a.href)));
          if (!follower) continue;
          const headers = [...card.children].map(element => {
            // Account labels and pronouns can be siblings of the name/handle
            // pair. Read that inner pair, while retaining the outer bio order.
            for (const part of [element, ...element.querySelectorAll('div,h1,h2')].slice(0, 80)) {
              const text = norm(part.innerText), m = text.match(new RegExp('^(.+?)\\s+@(' + handle + ')$', 'i'));
              const ownHandle = [...part.querySelectorAll('span,div,h1,h2')].some(e => norm(e.innerText).toLowerCase() === '@' + handle && !e.closest('a[href],button,[role="button"]'));
              if (m && m[1].length <= 160 && ownHandle) return { element, name: m[1], handle: m[2] };
            }
            return null;
          }).filter(Boolean);
          if (headers.length !== 1) continue;
          const header = headers[0], next = header.element.nextElementSibling;
          let bio = next && !next.contains(following) && !next.querySelector('[role="presentation"],time') ? String(next.innerText || '').trim() : '';
          if (bio) {
            const controls = new Set([...next.querySelectorAll('button,[role="button"]')].map(e => String(e.innerText || '').trim()).filter(Boolean));
            for (const label of controls) {
              if (bio === label) bio = '';
              else if (bio.startsWith(label + '\n') || bio.startsWith(label + ' ')) bio = bio.slice(label.length).trimStart();
              else if (bio.endsWith('\n' + label)) bio = bio.slice(0, -label.length).trimEnd();
            }
          }
          bio = bio.slice(0, 2048);
          const ids = new Set();
          for (const region of [card, card.parentElement]) {
            if (!region || region === content || region.querySelector('article,[role="article"]')) continue;
            for (const img of region.querySelectorAll('img')) {
              if (pathOf(img.closest('a[href]')?.href) !== '/' + handle + '/header_photo') continue;
              try {
                const source = new URL(img.getAttribute('currentsourceurl') || img.getAttribute('src') || '', url.href);
                const id = source.pathname.match(/^\/profile_banners\/(\d+)\//)?.[1];
                if (source.protocol === 'https:' && source.hostname === 'pbs.twimg.com' && !source.port && !source.username && !source.password && id) ids.add(id);
              } catch (_) { /* An avatar/image ID is never inferred as a user ID. */ }
            }
          }
          if (ids.size > 1) break;
          const post_ids = [...content.querySelectorAll('article')].flatMap(article => {
            const link = article.querySelector('time')?.closest('a[href]');
            const m = link && pathOf(link.href).match(new RegExp('^/' + handle + '/status/(\\d+)$'));
            const body = article.querySelector('[data-testid="tweetText"],div[lang],p[lang]');
            return m && body?.innerText.trim() ? [m[1]] : [];
          });
          profile = { kind: 'profile', handle: header.handle, name: header.name, bio,
            user_id: [...ids][0] || '', following: true, post_ids: [...new Set(post_ids)].slice(0, 20), identity_source: ids.size ? 'archived_profile_banner' : 'archived_profile_card' };
          break;
        }
      }
    }
    if (profile && content) {
      const handle = profile.handle.toLowerCase();
      profile.replies_tab_confirmed = [...content.querySelectorAll('a[role="tab"][href]')].some(a => {
        const m = String(a.href).match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([a-z0-9_]{1,15})\/with_replies(?:[/?#]|$)/i);
        const active = a.matches('[aria-selected="true"],[aria-current="page"]') || a.querySelector('[aria-selected="true"],[aria-current="page"]');
        return m && m[1].toLowerCase() === handle && Boolean(active) && !a.closest('article');
      });
    }
    return { kind: 'archive', receipt, original_url, captured_at, profile };
  }
  function submitTodayDocument(target, jobId) {
    const url = new URL(location.href);
    const hosts = ['archive.li', 'archive.md', 'archive.ph', 'archive.is', 'archive.today', 'archive.vn', 'archive.fo'];
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.port || url.username || url.password || !(url.pathname === '/' || /^\/submit\/?$/.test(url.pathname)) || !/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}(?:\/with_replies)?$/.test(target)) return { submitted: false, reason: '対象URLを確認できません' };
    if (/verify (?:that )?you are human|checking your browser|just a moment|captcha|unusual traffic|too many requests|access denied|\brate[- ]?limit(?:ed|ing)?\b|\b(?:error|http(?: status)?|status(?: code)?)\s*[:=-]?\s*(?:403|429|503)\b/i.test(document.title + '\n' + (document.body?.innerText || '')) ||
      document.querySelector('iframe[src*="challenges.cloudflare.com"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"],input[name="cf-turnstile-response"],.g-recaptcha,.h-captcha,#challenge-form')) return { submitted: false, blocked: true,
        block_type: /too many requests|\brate[- ]?limit|\b(?:error|http(?: status)?|status(?: code)?)\s*[:=-]?\s*429\b/i.test(document.title + '\n' + (document.body?.innerText || '')) ? 'rate_limit' : 'human', reason: '保存先で人間確認・アクセス制限が必要です' };
    const inputs = [...document.querySelectorAll('input[name="url"]')].filter(input => {
      const form = input.form;
      if (!form || !['text', 'url'].includes(input.type) || input.disabled || input.readOnly) return false;
      try {
        const action = new URL(form.action);
        const method = form.method.toLowerCase();
        const supported = method === 'post' || method === 'get' && action.pathname === '/submit/' &&
          form.getAttribute('id') === 'submiturl' && input.id === 'url';
        return action.origin === url.origin && /^\/submit\/?$/.test(action.pathname) &&
          !action.search && !action.hash && !action.username && !action.password && supported;
      } catch (_) { return false; }
    });
    if (inputs.length !== 1) return { submitted: false, reason: '保存フォームの構造が変わっています' };
    const input = inputs[0], form = input.form;
    if (form.dataset.xTrackerSubmitted) return { submitted: false, uncertain: true, reason: 'このページでは既に送信が開始されています' };
    form.dataset.xTrackerSubmitted = jobId;
    input.value = target;
    form.target = '_self';
    // Preserve the native GET/POST method and all hidden service fields.
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
    async recoverBinding(job) {
      // Reloading clears session storage. Read only exact submitted GET targets
      // or fresh, already-open capture wrappers; never send another request.
      if (!Number.isFinite(Date.parse(job.submission_started_at)) || !C.targetURL(job.target_url)) return null;
      const tabs = await this.chrome.tabs.query({ url: C.ARCHIVE_HOSTS.map(h => 'https://' + h + '/*') });
      const candidates = [];
      for (const tab of tabs.slice(0, 40)) {
        let u; try { u = new URL(tab.url || ''); } catch (_) { continue; }
        if (!this.trusted(u)) continue;
        if (/^\/submit\/?$/.test(u.pathname) && C.targetURL(u.searchParams.get('url')) === C.targetURL(job.target_url)) {
          candidates.push({ tab }); continue;
        }
        if (!C.resultURL(u.href) || tab.status !== 'complete' || tab.pendingUrl) continue;
        try {
          const results = await this.chrome.scripting.executeScript({ target: { tabId: tab.id }, func: this.inspectDocument });
          const page = results.find(r => r.frameId === 0)?.result, stamp = Date.parse(page?.captured_at);
          if (page?.kind !== 'archive' || C.targetURL(page.original_url) !== C.targetURL(job.target_url) ||
              !Number.isFinite(stamp) || stamp < Date.parse(job.submission_started_at) - 5 * C.MINUTE || stamp > Date.now() + 5 * C.MINUTE) continue;
          candidates.push({ tab, page });
        } catch (_) { /* A closed or inaccessible tab provides no evidence. */ }
      }
      if (candidates.length !== 1) return null;
      const chosen = candidates[0];
      await this.chrome.storage.session.set({ ['autoArchiveTab:' + job.job_id]: chosen.tab.id,
        ['autoArchiveBorrowedTab:' + job.job_id]: true });
      return chosen;
    }
    async reconcile(job) {
      let tab = await this.binding(job);
      if (!tab && !job.receipt) {
        const recovered = await this.recoverBinding(job);
        if (recovered?.page) return recovered.page;
        tab = recovered?.tab;
        if (!tab) return { kind: 'unresolved', reason: '送信済みの保存先タブを特定できません。「保存先で確認」で保存一覧を開き、個別の保存結果を選んでください' };
      }
      return super.reconcile(job);
    }
    async show(job) {
      if (!await this.binding(job) && job.submission_started_at && !job.receipt) await this.recoverBinding(job);
      return super.show(job);
    }
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
