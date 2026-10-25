const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const base = require('node:path').join(__dirname, '../extensions/mute-screen-capture');
function setup() {
  const session = {}, local = {};
  let active = { id:1, windowId:7, url:'https://x.com/settings/muted/all', status:'complete' };
  const calls = { capture:0, updates:[], notifications:[], badge:[], now:Date.now(), alarms:new Map(), windowCreates:[] };
  const storage = target => ({get:async key=>({[key]:target[key]}),set:async obj=>Object.assign(target,obj),remove:async key=>{delete target[key];}});
  const chrome = {
    runtime:{id:'test-id',getURL:p=>'chrome-extension://test-id/'+p,onMessage:{addListener:()=>{}},onStartup:{addListener:fn=>{calls.onStartup=fn;}},onInstalled:{addListener:fn=>{calls.onInstalled=fn;}}},
    storage:{session:storage(session),local:storage(local)},
    action:{setBadgeText:async value=>calls.badge.push(value.text),setBadgeBackgroundColor:async()=>{}},
    notifications:{create:async(id,data)=>calls.notifications.push({id,...data}),clear:async()=>{},onClicked:{addListener:fn=>{calls.onNotification=fn;}}},
    alarms:{get:async name=>calls.alarms.get(name),create:async(name,options)=>calls.alarms.set(name,options),clear:async name=>calls.alarms.delete(name),onAlarm:{addListener:fn=>{calls.onAlarm=fn;}}},
    windows:{get:async id=>({id,state:calls.windowState||'normal'}),getAll:async()=>[{id:7,type:'normal'},{id:8,type:'normal'}],update:async()=>{},create:async options=>{
      calls.windowCreates.push(options);
      if(options.tabId){active={...active,windowId:8};return {id:8,tabs:[active]};}
      return {id:9,tabs:[{id:2,windowId:9}]};
    }},
    tabs:{query:async()=>[active],captureVisibleTab:async(id,opts)=>{calls.capture++;assert.equal(id,active.windowId);assert.equal(opts.format,'png');return 'data:image/png;base64,AAAA';},create:async()=>({id:2}),update:async(id,opts)=>{calls.updates.push({id,...opts});return {id,windowId:7};},remove:async()=>{},onRemoved:{addListener:fn=>{calls.onRemoved=fn;}}},
  };
  class Clock extends Date { static now() { return calls.now; } }
  const context = vm.createContext({chrome,URL,crypto:require('node:crypto').webcrypto,Date:Clock});
  vm.runInContext(fs.readFileSync(base+'/background.js','utf8'),context);
  return {session,local,calls,chrome,setActive:v=>{active=v;},run:(msg,sender={id:'test-id',url:'chrome-extension://test-id/popup.html'})=>context.handle(msg,sender),daily:()=>context.runDaily(),ensure:()=>context.ensureAlarm(),valid:url=>context.isMutePage(url)};
}
test('manifest limits access to activeTab, storage and the exact tracker pages',()=>{
  const m=JSON.parse(fs.readFileSync(base+'/manifest.json'));
  assert.deepEqual(m.permissions,['activeTab','storage','alarms','notifications']);
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
const DAY=24*60*60*1000;
test('daily start binds the already authorized tab, schedules 24 hours later and requires source account',async()=>{
  const a=setup();await assert.rejects(a.run({type:'START_DAILY_MUTE'}),/ユーザー名/);
  assert.equal(a.calls.windowCreates.length,0);
  await a.run({type:'START_DAILY_MUTE',sourceAccount:'@Owner'});
  const schedule=a.local.dailyMuteSchedule;
  assert.equal(schedule.enabled,true);assert.equal(schedule.nextRunAt,a.calls.now+DAY);
  assert.equal(a.session.dailyMuteBinding.tabId,1);assert.equal(a.session.dailyMuteBinding.windowId,8);
  assert.equal(a.calls.windowCreates[0].tabId,1);
  assert.equal(a.calls.capture,0);assert.equal(a.calls.alarms.get('daily-mute-capture').periodInMinutes,1440);
});
test('daily alarm captures one frame in source window without taking focus; duplicate alarms do not repeat',async()=>{
  const a=setup();await a.run({type:'START_DAILY_MUTE',sourceAccount:'Owner'});
  await a.daily();assert.equal(a.calls.capture,0);
  a.calls.now+=DAY+4000;await a.daily();
  assert.equal(a.calls.capture,1);assert.equal(a.local.dailyMuteSchedule.lastResult,'success');
  assert.equal(a.calls.alarms.get('daily-mute-capture').when,a.calls.now+DAY);
  const pending=a.session.pendingMuteScreen;assert.equal(pending.sourceAccount,'Owner');
  assert.ok(a.calls.notifications.some(item=>item.id==='mute-review:2'));
  await a.daily();assert.equal(a.calls.capture,1);
});
test('sleep catches up at most once, and missing alarms are reconstructed from saved schedule',async()=>{
  const a=setup();await a.run({type:'START_DAILY_MUTE',sourceAccount:'Owner'});
  a.calls.alarms.clear();await a.ensure();assert.equal(a.calls.alarms.get('daily-mute-capture').when,a.calls.now+DAY);
  a.calls.now+=DAY*4;await a.daily();await a.daily();
  assert.equal(a.calls.capture,1);assert.equal(a.local.dailyMuteSchedule.nextRunAt,a.calls.now+DAY);
});
test('lost binding after restart never reuses tab IDs and notifies for re-registration',async()=>{
  const a=setup();await a.run({type:'START_DAILY_MUTE',sourceAccount:'Owner'});
  await a.calls.onStartup();assert.equal(a.session.dailyMuteBinding,undefined);
  assert.equal((await a.run({type:'GET_DAILY_STATUS'})).needsRegistration,true);
  a.calls.now+=DAY;await a.daily();assert.equal(a.calls.capture,0);
  assert.match(a.local.dailyMuteSchedule.lastError,/権限/);
  assert.ok(a.calls.notifications.some(item=>item.id==='mute-daily-error'));
});
test('minimized windows, wrong selected tab and capture permission errors are skipped and recorded',async()=>{
  for(const scenario of ['minimized','other-tab','permission']) {
    const a=setup();await a.run({type:'START_DAILY_MUTE',sourceAccount:'Owner'});a.calls.now+=DAY;
    if(scenario==='minimized')a.calls.windowState='minimized';
    if(scenario==='other-tab')a.setActive({id:88,windowId:8,url:'https://example.com/'});
    if(scenario==='permission')a.chrome.tabs.captureVisibleTab=async()=>{throw Error('activeTab permission lost');};
    await a.daily();assert.equal(a.local.dailyMuteSchedule.lastResult,'failed');
    assert.equal(a.calls.updates.length,0);assert.ok(a.calls.notifications.some(item=>item.id==='mute-daily-error'));
  }
});
test('stopping daily capture clears alarms and bindings without closing user tabs',async()=>{
  const a=setup();await a.run({type:'START_DAILY_MUTE',sourceAccount:'Owner'});
  await a.run({type:'STOP_DAILY_MUTE'});a.calls.now+=DAY*2;await a.daily();
  assert.equal(a.calls.capture,0);assert.equal(a.calls.alarms.size,0);assert.equal(a.session.dailyMuteBinding,undefined);
  assert.equal(a.local.dailyMuteSchedule.enabled,false);
});
test('closing the dedicated tab notifies immediately and does not capture another tab',async()=>{
  const a=setup();await a.run({type:'START_DAILY_MUTE',sourceAccount:'Owner'});
  await a.calls.onRemoved(1);assert.equal(a.session.dailyMuteBinding,undefined);
  assert.match(a.local.dailyMuteSchedule.lastError,/閉じられ/);assert.equal(a.calls.capture,0);
});
test('stopping during an in-flight daily capture does not open a review tab or recreate the timer',async()=>{
  const a=setup();await a.run({type:'START_DAILY_MUTE',sourceAccount:'Owner'});a.calls.now+=DAY;
  a.chrome.tabs.captureVisibleTab=async()=>{await a.run({type:'STOP_DAILY_MUTE'});return 'data:image/png;base64,AAAA';};
  await a.daily();assert.equal(a.local.dailyMuteSchedule.enabled,false);assert.equal(a.calls.alarms.size,0);assert.equal(a.calls.updates.length,0);
});
test('blocked desktop notifications leave a badge and saved error visible in the popup',async()=>{
  const a=setup();a.chrome.notifications.create=async()=>{throw Error('OS notifications blocked');};
  await a.run({type:'START_DAILY_MUTE',sourceAccount:'Owner'});a.calls.now+=DAY;delete a.session.dailyMuteBinding;
  await a.daily();const result=await a.run({type:'GET_DAILY_STATUS'});
  assert.equal(result.schedule.lastResult,'failed');assert.equal(result.needsRegistration,true);assert.equal(a.calls.badge.at(-1),'!');
});
