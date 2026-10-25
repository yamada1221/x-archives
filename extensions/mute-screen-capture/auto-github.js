'use strict';
(function (root) {
  class GitHub {
    constructor(config, fetcher = fetch) {
      this.config = config;
      // Native WorkerGlobalScope.fetch must receive the worker as its receiver.
      this.fetcher = (...args) => Reflect.apply(fetcher, globalThis, args);
    }
    async request(path, method = 'GET', body) {
      const c = this.config, controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 25000);
      try {
        const response = await this.fetcher(`https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
          method, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
          headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        const raw = await response.text();
        if (raw.length > 8 * 1024 * 1024) throw Error('GitHubの応答が大きすぎます');
        return { ok: response.ok, status: response.status, json: async () => JSON.parse(raw) };
      } finally { clearTimeout(timeout); }
    }
    async get(path, missing = false) {
      const r = await this.request(path);
      if (missing && r.status === 404) return { data: null, sha: null };
      if (!r.ok) throw Error(`GitHubの読み込みに失敗しました（HTTP ${r.status}）`);
      const f = await r.json();
      if (typeof f.sha !== 'string' || f.encoding !== 'base64' || typeof f.content !== 'string') throw Error('GitHubのファイル形式を確認できません');
      const bytes = Uint8Array.from(atob(f.content.replace(/\s/g, '')), c => c.charCodeAt(0));
      return { sha: f.sha, data: JSON.parse(new TextDecoder().decode(bytes)) };
    }
    async update(path, transform) {
      for (let i = 0; i < 3; i++) {
        const current = await this.get(path, true), data = structuredClone(current.data);
        const next = transform(data);
        if (next === undefined) return current.data;
        if (JSON.stringify(next) === JSON.stringify(current.data)) return next;
        const bytes = new TextEncoder().encode(JSON.stringify(next, null, 2) + '\n');
        let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
        const r = await this.request(path, 'PUT', { message: 'chore: sync automatic archives from browser extension', content: btoa(binary), ...(current.sha ? { sha: current.sha } : {}) });
        if ([409, 422].includes(r.status)) continue;
        if (!r.ok) throw Error(`GitHubへの同期に失敗しました（HTTP ${r.status}）`);
        return next;
      }
      throw Error('GitHub側の更新と競合しました。保存依頼を出し直さず、同期を再試行します');
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = GitHub; else root.AutoArchiveGitHub = GitHub;
})(globalThis);
