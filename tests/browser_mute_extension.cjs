const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ headless:true,
    ...(process.env.MUTE_TEST_BROWSER_EXECUTABLE ? {executablePath:process.env.MUTE_TEST_BROWSER_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']} : {}) });
  try {
    const page = await browser.newPage({viewport:{width:390,height:844}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://yamada1221.github.io/x-archives/**', async route => {
      const relative = new URL(route.request().url()).pathname.slice('/x-archives/'.length) || 'index.html';
      const file = path.join(__dirname,'..',relative);
      await route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'application/javascript':'text/html'});
    });
    await page.goto('https://yamada1221.github.io/x-archives/?mute_capture=test-token');
    await page.evaluate(() => {
      Tesseract.createWorker=async()=>({setParameters:async()=>{},recognize:async()=>({data:{text:'@Example\n@SecondUser'}}),terminate:async()=>{}});
      const canvas=document.createElement('canvas');canvas.width=500;canvas.height=400;
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,500,400);ctx.fillStyle='black';ctx.font='24px sans-serif';ctx.fillText('@Example',30,50);
      const imageData=canvas.toDataURL();
      window.testClaims=0;
      window.chrome={runtime:{sendMessage:async request=>{
        if(request.type!=='CLAIM_MUTE_SCREEN'||request.token!=='test-token')throw Error('Unexpected request');
        window.testClaims++;return {ok:true,imageData,sourceAccount:'Owner'};
      }}};
    });
    await page.addScriptTag({path:path.join(__dirname,'../extensions/mute-screen-capture/bridge.js')});
    await page.waitForFunction(()=>document.getElementById('muteCandidates').value.includes('@SecondUser'));
    assert.equal(await page.evaluate(()=>window.testClaims),1);
    assert.equal(new URL(page.url()).searchParams.has('mute_capture'),false);
    assert.equal(await page.locator('#muteSourceAccount').inputValue(),'Owner');
    assert.equal(await page.locator('#muteImportModal').isVisible(),true);
    assert.match(await page.locator('#muteStatus').textContent(),/手動スクロール/);
    assert.equal(await page.evaluate(()=>artists.length),0); // User review is still required.
    await page.locator('#muteConfirmed').check();await page.locator('#muteRegister').click();
    assert.equal(await page.evaluate(()=>artists.length),2);
    assert.equal(await page.evaluate(()=>artists[0].x_mute_observations.owner.muted),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    // A different-origin message cannot replace the current review image.
    await page.evaluate(()=>{window.dispatchEvent(new MessageEvent('message',{source:window,origin:'https://evil.test',data:{type:'X_TRACKER_MUTE_SCREEN_IMAGE',imageData:'data:image/png;base64,AAAA',sourceAccount:'Impostor'}}));});
    assert.equal(await page.locator('#muteSourceAccount').inputValue(),'Owner');
    assert.deepEqual(errors,[]);
    console.log('Extension bridge browser checks passed: handshake, one-time claim, local image review, account source, no automatic registration, mobile layout and origin checks.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exit(1)});
