const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const u = require('../tracker-utils.js');

for (const input of ['@Example_1', 'Example_1', 'https://x.com/Example_1?s=21', 'twitter.com/Example_1/', 'https://mobile.twitter.com/Example_1/with_replies', 'https://www.x.com/Example_1/status/123/photo/1?s=20']) {
  test(`extracts account from ${input}`, () => assert.equal(u.parseXInput(input).account, 'Example_1'));
}
test('post URL loses tracking and media suffix, retains the post', () => {
  assert.deepEqual(u.parseXInput('https://twitter.com/Example/status/123/video/1?s=21#share'), { account: 'Example', postUrl: 'https://x.com/Example/status/123' });
});
for (const input of ['https://x.com.evil.test/user', 'https://x.com@evil.test/user', 'https://evil.test/x.com/user', 'https://x.com/home', 'https://x.com/i/web/status/123', 'https://x.com/i/user/123', 'https://x.com/search?q=x', 'https://x.com/user/lists/123', 'https://x.com/user/status/no-id', 'javascript:alert(1)', 'https://x.com/%2fuser', 'sixteencharacter', 'https://x.com/user:pw@evil.test']) {
  test(`rejects ambiguous or invalid X input: ${input}`, () => assert.throws(() => u.parseXInput(input)));
}
test('empty X input is allowed for Threads-only records', () => assert.equal(u.parseXInput('').account, ''));
test('presets use repeated existing notes, including non-ASCII, in frequency order', () => {
  assert.deepEqual(u.suggestPhrases([{note:'既存B'}, {note:'既存A'}, {note:'既存A'}, {note:'既存B'}, {note:'既存B'}, {note:'一度だけ'}]), ['既存B','既存A']);
});
test('presets preserve manual text and avoid repeated taps including compound phrases', () => {
  assert.equal(u.appendPhrase('手書きメモ', '要確認'), '手書きメモ / 要確認');
  assert.equal(u.appendPhrase('手書きメモ / 要確認', '要確認'), '手書きメモ / 要確認');
  assert.equal(u.appendPhrase('手書きメモ / A / B', 'A / B'), '手書きメモ / A / B');
  assert.equal(u.appendPhrase('要確認の予定', '要確認'), '要確認の予定 / 要確認');
  assert.equal(u.appendPhrase('  ', '要確認'), '要確認');
});
test('custom presets deduplicate without interpreting HTML and permit empty settings', () => {
  assert.deepEqual(u.normalizePhrases([' a ', 'a', '', '<b>手入力</b>']), ['a', '<b>手入力</b>']);
  assert.deepEqual(u.normalizePhrases([]), []);
});
for (const [url, provider, status] of [
  ['https://archive.md/Abc12', 'archive.today', 'pending'],
  ['https://archive.li/2026.10.12-093319/https://x.com/example', 'archive.today', 'pending'],
  ['https://archive.li/wip/Abc12', 'archive.today', 'pending'],
  ['https://archive.ph/wip/2026.10.12-093319/https://x.com/example', 'archive.today', 'pending'],
  ['https://ghostarchive.org/archive/Ab123', 'ghostarchive', 'pending'],
  ['https://web.archive.org/web/20261012090000/https://x.com/example', 'wayback', 'pending'],
  ['https://perma.cc/ABCD-1234', 'perma', 'pending'],
]) test(`recognizes saved result ${url}`, () => assert.deepEqual(u.archiveResult(url), { url, provider, status }));
for (const url of ['https://archive.md/', 'https://archive.md/submit', 'https://archive.md/about', 'https://archive.md/newest/https://x.com/example', 'https://ghostarchive.org/', 'https://ghostarchive.org/search?term=example', 'https://web.archive.org/save/https://x.com/example', 'https://web.archive.org/web/*/https://x.com/example', 'https://perma.cc/docs', 'javascript:alert(1)', 'https://ghostarchive.org.evil.test/archive/Ab123', 'https://user:pass@perma.cc/ABCD-1234']) {
  test(`does not treat form/search/unsafe URL as a saved result: ${url}`, () => assert.equal(u.archiveResult(url), null));
}
test('all existing archive links remain visible without migrating user data', () => {
  for (const artist of JSON.parse(fs.readFileSync('data/artists.json')).artists.filter(a => a.archive_url)) assert.ok(u.archiveResults(artist).length, 'legacy URL was dropped');
});
test('multiple providers preserve existing data; pending cannot downgrade completed captures', () => {
  const artist = { archive_url: 'https://archive.md/Abc12', archive_status: 'done', note: 'keep', monitoring: {last_result:'active'}, works: [{url:'https://example.com'}] };
  u.recordArchive(artist, 'https://ghostarchive.org/archive/Ab123', 'https://x.com/example', '2026-10-13', true);
  u.recordArchive(artist, 'https://archive.li/wip/Bcd23', 'https://x.com/example', '2026-10-13');
  assert.equal(artist.archive_status, 'done');
  assert.equal(artist.archive_url, 'https://ghostarchive.org/archive/Ab123');
  assert.equal(artist.archives.length, 3);
  u.recordArchive(artist, 'https://ghostarchive.org/archive/Ab123', 'https://x.com/example', '2026-10-14');
  assert.equal(artist.archives.length, 3);
  assert.equal(artist.note, 'keep'); assert.equal(artist.monitoring.last_result, 'active');
  assert.equal(artist.works[0].url, 'https://example.com');
});
function formHarness() {
  const elements = new Map(), state = new Map(), alerts = [], fetched = [];
  const ctx = vm.createContext({ TrackerUtils:u, URL, console, setTimeout:()=>{}, clearTimeout(){}, alert:m=>alerts.push(m),
    document:{getElementById:id=>{if(!elements.has(id)) elements.set(id,{value:'',style:{},classList:{add(){},remove(){}},focus(){}});return elements.get(id);}},
    localStorage:{getItem:k=>state.get(k)??null,setItem:(k,v)=>state.set(k,v)} });
  const script = fs.readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script.slice(0,script.lastIndexOf('\nloadLocal();')),ctx);
  Object.assign(ctx,{fetched});
  vm.runInContext('renderList=()=>{};showToast=()=>{};syncToGitHub=async()=>true;triggerFetch=async(id,x)=>{fetched.push(x);return true;};',ctx);
  ctx.document.getElementById('fMode').value='record';
  return {ctx,state,alerts,fetched, field:(id,v)=>ctx.document.getElementById(id).value=v, get:()=>JSON.parse(vm.runInContext('JSON.stringify(artists)',ctx))};
}
test('URL add dispatches only handle and retains canonical post; duplicate URLs do not add accounts', async()=>{
  const h=formHarness(); h.field('fX','https://twitter.com/Example/status/123?s=20'); h.field('fNote','manual');
  await h.ctx.saveArtist();
  assert.equal(h.get()[0].x_account,'Example'); assert.equal(h.get()[0].works[0].url,'https://x.com/Example/status/123');
  assert.equal(h.get()[0].note,'manual'); assert.deepEqual(h.fetched,['Example']);
  h.field('fX','https://x.com/example'); await h.ctx.saveArtist();
  assert.equal(h.get().length,1); assert.match(h.alerts.at(-1),/すでに登録/);
});
test('legacy URL accounts prevent duplicates while malformed entries remain tolerated', async()=>{
  const h=formHarness();
  vm.runInContext("artists=[{id:'invalid',x_account:'https://example.org/Foo'},{id:'legacy',x_account:'https://twitter.com/Foo/status/123?s=20'}];",h.ctx);
  h.field('fX','https://x.com/foo'); await h.ctx.saveArtist();
  assert.equal(h.get().length,2); assert.match(h.alerts.at(-1),/すでに登録/);
  assert.equal(h.fetched.length,0);
  h.field('fX','Bar'); await h.ctx.saveArtist();
  assert.equal(h.get().length,3); assert.deepEqual(h.fetched,['Bar']);
});
test('invalid URL leaves existing records and dispatches untouched', async()=>{
  const h=formHarness();h.field('fX','https://x.com/i/status/123');await h.ctx.saveArtist();assert.equal(h.get().length,0);assert.equal(h.fetched.length,0);
});
test('changing only URL format does not reset account identity or duplicate its post',async()=>{
  const h=formHarness(); h.field('fX','https://x.com/Example/status/123'); await h.ctx.saveArtist();
  vm.runInContext("editingId=artists[0].id;artists[0].x_user_id='123';artists[0].monitoring={last_result:'active'};",h.ctx);
  h.field('fX','https://twitter.com/EXAMPLE/status/123?s=20');await h.ctx.saveArtist();
  assert.equal(h.get()[0].x_user_id,'123');assert.equal(h.get()[0].monitoring.last_result,'active');assert.equal(h.get()[0].works.length,1);
});
test('a completed result clears only the same provider and target pending entry', () => {
  const artist = {};
  u.recordArchive(artist,'https://archive.md/wip/Abc12','https://x.com/example','now');
  u.recordArchive(artist,'https://archive.md/wip/Bcd23','https://x.com/other','now');
  u.recordArchive(artist,'https://archive.li/Cde34','https://x.com/example','later', true);
  assert.equal(artist.archives.length,2);
  assert.equal(artist.archives[0].target_url,'https://x.com/other');
  assert.equal(artist.archive_status,'done');
});

