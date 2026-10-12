const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('index.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const seed = [{ id: 'local', name: '保存済み', x_account: 'local', works: [], threads_posts: [], tracking_mode: 'monitor_only' }];
function harness() {
  const pending = [], messages = [], state = new Map([['artist_tracker_v1', JSON.stringify(seed)]]);
  const elements = new Map();
  let failStorage = false;
  const ctx = vm.createContext({
    URL, console, setTimeout: () => {}, clearTimeout() {},
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    document: { getElementById: id => {
      if (!elements.has(id)) elements.set(id, { value: '', style: {}, classList: { add() {}, remove() {} } });
      return elements.get(id);
    } },
    localStorage: { getItem: key => state.get(key) ?? null, setItem: (key, value) => {
      if (failStorage) throw new Error('QuotaExceededError'); state.set(key, value);
    } },
    fetch: () => new Promise(resolve => pending.push(resolve))
  });
  vm.runInContext(script.slice(0, script.lastIndexOf('\nloadLocal();')), ctx);
  vm.runInContext(`artists = ${JSON.stringify(seed)}; renderList = () => {}; showToast = message => messages.push(message);`,
    Object.assign(ctx, { messages }));
  for (const [id, value] of Object.entries({ cfgToken: 'test-token', cfgOwner: 'owner', cfgRepo: 'repo', cfgPath: 'data/artists.json' })) {
    ctx.document.getElementById(id).value = value;
  }
  const respond = (index, value) => pending[index]({ ok: true, json: async () => ({ content: Buffer.from(JSON.stringify(value)).toString('base64') }) });
  return { ctx, state, messages, respond, get: () => JSON.parse(vm.runInContext('JSON.stringify(artists)', ctx)),
    failStorage: () => { failStorage = true; } };
}
const remote = { artists: [{ id: 'remote', name: '取得した名前' }] };
test('edits made during a GitHub read survive the late response', async () => {
  const h = harness(), read = h.ctx.loadFromGitHub();
  vm.runInContext("artists[0].note = '読み込み中に編集'; saveLocal();", h.ctx);
  const before = h.state.get('artist_tracker_v1');
  h.respond(0, remote); await read;
  assert.equal(h.get()[0].note, '読み込み中に編集');
  assert.equal(h.state.get('artist_tracker_v1'), before);
});
test('changing repositories during a read does not import the old repository', async () => {
  const h = harness(), read = h.ctx.loadFromGitHub();
  h.ctx.document.getElementById('cfgRepo').value = 'other';
  h.respond(0, remote); await read;
  assert.deepEqual(h.get(), seed);
});
test('only the latest overlapping read may update the list', async () => {
  const h = harness(), first = h.ctx.loadFromGitHub(), second = h.ctx.loadFromGitHub();
  h.respond(1, remote); await second;
  h.respond(0, { artists: [{ id: 'stale' }] }); await first;
  assert.equal(h.get()[0].id, 'remote');
});
test('another tab changing local storage during a read is not overwritten', async () => {
  const h = harness(), read = h.ctx.loadFromGitHub();
  const other = JSON.stringify([{ id: 'other-tab' }]);
  h.state.set('artist_tracker_v1', other);
  h.respond(0, remote); await read;
  assert.equal(h.state.get('artist_tracker_v1'), other);
  assert.deepEqual(h.get(), seed);
});
test('storage failure preserves both the displayed list and saved list', async () => {
  const h = harness(), read = h.ctx.loadFromGitHub(); h.failStorage();
  h.respond(0, remote); await read;
  assert.deepEqual(h.get(), seed);
  assert.equal(h.state.get('artist_tracker_v1'), JSON.stringify(seed));
  assert.match(h.messages.at(-1), /エラー/);
});
for (const artists of [[{}], ['invalid'], [{ id: 'same' }, { id: 'same' }], [{ id: 'new', name: {} }],
  [{ id: 'new', threads_posts: [{ text: {} }] }], [{ id: 'new', threads_posts: [{ timestamp: 1 }] }],
  [{ id: 'new', monitoring: { observed_username: {} } }]]) {
  test(`invalid records leave the existing list intact: ${JSON.stringify(artists)}`, async () => {
    const h = harness(), read = h.ctx.loadFromGitHub(); h.respond(0, { artists }); await read;
    assert.deepEqual(h.get(), seed);
    assert.equal(h.state.get('artist_tracker_v1'), JSON.stringify(seed));
    assert.match(h.messages.at(-1), /エラー/);
  });
}
test('valid records retain extra profile data and get legacy defaults', async () => {
  const h = harness(), read = h.ctx.loadFromGitHub();
  h.respond(0, { artists: [{ id: 'remote', name: null, monitoring: { last_result: 'active' } }] }); await read;
  assert.deepEqual(h.get(), [{ id: 'remote', name: null, monitoring: { last_result: 'active' },
    tracking_mode: 'monitor_only', works: [], threads_posts: [] }]);
  assert.deepEqual(JSON.parse(h.state.get('artist_tracker_v1')), h.get());
});
