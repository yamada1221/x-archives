const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const base = path.join(__dirname, '../extensions/mute-screen-capture');
const C = require(path.join(base, 'auto-core.js'));

class MemoryStore {
  constructor() { this.data = new Map(); this.locks = new Set(); }
  async get(key, fallback = null) { return structuredClone(this.data.has(key) ? this.data.get(key) : fallback); }
  async set(key, value) { this.data.set(key, structuredClone(value)); }
  async acquire(key) { if (this.locks.has(key)) return false; this.locks.add(key); return true; }
  async release(key) { this.locks.delete(key); }
}

async function runtime(jobs) {
  const config = C.config({ token: 'fixture-token', provider: 'archive.today', enabled: false,
    providerReady: C.adapterVersion('archive.today') });
  delete config.token;
  const local = { autoArchiveSettings: config, autoArchiveDevice: 'device' }, db = new MemoryStore();
  await db.set('credential:' + C.scope(config), 'fixture-token');
  await db.set(C.scope(config), { jobs, lastRunAt: 0, nextScanAt: 0, candidateCount: 125 });
  const ctx = { URL, Date, Set, Map, Promise, structuredClone, TextEncoder, TextDecoder, AbortController,
    setTimeout, clearTimeout, crypto: require('node:crypto').webcrypto };
  ctx.chrome = {
    runtime: { id: 'mine', getURL: p => 'chrome-extension://mine/' + p,
      onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { local: { get: async key => ({ [key]: local[key] }), set: async value => Object.assign(local, value) } },
    alarms: { get: async () => null, create: async () => {}, clear: async () => {}, onAlarm: { addListener() {} } }
  };
  vm.createContext(ctx);
  for (const name of ['auto-core', 'auto-ghost', 'auto-today', 'auto-engine']) {
    vm.runInContext(fs.readFileSync(path.join(base, name + '.js'), 'utf8'), ctx);
  }
  ctx.AutoArchiveStore = class { constructor() { return db; } };
  ctx.AutoArchiveGitHub = class {};
  vm.runInContext(fs.readFileSync(path.join(base, 'auto-runtime.js'), 'utf8'), ctx);
  return { api: ctx.AutoArchiveRuntime, db, config };
}

test('settings retain all older attention states and replies metadata beyond a 100-job backlog', async () => {
  const older = [
    { job_id: 'old-review', registered_handle: 'OldReview', state: 'needs_review' },
    { job_id: 'old-unknown', registered_handle: 'OldUnknown', state: 'submission_unknown' },
    { job_id: 'old-human', registered_handle: 'OldHuman', state: 'opening', access_wait: 'human',
      target_kind: 'replies', executor_device_id: 'device', provider: 'archive.today' },
    { job_id: 'old-limit', registered_handle: 'OldLimit', state: 'retry_wait', access_wait: 'rate_limit',
      executor_device_id: 'other', provider: 'archive.today' }
  ];
  const queued = Array.from({ length: 125 }, (_, i) => ({ job_id: 'queued-' + i, registered_handle: 'Queue' + i,
    state: 'queued', provider: 'archive.today' }));
  queued[120] = { job_id: 'recent-review', registered_handle: 'RecentReview', state: 'needs_review', provider: 'archive.today' };
  const jobs = [...older, ...queued], { api, db, config } = await runtime(jobs);
  const full = await api.handle({ type: 'AUTO_STATUS' }, { id: 'mine', url: 'chrome-extension://mine/auto-options.html' });
  const page = await api.status(false);
  assert.equal(full.reviewCount, 5);
  assert.equal(full.jobs.length, 104);
  assert.equal(new Set(full.jobs.map(j => j.job_id)).size, 104);
  for (const original of older) assert.equal(full.jobs.filter(j => j.job_id === original.job_id).length, 1);
  assert.equal(full.jobs.filter(j => j.job_id === 'recent-review').length, 1);
  const human = full.jobs.find(j => j.job_id === 'old-human');
  assert.equal(human.target_kind, 'replies');
  assert.equal(human.label, '人間確認待ち');
  assert.equal(human.attention, true);
  assert.equal(human.access_wait, 'human');
  assert.equal(human.can_recheck, true);
  assert.equal(full.jobs.find(j => j.job_id === 'old-limit').can_recheck, false);
  assert.equal(full.submissionHeld, true);
  assert.equal(page.jobs.length, 100);
  assert.equal(page.jobs.some(j => j.job_id.startsWith('old-')), false);
  assert.deepEqual(Array.from(page.jobs, j => j.job_id), queued.slice(-100).map(j => j.job_id));
  assert.equal(page.reviewCount, undefined);
  assert.equal(page.config, undefined);
  assert.equal(page.device, undefined);
  assert.equal(JSON.stringify(full).includes('fixture-token'), false);
  assert.equal(JSON.stringify(page).includes('fixture-token'), false);
  assert.deepEqual((await db.get(C.scope(config))).jobs, jobs);
});

test('a short attention queue is returned once in its existing order', async () => {
  const jobs = [{ job_id: 'queued', registered_handle: 'Queue', state: 'queued' },
    { job_id: 'review', registered_handle: 'Review', state: 'needs_review' }];
  const { api } = await runtime(jobs);
  const full = await api.status(true), page = await api.status(false);
  assert.equal(full.reviewCount, 1);
  assert.deepEqual(Array.from(full.jobs, j => j.job_id), ['queued', 'review']);
  assert.deepEqual(Array.from(page.jobs, j => j.job_id), ['queued', 'review']);
});
