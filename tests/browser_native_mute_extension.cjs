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
    await page.waitForFunction(()=>document.getElementById('muteCandidates')?.value==='@Example',{},{timeout:20000});
    assert.equal(await page.locator('#muteSourceAccount').inputValue(),'Owner');
    assert.equal(new URL(page.url()).searchParams.has('mute_capture'),false);
    assert.equal(await page.evaluate(()=>artists.length),0);
    assert.equal(await worker.evaluate(async()=>Boolean((await chrome.storage.session.get('pendingMuteScreen')).pendingMuteScreen)),false);
    assert.deepEqual(errors,[]);
    console.log('Native MV3 checks passed: extension install, real isolated-world bridge, guarded screenshot claim, deletion after transfer and manual review.');
  } finally { await context.close(); }
})().catch(error=>{console.error(error);process.exit(1)});
