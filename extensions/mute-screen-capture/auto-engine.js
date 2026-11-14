'use strict';
(function (root) {
  const C = typeof module !== 'undefined' && module.exports ? require('./auto-core.js') : root.AutoArchiveCore;
  const JOBS = 'data/archive_jobs.json', CONFIG = 'data/auto_archive_config.json';
  const BODY_READER_REVISION = 'archive-card-labels-20261027';
  const PROFILE_COVERAGE_REVISION = 'profile-from-reply-capture-20261114';
  const PROFILE_COVERAGE_ERRORS = new Set(['保存先の対象URLが一致しません', '保存先は返信タブです。プロフィールの保存結果を選んでください']);
  const RECEIPT_READER_REVISION = 'archive-challenge-recovery-20261029';
  const BODY_READER_ERRORS = new Set(['プロフィール本文・対象ハンドルを確認できません', '本文から同じアカウントだと確認する証拠が不足しています']);
  const MANUAL_RECEIPT_REPLACEMENT_ERRORS = new Set(['保存先の対象URLが一致しません', '保存先の対象アカウントが一致しません',
    '保存先は返信タブです。プロフィールの保存結果を選んでください', '保存先はプロフィールです。返信タブの保存結果を選んでください',
    '保存対象の種類が一致しません']);
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
    publicJob(job) { const { dirty, applied, receiptCorrection, rejectedReceiptCorrections, ...value } = job; return value; }
    prepareBodyRechecks(state) {
      const revisions = new Map(state.bodyReaderRevisions || []);
      let changed = 0;
      for (const job of [...state.jobs]) {
        const requested = C.targetURL(job.target_url);
        const coverage = job.target_kind !== 'replies' && requested && !requested.endsWith('/with_replies') && PROFILE_COVERAGE_ERRORS.has(job.last_error);
        const revision = coverage ? PROFILE_COVERAGE_REVISION : BODY_READER_REVISION;
        const savedProvider = C.resultProvider(job.receipt);
        const matchingProvider = coverage ? savedProvider === (job.provider || 'ghostarchive') : job.provider === 'archive.today' && savedProvider === 'archive.today';
        if (job.kind !== 'profile' || job.executor_device_id !== this.device || job.state !== 'needs_review' ||
            (!BODY_READER_ERRORS.has(job.last_error) && !coverage) || !matchingProvider ||
            revisions.get(job.job_id) === revision || !coverage && revisions.get(job.job_id) === PROFILE_COVERAGE_REVISION) continue;
        // Retry the recorded receipt, never the original save form. Keep the
        // original submission time, request count and receipt history intact.
        revisions.set(job.job_id, revision);
        job.state = 'processing'; job.verification_checks = 0; job.next_attempt_at = this.now(); job.last_error = '';
        if (coverage) job.receipt_recovery_started_at = new Date(this.now()).toISOString();
        this.put(state, job); changed++;
      }
      if (changed) state.bodyReaderRevisions = [...revisions];
      return changed;
    }
    async recheckKnownBodies() {
      const owner = this.uuid();
      if (!await this.store.acquire(this.key, owner, this.now())) return 0;
      try {
        const state = await this.state(), changed = this.prepareBodyRechecks(state);
        if (changed) await this.save(state);
        return changed;
      } finally { await this.store.release(this.key, owner); }
    }
    prepareReceiptRechecks(state) {
      const revisions = new Map(state.receiptReaderRevisions || []);
      let changed = 0;
      for (const job of state.jobs) {
        if (job.provider !== 'archive.today' || job.executor_device_id !== this.device || job.state !== 'needs_review' ||
            !job.submission_started_at || job.receipt || !C.UNKNOWN_RECEIPT_ERRORS.has(job.last_error) ||
            revisions.get(job.job_id) === RECEIPT_READER_REVISION) continue;
        revisions.set(job.job_id, RECEIPT_READER_REVISION);
        job.state = 'submission_unknown'; job.receipt_checks = 0; job.receipt_recovery_required = true;
        job.receipt_recovery_started_at = new Date(this.now()).toISOString();
        job.next_attempt_at = this.now(); job.last_error = '送信済みの保存結果を再確認しています。保存依頼は出し直しません';
        this.put(state, job); changed++;
      }
      if (changed) state.receiptReaderRevisions = [...revisions];
      return changed;
    }
    async recheckKnownReceipts() {
      const owner = this.uuid();
      if (!await this.store.acquire(this.key, owner, this.now())) return 0;
      try {
        const state = await this.state(), changed = this.prepareReceiptRechecks(state);
        if (changed) await this.save(state);
        return changed;
      } finally { await this.store.release(this.key, owner); }
    }
    clearAccessWait(job) { delete job.access_wait; delete job.receipt_recovery_required; }
    acceptReceipt(job, receipt) {
      if (job.receipt && job.receipt !== receipt) {
        if (!C.receiptTransition(job.receipt, receipt)) return false;
        job.receipt_history = [...new Set([...(job.receipt_history || []), job.receipt])];
      }
      job.receipt = receipt;
      return true;
    }
    async waitForAccess(state, job, page) {
      job.access_wait = page.block_type || 'human';
      job.state = job.submission_started_at || job.receipt ? 'submission_unknown' : 'opening';
      job.last_error = job.access_wait === 'human' ?
        '保存先の人間確認が必要です。「保存先で確認」で完了してください。完了後は自動で結果を確認します' :
        '保存先のアクセス制限を確認しました。新規依頼を止め、既存の依頼の結果だけを再確認します';
      job.next_attempt_at = this.now() + (job.access_wait === 'human' ? 5 * C.MINUTE : C.HOUR);
      this.put(state, job); await this.save(state);
      if (job.access_wait !== 'human') {
        await this.git.update(JOBS, old => { const d = C.ledger(old);
          d.provider = { ...d.provider, name: job.provider || 'ghostarchive', paused_until: Math.max(d.provider.paused_until || 0, this.now() + C.DAY), reason: job.last_error }; return d; });
      }
    }
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
        let shared;
        try { shared = await this.git.update(JOBS, old => {
          const d = C.ledger(old), i = d.jobs.findIndex(j => j.job_id === job.job_id), r = d.jobs[i];
          const conflict = reason => {
            const error = Error(reason);
            if (job.receiptCorrection) error.receiptCorrectionConflict = { remote: r ? this.publicJob(r) : null };
            throw error;
          };
          if (r && (r.artist_id !== job.artist_id || (r.expected_x_user_id && job.expected_x_user_id && r.expected_x_user_id !== job.expected_x_user_id))) conflict('共有ジョブのアカウントが一致しません');
          const progressed = r?.receipt && job.receipt_history?.includes(r.receipt) && C.receiptTransition(r.receipt, job.receipt);
          const remoteProgressed = job.receipt && r?.receipt_history?.includes(job.receipt) && C.receiptTransition(job.receipt, r.receipt);
          const correction = job.receiptCorrection;
          const sameCorrectionScope = r && (r.provider || 'ghostarchive') === (job.provider || 'ghostarchive') &&
            C.resultProvider(job.receipt) === (r.provider || 'ghostarchive') &&
            C.targetURL(r.target_url) && C.targetURL(r.target_url) === C.targetURL(job.target_url) &&
            (r.target_kind || 'profile') === (job.target_kind || 'profile') &&
            r.expected_x_user_id === job.expected_x_user_id && r.identity?.handle?.toLowerCase() === job.identity?.handle?.toLowerCase();
          const corrected = correction && correction.from === r?.receipt && correction.to === job.receipt &&
            job.receipt_history?.includes(r.receipt) && r.state === 'needs_review' &&
            MANUAL_RECEIPT_REPLACEMENT_ERRORS.has(r.last_error) && correction.reason === r.last_error && correction.updated_at === r.updated_at &&
            sameCorrectionScope;
          const alreadyCorrected = correction && correction.to === job.receipt && r?.receipt === job.receipt &&
            job.receipt_history?.includes(correction.from) && sameCorrectionScope;
          if (correction && !corrected && !alreadyCorrected) conflict('受付URLが競合しています。結果を確認してください');
          if (job.receipt && r?.receipt !== job.receipt && (r?.receipt || correction) && !progressed && !remoteProgressed && !corrected) conflict('受付URLが競合しています。結果を確認してください');
          // A stale cache must not undo a completed capture or a receipt recovered
          // by another executor. Preserve the remote evidence in that case.
          let value = this.publicJob(job);
          if (r?.state === 'succeeded' || remoteProgressed || (r?.receipt && !job.receipt) || (r?.submission_started_at && !job.submission_started_at)) value = r;
          if (i < 0) d.jobs.push(value); else d.jobs[i] = value;
          return d;
        }); } catch (error) {
          if (error.receiptCorrectionConflict) {
            const rejectedReceiptCorrections = [...(job.rejectedReceiptCorrections || []), {
              receipt: job.receiptCorrection.to, reason: error.message, rejected_at: new Date(this.now()).toISOString()
            }].slice(-10);
            const remote = error.receiptCorrectionConflict.remote;
            // The server rejected this explicit selection. Resume from its
            // authoritative evidence, never verify the refused local receipt.
            if (remote) {
              const restored = { ...remote, dirty: false, rejectedReceiptCorrections,
                applied: job.applied === true && job.receipt === remote.receipt };
              state.jobs = state.jobs.map(j => j.job_id === job.job_id ? restored : j);
            } else {
              state.jobs = state.jobs.filter(j => j.job_id !== job.job_id);
              state.rejectedReceiptCorrections = [...(state.rejectedReceiptCorrections || []),
                ...rejectedReceiptCorrections.map(rejection => ({ job_id: job.job_id, ...rejection }))].slice(-10);
            }
            state.lastError = error.message; await this.save(state);
          }
          throw error;
        }
        const saved = shared.jobs.find(j => j.job_id === job.job_id);
        Object.assign(job, saved, { dirty: false });
        delete job.receiptCorrection;
        if (!saved.access_wait) delete job.access_wait;
        if (!saved.receipt_recovery_required) delete job.receipt_recovery_required;
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
        if (!cached?.dirty) local.set(job.job_id, { ...this.publicJob(job), applied: cached?.applied || false, dirty: false,
          ...(cached?.rejectedReceiptCorrections ? { rejectedReceiptCorrections: cached.rejectedReceiptCorrections } : {}) });
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
        if (!C.eligible(a, this.config.provider)) continue;
        for (const targetKind of C.repliesTagged(a) ? ['profile', 'replies'] : ['profile']) {
        if (added >= 5) break;
        if (C.completed(a, targetKind)) continue;
        if (state.jobs.some(j => j.artist_id === a.id &&
          (j.target_kind || 'profile') === targetKind &&
          (j.expected_x_user_id && a.x_user_id ? j.expected_x_user_id === a.x_user_id : j.registered_handle.toLowerCase() === a.x_account.toLowerCase()) &&
          (!['canceled', 'skipped'].includes(j.state) || j.receipt || j.submission_started_at))) continue;
        const target = 'https://x.com/' + a.x_account + (targetKind === 'replies' ? '/with_replies' : '');
        const pending = (a.archives || []).find(e => e.status !== 'done' && C.resultProvider(e.url) === this.config.provider && C.resultURL(e.url) &&
          C.targetURL(e.target_url) === C.targetURL(target));
        this.put(state, { job_id: this.uuid(), kind: 'profile', artist_id: a.id, registered_handle: a.x_account,
          ...(targetKind === 'replies' ? { target_kind: 'replies' } : {}),
          ...(pending ? { receipt: C.resultURL(pending.url), adopted_existing: true } : {}),
          expected_x_user_id: a.x_user_id || '', state: 'queued', provider: this.config.provider, created_at: new Date(this.now()).toISOString(),
          attempt_count: 0, next_attempt_at: this.now(), executor_device_id: this.device });
        added++;
        }
      }
      state.candidateCount = data.artists.reduce((n,a) => n + (C.eligible(a, this.config.provider) ? Number(!C.completed(a)) + Number(C.repliesTagged(a) && !C.completed(a, 'replies')) : 0), 0);
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
      job.expected_x_user_id = p.id; job.identity = p; job.target_url = 'https://x.com/' + p.handle + (job.target_kind === 'replies' ? '/with_replies' : '');
      job.event_key = (job.kind === 'connection_test' ? 'test:' + job.job_id : 'first:' + p.id) + ':' + (job.target_kind || 'profile');
    }
    async cancelIfChanged(state, job) {
      const a = await this.currentArtist(job);
      if (!C.sameAccount(a, job) || (job.kind !== 'connection_test' && C.completed(a, job.target_kind || 'profile'))) {
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
        if (C.submissionHold(d.jobs.filter(j => j.job_id !== job.job_id), job.provider || 'ghostarchive')) throw Error('保存先の確認が必要な依頼があるため、新規依頼を待機しています');
        d.reservations = d.reservations.filter(r => now - r.at < C.DAY);
        const daily = Math.min(20, Number(shared.daily_limit) || 20);
        if (d.reservations.length >= daily) throw Error('直近24時間の保存依頼上限に達しています');
        if ((d.provider?.name || 'ghostarchive') === (job.provider || 'ghostarchive') && d.provider?.paused_until > now) {
          // An explicit connection test can recover a prior structural failure
          // only after advance() has recognized a valid form. Rate limits and
          // human-verification pauses retain their full waiting period.
          const retest = job.kind === 'connection_test' && job.provider === 'archive.today' &&
            job.adapter_version === C.adapterVersion(job.provider) && d.provider.reason === '保存フォームの構造を確認できません';
          if (!retest) throw Error('保存先の自動処理を一時停止しています');
          d.provider = { ...d.provider, paused_until: 0, reason: '' };
        }
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
      if (job.access_wait) job.receipt_recovery_required = true;
      delete job.access_wait;
      if (job.submission_started_at && !job.receipt) job.receipt_recovery_required = true;
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
        this.prepareBodyRechecks(state);
        this.prepareReceiptRechecks(state);
        const executor = shared?.executor_device_id === this.device;
        if (executor && shared.enabled !== false) await this.scan(state, forceScan);
        const inflight = j => ['submitting', 'submission_unknown', 'processing', 'verifying'].includes(j.state);
        const job = state.jobs.filter(j => !C.TERMINAL.has(j.state) && (j.next_attempt_at || 0) <= this.now() &&
          (((inflight(j) || j.access_wait) && (executor || !shared && j.executor_device_id === this.device)) ||
            (executor && shared.enabled !== false && (j.provider || 'ghostarchive') === this.config.provider &&
              !C.submissionHold(state.jobs, this.config.provider) &&
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
      if ((job.submission_started_at || job.receipt) && this.now() - Date.parse(job.receipt_recovery_started_at || job.submission_started_at || job.created_at) > 2 * C.DAY) {
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
        if (page.kind === 'blocked') return this.waitForAccess(state, job, page);
        if (page.kind !== 'form') return this.review(state, job, '保存フォームの構造を確認できません', true);
        await this.identity(job, a);
        const latest = await this.sharedConfig();
        if (!shared || latest.executor_device_id !== this.device || latest.enabled === false || !await this.canSubmit(job)) return;
        this.clearAccessWait(job);
        // Reserve in the shared CAS ledger before allowing the save request.
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
          if (sent?.blocked) return this.waitForAccess(state, job, sent);
          job.state = sent?.uncertain ? 'submission_unknown' : 'needs_review'; job.last_error = sent?.reason || '保存先の受付を確認できません';
        }
        job.next_attempt_at = this.now() + C.MINUTE; this.put(state, job); await this.save(state);
        return;
      }
      if (job.state === 'submitting' || job.state === 'submission_unknown') {
        const result = await this.ghost.reconcile(job);
        // A challenge may already have a short receipt URL. Keep it as evidence,
        // but do not mistake the CAPTCHA itself for successful acceptance.
        const receipt = C.resultProvider(result.receipt) === (job.provider || 'ghostarchive') ? C.resultURL(result.receipt) : '';
        if (result.kind === 'blocked') {
          if (receipt) this.acceptReceipt(job, receipt);
          return this.waitForAccess(state, job, result);
        }
        if (receipt) {
          if (!this.acceptReceipt(job, receipt)) return this.review(state, job, '保存結果URLが変わっています。対象を確認してください');
          this.clearAccessWait(job); job.state = 'processing'; job.last_error = ''; job.next_attempt_at = this.now() + C.MINUTE; this.put(state, job);
        }
        else if (result.kind === 'loading' || result.kind === 'form') {
          job.receipt_checks = (job.receipt_checks || 0) + 1;
          if (job.receipt_checks >= 3) return this.review(state, job, '受付URLを確認できません。保存先の画面で確認してください');
          job.state = 'submission_unknown'; job.next_attempt_at = this.now() + C.MINUTE; this.put(state, job);
        }
        else {
          delete job.access_wait; job.receipt_recovery_required = true;
          await this.review(state, job, result.reason || '受付結果が不明です。保存先の画面または検索結果で確認してください');
        }
        return;
      }
      if (job.state === 'processing' || job.state === 'verifying') {
        if (job.provider === 'archive.today') {
          const revisions = new Map(state.bodyReaderRevisions || []);
          revisions.set(job.job_id, BODY_READER_REVISION); state.bodyReaderRevisions = [...revisions];
        }
        const page = await this.ghost.inspect(job);
        if (page.kind === 'blocked') return this.waitForAccess(state, job, page);
        if (!['archive', 'processing', 'loading'].includes(page.kind)) return this.review(state, job, '保存結果の形式を確認できません');
        if (page.receipt && C.resultURL(page.receipt) !== job.receipt) {
          if (!C.receiptTransition(job.receipt, page.receipt)) return this.review(state, job, '保存結果URLが変わっています。対象を確認してください');
          job.receipt_history = [...new Set([...(job.receipt_history || []), job.receipt])]; job.receipt = C.resultURL(page.receipt);
          this.put(state, job); await this.save(state);
        }
        this.clearAccessWait(job);
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
      const receipt = C.resultURL(value);
      if (!receipt) {
        if (C.searchTarget(value)) throw Error('これは保存履歴の検索ページです。「開いている保存ページから選ぶ」で個別の保存結果を選択してください');
        throw Error('保存先の保存結果URLを入力してください');
      }
      const owner = this.uuid(); if (!await this.store.acquire(this.key, owner, this.now())) throw Error('処理中です。少し待ってください');
      try {
        const state = await this.state(); const job = state.jobs.find(j => j.job_id === jobId);
        if (!job || !job.identity || job.state === 'succeeded') throw Error('確認対象のジョブが見つかりません');
        if (C.resultProvider(receipt) !== (job.provider || 'ghostarchive')) throw Error('このジョブと同じ保存先の結果URLを入力してください');
        if (job.receipt && receipt !== job.receipt) {
          const correctingMismatch = job.state === 'needs_review' && MANUAL_RECEIPT_REPLACEMENT_ERRORS.has(job.last_error);
          if (!C.receiptTransition(job.receipt, receipt)) {
            if (!correctingMismatch) throw Error('受付済みの結果URLを別の保存に変更できません');
            job.receiptCorrection = { from: job.receipt, to: receipt, reason: job.last_error, updated_at: job.updated_at };
          }
          job.receipt_history = [...new Set([...(job.receipt_history || []), job.receipt])];
        }
        this.clearAccessWait(job);
        job.receipt = receipt; job.state = 'processing'; job.next_attempt_at = this.now(); job.verification_checks = 0;
        job.receipt_recovery_started_at = new Date(this.now()).toISOString();
        this.put(state, job); await this.save(state); await this.flush(state);
      } finally { await this.store.release(this.key, owner); }
    }
    async recheck(jobId) {
      const owner = this.uuid(); if (!await this.store.acquire(this.key, owner, this.now())) throw Error('処理中です。少し待ってください');
      try {
        const state = await this.state(), job = state.jobs.find(j => j.job_id === jobId);
        if (!job || job.executor_device_id !== this.device || !C.attention(job)) throw Error('このブラウザの確認対象が見つかりません');
        if (!job.submission_started_at && !job.receipt && !job.access_wait) throw Error('保存結果を確認する対象がありません');
        job.state = job.receipt ? 'processing' : job.submission_started_at ? 'submission_unknown' : 'opening';
        job.receipt_checks = 0; job.verification_checks = 0; job.next_attempt_at = this.now();
        job.receipt_recovery_started_at = new Date(this.now()).toISOString();
        this.put(state, job); await this.save(state);
      } finally { await this.store.release(this.key, owner); }
    }
  }
  const api = { Engine, JOBS, CONFIG };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AutoArchiveEngine = api;
})(globalThis);
