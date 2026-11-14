const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../extensions/mute-screen-capture/auto-core.js');
const { collect } = require('../extensions/mute-screen-capture/auto-receipt-picker.js');
const { inspectTodayDocument } = require('../extensions/mute-screen-capture/auto-today.js');
const { inspectGhostDocument } = require('../extensions/mute-screen-capture/auto-ghost.js');
test('search URLs identify their profile but are never accepted as individual captures', () => {
  assert.equal(C.searchTarget('https://archive.li/https://x.com/X'), 'https://x.com/x');
  assert.equal(C.resultURL('https://archive.li/https://x.com/X'), '');
  assert.equal(C.searchTarget('https://ghostarchive.org/search?term=https%3A%2F%2Fx.com%2FX'), 'https://x.com/x');
  assert.equal(C.searchTarget('https://archive.li/https://x.com/X/with_replies'), 'https://x.com/x/with_replies');
  assert.equal(C.searchTarget('https://ghostarchive.org/search?term=https%3A%2F%2Fx.com%2FX%2Fwith_replies'), 'https://x.com/x/with_replies');
  for (const url of ['https://archive.li.example.com/https://x.com/X', 'http://archive.li/https://x.com/X', 'https://user@archive.li/https://x.com/X', 'https://archive.li:444/https://x.com/X']) assert.equal(C.searchTarget(url), '');
});
test('receipt picking reads matching search tabs, excludes search URLs, and deduplicates captures', async () => {
  const readTabs = [];
  const chrome = {
    tabs: { query: async () => [
      { id: 1, url: 'https://archive.li/https://x.com/X', lastAccessed: 3 },
      { id: 2, url: 'https://archive.li/Ab123?share=private', title: 'Saved X', lastAccessed: 2 },
      { id: 3, url: 'https://archive.li/https://x.com/Other' },
      { id: 4, url: 'https://example.com/Ab123' }
    ] },
    permissions: { contains: async () => true },
    scripting: { executeScript: async request => {
      readTabs.push(request.target.tabId);
      if (request.target.tabId === 2) {
        assert.equal(request.func, inspectTodayDocument);
        return [{ result: { kind: 'archive', receipt: 'https://archive.li/Ab123', original_url: 'https://x.com/X' } }];
      }
      return [{ result: [
        { url: 'https://archive.li/Ab123', label: '2026-10-26 X' },
        { url: 'https://archive.li/https://x.com/X', label: 'Search' },
        { url: 'https://example.com/Ab123', label: 'Foreign' }
      ] }];
    } }
  };
  const results = await collect(chrome, { target_url: 'https://x.com/X', provider: 'archive.today' });
  assert.deepEqual(readTabs, [1, 2]);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://archive.li/Ab123');
  assert.equal(results[0].label, '2026-10-26 X');
  assert.match(results[0].source, /本文未確認/);
  assert.doesNotMatch(JSON.stringify(results), /private/);
});
test('receipt picking respects existing site permissions', async () => {
  const results = await collect({ tabs: { query: async () => [{ id: 1, url: 'https://archive.li/Ab123' }] }, permissions: { contains: async () => false } }, { target_url: 'https://x.com/X', provider: 'archive.today' });
  assert.deepEqual(results, []);
});

