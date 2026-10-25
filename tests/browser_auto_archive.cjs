// Real MV3 worker, IndexedDB, alarms, isolated-world DOM operations and browser
// form POSTs. External service responses are fixtures; DOM operations are real.
const {chromium}=require('playwright');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'), temp=fs.mkdtempSync(path.join(os.tmpdir(),'x-archive-mv3-'));
const provider=process.env.ARCHIVE_PROVIDER || 'archive.today',today=provider==='archive.today';
const home=today?'https://archive.li/':'https://ghostarchive.org/';
const captureId=n=>today?'Fx00'+n:'Fixture'+n;
const receiptURL=(n,processing=false)=>home+(today?(processing?'wip/':''):'archive/')+captureId(n);
const extension=path.join(temp,'extension');fs.cpSync(path.join(root,'extensions/mute-screen-capture'),extension,{recursive:true});
// Represent permissions already granted by the user. Never ship this test-only
// manifest: the distribution requests these permissions from its settings UI.
const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json')));
manifest.permissions.push(...manifest.optional_permissions);manifest.host_permissions=manifest.optional_host_permissions;
delete manifest.optional_permissions;delete manifest.optional_host_permissions;
fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify(manifest));
async function fakeNetwork(){
  globalThis.fixtureClock=(await chrome.storage.local.get('fixtureClock')).fixtureClock || Date.now();
  Date.now=()=>globalThis.fixtureClock;
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
  let posts=0,fixtureNow=Date.now();const captures=new Map(),errors=[];
  try{
    context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
    const savedBody=(cap,id,inline=false)=>{
      const h=cap.target.split('/').pop(),user=h==='X'?'783214':'1234567890123456789';
      const rewrite=inline?home+'o/'+id+'/':'https://ghostarchive.org/news2/'+id+'/a/href/';
      return `<main data-testid="primaryColumn"><div data-testid="UserName">${h==='X'?'X':'例'}<br>@${h}</div><div data-testid="UserDescription">自己紹介</div><div data-testid="userActions"><button data-testid="${user}-follow">Follow</button></div><a href="${rewrite}https://x.com/${h}/following">Following</a><article data-testid="tweet"><a href="${rewrite}https://x.com/${h}/status/987654321"><time>今日</time></a><div data-testid="tweetText">保存本文</div></article></main>`;
    };
    await context.route('https://archive.li/**',async route=>{
      const req=route.request(),u=new URL(req.url());
      if(u.pathname==='/submit'){
        assert.equal(req.method(),'POST');const params=new URLSearchParams(req.postData()),target=params.get('url');
        assert.equal(params.get('submitid'),'fixture-form-token');assert.match(target,/^https:\/\/x\.com\/(X|Example)$/);
        const n=++posts;captures.set(captureId(n),{target,ready:false});
        await route.fulfill({status:302,headers:{location:receiptURL(n,true)}});return;
      }
      const wip=u.pathname.match(/^\/wip\/(Fx00\d)$/),final=u.pathname.match(/^\/(Fx00\d)$/),m=wip||final;
      if(m){
        const cap=captures.get(m[1]);assert.ok(cap);
        if(wip&&cap.ready){await route.fulfill({status:302,headers:{location:home+m[1]}});return;}
        const stamp=new Date(fixtureNow).toISOString().replace(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d).*$/,'$1.$2.$3-$4$5$6');
        await route.fulfill({contentType:'text/html',body:wip?'<!doctype html><title>Archiving</title><p>Saving page</p>':`<!doctype html><title>保存結果</title><div id="HEADER"><input id="SHARE_LONGLINK" value="${home}${stamp}/${cap.target}"></div><div id="CONTENT">${savedBody(cap,m[1],true)}</div>`});return;
      }
      await route.fulfill({contentType:'text/html',body:'<!doctype html><title>archive.li</title><form id="submit_form" action="/submit" method="POST"><input name="submitid" type="hidden" value="fixture-form-token"><label>URL<input name="url"></label><button>save</button></form>'});
    });
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
        await route.fulfill({contentType:'text/html',body:cap.ready?`<!doctype html><title>保存結果</title><input id="searchInput" value="${cap.target}"><p>Archive date: ${new Date(fixtureNow).toUTCString()}</p><iframe src="/news2/${m[1]}/web/ghost/"></iframe>`:'<!doctype html><title>Archiving in progress.....</title><p>When the archival process is finished, this page will automatically refresh.</p>'});return;
      }
      const frame=u.pathname.match(/^\/news2\/(Fixture\d+)\/web\/ghost\/$/);
      if(frame){const cap=captures.get(frame[1]);
        await route.fulfill({contentType:'text/html',body:`<!doctype html><title>プロフィール</title>${savedBody(cap,frame[1])}`});return;
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
    assert.equal(await page.locator('#provider').inputValue(),'archive.today');
    await page.locator('#provider').selectOption(provider);
    await page.locator('#token').fill('fixture-token');await page.locator('#connection button').click();
    await page.locator('#summary').filter({hasText:'接続テストが必要'}).waitFor().catch(async e=>{console.error('Settings diagnostics:',await page.locator('#message').innerText());throw e;});
    assert.equal(await worker.evaluate(async()=>Object.hasOwn((await chrome.storage.local.get('autoArchiveSettings')).autoArchiveSettings,'token')),false);
    const testTab=context.waitForEvent('page');
    await page.locator('#test').click();
    await page.locator('#message').filter({hasText:'反映しました'}).waitFor();
    const first=await testTab;await first.waitForURL(home);await first.waitForSelector(today?'form input[name="url"]':'form input#archive');
    const due=async()=>{
      fixtureNow=await worker.evaluate(async()=>{
        globalThis.fixtureClock+=61000;
        await chrome.storage.local.set({fixtureClock:globalThis.fixtureClock});
        await AutoArchiveRuntime.kick(false);
        return globalThis.fixtureClock;
      });
    };
    const state=()=>worker.evaluate(async()=>AutoArchiveRuntime.status(true));
    await due();assert.equal(posts,1);
    await first.waitForURL(receiptURL(1,today),{waitUntil:'domcontentloaded'});
    await due();assert.equal((await state()).jobs[0].state,'processing');assert.equal((await state()).ready,false);
    captures.get(captureId(1)).ready=true;
    await first.reload();await (today?first.locator('#CONTENT'):first.frameLocator('iframe')).locator('[data-testid="UserName"]').waitFor();
    await due();assert.equal((await state()).ready,true);assert.equal((await state()).jobs[0].state,'succeeded');
    const captureTab=context.waitForEvent('page');
    await page.locator('#start').click();await page.locator('#message').filter({hasText:'反映しました'}).waitFor();
    const second=await captureTab;await second.waitForURL(home);await second.waitForSelector(today?'form input[name="url"]':'form input#archive');
    await due();assert.equal(posts,2);
    await second.waitForURL(receiptURL(2,today),{waitUntil:'domcontentloaded'});await due();
    assert.equal((await state()).jobs.find(j=>j.artist_id==='one').state,'processing');
    // Stop the actual MV3 worker. IndexedDB and the shared receipt must survive;
    // waking it must not cause the form POST to run a second time.
    // Close the extension worker's target, as in Chrome's termination testing
    // guide. stopAllWorkers can reuse the CDP target and leave Playwright 1.51
    // waiting for a new worker event which Chrome never emits.
    const cdp=await context.newCDPSession(page), workerURL=worker.url(), {targetInfos}=await cdp.send('Target.getTargets');
    const target=targetInfos.find(t=>t.type==='service_worker'&&t.url===workerURL);assert.ok(target);
    await worker.evaluate(()=>{globalThis.fixtureBeforeRestart=true;});
    const stopped=await cdp.send('Target.closeTarget',{targetId:target.targetId});assert.equal(stopped.success,true);
    await page.evaluate(()=>chrome.runtime.sendMessage({type:'AUTO_STATUS'}));
    const restarted=(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='service_worker'&&t.url===workerURL);assert.ok(restarted);
    worker=await require('./native_cdp_worker.cjs')(cdp,restarted.targetId);
    assert.equal(await worker.evaluate(()=>typeof fixtureBeforeRestart),'undefined');await worker.evaluate(fakeNetwork);
    captures.get(captureId(2)).ready=true;await second.reload();await (today?second.locator('#CONTENT'):second.frameLocator('iframe')).locator('[data-testid="UserName"]').waitFor();
    await due();assert.equal(posts,2);
    const final=await state();assert.equal(final.jobs.find(j=>j.artist_id==='one').state,'succeeded');
    const api=await worker.evaluate(async()=>(await chrome.storage.local.get('fixtureAPI')).fixtureAPI);
    const saved=api.docs['data/artists.json'];assert.equal(saved.artists[0].archive_status,'done');assert.equal(saved.artists[0].note,'手元のメモ');assert.equal(saved.artists[0].threads_posts[0].text,'残す');
    assert.equal(saved.artists[0].archives[0].posts_verification,'confirmed');assert.equal(saved.artists[1].archive_status,undefined);assert.equal(saved.artists[2].archive_url,'https://archive.md/Abc12');
    assert.equal(saved.artists[0].archive_provider,provider);assert.equal(saved.artists[0].archive_url,receiptURL(2));
    await page.reload();await page.locator('#summary').filter({hasText:'有効'}).waitFor();
    fs.mkdirSync(path.join(root,'test-output'),{recursive:true});await page.screenshot({path:path.join(root,'test-output/auto-archive-options-'+provider+'.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('Native auto-archive checks passed ('+provider+'): native fetch, permissions, settings, gate, form POST, saved body, numeric ID, posts, worker restart, IndexedDB, GitHub CAS and legacy exclusions.');
  }finally{await context.close();fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1)});
