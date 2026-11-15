const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Ghost } = require('../extensions/mute-screen-capture/auto-ghost.js');
const { Today, Providers } = require('../extensions/mute-screen-capture/auto-today.js');

function fixture(existing = null) {
  const values = {}, created = [], navigated = [], inspected = [], focused = [];
  if (existing) values['autoArchiveTab:job'] = existing.id;
  const chrome = {
    storage: { session: {
      get: async key => ({ [key]: values[key] }),
      set: async update => Object.assign(values, update)
    } },
    tabs: {
      get: async id => { if (!existing || existing.id !== id) throw Error('closed'); return existing; },
      query: async () => [],
      create: async info => { created.push(info); return { id: 77, windowId: 1, url: 'about:blank' }; },
      update: async (id, info) => { navigated.push({ id, ...info }); return { id, windowId: 1, ...info }; }
    },
    windows: { update: async (id, info) => focused.push({ id, ...info }) },
    scripting: { executeScript: async info => { inspected.push(info.target.tabId); return [{ frameId: 0, result: { kind: 'form' } }]; } }
  };
  return { chrome, created, navigated, inspected, focused };
}

test('a hold can inspect only an existing bound page without opening or navigating tabs', async () => {
  for (const Type of [Ghost, Today]) {
    const missing = fixture(), job = { job_id: 'job', state: 'opening' };
    assert.deepEqual(await new Type(missing.chrome).inspect(job, { allowOpen: false }), { kind: 'missing_binding' });
    assert.equal(missing.created.length, 0);
    assert.equal(missing.navigated.length, 0);
    assert.equal(missing.inspected.length, 0);

    const url = Type === Today ? 'https://archive.li/' : 'https://ghostarchive.org/';
    const present = fixture({ id: 7, windowId: 1, url, status: 'complete' });
    assert.equal((await new Type(present.chrome).inspect(job, { allowOpen: false })).kind, 'form');
    assert.deepEqual(present.inspected, [7]);
    assert.equal(present.created.length, 0);
    assert.equal(present.navigated.length, 0);
  }
});

test('provider wrapper preserves the no-open inspection option', async () => {
  const f = fixture(), providers = new Providers(f.chrome);
  assert.deepEqual(await providers.inspect({ job_id: 'job', state: 'opening', provider: 'archive.today' }, { allowOpen: false }), { kind: 'missing_binding' });
  assert.equal(f.created.length, 0);
});

test('explicitly showing an unbound, unsent human challenge opens the homepage', async () => {
  const f = fixture();
  await new Today(f.chrome).show({ job_id: 'job', state: 'opening', access_wait: 'human', target_url: 'https://x.com/Example' });
  assert.equal(f.created.length, 1);
  assert.equal(f.navigated[0].url, 'https://archive.li/');
  assert.equal(f.navigated[1].active, true);
  assert.equal(f.focused.length, 1);
});

test('explicitly showing an unknown submitted request continues to open its search page', async () => {
  const f = fixture();
  await new Today(f.chrome).show({ job_id: 'job', state: 'submission_unknown', submission_started_at: '2026-11-15T00:00:00Z', target_url: 'https://x.com/Example' });
  assert.equal(f.created.length, 1);
  assert.equal(f.navigated[0].url, 'https://archive.li/https://x.com/Example');
});
