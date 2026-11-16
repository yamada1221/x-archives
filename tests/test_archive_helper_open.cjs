const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const utils = require(path.join(root, 'tracker-utils.js'));
const html = fs.readFileSync(path.join(root, 'archive_helper.html'), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];

function fixture() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {value:'', dataset:{}, classList:{remove(){}}, addEventListener(){}});
    return elements.get(id);
  };
  element('archiveProvider').value = 'archive.li';
  const opened = [];
  const ctx = {document:{getElementById:element}, TrackerUtils:utils, URL, URLSearchParams,
    location:{search:''}, localStorage:{getItem(){return null;},setItem(){}},
    window:{open(...args){opened.push(args);}}, navigator:{clipboard:{writeText:async()=>{}}}, alert(){}};
  vm.createContext(ctx); vm.runInContext(script, ctx);
  return {element, opened, ctx};
}

for (const provider of ['archive.li', 'archive.md']) {
  test(`${provider} passes the exact selected target as an encoded save URL`, async () => {
    const f = fixture(); f.element('archiveProvider').value = provider;
    const target = 'https://x.com/Example/with_replies?x=1&y=two%20words';
    f.element('archiveTarget').value = target;
    await f.ctx.openArchive();
    assert.equal(f.opened.length, 1);
    const u = new URL(f.opened[0][0]);
    assert.equal(u.origin, 'https://' + provider); assert.equal(u.searchParams.get('run'), '1');
    assert.equal(u.searchParams.get('url'), target); assert.equal(f.opened[0][1], '_blank');
  });
}
test('other archive providers keep their previous destinations', async () => {
  const f = fixture(); f.element('archiveProvider').value = 'ghostarchive';
  f.element('archiveTarget').value = 'https://x.com/Example'; await f.ctx.openArchive();
  assert.equal(f.opened[0][0], 'https://ghostarchive.org/');
});