const fishUrl = 'https://megalodon.jp/2026-1017-0547-37/https://x.com:443/X';
test('gyotaku URL starts unverified and can be confirmed without duplication', () => {
  assert.equal(u.archiveResult(fishUrl).status, 'pending');
  const artist = {archive_url:'https://archive.md/Abc12', archive_status:'done', note:'keep'};
  u.recordArchive(artist, fishUrl, 'https://x.com/X', 'first');
  assert.equal(artist.archive_url, 'https://archive.md/Abc12');
  assert.equal(u.archiveResults(artist).find(e=>e.provider==='gyotaku').status, 'pending');
  u.recordArchive(artist, fishUrl, 'https://x.com/X', 'confirmed', true);
  assert.equal(artist.archive_url, fishUrl);
  assert.equal(artist.archives.length, 2);
  const restored = JSON.parse(JSON.stringify(artist));
  assert.equal(u.archiveResults(restored).find(e=>e.provider==='gyotaku').status, 'done');
  u.recordArchive(restored, fishUrl, 'https://x.com/X', 'again');
  assert.equal(restored.archive_status, 'done');
  assert.equal(restored.archives.find(e=>e.provider==='gyotaku').content_verified_at, 'confirmed');
  assert.equal(restored.note, 'keep');
});
for (const url of ['https://megalodon.jp/', 'https://megalodon.jp/pc/main?url=https://x.com/X', 'https://megalodon.jp.evil.test/2026-1017-0547-37/https://x.com/X', 'https://megalodon.jp/2026-1017-0547-37/javascript:alert(1)', 'https://megalodon.jp/2026-1017-0547-37/https://user:pass@x.com/X']) {
  test(`rejects invalid fish result: ${url}`,()=>assert.equal(u.archiveResult(url),null));
}
