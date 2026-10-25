const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const base = require('node:path').join(__dirname, '../extensions/mute-screen-capture');
function setup() {
  const session = {}, local = {};
  let active = { id:1, windowId:7, url:'https://x.com/settings/muted/all', status:'complete' };
  const calls = { capture:0, updates:[] };
  const chrome = {
    runtime:{id:'test-id',getURL:p=>'chrome-extension://test-id/'+p,onMessage:{addListener:()=>{}}},
    storage:{session:{get:async key=>({[key]:session[key]}),set:async obj=>Object.assign(session,obj),remove:async key=>{delete session[key];}},local:{set:async obj=>Object.assign(local,obj)}},
    tabs:{query:async()=>[active],captureVisibleTab:async(id,opts)=>{calls.capture++;assert.equal(id,7);assert.equal(opts.format,'png');return 'data:image/png;base64,AAAA';},create:async()=>({id:2}),update:async(id,opts)=>calls.updates.push({id,...opts}),remove:async()=>{},onRemoved:{addListener:fn=>{calls.onRemoved=fn;}}},
  };
  const context = vm.createContext({chrome,URL,crypto:require('node:crypto').webcrypto,Date});
  vm.runInContext(fs.readFileSync(base+'/background.js','utf8'),context);
  return {session,local,calls,chrome,setActive:v=>{active=v;},run:(msg,sender={id:'test-id',url:'chrome-extension://test-id/popup.html'})=>context.handle(msg,sender),valid:url=>context.isMutePage(url)};
}
test('manifest limits access to activeTab, storage and the exact tracker pages',()=>{
  const m=JSON.parse(fs.readFileSync(base+'/manifest.json'));
  assert.deepEqual(m.permissions,['activeTab','storage']);
  assert.equal(m.host_permissions,undefined);
  assert.ok(m.content_scripts[0].matches.every(url=>url.startsWith('https://yamada1221.github.io/x-archives/')));
});
test('only a mute-list URL is eligible for capture',()=>{
  const a=setup();
  for(const url of ['https://x.com/settings/muted/all','https://twitter.com/settings/muted/'])assert.equal(a.valid(url),true);
  for(const url of ['https://x.com/home','https://x.com/settings/muted/words','https://x.com.evil/settings/muted/all','https://x.com@evil/settings/muted/all','http://x.com/settings/muted/all'])assert.equal(a.valid(url),false);
});
test('one capture is bound to one receiver tab and can be claimed only once',async()=>{
  const a=setup();await a.run({type:'CAPTURE_MUTE_SCREEN',sourceAccount:'@Owner'});
  assert.equal(a.calls.capture,1);assert.equal(a.local.sourceAccount,'Owner');
  const pending=a.session.pendingMuteScreen;
  assert.equal(pending.targetTabId,2);assert.match(a.calls.updates[0].url,/^https:\/\/yamada1221.github.io\/x-archives\/\?mute_capture=/);
  const receiver={id:'test-id',url:a.calls.updates[0].url,frameId:0,tab:{id:2}};
  await assert.rejects(a.run({type:'CLAIM_MUTE_SCREEN',token:pending.token},{...receiver,tab:{id:3}}));
  await assert.rejects(a.run({type:'CLAIM_MUTE_SCREEN',token:pending.token},{...receiver,url:'https://evil.test/'}));
  await assert.rejects(a.run({type:'CLAIM_MUTE_SCREEN',token:'wrong'},receiver));
  const result=await a.run({type:'CLAIM_MUTE_SCREEN',token:pending.token},receiver);
  assert.equal(result.imageData,'data:image/png;base64,AAAA');assert.equal(a.session.pendingMuteScreen,undefined);
  await assert.rejects(a.run({type:'CLAIM_MUTE_SCREEN',token:pending.token},receiver));
});
test('page messages cannot capture; wrong page and tab-switch races never open the tracker',async()=>{
  const a=setup();await assert.rejects(a.run({type:'CAPTURE_MUTE_SCREEN'},{id:'test-id',tab:{id:1},url:'https://x.com/settings/muted/all'}));
  a.setActive({id:1,windowId:7,url:'https://x.com/home'});await assert.rejects(a.run({type:'CAPTURE_MUTE_SCREEN'}));assert.equal(a.calls.capture,0);
  a.setActive({id:1,windowId:7,url:'https://x.com/settings/muted/all'});
  const capture=a.chrome.tabs.captureVisibleTab;a.chrome.tabs.captureVisibleTab=async(...args)=>{const image=await capture(...args);a.setActive({id:99,windowId:7,url:'https://x.com/home'});return image;};
  await assert.rejects(a.run({type:'CAPTURE_MUTE_SCREEN'}),/表示タブ/);assert.equal(a.calls.updates.length,0);assert.equal(a.session.pendingMuteScreen,undefined);
});
test('expired screenshots and closed receiver tabs are discarded',async()=>{
  const a=setup();await a.run({type:'CAPTURE_MUTE_SCREEN'});
  const pending=a.session.pendingMuteScreen;pending.createdAt=0;
  await assert.rejects(a.run({type:'CLAIM_MUTE_SCREEN',token:pending.token},{id:'test-id',url:a.calls.updates[0].url,frameId:0,tab:{id:2}}),/期限/);
  assert.equal(a.session.pendingMuteScreen,undefined);
  await a.run({type:'CAPTURE_MUTE_SCREEN'});await a.calls.onRemoved(2);assert.equal(a.session.pendingMuteScreen,undefined);
});