for (const provider of ['archive.today', 'ghostarchive']) {
  const receipt = n => provider === 'archive.today' ? 'https://archive.li/Ab' + String(n).padStart(3, '0') : 'https://ghostarchive.org/archive/Ab' + n;
  const inspector = provider === 'archive.today' ? inspectTodayDocument : inspectGhostDocument;
  test(provider + ' direct results require the exact account and profile/replies target without side effects', async () => {
    const mutations = [], reads = [];
    const forbidden = name => () => { mutations.push(name); throw Error('Unexpected ' + name); };
    const pages = [
      { kind: 'archive', original_url: 'https://twitter.com/X/' },
      { kind: 'archive', original_url: 'https://x.com/X/with_replies' },
      { kind: 'archive', original_url: 'https://x.com/Other' },
      { kind: 'archive', original_url: '' },
      { kind: 'blocked', original_url: 'https://x.com/X', block_type: 'human' },
      { kind: 'archive', original_url: 'https://x.com/X', receipt: provider === 'archive.today' ? 'https://ghostarchive.org/archive/Wrong' : 'https://archive.li/Wrong' },
      { kind: 'processing', original_url: 'https://x.com/X' },
      { kind: 'archive', original_url: 'https://x.com/X', receipt: receipt(99) }
    ].map((page, index) => ({ receipt: receipt(index), ...page }));
    const tabs = pages.map((_, index) => ({ id: index, url: receipt(index), title: 'Saved ' + index, status: 'complete' }));
    const chrome = {
      tabs: { query: async () => tabs, create: forbidden('tabs.create'), update: forbidden('tabs.update'), remove: forbidden('tabs.remove') },
      storage: { local: { set: forbidden('storage.local.set') }, session: { set: forbidden('storage.session.set') } },
      permissions: { contains: async () => true, request: forbidden('permissions.request') },
      scripting: { executeScript: async request => {
        reads.push(request.target.tabId);
        assert.equal(request.func, inspector);
        assert.deepEqual(request.target, { tabId: request.target.tabId });
        assert.deepEqual(request.args, provider === 'ghostarchive' ? ['Ab' + request.target.tabId] : []);
        return [{ frameId: 0, result: pages[request.target.tabId] }];
      } }
    };
    const profile = await collect(chrome, { provider, target_url: 'https://x.com/X' });
    assert.deepEqual(profile.map(result => result.url), [receipt(0)]);
    assert.match(profile[0].source, /対象URL確認済み.*本文未確認/);
    const replies = await collect(chrome, { provider, target_url: 'https://x.com/X/with_replies' });
    assert.deepEqual(replies.map(result => result.url), [receipt(1)]);
    assert.equal(reads.length, pages.length * 2);
    assert.deepEqual(mutations, []);
  });

  test(provider + ' denies direct and list reads without granted permissions', async () => {
    let injected = 0;
    const search = provider === 'archive.today' ? 'https://archive.li/https://x.com/X/with_replies' :
      'https://ghostarchive.org/search?term=https%3A%2F%2Fx.com%2FX%2Fwith_replies';
    const results = await collect({ tabs: { query: async () => [{ id: 1, url: receipt(1) }, { id: 2, url: search }] },
      permissions: { contains: async () => false }, scripting: { executeScript: async () => { injected++; throw Error('No permission'); } } },
    { provider, target_url: 'https://x.com/X/with_replies' });
    assert.deepEqual(results, []);
    assert.equal(injected, 0);
  });

  test(provider + ' reads only the matching target-kind search list and keeps links unverified', async () => {
    const searched = [], base = provider === 'archive.today' ? 'https://archive.li/' : 'https://ghostarchive.org/search?term=';
    const search = target => base + (provider === 'archive.today' ? target : encodeURIComponent(target));
    const chrome = { tabs: { query: async () => [{ id: 1, url: search('https://x.com/X') },
      { id: 2, url: search('https://x.com/X/with_replies') }, { id: 3, url: search('https://x.com/Other/with_replies') }] },
    permissions: { contains: async () => true }, scripting: { executeScript: async request => {
      searched.push(request.target.tabId);
      return [{ result: [{ url: receipt(1), label: 'Unverified archive' }] }];
    } } };
    const results = await collect(chrome, { provider, target_url: 'https://x.com/X/with_replies' });
    assert.deepEqual(searched, [2]);
    assert.equal(results.length, 1);
    assert.match(results[0].source, /保存一覧.*本文未確認/);
  });
}

test('direct result inspections stop after 40 tabs and candidate output stays bounded at 20', async () => {
  let inspected = 0;
  const chrome = { tabs: { query: async () => Array.from({ length: 60 }, (_, id) => ({ id,
    url: 'https://archive.li/Ab' + String(id).padStart(3, '0'), status: 'complete' })) },
  permissions: { contains: async () => true }, scripting: { executeScript: async request => {
    inspected++;
    return [{ result: { kind: 'archive', original_url: request.target.tabId < 40 ? 'https://x.com/Other' : 'https://x.com/X',
      receipt: 'https://archive.li/Ab' + String(request.target.tabId).padStart(3, '0') } }];
  } } };
  assert.deepEqual(await collect(chrome, { provider: 'archive.today', target_url: 'https://x.com/X' }), []);
  assert.equal(inspected, 40);
  inspected = 0;
  chrome.scripting.executeScript = async request => {
    inspected++;
    return [{ result: { kind: 'archive', original_url: 'https://x.com/X',
      receipt: 'https://archive.li/Ab' + String(request.target.tabId).padStart(3, '0') } }];
  };
  assert.equal((await collect(chrome, { provider: 'archive.today', target_url: 'https://x.com/X' })).length, 20);
  assert.equal(inspected, 20);
});
