// Run with Playwright's full Chromium: validates a real MV3 installation and
// isolated-world message delivery. The PNG is a fixture; X is never contacted.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const extension = path.resolve(__dirname,'../extensions/mute-screen-capture');
  const context = await chromium.launchPersistentContext('', {channel:'chromium',headless:true,
    args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker',{timeout:15000});
    assert.ok(worker.url().startsWith('chrome-extension://'));
    await require('./native_extension_startup.cjs')(worker);
    const errors=[];
    context.on('page', page=>page.on('pageerror', error=>errors.push(error.message)));
    await context.route('https://yamada1221.github.io/x-archives/**',async route=>{
      const relative=new URL(route.request().url()).pathname.slice('/x-archives/'.length)||'index.html';
      if(relative==='vendor/tesseract/tesseract.min.js') {
        await route.fulfill({contentType:'application/javascript',body:"window.Tesseract={createWorker:async()=>({setParameters:async()=>{},recognize:async()=>({data:{text:'@Example'}}),terminate:async()=>{}})};"});return;
      }
      const file=path.join(__dirname,'..',relative);
      await route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'application/javascript':'text/html'});
    });
    const fixture=context.pages()[0]||await context.newPage();
    const imageData=await fixture.evaluate(()=>{const c=document.createElement('canvas');c.width=400;c.height=300;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,400,300);return c.toDataURL();});
    const newPage=context.waitForEvent('page');
    await worker.evaluate(async image=>{
      const tab=await chrome.tabs.create({url:'about:blank',active:true});
      await chrome.storage.session.set({pendingMuteScreen:{token:'native-test',targetTabId:tab.id,imageData:image,sourceAccount:'Owner',createdAt:Date.now()}});
      await chrome.tabs.update(tab.id,{url:'https://yamada1221.github.io/x-archives/?mute_capture=native-test'});
    },imageData);
    const page=await newPage;
    await page.waitForFunction(()=>document.getElementById('muteCandidates')?.value==='@Example',{},{timeout:20000}).catch(async error=>{
      console.error('Native receiver diagnostics:',JSON.stringify({errors,body:(await page.locator('body').innerText()).slice(-3500),worker:await worker.evaluate(async()=>({runtime:typeof AutoArchiveRuntime,pending:Boolean((await chrome.storage.session.get('pendingMuteScreen')).pendingMuteScreen)}))}));
      throw error;
    });
    assert.equal(await page.locator('#muteSourceAccount').inputValue(),'Owner');
    assert.equal(new URL(page.url()).searchParams.has('mute_capture'),false);
    assert.equal(await page.evaluate(()=>artists.length),0);
    assert.equal(await worker.evaluate(async()=>Boolean((await chrome.storage.session.get('pendingMuteScreen')).pendingMuteScreen)),false);
    // Real Chrome APIs: a scheduled attempt without activeTab permission is
    // skipped, even when the tab ID and URL happen to match the saved binding.
    await context.route('https://x.com/settings/muted/all',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Fixture mute list</title><p>@Example</p>'}));
    const xPage=await context.newPage();await xPage.goto('https://x.com/settings/muted/all');await xPage.bringToFront();
    const skipped=await worker.evaluate(async()=>{
      const tab=(await chrome.tabs.query({active:true,lastFocusedWindow:true}))[0];
      await chrome.storage.local.set({dailyMuteSchedule:{enabled:true,token:'native-daily',sourceAccount:'Owner',nextRunAt:Date.now()-1}});
      await chrome.storage.session.set({dailyMuteBinding:{token:'native-daily',tabId:tab.id,windowId:tab.windowId}});
      await runDaily();
      return {schedule:(await chrome.storage.local.get('dailyMuteSchedule')).dailyMuteSchedule,badge:await chrome.action.getBadgeText({}),alarm:await chrome.alarms.get('daily-mute-capture')};
    });
    assert.equal(skipped.schedule.lastResult,'failed');assert.equal(skipped.badge,'!');assert.equal(skipped.alarm.periodInMinutes,1440);
    // Supply fixture pixels in place of the native capture only. Window
    // selection, alarms, session storage, notifications and bridge remain real.
    const dailyPagePromise=context.waitForEvent('page');
    await worker.evaluate(async image=>{
      const schedule=(await chrome.storage.local.get('dailyMuteSchedule')).dailyMuteSchedule;
      await chrome.storage.local.set({dailyMuteSchedule:{...schedule,nextRunAt:Date.now()-1}});
      const capture=captureImage;captureImage=async()=>image;
      try { await runDaily(); } finally { captureImage=capture; }
    },imageData);
    const dailyPage=await dailyPagePromise;
    await dailyPage.waitForFunction(()=>document.getElementById('muteCandidates')?.value==='@Example',{},{timeout:20000});
    const successful=await worker.evaluate(async()=>{
      const schedule=(await chrome.storage.local.get('dailyMuteSchedule')).dailyMuteSchedule;
      const binding=(await chrome.storage.session.get('dailyMuteBinding')).dailyMuteBinding;
      const active=(await chrome.tabs.query({active:true,windowId:binding.windowId}))[0];
      return {schedule,sourceStillActive:active.id===binding.tabId};
    });
    assert.equal(successful.schedule.lastResult,'success');assert.equal(successful.sourceStillActive,true);
    assert.equal(await dailyPage.evaluate(()=>artists.length),0);
    assert.deepEqual(errors,[]);
    console.log('Native MV3 checks passed: extension install, guarded bridge, permission-loss skip, daily alarm bookkeeping, background delivery without changing source tab, and manual review.');
  } finally { await context.close(); }
})().catch(error=>{console.error(error);process.exit(1)});
