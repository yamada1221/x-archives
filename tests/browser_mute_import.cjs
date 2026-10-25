const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless:true,
    ...(process.env.MUTE_TEST_BROWSER_EXECUTABLE ? {
      executablePath:process.env.MUTE_TEST_BROWSER_EXECUTABLE,
      args:['--no-sandbox', '--disable-dev-shm-usage'],
    } : {}) });
  const page = await browser.newPage({ viewport:{ width:390, height:844 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8765/');
  await page.evaluate(() => {
    localStorage.setItem('artist_tracker_v1', JSON.stringify([{ id:'existing', name:'Existing', x_account:'Example', note:'保持', works:[] }]));
  });
  await page.reload();
  await page.evaluate(() => {
    Tesseract.createWorker = async () => ({
      setParameters:async()=>{}, recognize:async()=>({data:{text:'@Example\n@NewUser\nbio mentions @DoNotAdd'}}), terminate:async()=>{},
    });
  });
  await page.getByRole('button',{name:'ミュート画像を取り込む',exact:true}).click();
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width=400; canvas.height=600;
    const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,400,600);ctx.fillStyle='black';ctx.font='24px sans-serif';ctx.fillText('@Example',30,80);ctx.fillText('@NewUser',30,180);
    return canvas.toDataURL().split(',')[1];
  });
  await page.locator('#muteFile').setInputFiles({name:'screen.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await page.waitForFunction(()=>document.getElementById('muteCandidates').value.includes('@NewUser'));
  assert.match(await page.locator('#muteStatus').textContent(),/手動スクロール/);
  assert.equal(await page.evaluate(()=>artists.length),1);
  await page.locator('#muteSourceAccount').fill('@Owner');
  await page.locator('#muteRegister').click();
  assert.equal(await page.evaluate(()=>artists.length),1); // Confirmation is mandatory.
  await page.locator('#muteConfirmed').check();
  // Save failure must preserve both the persisted and visible records.
  await page.evaluate(()=>{window.originalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new Error('容量不足')};});
  await page.locator('#muteRegister').click();
  assert.match(await page.locator('#muteStatus').textContent(),/容量不足/);
  assert.equal(await page.evaluate(()=>artists.length),1);
  await page.evaluate(()=>{Storage.prototype.setItem=window.originalSet;});
  await page.locator('#muteRegister').click();
  assert.match(await page.locator('#muteStatus').textContent(),/新規1件・既存1件/);
  const rows = await page.evaluate(()=>JSON.parse(localStorage.getItem('artist_tracker_v1')));
  assert.equal(rows.length,2); assert.equal(rows[0].note,'保持');
  assert.equal(rows[0].x_muted,true);assert.equal(rows[1].x_mute_observations.owner.muted,true);
  assert.equal(await page.getByText('Xミュート確認',{exact:true}).count(),2);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'/tmp/mute-import-mobile.png'});
  await page.getByRole('button',{name:'閉じる',exact:true}).last().click();
  assert.equal(await page.locator('#mutePreview').getAttribute('src'),null);
  // A synthetic shared surface validates exactly one capture and stream cleanup.
  await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=400;canvas.height=300;
    const ctx=canvas.getContext('2d');let n=0;
    window.captureTimer=setInterval(()=>{ctx.fillStyle=n++%2?'white':'black';ctx.fillRect(0,0,400,300)},30);
    window.captureCalls=0;window.stoppedTracks=0;
    navigator.mediaDevices.getDisplayMedia=async()=>{
      window.captureCalls++;const stream=canvas.captureStream(10);
      for(const t of stream.getTracks()){const stop=t.stop.bind(t);t.stop=()=>{if(t.readyState!=='ended')window.stoppedTracks++;stop();};}
      return stream;
    };
  });
  await page.getByRole('button',{name:'ミュート画像を取り込む',exact:true}).click();
  await page.locator('#muteCapture').click();
  await page.waitForFunction(()=>document.getElementById('muteCandidates').value.includes('@NewUser'));
  assert.equal(await page.evaluate(()=>window.captureCalls),1);
  assert.equal(await page.evaluate(()=>window.stoppedTracks),1);
  assert.equal(await page.locator('#muteCapture').isDisabled(),false);
  await page.evaluate(()=>clearInterval(window.captureTimer));
  // Another tab's changes are never replaced by importing a stale list.
  await page.evaluate(()=>{const rows=JSON.parse(localStorage.getItem('artist_tracker_v1'));rows[0].note='別タブの編集';localStorage.setItem('artist_tracker_v1',JSON.stringify(rows));});
  await page.locator('#muteConfirmed').check();await page.locator('#muteRegister').click();
  assert.match(await page.locator('#muteStatus').textContent(),/別タブ/);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('artist_tracker_v1'))[0].note),'別タブの編集');
  assert.deepEqual(errors,[]);
  await browser.close();
  console.log('Mute import browser checks passed: image input, review, merge, storage failure, single-frame capture and cleanup, stale-tab protection, mobile layout.');
})().catch(e=>{console.error(e);process.exit(1)});
