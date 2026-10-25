'use strict';
(function (root) {
  const C = typeof module !== 'undefined' && module.exports ? require('./auto-core.js') : root.AutoArchiveCore;
  const JOBS = 'data/archive_jobs.json', CONFIG = 'data/auto_archive_config.json';
  class Engine {
    constructor({ config, store, git, ghost, profile, device, now = Date.now, uuid = () => crypto.randomUUID(), ready = async () => {}, canSubmit = async () => true }) {
      Object.assign(this, { config, store, git, ghost, profile, device, now, uuid, ready, canSubmit });
      this.key = C.scope(config);
    }
    async state() { return this.store.get(this.key, { jobs: [], nextScanAt: 0, lastRunAt: 0, lastError: '' }); }
    async save(state) { await this.store.set(this.key, state); }
    put(state, job) {
      job.updated_at = new Date(this.now()).toISOString(); job.dirty = true;
      state.jobs = [...state.jobs.filter(j => j.job_id !== job.job_id), job];
    }
    publicJob(job) { const { dirty, applied, ...value } = job; return value; }
    async claim(takeover = false) {
      return this.git.update(CONFIG, old => {
        if (old && (old.version !== 1 || old.artists_path !== this.config.path)) throw Error('共通設定のデータファイルが一致しません');
        if (old?.executor_device_id && old.executor_device_id !== this.device && !takeover) throw Error('別のブラウザが実行担当です。「このブラウザへ引き継ぐ」を選んでください');
        return { ...old, version: 1, enabled: old?.enabled !== false, artists_path: this.config.path, provider: this.config.provider,
          executor_device_id: this.device, daily_limit: 20, interval_ms: C.MINUTE };
      });
    }
    async sharedConfig() {
      const v = (await this.git.get(CONFIG, true)).data;
      if (!v || v.version !== 1 || v.artists_path !== this.config.path) throw Error('拡張機能の設定画面から実行担当を登録してください');
      return v;
    }
    async artists() { return C.validateArtists((await this.git.get(this.config.path)).data); }
    async flush(state) {
      for (const job of state.jobs.filter(j => j.dirty)) {
        const shared = await this.git.update(JOBS, old => {
          const d = C.ledger(old), i = d.jobs.findIndex(j => j.job_id === job.job_id), r = d.jobs[i];
          if (r && (r.artist_id !== job.artist_id || (r.expected_x_user_id && job.expected_x_user_id && r.expected_x_user_id !== job.expected_x_user_id))) throw Error('共有ジョブのアカウントが一致しません');
          const progressed = r?.receipt && job.receipt_history?.includes(r.receipt) && C.receiptTransition(r.receipt, job.receipt);
          const remoteProgressed = job.receipt && r?.receipt_history?.includes(job.receipt) && C.receiptTransition(job.receipt, r.receipt);
          if (r?.receipt && job.receipt && r.receipt !== job.receipt && !progressed && !remoteProgressed) throw Error('受付URLが競合しています。結果を確認してください');
          // A stale cache must not undo a completed capture or a receipt recovered
          // by another executor. Preserve the remote evidence in that case.
          let value = this.publicJob(job);
          if (r?.state === 'succeeded' || remoteProgressed || (r?.receipt && !job.receipt) || (r?.submission_started_at && !job.submission_started_at)) value = r;
          if (i < 0) d.jobs.push(value); else d.jobs[i] = value;
          return d;
        });
        const saved = shared.jobs.find(j => j.job_id === job.job_id);
        Object.assign(job, saved, { dirty: false });
        await this.save(state);
      }
      for (const job of state.jobs.filter(j => j.state === 'succeeded' && !j.applied)) {
        if (job.kind !== 'connection_test') {
          await this.git.update(this.config.path, doc => { C.applyResult(doc, job); return doc; });
        } else if (job.executor_device_id === this.device && job.provider === this.config.provider && job.adapter_version === C.adapterVersion(this.config.provider) && job.verification?.ok) {
          await this.ready(job.adapter_version);
        }
        job.applied = true;
        await this.save(state);
      }
    }
    async importJobs(state) {
      const remote = C.ledger((await this.git.get(JOBS, true)).data);
      const local = new Map(state.jobs.map(j => [j.job_id, j]));
      for (const job of remote.jobs) {
        const cached = local.get(job.job_id);
        if (!cached?.dirty) local.set(job.job_id, { ...job, applied: cached?.applied || false, dirty: false });
      }
      state.jobs = [...local.values()]; state.provider = remote.provider;
      return remote;
    }
    async enqueueTest() {
      const lock = this.uuid();
      if (!await this.store.acquire(this.key, lock, this.now())) throw Error('処理中です。少し待ってください');
      try {
        const shared = await this.sharedConfig();
        if (shared.executor_device_id !== this.device) throw Error('このブラウザを実行担当にしてください');
        const s = await this.state(); await this.importJobs(s);
        for (const j of s.jobs.filter(j => j.kind === 'connection_test' && !C.TERMINAL.has(j.state) && (j.provider || 'ghostarchive') !== this.config.provider && !j.receipt && !j.submission_started_at)) {
          j.state = 'canceled'; j.last_error = '保存先が変わったため未送信の接続テストを中止しました'; this.put(s, j);
          await this.ghost.close(j).catch(() => {});
        }
        if (s.jobs.some(j => j.kind === 'connection_test' && !C.TERMINAL.has(j.state))) throw Error('接続テストは既に実行中です');
        this.put(s, { job_id: this.uuid(), kind: 'connection_test', artist_id: 'connection-test:' + this.device,
          registered_handle: 'X', expected_x_user_id: '783214', state: 'queued', provider: this.config.provider,
          created_at: new Date(this.now()).toISOString(), attempt_count: 0, next_attempt_at: this.now(), executor_device_id: this.device, adapter_version: C.adapterVersion(this.config.provider) });
        await this.save(s); await this.flush(s);
      } finally { await this.store.release(this.key, lock); }
    }
    async scan(state, force) {
      if (!this.config.enabled || this.config.providerReady !== C.adapterVersion(this.config.provider) || (!force && state.nextScanAt > this.now())) return;
      // Unsent work follows a changed default. A submitted job keeps its
      // original adapter and receipt, even after the selected provider changes.
      for (const j of state.jobs.filter(j => !C.TERMINAL.has(j.state) && (j.provider || 'ghostarchive') !== this.config.provider && !j.receipt && !j.submission_started_at)) {
        j.state = 'canceled'; j.last_error = '保存先の変更に合わせて未送信のジョブを中止しました';
        this.put(state, j); await this.ghost.close(j).catch(() => {});
      }
      const data = await this.artists();
      let added = 0;
      for (const a of data.artists) {
        if (added >= 5) break;
        if (!C.eligible(a, this.config.provider) || C.completed(a)) continue;
        if (state.jobs.some(j => j.artist_id === a.id &&
          (j.expected_x_user_id && a.x_user_id ? j.expected_x_user_id === a.x_user_id : j.registered_handle.toLowerCase() === a.x_account.toLowerCase()) &&
          (!['canceled', 'skipped'].includes(j.state) || j.receipt || j.submission_started_at))) continue;
        const pending = (a.archives || []).find(e => C.resultProvider(e.url) === this.config.provider && C.resultURL(e.url) &&
          C.profileURL(e.target_url) === C.profileURL('https://x.com/' + a.x_account));
        this.put(state, { job_id: this.uuid(), kind: 'profile', artist_id: a.id, registered_handle: a.x_account,
          ...(pending ? { receipt: C.resultURL(pending.url), adopted_existing: true } : {}),
          expected_x_user_id: a.x_user_id || '', state: 'queued', provider: this.config.provider, created_at: new Date(this.now()).toISOString(),
          attempt_count: 0, next_attempt_at: this.now(), executor_device_id: this.device });
        added++;
      }
      state.candidateCount = data.artists.filter(a => C.eligible(a, this.config.provider) && !C.completed(a)).length;
      state.nextScanAt = this.now() + 6 * C.HOUR;
      await this.save(state);
    }
    async currentArtist(job) {
      if (job.kind === 'connection_test') {
        if (job.artist_id !== 'connection-test:' + job.executor_device_id || job.registered_handle !== 'X') throw Error('接続テストの対象が不正です');
        return { id: job.artist_id, x_account: 'X', x_user_id: job.expected_x_user_id || '', tracking_mode: 'record' };
      }
      return (await this.artists()).artists.find(a => a.id === job.artist_id);
    }
    async identity(job, artist) {
      const p = await this.profile(artist.x_account, job.expected_x_user_id || artist.x_user_id || '');
      job.expected_x_user_id = p.id; job.identity = p; job.target_url = 'https://x.com/' + p.handle;
      job.event_key = (job.kind === 'connection_test' ? 'test:' + job.job_id : 'first:' + p.id) + ':profile';
    }
    async cancelIfChanged(state, job) {
      const a = await this.currentArtist(job);
      if (!C.sameAccount(a, job) || (job.kind !== 'connection_test' && C.completed(a))) {
        job.state = 'canceled'; job.last_error = '登録の削除・対象変更・保存済みへの変更を確認したため送信を中止しました';
        this.put(state, job); await this.save(state); await this.ghost.close(job); return null;
      }
      return a;
    }
    async reserve(job, shared) {
      const now = this.now();
      return this.git.update(JOBS, old => {
        const d = C.ledger(old), existing = d.jobs.find(j => j.job_id === job.job_id);
        if (existing?.submission_started_at || existing?.receipt || (existing && existing.state !== 'opening')) throw Error('このジョブは既に送信が開始されています');
        if (d.jobs.some(j => j.job_id !== job.job_id && j.event_key === job.event_key && !['canceled', 'skipped'].includes(j.state))) throw Error('同じ対象の保存依頼が既にあります');
        d.reservations = d.reservations.filter(r => now - r.at < C.DAY);
        const daily = Math.min(20, Number(shared.daily_limit) || 20);
        if (d.reservations.length >= daily) throw Error('直近24時間の保存依頼上限に達しています');
        if ((d.provider?.name || 'ghostarchive') === (job.provider || 'ghostarchive') && d.provider?.paused_until > now) throw Error('保存先の自動処理を一時停止しています');
        if (d.reservations.some(r => now - r.at < C.MINUTE)) throw Error('保存依頼の間隔を空けて待機しています');
        if (d.jobs.filter(j => ['submitting', 'processing', 'verifying', 'submission_unknown'].includes(j.state)).length >= 5) throw Error('保存処理中の案件が5件あるため待機しています');
        job.state = 'submitting'; job.submission_started_at = new Date(now).toISOString(); job.operation_id = this.uuid();
        job.lease_expires_at = now + 30 * C.MINUTE; job.attempt_count++; job.executor_device_id = this.device;
        d.reservations.push({ job_id: job.job_id, at: now, executor_device_id: this.device });
        d.jobs = [...d.jobs.filter(j => j.job_id !== job.job_id), this.publicJob(job)];
        return d;
      });
    }
    async review(state, job, reason, pause = false) {
      job.state = 'needs_review'; job.last_error = reason;
      this.put(state, job); await this.save(state);
      if (pause) {
        await this.git.update(JOBS, old => { const d = C.ledger(old); d.provider = { name: job.provider || 'ghostarchive', paused_until: this.now() + C.DAY, reason }; return d; });
      }
    }
    async run({ forceScan = false } = {}) {
      const owner = this.uuid();
      if (!await this.store.acquire(this.key, owner, this.now())) return;
      let state;
      try {
        state = await this.state(); state.lastRunAt = this.now(); state.lastError = '';
        let shared;
        try { await this.flush(state); shared = await this.sharedConfig(); await this.importJobs(state); }
        catch (error) { state.lastError = error.message; }
        const executor = shared?.executor_device_id === this.device;
        if (executor && shared.enabled !== false) await this.scan(state, forceScan);
        const inflight = j => ['submitting', 'submission_unknown', 'processing', 'verifying'].includes(j.state);
        const job = state.jobs.filter(j => !C.TERMINAL.has(j.state) && (j.next_attempt_at || 0) <= this.now() &&
          ((inflight(j) && (executor || !shared && j.executor_device_id === this.device)) ||
            (executor && shared.enabled !== false && (j.provider || 'ghostarchive') === this.config.provider &&
              (this.config.enabled && this.config.providerReady === C.adapterVersion(this.config.provider) || j.kind === 'connection_test' && j.executor_device_id === this.device))))
          .sort((a, b) => Number(inflight(b)) - Number(inflight(a)) || (a.next_attempt_at || 0) - (b.next_attempt_at || 0))[0];
        if (job) {
          try { await this.advance(state, job, shared); }
          catch (error) {
            if (job.state === 'submitting' || job.state === 'submission_unknown') {
              job.state = 'submission_unknown'; job.last_error = '受付状況を確認しています。新規依頼は出し直しません';
              job.next_attempt_at = this.now() + C.MINUTE;
            } else if (['processing', 'verifying', 'succeeded'].includes(job.state)) {
              job.last_error = error.message; job.next_attempt_at = this.now() + C.MINUTE;
            } else {
              job.preflight_failures = (job.preflight_failures || 0) + 1;
              job.last_error = error.message;
              // Transport/identity failures never become account disappearance.
              if (job.preflight_failures >= 3) job.state = 'needs_review';
              else { job.resume_state = job.state === 'opening' ? 'opening' : 'queued'; job.state = 'retry_wait'; }
              job.next_attempt_at = this.now() + (job.preflight_failures === 1 ? C.HOUR : 6 * C.HOUR);
            }
            this.put(state, job); await this.save(state);
          }
        }
        await this.save(state);
        try { await this.flush(state); } catch (error) { state.lastError = error.message; await this.save(state); }
      } catch (error) {
        if (state) { state.lastError = error.message; await this.save(state); }
        else throw error;
      } finally { await this.store.release(this.key, owner); }
    }
    async advance(state, job, shared) {
      if ((job.submission_started_at || job.receipt) && this.now() - Date.parse(job.submission_started_at || job.created_at) > 2 * C.DAY) {
        return this.review(state, job, '48時間を超えて完了を確認できません。結果URLを確認してください');
      }
      if (job.state === 'retry_wait') job.state = job.resume_state || 'queued';
      if (job.state === 'queued') {
        const a = await this.cancelIfChanged(state, job); if (!a) return;
        await this.identity(job, a);
        if (state.jobs.some(j => j.job_id !== job.job_id && j.event_key === job.event_key && !['canceled', 'skipped'].includes(j.state))) {
          job.state = 'skipped'; job.last_error = '同じアカウントの保存依頼を既存ジョブで追跡しています';
        } else { job.state = job.receipt ? 'processing' : 'opening'; job.next_attempt_at = this.now(); job.last_error = ''; }
        this.put(state, job); await this.save(state); await this.flush(state);
        if (job.state === 'opening') await this.ghost.open(job, C.homeURL(job.provider || 'ghostarchive'));
        return;
      }
      if (job.state === 'opening') {
        const a = await this.cancelIfChanged(state, job); if (!a) return;
        const page = await this.ghost.inspect(job);
        if (page.kind === 'loading') { job.next_attempt_at = this.now() + C.MINUTE; this.put(state, job); return; }
        if (page.kind !== 'form') return this.review(state, job, page.kind === 'blocked' ? '保存先で人間確認・アクセス制限が必要です' : '保存フォームの構造を確認できません', true);
        await this.identity(job, a);
        const latest = await this.sharedConfig();
        if (!shared || latest.executor_device_id !== this.device || latest.enabled === false || !await this.canSubmit(job)) return;
        // Reserve in the shared CAS ledger before allowing this POST.
        try { await this.reserve(job, latest); }
        catch (error) { job.state = job.submission_started_at ? 'submission_unknown' : 'opening'; job.last_error = error.message; job.next_attempt_at = this.now() + C.MINUTE; this.put(state, job); return; }
        this.put(state, job); await this.save(state);
        // Re-read registration after the reservation: concurrent edits cannot
        // silently redirect the capture to a different person.
        const current = await this.currentArtist(job);
        if (!C.sameAccount(current, job) || !await this.canSubmit(job)) {
          job.state = 'canceled'; job.last_error = '送信直前に設定または対象が変わったため中止しました'; this.put(state, job); return;
        }
        const sent = await this.ghost.submit(job);
        if (!sent?.submitted) {
          job.state = sent?.uncertain ? 'submission_unknown' : 'needs_review'; job.last_error = sent?.reason || '保存先の受付を確認できません';
        }
        job.next_attempt_at = this.now() + C.MINUTE; this.put(state, job); await this.save(state);
        return;
      }
      if (job.state === 'submitting' || job.state === 'submission_unknown') {
        const result = await this.ghost.reconcile(job);
        const receipt = C.resultProvider(result.receipt) === (job.provider || 'ghostarchive') ? C.resultURL(result.receipt) : '';
        if (receipt) { job.receipt = receipt; job.state = 'processing'; job.last_error = ''; job.next_attempt_at = this.now() + C.MINUTE; this.put(state, job); }
        else if (result.kind === 'loading' || result.kind === 'form') {
          job.receipt_checks = (job.receipt_checks || 0) + 1;
          if (job.receipt_checks >= 3) return this.review(state, job, '受付URLを確認できません。保存先の画面で確認してください');
          job.state = 'submission_unknown'; job.next_attempt_at = this.now() + C.MINUTE; this.put(state, job);
        }
        else await this.review(state, job, result.reason || '受付結果が不明です。保存先の画面または検索結果で確認してください');
        return;
      }
      if (job.state === 'processing' || job.state === 'verifying') {
        const page = await this.ghost.inspect(job);
        if (page.kind === 'blocked') return this.review(state, job, '保存先で人間確認・アクセス制限が必要です', true);
        if (!['archive', 'processing', 'loading'].includes(page.kind)) return this.review(state, job, '保存結果の形式を確認できません');
        if (page.receipt && C.resultURL(page.receipt) !== job.receipt) {
          if (!C.receiptTransition(job.receipt, page.receipt)) return this.review(state, job, '保存結果URLが変わっています。対象を確認してください');
          job.receipt_history = [...new Set([...(job.receipt_history || []), job.receipt])]; job.receipt = C.resultURL(page.receipt);
          this.put(state, job); await this.save(state);
        }
        if (page.kind === 'archive') {
          if (C.processingURL(job.receipt)) return this.review(state, job, '処理中のURLから保存完了を確認できません');
          const evidence = C.verify(page, page.frames || [], job, this.now());
          if (evidence.ok) {
            if (!evidence.archived_user_id) await this.profile(job.identity.handle, job.expected_x_user_id);
            job.verification = evidence; job.state = 'succeeded'; job.last_error = '';
            this.put(state, job); await this.save(state);
            await this.ghost.close(job).catch(() => {}); return;
          }
          job.last_error = evidence.reason; job.verification_checks = (job.verification_checks || 0) + 1;
          if (job.verification_checks >= 3) return this.review(state, job, evidence.reason);
        }
        job.next_attempt_at = this.now() + C.MINUTE; this.put(state, job); await this.save(state);
      }
    }
    async adopt(jobId, value) {
      const receipt = C.resultURL(value); if (!receipt) throw Error('保存先の保存結果URLを入力してください');
      const owner = this.uuid(); if (!await this.store.acquire(this.key, owner, this.now())) throw Error('処理中です。少し待ってください');
      try {
        const state = await this.state(); const job = state.jobs.find(j => j.job_id === jobId);
        if (!job || !job.identity || job.state === 'succeeded') throw Error('確認対象のジョブが見つかりません');
        if (C.resultProvider(receipt) !== (job.provider || 'ghostarchive')) throw Error('このジョブと同じ保存先の結果URLを入力してください');
        if (job.receipt && receipt !== job.receipt) {
          if (!C.receiptTransition(job.receipt, receipt)) throw Error('受付済みの結果URLを別の保存に変更できません');
          job.receipt_history = [...new Set([...(job.receipt_history || []), job.receipt])];
        }
        job.receipt = receipt; job.state = 'processing'; job.next_attempt_at = this.now(); job.verification_checks = 0;
        this.put(state, job); await this.save(state); await this.flush(state);
      } finally { await this.store.release(this.key, owner); }
    }
  }
  const api = { Engine, JOBS, CONFIG };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AutoArchiveEngine = api;
})(globalThis);
