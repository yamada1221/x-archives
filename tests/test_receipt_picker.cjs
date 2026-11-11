const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../extensions/mute-screen-capture/auto-core.js');
const { collect } = require('../extensions/mute-screen-capture/auto-receipt-picker.js');
test('search URLs identify their profile but are never accepted as individual captures', () => {
  assert.equal(C.searchTarget('https://archive.li/https://x.com/X'), 'https://x.com/x');
  assert.equal(C.resultURL('https://archive.li/https://x.com/X'), '');
  assert.equal(C.searchTarget('https://ghostarchive.org/search?term=https%3A%2F%2Fx.com%2FX'), 'https://x.com/x');
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
      return [{ result: [
        { url: 'https://archive.li/Ab123', label: '2026-10-26 X' },
        { url: 'https://archive.li/https://x.com/X', label: 'Search' },
        { url: 'https://example.com/Ab123', label: 'Foreign' }
      ] }];
    } }
  };
  const results = await collect(chrome, { target_url: 'https://x.com/X', provider: 'archive.today' });
  assert.deepEqual(readTabs, [1]);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://archive.li/Ab123');
  assert.equal(results[0].label, '2026-10-26 X');
  assert.doesNotMatch(JSON.stringify(results), /private/);
});
test('receipt picking respects existing site permissions', async () => {
  const results = await collect({ tabs: { query: async () => [{ id: 1, url: 'https://archive.li/Ab123' }] }, permissions: { contains: async () => false } }, { target_url: 'https://x.com/X', provider: 'archive.today' });
  assert.deepEqual(results, []);
});
