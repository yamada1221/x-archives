// Real MV3 worker, IndexedDB, alarms, isolated-world DOM operations and browser
// form POSTs. Only the external GitHub/FxTwitter/Ghostarchive responses are fixtures.
const {chromium}=require('playwright');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'), temp=fs.mkdtempSync(path.join(os.tmpdir(),'x-archive-mv3-'));
const extension=path.join(temp,'extension');fs.cpSync(path.join(root,'extensions/mute-screen-capture'),extension,{recursive:true});
// Represent permissions already granted by the user. Never ship this test-only
// manifest: the distribution requests these permissions from its settings UI.
const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json')));
manifest.permissions.push(...manifest.optional_permissions);manifest.host_permissions=manifest.optional_host_permissions;
delete manifest.optional_permissions;delete manifest.optional_host_permissions;
fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify(manifest));
async function fakeNetwork(){
  globalThis.fetch=async(url,opts={})=>{
    const u=new URL(url);
    if(u.hostname==='api.fxtwitter.com'){
      const target=decodeURIComponent(u.pathname.split('/').pop()),isX=target==='X'||target==='id:783214';
      return new Response(JSON.stringify({code:200,user:{id:isX?'783214':'1234567890123456789',screen_name:isX?'X':'Example',name:isX?'X':'例',description:'自己紹介'}}));
    }
    if(u.hostname!=='api.github.com')throw Error('Unexpected network in fixture: '+u.hostname);
    if(opts.headers.Authorization!=='Bearer fixture-token')throw Error('Authorization missing');
    const key=decodeURIComponent(u.pathname.split('/contents/')[1]);
    const api=(await chrome.storage.local.get('fixtureAPI')).fixtureAPI;
    if(opts.method==='PUT'){
      const body=JSON.parse(opts.body),current=api.versions[key];
      if((current?'v'+current:undefined)!==body.sha)return new Response('{}',{status:409});
      api.docs[key]=JSON.parse(decodeURIComponent(escape(atob(body.content))));api.versions[key]=(current||0)+1;
      await chrome.storage.local.set({fixtureAPI:api});return new Response('{}');
    }
    if(!api.docs[key])return new Response('{}',{status:404});
    return new Response(JSON.stringify({sha:'v'+api.versions[key],encoding:'base64',content:btoa(unescape(encodeURIComponent(JSON.stringify(api.docs[key]))))}));
  };
}
(async()=>{
  const context=await chromium.launchPersistentContext(path.join(temp,'profile'),{channel:'chromium',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  let posts=0;const captures=new Map(),errors=[];
  try{
    context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
    await context.route('https://ghostarchive.org/**',async route=>{
      const req=route.request(),u=new URL(req.url());
      if(u.pathname==='/archive2'){
        assert.equal(req.method(),'POST');const target=new URLSearchParams(req.postData()).get('archive');
        assert.match(target,/^https:\/\/x\.com\/(X|Example)$/);
        const id='Fixture'+(++posts);captures.set(id,{target,ready:false});
        await route.fulfill({status:302,headers:{location:'https://ghostarchive.org/archive/'+id}});return;
      }
      const m=u.pathname.match(/^\/archive\/(Fixture\d+)$/);
      if(m){const cap=captures.get(m[1]);assert.ok(cap);
        await route.fulfill({contentType:'text/html',body:cap.ready?`<!doctype html><title>保存結果</title><input id="searchInput" value="${cap.target}"><p>Archive date: ${new Date().toUTCString()}</p><iframe src="/news2/${m[1]}/web/ghost/"></iframe>`:'<!doctype html><title>Archiving in progress.....</title><p>When the archival process is finished, this page will automatically refresh.</p>'});return;
      }
      const frame=u.pathname.match(/^\/news2\/(Fixture\d+)\/web\/ghost\/$/);
      if(frame){const cap=captures.get(frame[1]),h=cap.target.split('/').pop(),id=h==='X'?'783214':'1234567890123456789';
        await route.fulfill({contentType:'text/html',body:`<!doctype html><title>プロフィール</title><main data-testid="primaryColumn"><div data-testid="UserName">${h==='X'?'X':'例'}<br>@${h}</div><div data-testid="UserDescription">自己紹介</div><div data-testid="userActions"><button data-testid="${id}-follow">Follow</button></div><a href="https://ghostarchive.org/news2/${frame[1]}/a/href/https://x.com/${h}/following">Following</a><article data-testid="tweet"><a href="https://ghostarchive.org/news2/${frame[1]}/a/href/https://x.com/${h}/status/987654321"><time>今日</time></a><div data-testid="tweetText">保存本文</div></article></main>`});return;
      }
      await route.fulfill({contentType:'text/html',body:'<!doctype html><title>Ghostarchive</title><form action="/archive2" method="POST"><label for="archive">Website to be archived:</label><input id="archive" name="archive"><button>Submit for archival</button></form>'});
    });
    let worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    await require('./native_extension_startup.cjs')(worker);
    await worker.evaluate(async()=>{
      await chrome.storage.local.set({fixtureAPI:{versions:{'data/artists.json':1},docs:{'data/artists.json':{artists:[
        {id:'one',x_account:'Example',x_user_id:'1234567890123456789',tracking_mode:'record',note:'手元のメモ',threads_posts:[{id:'t',text:'残す'}]},
        {id:'monitor',x_account:'Monitor',tracking_mode:'monitor_only'},
        {id:'old',x_account:'Old',tracking_mode:'record',archive_url:'https://archive.md/Abc12',archive_status:'done'}]}}}});
    });
    await worker.evaluate(fakeNetwork);
    const extensionId=new URL(worker.url()).hostname,page=await context.newPage();
    await page.goto('chrome-extension://'+extensionId+'/auto-options.html');
    await page.locator('#token').fill('fixture-token');await page.locator('#connection button').click();
    await page.locator('#summary').filter({hasText:'接続テストが必要'}).waitFor();
    await page.locator('#test').click();
    const ghostPage=await context.waitForEvent('page', {predicate:p=>p.url().includes('ghostarchive.org')||p.url()==='about:blank',timeout:5000}).catch(()=>context.pages().find(p=>p.url()==='https://ghostarchive.org/'));
    const due=async()=>{
      await worker.evaluate(async()=>{
        const cfg=(await chrome.storage.local.get('autoArchiveSettings')).autoArchiveSettings,key=AutoArchiveCore.scope(cfg),store=new AutoArchiveStore();
        const state=await store.get(key);state.jobs.forEach(j=>j.next_attempt_at=0);await store.set(key,state);await AutoArchiveRuntime.kick(false);
      });
    };
    const state=()=>worker.evaluate(async()=>AutoArchiveRuntime.status(true));
    const waitForForm=async()=>{
      const p=context.pages().find(p=>p.url()==='https://ghostarchive.org/')||ghostPage;
      assert.ok(p,'archive tab created');await p.waitForSelector('form input#archive');return p;
    };
    await waitForForm();await due();assert.equal(posts,1);
    await context.pages().find(p=>p.url().includes('/archive/Fixture1')).waitForLoadState('domcontentloaded');
    await due();assert.equal((await state()).jobs[0].state,'processing');assert.equal((await state()).ready,false);
    captures.get('Fixture1').ready=true;
    const first=context.pages().find(p=>p.url().includes('/archive/Fixture1'));await first.reload();await first.frameLocator('iframe').locator('[data-testid="UserName"]').waitFor();
    await due();assert.equal((await state()).ready,true);assert.equal((await state()).jobs[0].state,'succeeded');
    await page.locator('#start').click();await waitForForm();await due();assert.equal(posts,2);
    const second=context.pages().find(p=>p.url().includes('/archive/Fixture2'));await second.waitForLoadState('domcontentloaded');await due();
    assert.equal((await state()).jobs.find(j=>j.artist_id==='one').state,'processing');
    // Stop the actual MV3 worker. IndexedDB and the shared receipt must survive;
    // waking it must not cause the form POST to run a second time.
    const cdp=await context.newCDPSession(page);await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');
    const nextWorker=context.waitForEvent('serviceworker');
    await page.evaluate(()=>chrome.runtime.sendMessage({type:'AUTO_STATUS'}));worker=await nextWorker;await worker.evaluate(fakeNetwork);
    captures.get('Fixture2').ready=true;await second.reload();await second.frameLocator('iframe').locator('[data-testid="UserName"]').waitFor();
    await due();assert.equal(posts,2);
    const final=await state();assert.equal(final.jobs.find(j=>j.artist_id==='one').state,'succeeded');
    const api=await worker.evaluate(async()=>(await chrome.storage.local.get('fixtureAPI')).fixtureAPI);
    const saved=api.docs['data/artists.json'];assert.equal(saved.artists[0].archive_status,'done');assert.equal(saved.artists[0].note,'手元のメモ');assert.equal(saved.artists[0].threads_posts[0].text,'残す');
    assert.equal(saved.artists[0].archives[0].posts_verification,'confirmed');assert.equal(saved.artists[1].archive_status,undefined);assert.equal(saved.artists[2].archive_url,'https://archive.md/Abc12');
    await page.reload();await page.locator('#summary').filter({hasText:'有効'}).waitFor();
    fs.mkdirSync(path.join(root,'test-output'),{recursive:true});await page.screenshot({path:path.join(root,'test-output/auto-archive-options.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('Native auto-archive checks passed: permissions, settings, gate, real form POST, archived iframe body, numeric ID, posts, actual worker restart, IndexedDB persistence, GitHub CAS and legacy exclusions.');
  }finally{await context.close();fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1)});
