const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('index.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const seed = [{ id: 'local', name: '保存済み', x_account: 'local', works: [], threads_posts: [], tracking_mode: 'monitor_only' }];
function harness() {
  const pending = [], calls = [], messages = [], state = new Map([['artist_tracker_v1', JSON.stringify(seed)]]);
  const elements = new Map();
  let failStorage = false;
  const ctx = vm.createContext({
    URL, console, setTimeout: () => {}, clearTimeout() {},
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    document: { getElementById: id => {
      if (!elements.has(id)) elements.set(id, { value: '', style: {}, classList: { add() {}, remove() {} } });
      return elements.get(id);
    } },
    localStorage: { getItem: key => state.get(key) ?? null, setItem: (key, value) => {
      if (failStorage) throw new Error('QuotaExceededError'); state.set(key, value);
    } },
    fetch: (url, options) => new Promise(resolve => { calls.push({ url, ...options }); pending.push(resolve); })
  });
  vm.runInContext(script.slice(0, script.lastIndexOf('\nloadLocal();')), ctx);
  vm.runInContext(`artists = ${JSON.stringify(seed)}; renderList = () => {}; showToast = message => messages.push(message);`,
    Object.assign(ctx, { messages }));
  for (const [id, value] of Object.entries({ cfgToken: 'test-token', cfgOwner: 'owner', cfgRepo: 'repo', cfgPath: 'data/artists.json' })) {
    ctx.document.getElementById(id).value = value;
  }
  const reply = (index, status, body) => pending[index]({ ok: status >= 200 && status < 300, status, json: async () => body });
  const respond = (index, value) => reply(index, 200, { sha: 'base', content: Buffer.from(JSON.stringify(value)).toString('base64') });
  return { ctx, state, messages, respond, reply, calls, get: () => JSON.parse(vm.runInContext('JSON.stringify(artists)', ctx)),
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

const turn = () => new Promise(resolve => setImmediate(resolve));
async function loaded() {
  const h = harness(), read = h.ctx.loadFromGitHub();
  h.respond(0, remote); await read;
  vm.runInContext("artists[0].note = 'ローカルの編集'; saveLocal();", h.ctx);
  return h;
}
async function finishUnexpectedWrite(h, promise) {
  await turn();
  h.calls.forEach((call, i) => { if (call.method === 'PUT') h.reply(i, 200, { content: { sha: 'saved' } }); });
  await promise;
}
test('a stale page never writes over newer remote profile data', async () => {
  const h = await loaded(), before = h.state.get('artist_tracker_v1');
  const save = h.ctx.syncToGitHub(); h.reply(1, 200, { sha: 'newer-remote' });
  await finishUnexpectedWrite(h, save);
  assert.equal(h.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal(h.state.get('artist_tracker_v1'), before);
  assert.equal(h.get()[0].note, 'ローカルの編集');
});
test('a failed version check never sends a blind create or update', async () => {
  const h = await loaded(), save = h.ctx.syncToGitHub(); h.reply(1, 503, {});
  await finishUnexpectedWrite(h, save);
  assert.equal(h.calls.filter(call => call.method === 'PUT').length, 0);
});
test('an existing file cannot be overwritten without first loading its revision', async () => {
  const h = harness(), save = h.ctx.syncToGitHub(); h.reply(0, 200, { sha: 'unseen' });
  await finishUnexpectedWrite(h, save);
  assert.equal(h.calls.filter(call => call.method === 'PUT').length, 0);
});
test('a normal save uses the loaded revision and subsequent saves use the returned revision', async () => {
  const h = await loaded(), first = h.ctx.syncToGitHub();
  h.reply(1, 200, { sha: 'base' }); await turn();
  const body = JSON.parse(h.calls[2].body);
  assert.equal(body.sha, 'base');
  assert.equal(JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')).artists[0].note, 'ローカルの編集');
  // A later local edit is not erased by the save acknowledgement.
  vm.runInContext("artists[0].note = '保存中の次の編集'; saveLocal();", h.ctx);
  h.reply(2, 200, { content: { sha: 'saved' } }); assert.equal(await first, true);
  assert.equal(h.get()[0].note, '保存中の次の編集');
  const second = h.ctx.syncToGitHub(); h.reply(3, 200, { sha: 'saved' }); await turn();
  assert.equal(JSON.parse(h.calls[4].body).sha, 'saved');
  h.reply(4, 200, { content: { sha: 'saved-again' } }); assert.equal(await second, true);
});
test('a genuinely missing target can be created without a revision', async () => {
  const h = harness(), save = h.ctx.syncToGitHub(); h.reply(0, 404, {}); await turn();
  assert.equal(Object.hasOwn(JSON.parse(h.calls[1].body), 'sha'), false);
  h.reply(1, 201, { content: { sha: 'created' } }); assert.equal(await save, true);
});
test('a deleted remote file is not silently recreated from an old page', async () => {
  const h = await loaded(), save = h.ctx.syncToGitHub(); h.reply(1, 404, {});
  assert.equal(await save, false);
  assert.equal(h.calls.length, 2);
});
test('a revision from another repository cannot authorize a save', async () => {
  const h = await loaded(); h.ctx.document.getElementById('cfgRepo').value = 'other';
  const save = h.ctx.syncToGitHub(); h.reply(1, 200, { sha: 'base' });
  assert.equal(await save, false);
  assert.equal(h.calls.length, 2);
});
for (const change of ["artists[0].note = '次の編集'", "document.getElementById('cfgRepo').value = 'other'"]) {
  test(`a change during the version check cancels saving: ${change}`, async () => {
    const h = await loaded(), save = h.ctx.syncToGitHub(); vm.runInContext(change, h.ctx);
    h.reply(1, 200, { sha: 'base' }); assert.equal(await save, false);
    assert.equal(h.calls.length, 2);
  });
}
test('overlapping saves and reads do not start a second operation', async () => {
  const h = await loaded(), save = h.ctx.syncToGitHub();
  assert.equal(await h.ctx.syncToGitHub(), false); await h.ctx.loadFromGitHub();
  assert.equal(h.calls.length, 2);
  h.reply(1, 200, { sha: 'base' }); await turn();
  h.reply(2, 200, { content: { sha: 'saved' } }); assert.equal(await save, true);
});
test('a conflict after the check is not retried with a newer revision', async () => {
  const h = await loaded(), before = h.state.get('artist_tracker_v1'), save = h.ctx.syncToGitHub();
  h.reply(1, 200, { sha: 'base' }); await turn(); h.reply(2, 409, {});
  assert.equal(await save, false);
  assert.equal(h.calls.length, 3);
  assert.equal(h.state.get('artist_tracker_v1'), before);
  assert.equal(h.ctx.document.getElementById('syncBtn').disabled, false);
});
test('a malformed revision check cannot start a write', async () => {
  const h = await loaded(), save = h.ctx.syncToGitHub(); h.reply(1, 200, {});
  assert.equal(await save, false); assert.equal(h.calls.length, 2);
});
test('a read started before a save cannot later replace the edits or saved revision', async () => {
  const h = await loaded(), read = h.ctx.loadFromGitHub(), save = h.ctx.syncToGitHub();
  h.reply(2, 200, { sha: 'base' }); await turn();
  h.reply(3, 200, { content: { sha: 'saved' } }); assert.equal(await save, true);
  h.respond(1, remote); await read;
  assert.equal(h.get()[0].note, 'ローカルの編集');
  const next = h.ctx.syncToGitHub(); h.reply(4, 200, { sha: 'saved' }); await turn();
  h.reply(5, 200, { content: { sha: 'saved-again' } }); assert.equal(await next, true);
});
