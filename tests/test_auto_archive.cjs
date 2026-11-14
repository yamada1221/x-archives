const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const base=path.join(__dirname,'../extensions/mute-screen-capture');
const C=require(base+'/auto-core.js'), {Engine,JOBS,CONFIG}=require(base+'/auto-engine.js'), GitHub=require(base+'/auto-github.js');
const clone=structuredClone;
class MemoryStore {
  constructor(){this.data=new Map();this.locks=new Set();}
  async get(k,f=null){return clone(this.data.has(k)?this.data.get(k):f);}
  async set(k,v){this.data.set(k,clone(v));}
  async acquire(k){if(this.locks.has(k))return false;this.locks.add(k);return true;}
  async release(k){this.locks.delete(k);}
}
const artist=()=>({id:'one',x_account:'Example',x_user_id:'1234567890123456789',tracking_mode:'record',note:'残すメモ',threads_posts:[{id:'t',text:'残す'}],x_mute_observations:{owner:{muted:true}}});
function setup(rows=[artist()],selected='ghostarchive') {
  let now=Date.parse('2026-10-25T15:00:00Z'), n=0;
  const config=C.config({token:'fixture',enabled:true,provider:selected,providerReady:C.adapterVersion(selected)});
  const docs=new Map([[config.path,{artists:clone(rows),unrelated_summary:{keep:true}}],[CONFIG,{version:1,enabled:true,executor_device_id:'device',artists_path:config.path}]]);
  const store=new MemoryStore(), calls={post:0,opened:0,closed:0,ready:[],writes:[]};
  const git={get:async k=>({data:clone(docs.get(k)||null),sha:'v'}),update:async(k,f)=>{
    if(calls.failSync&&k===JOBS)throw Error('fixture offline');
    const next=f(clone(docs.get(k)||null));if(next!==undefined){docs.set(k,clone(next));calls.writes.push(k);}return clone(docs.get(k));
  }};
  const ghost={open:async()=>{calls.opened++;},close:async()=>{calls.closed++;},show:async()=>{},
    inspect:async j=>j.state==='opening'?{kind:'form'}:{kind:'archive',receipt:j.receipt,original_url:j.target_url,captured_at:new Date(now).toISOString(),frames:[{kind:'profile',handle:'Example',name:'例',bio:'自己紹介',following:true,user_id:'1234567890123456789',post_ids:['987654321']}]},
    submit:async()=>{calls.post++;if(calls.crashPost)throw Error('fixture worker shutdown');return{submitted:true};},
    reconcile:async()=>calls.lostReceipt?{kind:'unresolved',reason:'URL不明'}:{kind:'processing',receipt:selected==='ghostarchive'?'https://ghostarchive.org/archive/Ab123':'https://archive.li/wip/Ab123'}
  };
  const deps={config,store,git,ghost,device:'device',profile:async(h,id)=>({id:id||'1234567890123456789',handle:h,name:'例',bio:'自己紹介'}),now:()=>now,uuid:()=>`job-${++n}`,ready:async v=>calls.ready.push(v),canSubmit:async()=>calls.stopped!==true};
  const make=()=>new Engine(deps); let engine=make();
  return {config,docs,store,calls,git,ghost,deps,get engine(){return engine;},restart(){engine=make();},advance(){now+=C.MINUTE+1;},now:()=>now,
    async run(force=false){await engine.run({forceScan:force});},async state(){return engine.state();}};
}
test('first-only policy excludes monitor-only and preserves legacy completed registrations',async()=>{
  const a=setup([{...artist(),tracking_mode:'monitor_only'},{...artist(),id:'old',archive_status:'done',archive_url:'https://archive.md/Abc12'},{...artist(),id:'off',auto_archive:{enabled:'off'}}]);
  await a.run(true);assert.equal((await a.state()).jobs.length,0);assert.equal(a.calls.post,0);assert.equal(a.calls.opened,0);
});
test('end-to-end state transitions verify body and preserve notes, Threads, mute observations and root metadata',async()=>{
  const a=setup();await a.run(true);assert.equal((await a.state()).jobs[0].state,'opening');
  a.advance();await a.run();assert.equal(a.calls.post,1);assert.equal((await a.state()).jobs[0].state,'submitting');
  a.advance();a.restart();await a.run();assert.equal((await a.state()).jobs[0].state,'processing');
  a.advance();await a.run();assert.equal((await a.state()).jobs[0].state,'succeeded');
  const d=a.docs.get(a.config.path),r=d.artists[0];
  assert.equal(r.note,'残すメモ');assert.equal(r.threads_posts[0].text,'残す');assert.equal(r.x_mute_observations.owner.muted,true);assert.deepEqual(d.unrelated_summary,{keep:true});
  assert.equal(r.archive_status,'done');assert.equal(r.archives[0].verification_method,'archived_profile_body');assert.equal(r.archives[0].posts_verification,'confirmed');assert.equal(a.calls.closed,1);
  await a.run(true);assert.equal(a.calls.post,1);assert.equal((await a.state()).jobs.length,1);
});
test('an interrupted POST is reconciled after a worker restart and never resubmitted',async()=>{
  const a=setup();await a.run(true);a.calls.crashPost=true;a.advance();await a.run();
  assert.equal((await a.state()).jobs[0].state,'submission_unknown');assert.equal(a.calls.post,1);
  a.restart();a.advance();await a.run();a.advance();await a.run();assert.equal(a.calls.post,1);assert.equal((await a.state()).jobs[0].state,'succeeded');
});
test('an unknown receipt stays manual instead of creating another capture',async()=>{
  const a=setup();await a.run(true);a.calls.crashPost=true;a.advance();await a.run();a.calls.lostReceipt=true;
  a.advance();await a.run();await a.run(true);assert.equal((await a.state()).jobs[0].state,'needs_review');assert.equal(a.calls.post,1);
});
test('manual receipt reconciliation navigates the owned tab to that result before reading its body',async()=>{
  const {Ghost}=require(base+'/auto-ghost.js'), moves=[];
  const api={storage:{session:{get:async key=>({[key]:7})}},tabs:{get:async()=>({id:7,url:'https://ghostarchive.org/',status:'complete'}),update:async(...args)=>moves.push(args)},
    scripting:{executeScript:async()=>{throw Error('stale form must not be inspected as the result');}}};
  const result=await new Ghost(api).inspect({job_id:'manual',state:'processing',receipt:'https://ghostarchive.org/archive/Ab123'});
  assert.equal(result.kind,'loading');assert.deepEqual(moves,[[7,{url:'https://ghostarchive.org/archive/Ab123?wr=false'}]]);
});
test('HTTP 200, metadata, empty frames and wrong account bodies cannot complete a capture',async()=>{
  for(const frame of [null,{kind:'profile',handle:'Other',name:'例',following:true,user_id:'1234567890123456789'},{kind:'profile',handle:'Example',name:'例',following:true,user_id:'999'}]) {
    const a=setup();await a.run(true);a.advance();await a.run();a.advance();await a.run();
    a.ghost.inspect=async j=>({kind:'archive',original_url:j.target_url,captured_at:new Date(a.now()).toISOString(),frames:frame?[frame]:[]});
    for(let i=0;i<3;i++){a.advance();await a.run();}
    assert.equal((await a.state()).jobs[0].state,'needs_review');assert.equal(a.docs.get(a.config.path).artists[0].archive_status,undefined);
  }
});
test('empty biography can verify using an archived numeric ID; weak evidence cannot',()=>{
  const now=Date.now(),j={target_url:'https://x.com/Example',expected_x_user_id:'123',identity:{handle:'Example',name:'例',bio:''},submission_started_at:new Date(now).toISOString()};
  const outer={original_url:j.target_url,captured_at:new Date(now).toISOString()};
  assert.equal(C.verify(outer,[{kind:'profile',handle:'Example',name:'例',bio:'',following:true,user_id:'123'}],j,now).ok,true);
  assert.equal(C.verify(outer,[{kind:'profile',handle:'Example',name:'別人',bio:'',following:true}],j,now).ok,false);
});
test('deletion, mode change or identity change while preparing cancels without a POST or resurrecting the account',async()=>{
  for(const change of [d=>d.artists=[],d=>d.artists[0].tracking_mode='monitor_only',d=>d.artists[0].x_user_id='999']) {
    const a=setup();await a.run(true);change(a.docs.get(a.config.path));a.advance();await a.run();
    assert.equal((await a.state()).jobs[0].state,'canceled');assert.equal(a.calls.post,0);
  }
});
test('stop during a send reservation suppresses the actual POST',async()=>{
  const a=setup();await a.run(true);let checks=0;a.deps.canSubmit=async()=>++checks<2;a.restart();a.advance();await a.run();
  assert.equal(a.calls.post,0);assert.equal((await a.state()).jobs[0].state,'canceled');
});
test('profile transport failures preserve monitoring state and never confirm account loss',async()=>{
  const a=setup([{...artist(),monitoring:{status:'active'}}]);a.deps.profile=async()=>{throw Error('判定不能');};a.restart();await a.run(true);
  assert.equal(a.calls.post,0);assert.equal(a.docs.get(a.config.path).artists[0].monitoring.status,'active');assert.equal((await a.state()).jobs[0].state,'retry_wait');
});
test('existing pending Ghostarchive URL is verified without a new submission',async()=>{
  const a=setup([{...artist(),archives:[{provider:'ghostarchive',status:'pending',url:'https://ghostarchive.org/archive/Ab123',target_url:'https://x.com/Example'}]}]);
  await a.run(true);a.advance();await a.run();assert.equal(a.calls.post,0);assert.equal((await a.state()).jobs[0].state,'succeeded');
});
test('daily quota and send interval are reserved in the shared ledger',async()=>{
  const a=setup();await a.run(true);
  a.docs.get(JOBS).reservations=Array.from({length:20},(_,i)=>({job_id:'old'+i,at:a.now()-C.HOUR}));
  a.advance();await a.run();assert.equal(a.calls.post,0);assert.match((await a.state()).jobs[0].last_error,/上限/);
  a.docs.get(JOBS).reservations=[{job_id:'recent',at:a.now()}];await a.run(true);assert.equal(a.calls.post,0);
  a.advance();await a.run();assert.equal(a.calls.post,1);
});
test('another executor cannot run this browser queue or a copied connection test',async()=>{
  const a=setup();await a.run(true);a.docs.get(CONFIG).executor_device_id='other';a.advance();await a.run();assert.equal(a.calls.post,0);
  await assert.rejects(a.engine.enqueueTest(),/実行担当/);
});
test('result outbox survives GitHub being offline, then syncs without another POST',async()=>{
  const a=setup();await a.run(true);a.advance();await a.run();a.advance();await a.run();a.calls.failSync=true;a.advance();await a.run();
  let s=await a.state();assert.equal(s.jobs[0].state,'succeeded');assert.equal(s.jobs[0].dirty,true);assert.equal(a.calls.post,1);
  a.restart();a.calls.failSync=false;a.advance();await a.run();s=await a.state();assert.equal(s.jobs[0].dirty,false);assert.equal(s.jobs[0].applied,true);assert.equal(a.calls.post,1);
});
test('duplicate wakeups share a durable lock instead of submitting twice',async()=>{
  const a=setup();await a.run(true);a.advance();await Promise.all([a.run(),a.run(),a.run()]);assert.equal(a.calls.post,1);
});
test('connection test is allowed while automatic sending is off and only body verification opens readiness gate',async()=>{
  const a=setup([]);a.config.enabled=false;a.config.providerReady='';a.deps.profile=async()=>({id:'783214',handle:'X',name:'X',bio:"what's happening?!"});
  a.ghost.inspect=async j=>j.state==='opening'?{kind:'form'}:{kind:'archive',original_url:'https://x.com/X',captured_at:new Date(a.now()).toISOString(),frames:[{kind:'profile',handle:'X',name:'X',bio:"what's happening?!",following:true,user_id:'783214'}]};
  a.restart();await a.engine.enqueueTest();await a.run();a.advance();await a.run();assert.equal(a.calls.ready.length,0);
  a.advance();await a.run();a.advance();await a.run();assert.deepEqual(a.calls.ready,[C.adapterVersion('ghostarchive')]);assert.equal(a.docs.get(a.config.path).artists.length,0);
});
test('FxTwitter responses require exact string ID, identity, public state and a successful response',()=>{
  const p={code:200,user:{id:'123',screen_name:'NewName',name:'名前',description:''}};
  assert.equal(C.classifyProfile(p,200,'OldName','123').handle,'NewName');
  for(const payload of [{...p,user:{...p.user,id:123}},{...p,user:{...p.user,id:'456'}},{...p,user:{...p.user,protected:true}},{code:404,message:'User not found'}]) assert.throws(()=>C.classifyProfile(payload,200,'OldName','123'));
});
test('result URL and GitHub config validation reject credentials, lookalikes and traversal',()=>{
  for(const value of ['https://ghostarchive.org.evil/archive/Ab123','https://user:pw@ghostarchive.org/archive/Ab123','https://ghostarchive.org/search?term=Example','http://ghostarchive.org/archive/Ab123'])assert.equal(C.resultURL(value),'');
  assert.throws(()=>C.config({token:'fixture',path:'../secrets.json'}));
});
test('a recycled handle cannot attach an old archive without an archived numeric ID',()=>{
  const now=Date.now(),job={target_url:'https://x.com/Example',expected_x_user_id:'123',identity:{handle:'Example',name:'同じ名前',bio:'同じ自己紹介'},submission_started_at:new Date(now).toISOString()};
  const page={original_url:job.target_url,captured_at:new Date(now-86400000).toISOString()};
  const body={kind:'profile',handle:'Example',name:'同じ名前',bio:'同じ自己紹介',following:true};
  assert.equal(C.verify(page,[body],job,now).ok,false);
  assert.equal(C.verify(page,[{...body,user_id:'123'}],job,now).ok,true);
});
test('Contents API CAS retries merge new remote fields; bearer token stays on the GitHub host',async()=>{
  let gets=0,puts=0;const client=new GitHub(C.config({token:'secret-fixture'}),async(url,opts)=>{
    assert.equal(new URL(url).hostname,'api.github.com');assert.equal(opts.headers.Authorization,'Bearer secret-fixture');assert.equal(opts.redirect,'error');
    if(opts.method==='GET'){gets++;return new Response(JSON.stringify({sha:'v'+gets,encoding:'base64',content:Buffer.from(JSON.stringify({keep:gets,artists:[]})).toString('base64')}));}
    puts++;const body=JSON.parse(opts.body);assert.equal(body.sha,'v'+gets);
    if(puts===1)return new Response('{}',{status:409});
    const saved=JSON.parse(Buffer.from(body.content,'base64').toString());assert.equal(saved.keep,2);assert.equal(saved.changed,true);return new Response('{}');
  });
  await client.update('data/artists.json',d=>({...d,changed:true}));assert.equal(puts,2);
});
test('extension grants no automatic X page scripting and asks only for the archive module origins',()=>{
  const m=JSON.parse(fs.readFileSync(base+'/manifest.json'));
  assert.deepEqual(m.optional_permissions,['scripting']);assert.deepEqual(m.optional_host_permissions,[...C.origins(C.DEFAULT_PROVIDER),'https://ghostarchive.org/*']);
  assert.ok(m.content_scripts.every(c=>c.matches.every(p=>p.startsWith('https://yamada1221.github.io/x-archives/'))));
});
test('web pages and other extensions cannot save credentials, start tests or take over the executor',async()=>{
  const ctx={URL,Date,Set,Map,Promise,structuredClone,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout,crypto:require('node:crypto').webcrypto};
  const data={},listeners=[];ctx.chrome={runtime:{id:'mine',getURL:p=>'chrome-extension://mine/'+p,onStartup:{addListener:f=>listeners.push(f)},onInstalled:{addListener:f=>listeners.push(f)}},
    storage:{local:{get:async k=>({[k]:data[k]}),set:async d=>Object.assign(data,d),setAccessLevel:async()=>{}}},alarms:{onAlarm:{addListener:()=>{}}}};
  vm.createContext(ctx);for(const name of ['auto-core','auto-storage','auto-github','auto-ghost','auto-today','auto-engine','auto-form-diagnostics','auto-receipt-picker','auto-runtime'])vm.runInContext(fs.readFileSync(base+'/'+name+'.js','utf8'),ctx);
  for(const type of ['AUTO_SAVE','AUTO_START','AUTO_TEST','AUTO_CLAIM','AUTO_ADOPT','AUTO_RECHECK','AUTO_FORM_DIAGNOSTICS','AUTO_RECEIPT_CANDIDATES']){
    await assert.rejects(ctx.AutoArchiveRuntime.handle({type},{id:'mine',url:'https://yamada1221.github.io/x-archives/',frameId:0,tab:{id:1}}),/拡張機能の画面/);
    await assert.rejects(ctx.AutoArchiveRuntime.handle({type},{id:'other',url:'chrome-extension://mine/auto-options.html'}));
  }
  const result=await ctx.AutoArchiveRuntime.handle({type:'AUTO_STATUS'},{id:'mine',url:'chrome-extension://mine/auto-options.html'});assert.equal(result.configured,false);assert.equal('token' in result,false);
  const inTab=await ctx.AutoArchiveRuntime.handle({type:'AUTO_STATUS'},{id:'mine',url:'chrome-extension://mine/auto-options.html',tab:{id:1},frameId:0});assert.equal(inTab.configured,false);
  await assert.rejects(ctx.AutoArchiveRuntime.handle({type:'AUTO_STATUS'},{id:'mine',url:'chrome-extension://mine/auto-options.html',tab:{id:1},frameId:1}));
  ctx.chrome.tabs={query:async()=>[]};ctx.chrome.runtime.getManifest=()=>({version:'1.3.2'});
  const diagnostic=await ctx.AutoArchiveRuntime.handle({type:'AUTO_FORM_DIAGNOSTICS'},{id:'mine',url:'chrome-extension://mine/auto-options.html'});
  assert.equal(diagnostic.ok,true);assert.equal(diagnostic.diagnostics.pages.length,0);
  assert.ok(data.autoArchiveFormDiagnostics);
});
test('credential isolation survives browsers without StorageArea.setAccessLevel',async()=>{
  const ctx={URL,Date,Set,Map,Promise,structuredClone,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout,crypto:require('node:crypto').webcrypto};
  const local={},db=new MemoryStore(),repo=new Map();
  ctx.chrome={runtime:{id:'mine',getURL:p=>'chrome-extension://mine/'+p,onStartup:{addListener:()=>{}},onInstalled:{addListener:()=>{}}},
    storage:{local:{get:async k=>({[k]:local[k]}),set:async d=>Object.assign(local,d)}},permissions:{contains:async()=>true},
    alarms:{get:async()=>null,create:async()=>{},clear:async()=>{},onAlarm:{addListener:()=>{}}}};
  vm.createContext(ctx);for(const name of ['auto-core','auto-ghost','auto-today','auto-engine'])vm.runInContext(fs.readFileSync(base+'/'+name+'.js','utf8'),ctx);
  ctx.AutoArchiveStore=class{constructor(){return db;}};
  ctx.AutoArchiveGitHub=class{async update(k,f){const d=f(clone(repo.get(k)||null));repo.set(k,d);return d;}};
  vm.runInContext(fs.readFileSync(base+'/auto-runtime.js','utf8'),ctx);
  assert.equal(typeof ctx.AutoArchiveRuntime,'object');
  const result=await ctx.AutoArchiveRuntime.handle({type:'AUTO_SAVE',config:{token:'private-fixture-token'}},{id:'mine',url:'chrome-extension://mine/auto-options.html'});
  assert.equal(result.configured,true);assert.equal(Object.hasOwn(local.autoArchiveSettings,'token'),false);
  assert.equal(await db.get('credential:yamada1221/x-archives:data/artists.json'),'private-fixture-token');
  assert.equal(JSON.stringify(result).includes('private-fixture-token'),false);
  delete local.autoArchiveSettings.provider;local.autoArchiveSettings.enabled=true;local.autoArchiveSettings.providerReady='ghostarchive-dom-1';
  const upgraded=await ctx.AutoArchiveRuntime.status(true);assert.equal(upgraded.provider,'archive.today');assert.equal(upgraded.ready,false);assert.equal(upgraded.enabled,false);
  await ctx.AutoArchiveRuntime.handle({type:'AUTO_SAVE',config:{token:'',provider:'ghostarchive'}},{id:'mine',url:'chrome-extension://mine/auto-options.html'});
  assert.equal(local.autoArchiveSettings.provider,'ghostarchive');
  assert.equal(await db.get('credential:yamada1221/x-archives:data/artists.json'),'private-fixture-token');
});
test('new and upgraded settings default to archive.li and cannot reuse Ghostarchive readiness',()=>{
  const config=C.config({token:'fixture',enabled:true,providerReady:'ghostarchive-dom-1'});
  assert.equal(config.provider,'archive.today');assert.equal(C.homeURL(config.provider),'https://archive.li/');
  assert.notEqual(config.providerReady,C.adapterVersion(config.provider));
  assert.equal(C.config({token:'fixture',provider:'archive.li'}).provider,'archive.today');
  for(const provider of ['unknown','toString','__proto__'])assert.throws(()=>C.config({token:'fixture',provider}));
  assert.equal(C.eligible({...artist(),auto_archive:{provider:'archive.li'}},config.provider),true);
  assert.equal(C.eligible({...artist(),auto_archive:{provider:'ghostarchive'}},config.provider),false);
});
test('archive.today receipts accept only known HTTPS hosts and capture paths',()=>{
  for(const url of ['https://archive.li/Ab123','https://archive.ph/wip/Ab123','https://archive.li/2026.10.26-012345/https://x.com/Example']) {
    assert.equal(C.resultURL(url),url);assert.equal(C.resultProvider(url),'archive.today');
  }
  for(const url of ['https://archive.li.evil/Ab123','https://archive.li/submit?url=https://x.com/Example','https://archive.li/about','https://archive.li/about/','https://user:pw@archive.li/Ab123','http://archive.li/Ab123','https://archive.li:444/Ab123','https://archive.li/https://x.com/Example'])assert.equal(C.resultURL(url),'');
  assert.throws(()=>C.ledger({version:1,jobs:[{job_id:'bad',state:'processing',provider:'archive.today',receipt:'https://ghostarchive.org/archive/Ab123'}],reservations:[],provider:{}}));
});
test('archive.li transitions from WIP to a verified capture without another submission',async()=>{
  const a=setup([artist()],'archive.today');await a.run(true);a.advance();await a.run();a.advance();await a.run();
  assert.equal((await a.state()).jobs[0].receipt,'https://archive.li/wip/Ab123');
  const inspect=a.ghost.inspect;a.ghost.inspect=async j=>({...await inspect(j),receipt:'https://archive.li/Ab123'});
  a.advance();await a.run();
  assert.equal(a.calls.post,1);assert.equal((await a.state()).jobs[0].state,'succeeded');
  const saved=a.docs.get(a.config.path).artists[0];assert.equal(saved.archive_provider,'archive.today');assert.equal(saved.archive_url,'https://archive.li/Ab123');
  assert.deepEqual(a.docs.get(JOBS).jobs[0].receipt_history,['https://archive.li/wip/Ab123']);
});
test('WIP cannot be marked done and unrelated receipts cannot replace a capture',async()=>{
  const a=setup([artist()],'archive.today');await a.run(true);a.advance();await a.run();a.advance();await a.run();a.advance();await a.run();
  assert.equal((await a.state()).jobs[0].state,'needs_review');assert.equal(a.docs.get(a.config.path).artists[0].archive_status,undefined);
  await a.engine.adopt((await a.state()).jobs[0].job_id,'https://archive.li/Ab123');
  await assert.rejects(a.engine.adopt((await a.state()).jobs[0].job_id,'https://archive.li/Other'),/変更できません/);
  await assert.rejects(a.engine.adopt((await a.state()).jobs[0].job_id,'https://ghostarchive.org/archive/Ab123'),/同じ保存先/);
});
test('archive.li preflight challenges stay observable without a POST and resume only after the form is available',async()=>{
  const a=setup([artist()],'archive.today');await a.run(true);a.ghost.inspect=async()=>({kind:'blocked'});a.advance();await a.run();
  let j=(await a.state()).jobs[0];
  assert.equal(j.state,'opening');assert.equal(j.access_wait,'human');assert.equal(a.calls.post,0);
  assert.equal(C.jobLabel(j),'人間確認待ち');assert.equal(C.attention(j),true);assert.equal(C.submissionHold([j],'archive.today'),true);
  a.ghost.inspect=async()=>({kind:'form'});await a.engine.recheck(j.job_id);await a.run();
  j=(await a.state()).jobs[0];assert.equal(j.state,'submitting');assert.equal(j.access_wait,undefined);assert.equal(a.calls.post,1);
});
test('a changed default replaces unsent jobs and keeps submitted Ghostarchive work on its original provider',async()=>{
  for(const sent of [false,true]){
    const a=setup();await a.run(true);if(sent){a.advance();await a.run();}
    a.config.provider='archive.today';a.config.providerReady=C.adapterVersion('archive.today');a.restart();a.advance();await a.run(true);
    const jobs=(await a.state()).jobs;
    assert.equal(a.calls.post,sent?1:0);
    if(sent){assert.equal(jobs.length,1);assert.equal(jobs[0].provider,'ghostarchive');assert.equal(jobs[0].state,'processing');}
    else {assert.equal(jobs.length,2);assert.equal(jobs[0].state,'canceled');assert.equal(jobs[1].provider,'archive.today');assert.equal(jobs[1].state,'opening');}
  }
});
test('GitHub native-fetch wrapper preserves the global receiver',async()=>{
  const client=new GitHub(C.config({token:'fixture'}),function(){'use strict';assert.equal(this,globalThis);return Promise.resolve(new Response('{}'));});
  assert.equal((await client.request('data/artists.json')).ok,true);
});

test('an explicit connection test recovers a structural pause after recognizing the form',async()=>{
  const a=setup([artist()],'archive.today');
  a.config.enabled=false;
  await a.engine.enqueueTest();
  const ledger=a.docs.get(JOBS);
  ledger.provider={name:'archive.today',paused_until:a.now()+C.DAY,reason:'保存フォームの構造を確認できません'};
  a.docs.set(JOBS,ledger);
  await a.run();a.advance();await a.run();
  assert.equal(a.calls.post,1);
  assert.equal(a.docs.get(JOBS).provider.paused_until,0);
  assert.equal(a.docs.get(JOBS).reservations.length,1);
});
test('normal captures cannot lift structural pauses, and connection tests cannot lift access restrictions',async()=>{
  for(const [connection,reason] of [[false,'保存フォームの構造を確認できません'],[true,'保存先で人間確認・アクセス制限が必要です']]){
    const a=setup([artist()],'archive.today');
    if(connection){a.config.enabled=false;await a.engine.enqueueTest();}
    await a.run(!connection);
    const ledger=a.docs.get(JOBS),until=a.now()+C.DAY;
    ledger.provider={name:'archive.today',paused_until:until,reason};a.docs.set(JOBS,ledger);
    a.advance();await a.run();
    assert.equal(a.calls.post,0);
    assert.equal(a.docs.get(JOBS).provider.paused_until,until);
    assert.equal((await a.state()).jobs.at(-1).state,'opening');
  }
});
test('a connection test cannot lift a structural pause without recognizing the form',async()=>{
  const a=setup([artist()],'archive.today');a.config.enabled=false;await a.engine.enqueueTest();
  const ledger=a.docs.get(JOBS);
  ledger.provider={name:'archive.today',paused_until:a.now()+C.DAY,reason:'保存フォームの構造を確認できません'};a.docs.set(JOBS,ledger);
  a.ghost.inspect=async()=>({kind:'changed'});
  await a.run();a.advance();await a.run();
  assert.equal(a.calls.post,0);
  assert.ok(a.docs.get(JOBS).provider.paused_until>a.now());
  assert.equal((await a.state()).jobs.at(-1).state,'needs_review');
});
test('adopting a search URL explains how to choose a capture without changing a job',async()=>{
  const a=setup();
  await assert.rejects(a.engine.adopt('missing','https://archive.li/https://x.com/X'),/保存履歴の検索ページ/);
  assert.equal(a.calls.post,0);assert.equal(a.calls.writes.length,0);
});
async function seedBodyFailure(a, changes={}) {
  const job={job_id:'old-body',kind:'profile',artist_id:'one',registered_handle:'Example',expected_x_user_id:'1234567890123456789',
    target_url:'https://x.com/Example',provider:'archive.today',state:'needs_review',executor_device_id:'device',
    created_at:new Date(a.now()).toISOString(),submission_started_at:new Date(a.now()).toISOString(),attempt_count:1,
    receipt:'https://archive.li/Ab123',receipt_history:['https://archive.li/wip/Ab123'],verification_checks:3,
    identity:{handle:'Example',name:'例',bio:'自己紹介'},last_error:'本文から同じアカウントだと確認する証拠が不足しています',...changes};
  await a.engine.save({...await a.state(),jobs:[clone(job)]});
  a.docs.set(JOBS,{version:1,jobs:[clone(job)],reservations:[],provider:{}});
  return job;
}
test('an update rechecks an owned recorded receipt without another save request',async()=>{
  const a=setup([artist()],'archive.today');a.config.enabled=false;
  const old=await seedBodyFailure(a);
  assert.equal(await a.engine.recheckKnownBodies(),1);
  let state=await a.state();assert.equal(state.jobs[0].state,'processing');
  assert.equal(state.jobs[0].attempt_count,1);assert.equal(state.jobs[0].submission_started_at,old.submission_started_at);
  assert.deepEqual(state.jobs[0].receipt_history,old.receipt_history);
  assert.equal(a.calls.writes.length,0);
  await a.run();state=await a.state();
  assert.equal(state.jobs[0].state,'succeeded');assert.equal(a.docs.get(a.config.path).artists[0].archive_status,'done');
  assert.equal(a.calls.post,0);assert.equal(a.calls.opened,0);assert.deepEqual(a.docs.get(JOBS).reservations,[]);
});
test('the same reader version does not loop a body failure after restart',async()=>{
  const a=setup([artist()],'archive.today');a.config.enabled=false;await seedBodyFailure(a);
  a.ghost.inspect=async j=>({kind:'archive',receipt:j.receipt,original_url:j.target_url,captured_at:new Date(a.now()).toISOString(),frames:[]});
  await a.engine.recheckKnownBodies();
  for(let i=0;i<3;i++){await a.run();a.advance();}
  assert.equal((await a.state()).jobs[0].state,'needs_review');
  a.restart();assert.equal(await a.engine.recheckKnownBodies(),0);
  assert.equal(a.calls.post,0);
});
test('automatic body recovery excludes missing receipts, foreign executors and other review reasons',async()=>{
  for(const changes of [{receipt:undefined},{executor_device_id:'another-device'},{last_error:'保存本文の数値IDが別のアカウントです'},{last_error:'保存先で人間確認・アクセス制限が必要です'},{provider:'ghostarchive',receipt:'https://ghostarchive.org/archive/Ab123'}]){
    const a=setup([artist()],'archive.today');await seedBodyFailure(a,changes);
    assert.equal(await a.engine.recheckKnownBodies(),0);
    assert.equal((await a.state()).jobs[0].state,'needs_review');assert.equal(a.calls.post,0);
  }
});

test('a challenge after submission is visible, blocks new saves, and resumes verification without a second request',async()=>{
  const a=setup([artist()],'archive.today');await a.run(true);a.advance();await a.run();
  const original=clone((await a.state()).jobs[0]);
  a.ghost.reconcile=async()=>({kind:'blocked',block_type:'human'});a.advance();await a.run();
  let j=(await a.state()).jobs[0];
  assert.equal(j.state,'submission_unknown');assert.equal(j.access_wait,'human');assert.match(j.last_error,/人間確認/);
  assert.notEqual(j.last_error,'受付結果が不明です。保存先の画面または検索結果で確認してください');
  a.docs.get(a.config.path).artists.push({...artist(),id:'two',x_account:'Other',x_user_id:'999'});
  a.advance();await a.run(true);assert.equal(a.calls.post,1);
  assert.equal((await a.state()).jobs.find(j=>j.artist_id==='two').state,'queued');
  a.ghost.reconcile=async()=>({kind:'archive',receipt:'https://archive.li/Ab123'});
  for(let i=0;i<6;i++)a.advance();await a.run();
  j=(await a.state()).jobs.find(j=>j.job_id===original.job_id);assert.equal(j.state,'processing');
  a.advance();await a.run();j=(await a.state()).jobs.find(j=>j.job_id===original.job_id);
  assert.equal(j.state,'succeeded');assert.equal(j.access_wait,undefined);assert.equal(a.calls.post,1);
  assert.equal(j.submission_started_at,original.submission_started_at);assert.equal(j.attempt_count,1);
  assert.equal(a.docs.get(JOBS).reservations.length,1);
});
test('a blocked receipt remains under human confirmation, then preserves its WIP history when it completes',async()=>{
  const a=setup([artist()],'archive.today');await a.run(true);a.advance();await a.run();a.advance();await a.run();
  const inspect=a.ghost.inspect;a.ghost.inspect=async()=>({kind:'blocked',block_type:'human',receipt:'https://archive.li/wip/Ab123'});
  a.advance();await a.run();let j=(await a.state()).jobs[0];
  assert.equal(j.state,'submission_unknown');assert.equal(j.receipt,'https://archive.li/wip/Ab123');
  a.restart();a.ghost.reconcile=async()=>({kind:'archive',receipt:'https://archive.li/Ab123'});a.ghost.inspect=async j=>({...await inspect(j),receipt:'https://archive.li/Ab123'});
  await a.engine.recheck(j.job_id);await a.run();a.advance();await a.run();j=(await a.state()).jobs[0];
  assert.equal(j.state,'succeeded');assert.deepEqual(j.receipt_history,['https://archive.li/wip/Ab123']);assert.equal(a.calls.post,1);
});
test('rate limits are distinguished from CAPTCHA and keep the provider pause',async()=>{
  const a=setup([artist()],'archive.today');await a.run(true);a.advance();await a.run();
  a.ghost.reconcile=async()=>({kind:'blocked',block_type:'rate_limit'});a.advance();await a.run();
  const j=(await a.state()).jobs[0];assert.equal(j.access_wait,'rate_limit');assert.match(C.jobLabel(j),/アクセス制限/);
  assert.ok(a.docs.get(JOBS).provider.paused_until>a.now());assert.equal(a.calls.post,1);
});
test('old unknown receipts are checked once on update, including requests older than 48 hours, without reposting',async()=>{
  const a=setup([artist()],'archive.today');a.config.enabled=false;
  const old=await seedBodyFailure(a,{receipt:undefined,receipt_history:undefined,last_error:'受付結果が不明です。保存先の画面または検索結果で確認してください',
    submission_started_at:new Date(a.now()-4*C.DAY).toISOString()});
  assert.equal(await a.engine.recheckKnownReceipts(),1);assert.equal(a.calls.writes.length,0);
  a.ghost.reconcile=async()=>({kind:'archive',receipt:'https://archive.li/Ab123'});
  await a.run();a.advance();await a.run();const j=(await a.state()).jobs[0];
  assert.equal(j.state,'succeeded');assert.equal(j.submission_started_at,old.submission_started_at);
  assert.equal(j.attempt_count,1);assert.equal(a.calls.post,0);assert.equal(a.calls.opened,0);
  assert.deepEqual(a.docs.get(JOBS).reservations,[]);
});
test('unrecoverable old receipts do not loop or release new submissions after restart',async()=>{
  const a=setup([artist()],'archive.today');a.config.enabled=false;
  await seedBodyFailure(a,{receipt:undefined,last_error:'受付結果が不明です。保存先の画面または検索結果で確認してください'});
  await a.engine.recheckKnownReceipts();a.ghost.reconcile=async()=>({kind:'unresolved',reason:'送信済みタブなし'});await a.run();
  a.restart();assert.equal(await a.engine.recheckKnownReceipts(),0);
  const j=(await a.state()).jobs[0];assert.equal(j.state,'needs_review');assert.equal(j.receipt_recovery_required,true);
  assert.equal(C.submissionHold([j],'archive.today'),true);assert.equal(a.calls.post,0);
});
test('old unknown-receipt recovery excludes other executors and unrelated review errors',async()=>{
  for(const changes of [{executor_device_id:'another-device'},{last_error:'保存本文の数値IDが別のアカウントです'},{provider:'ghostarchive'}]){
    const a=setup([artist()],'archive.today');await seedBodyFailure(a,{receipt:undefined,last_error:'受付結果が不明です。保存先の画面または検索結果で確認してください',...changes});
    assert.equal(await a.engine.recheckKnownReceipts(),0);assert.equal(a.calls.post,0);
  }
});
test('a human-confirmation check while sending is stopped never sends an unsent form',async()=>{
  const a=setup([artist()],'archive.today');await a.run(true);a.ghost.inspect=async()=>({kind:'blocked'});a.advance();await a.run();
  const j=(await a.state()).jobs[0];a.config.enabled=false;a.calls.stopped=true;a.ghost.inspect=async()=>({kind:'form'});
  await a.engine.recheck(j.job_id);await a.run();assert.equal(a.calls.post,0);assert.equal((await a.state()).jobs[0].access_wait,'human');
});
test('manual receipt verification can recover an old job while retaining account identity safeguards',async()=>{
  const a=setup([artist()],'archive.today');a.config.enabled=false;
  const j=await seedBodyFailure(a,{submission_started_at:new Date(a.now()-4*C.DAY).toISOString()});
  await a.engine.adopt(j.job_id,j.receipt);await a.run();
  assert.equal((await a.state()).jobs[0].state,'succeeded');assert.equal(a.calls.post,0);
});
test('reply targets require an exact tag, record mode, and remain separate from existing profiles',async()=>{
  const rows=[{...artist(),note:'汚言 クソリプ',archive_status:'done',archive_url:'https://archive.li/Old01'},
    {...artist(),id:'monitor',x_account:'Monitor',note:'クソリプ',tracking_mode:'monitor_only'},
    {...artist(),id:'not-tagged',x_account:'Other',note:'クソリプ以外',archive_status:'done',archive_url:'https://archive.li/Old02'}];
  const a=setup(rows,'archive.today');await a.run(true);
  const jobs=(await a.state()).jobs;assert.equal(jobs.length,1);assert.equal(jobs[0].target_kind,'replies');
  assert.equal(jobs[0].target_url,'https://x.com/Example/with_replies');assert.match(jobs[0].event_key,/:replies$/);
  assert.equal(a.calls.post,0);
});
test('a new tagged record queues both independent profile and replies jobs without confusing completion',async()=>{
  const a=setup([{...artist(),note:'クソリプ / 要確認'}],'archive.today');await a.run(true);
  assert.deepEqual((await a.state()).jobs.map(j=>j.target_kind||'profile').sort(),['profile','replies']);
  assert.equal(C.completed({x_account:'Example',archives:[{status:'done',target_url:'https://x.com/Example/with_replies'}]}),false);
  assert.equal(C.completed({x_account:'Example',archives:[{status:'done',target_url:'https://x.com/Example/with_replies'}]},'replies'),true);
});
test('reply body must confirm the requested tab and target before separate archive application',()=>{
  const now=Date.now(),j={artist_id:'one',provider:'archive.today',kind:'profile',target_kind:'replies',registered_handle:'Example',expected_x_user_id:'1234567890123456789',
    target_url:'https://x.com/Example/with_replies',identity:{handle:'Example',name:'例',bio:'自己紹介'},submission_started_at:new Date(now).toISOString(),receipt:'https://archive.li/Ab123',event_key:'first:123:replies'};
  const outer={original_url:j.target_url,captured_at:new Date(now).toISOString()},p={kind:'profile',handle:'Example',name:'例',bio:'自己紹介',following:true,user_id:j.expected_x_user_id,post_ids:['987']};
  assert.equal(C.verify(outer,[p],j,now).ok,false);
  assert.equal(C.verify({...outer,original_url:'https://x.com/Example'},[{...p,replies_tab_confirmed:true}],j,now).ok,false);
  j.verification=C.verify(outer,[{...p,replies_tab_confirmed:true}],j,now);assert.deepEqual(j.verification.scope,['profile','replies']);
  const a={...artist(),note:'クソリプ',archive_status:'done',archive_url:'https://archive.li/Old01',archive_target_url:'https://x.com/Example'};
  const doc={artists:[a]};assert.equal(C.applyResult(doc,j),true);assert.equal(a.archive_url,'https://archive.li/Old01');
  assert.equal(a.archives[0].target_url,C.targetURL(j.target_url));assert.equal(a.archives[0].status,'done');
});
test('profile and replies save independently and preserve the primary profile result',async()=>{
  const a=setup([{...artist(),note:'クソリプ'}],'archive.today');
  a.ghost.reconcile=async j=>({kind:'archive',receipt:j.target_kind==='replies'?'https://archive.li/Rep01':'https://archive.li/Pro01'});
  a.ghost.inspect=async j=>j.state==='opening'?{kind:'form'}:{kind:'archive',receipt:j.receipt,original_url:j.target_url,captured_at:new Date(a.now()).toISOString(),
    frames:[{kind:'profile',handle:'Example',name:'例',bio:'自己紹介',following:true,user_id:'1234567890123456789',post_ids:['987'],replies_tab_confirmed:j.target_kind==='replies'}]};
  await a.run(true);for(let i=0;i<10;i++){a.advance();await a.run();}
  const jobs=(await a.state()).jobs;assert.deepEqual(jobs.map(j=>j.state).sort(),['succeeded','succeeded']);assert.equal(a.calls.post,2);
  const saved=a.docs.get(a.config.path).artists[0];assert.equal(saved.archive_url,'https://archive.li/Pro01');
  assert.deepEqual(saved.archives.map(e=>e.target_url).sort(),['https://x.com/example','https://x.com/example/with_replies']);
});
test('a mismatched reply kind and target cannot verify or enter the ledger',()=>{
  const j={job_id:'x',state:'queued',target_kind:'profile',target_url:'https://x.com/Example/with_replies'};
  assert.throws(()=>C.ledger({version:1,jobs:[j],reservations:[],provider:{}}),/保存対象/);
  assert.equal(C.verify({original_url:j.target_url},[],j,Date.now()).ok,false);
});

test('receipt diagnostics accept profile coverage from replies while rejecting reverse, account and metadata mismatches',()=>{
  const now=Date.now(),stamp=new Date(now).toISOString();
  const profile={target_url:'https://x.com/Example',expected_x_user_id:'1234567890123456789',
    identity:{handle:'Example',name:'例',bio:'自己紹介'},submission_started_at:stamp,adopted_existing:true};
  const replies={...profile,target_kind:'replies',target_url:'https://x.com/Example/with_replies'};
  const body={kind:'profile',handle:'Example',name:'例',bio:'自己紹介',following:true,user_id:profile.expected_x_user_id,replies_tab_confirmed:true};
  const outer=url=>({original_url:url,captured_at:stamp});
  const rejected=(page,job,reason)=>assert.deepEqual(C.verify(page,[body],job,now),{ok:false,reason});
  for(const job of [profile,replies]){
    const good=C.verify(outer(job.target_url),[body],job,now);
    assert.equal(good.ok,true);assert.deepEqual(good.scope,job.target_kind==='replies'?['profile','replies']:['profile']);
    assert.equal(good.archived_user_id,profile.expected_x_user_id);
    assert.equal(C.verify(outer(job.target_url),[{...body,user_id:'999'}],job,now).ok,false);
  }
  const covered=C.verify(outer('https://twitter.com/EXAMPLE/with_replies/?test=1'),[body],profile,now);
  assert.equal(covered.ok,true);assert.deepEqual(covered.scope,['profile','replies']);
  assert.equal(covered.captured_target_url,'https://x.com/example/with_replies');
  rejected(outer('https://www.x.com/EXAMPLE/'),replies,'保存先はプロフィールです。返信タブの保存結果を選んでください');
  for(const target of ['https://x.com/Other','https://x.com/Other/with_replies']){
    rejected(outer(target),profile,'保存先の対象アカウントが一致しません');
    rejected(outer(target),replies,'保存先の対象アカウントが一致しません');
  }
  for(const missing of [undefined,'','https://x.com/Example/status/123']){
    rejected(outer(profile.target_url),{...profile,target_url:missing},'保存対象のURLを確認できません');
  }
  for(const invalid of [undefined,'','https://x.com.evil/Example','https://user@x.com/Example','http://x.com/Example','https://x.com/Example/status/123']){
    rejected(outer(invalid),profile,'保存先の対象URLを確認できません');
    rejected(outer(invalid),replies,'保存先の対象URLを確認できません');
  }
  rejected(null,profile,'保存先の対象URLを確認できません');
});

test('manual correction of a mismatched receipt preserves the profile job and history without another save request',async()=>{
  for(const last_error of ['保存先の対象URLが一致しません','保存先の対象アカウントが一致しません',
    '保存先は返信タブです。プロフィールの保存結果を選んでください','保存先はプロフィールです。返信タブの保存結果を選んでください',
    '保存対象の種類が一致しません']){
    const a=setup([artist()],'archive.today');a.config.enabled=false;
    const old=await seedBodyFailure(a,{receipt:'https://archive.li/Rep01',receipt_history:['https://archive.li/wip/Rep01'],last_error});
    await a.engine.adopt(old.job_id,'https://archive.li/Pro01');
    let job=(await a.state()).jobs[0];
    assert.equal(job.state,'processing');assert.equal(job.receipt,'https://archive.li/Pro01');
    assert.deepEqual(job.receipt_history,['https://archive.li/wip/Rep01','https://archive.li/Rep01']);
    await a.run();job=(await a.state()).jobs[0];
    assert.equal(job.state,'succeeded');assert.deepEqual(job.verification.scope,['profile']);
    assert.equal(job.target_kind,old.target_kind);assert.equal(job.target_url,old.target_url);
    assert.equal(job.expected_x_user_id,old.expected_x_user_id);assert.equal(job.submission_started_at,old.submission_started_at);
    assert.equal(job.attempt_count,old.attempt_count);assert.equal(a.calls.post,0);assert.equal(a.calls.opened,0);
    assert.equal(a.docs.get(a.config.path).artists[0].archive_url,'https://archive.li/Pro01');
    assert.deepEqual(a.docs.get(JOBS).jobs[0].receipt_history,job.receipt_history);
    assert.equal(Object.hasOwn(job,'receiptCorrection'),false);
    assert.equal(Object.hasOwn(a.docs.get(JOBS).jobs[0],'receiptCorrection'),false);
  }
});

test('a corrected receipt still fails full account and numeric-ID verification',async()=>{
  for(const failure of ['account','id']){
    const a=setup([artist()],'archive.today');a.config.enabled=false;
    const old=await seedBodyFailure(a,{receipt:'https://archive.li/Rep01',last_error:'保存先は返信タブです。プロフィールの保存結果を選んでください'});
    const inspect=a.ghost.inspect;
    a.ghost.inspect=async job=>{
      const page=await inspect(job);
      if(failure==='account')page.original_url='https://x.com/Other';
      if(failure==='id')page.frames[0].user_id='999999999';
      return page;
    };
    await a.engine.adopt(old.job_id,'https://archive.li/Pro01');
    for(let i=0;i<3;i++){await a.run();a.advance();}
    const job=(await a.state()).jobs[0];
    assert.equal(job.state,'needs_review');assert.equal(job.verification?.ok,undefined);
    assert.equal(job.last_error,failure==='account'?'保存先の対象アカウントが一致しません':'保存本文の数値IDが別のアカウントです');
    assert.equal(job.target_kind,old.target_kind);assert.equal(job.target_url,old.target_url);
    assert.ok(job.receipt_history.includes('https://archive.li/Rep01'));
    assert.equal(a.docs.get(a.config.path).artists[0].archive_status,undefined);
    assert.equal(a.calls.post,0);assert.equal(a.calls.opened,0);
  }
});

test('manual receipt replacement is unavailable outside target-mismatch review or across providers',async()=>{
  const mismatch='保存先は返信タブです。プロフィールの保存結果を選んでください';
  const cases=[
    {state:'succeeded',last_error:mismatch},{state:'processing',last_error:mismatch},{state:'verifying',last_error:mismatch},
    {last_error:'本文から同じアカウントだと確認する証拠が不足しています'},
    {last_error:'プロフィール本文・対象ハンドルを確認できません'},
    {last_error:'保存本文の数値IDが別のアカウントです'},
    {last_error:'保存先の対象URLを確認できません'},
    {last_error:'保存先で人間確認・アクセス制限が必要です'},
    {last_error:mismatch,newReceipt:'https://ghostarchive.org/archive/Pro01'}
  ];
  for(const {newReceipt='https://archive.li/Pro01',...changes} of cases){
    const a=setup([artist()],'archive.today');a.config.enabled=false;
    const old=await seedBodyFailure(a,{receipt:'https://archive.li/Rep01',...changes});
    const before=await a.state();
    await assert.rejects(a.engine.adopt(old.job_id,newReceipt),/確認対象|変更できません|同じ保存先/);
    assert.deepEqual(await a.state(),before);assert.equal(a.calls.writes.length,0);
    assert.equal(a.calls.post,0);assert.equal(a.calls.opened,0);
  }
});

test('manual correction survives a failed sync and worker restart without publishing its authorization or another POST',async()=>{
  const a=setup([artist()],'archive.today');a.config.enabled=false;
  const old=await seedBodyFailure(a,{receipt:'https://archive.li/Rep01',last_error:'保存先の対象URLが一致しません'});
  a.calls.failSync=true;
  await assert.rejects(a.engine.adopt(old.job_id,'https://archive.li/Pro01'),/offline/);
  const pending=(await a.state()).jobs[0];
  assert.equal(pending.receiptCorrection.from,'https://archive.li/Rep01');
  assert.equal(pending.receiptCorrection.to,'https://archive.li/Pro01');
  assert.equal(a.docs.get(JOBS).jobs[0].receipt,'https://archive.li/Rep01');
  a.restart();a.calls.failSync=false;
  await a.run();
  const saved=(await a.state()).jobs[0],remote=a.docs.get(JOBS).jobs[0];
  assert.equal(saved.state,'succeeded');assert.equal(remote.receipt,'https://archive.li/Pro01');
  assert.ok(remote.receipt_history.includes('https://archive.li/Rep01'));
  assert.equal(Object.hasOwn(saved,'receiptCorrection'),false);assert.equal(Object.hasOwn(remote,'receiptCorrection'),false);
  await a.run();
  assert.equal(a.calls.writes.filter(k=>k===a.config.path).length,1);
  assert.equal(a.calls.post,0);assert.equal(a.calls.opened,0);
});

test('a manual correction cannot overwrite remote completion, a new receipt, or changed target identity',async()=>{
  const mismatch='保存先は返信タブです。プロフィールの保存結果を選んでください';
  for(const change of [
    {state:'succeeded'},{state:'processing'},{receipt:'https://archive.li/Rem01'},
    {target_url:'https://x.com/Other'},
    {target_kind:'replies',target_url:'https://x.com/Example/with_replies'},
    {expected_x_user_id:'999999999'},
    {identity:{handle:'Other',name:'例',bio:'自己紹介'}},
    {last_error:'保存本文の数値IDが別のアカウントです'},
    {provider:'ghostarchive',receipt:'https://ghostarchive.org/archive/Rem01'},
    {updated_at:'2026-10-25T15:00:01.000Z'}
  ]){
    const a=setup([artist()],'archive.today');a.config.enabled=false;
    const old=await seedBodyFailure(a,{receipt:'https://archive.li/Rep01',last_error:mismatch});
    Object.assign(a.docs.get(JOBS).jobs[0],change);
    const remote=clone(a.docs.get(JOBS));
    await assert.rejects(a.engine.adopt(old.job_id,'https://archive.li/Pro01'),/競合|アカウントが一致/);
    assert.deepEqual(a.docs.get(JOBS),remote);
    const restored=(await a.state()).jobs[0];
    assert.deepEqual(a.engine.publicJob(restored),remote.jobs[0]);
    assert.equal(restored.dirty,false);assert.equal(Object.hasOwn(restored,'receiptCorrection'),false);
    assert.equal(restored.rejectedReceiptCorrections[0].receipt,'https://archive.li/Pro01');
    assert.equal(a.calls.writes.length,0);assert.equal(a.calls.post,0);assert.equal(a.calls.opened,0);
  }
});

test('a version conflict stays rejected across wakeups and restarts, then a fresh explicit selection can recover',async()=>{
  const a=setup([artist()],'archive.today');a.config.enabled=false;
  const old=await seedBodyFailure(a,{receipt:'https://archive.li/Rep01',last_error:'保存先の対象アカウントが一致しません',updated_at:new Date(a.now()).toISOString()});
  a.docs.get(JOBS).jobs[0].updated_at=new Date(a.now()+1000).toISOString();
  const remote=clone(a.docs.get(JOBS)),seen=[];
  const inspect=a.ghost.inspect;a.ghost.inspect=async job=>{seen.push(job.receipt);return inspect(job);};
  await assert.rejects(a.engine.adopt(old.job_id,'https://archive.li/Pro01'),/競合/);
  for(let i=0;i<3;i++){a.restart();a.advance();await a.run();}
  let restored=(await a.state()).jobs[0];
  assert.equal(restored.state,'needs_review');assert.equal(restored.receipt,'https://archive.li/Rep01');
  assert.equal(restored.rejectedReceiptCorrections[0].receipt,'https://archive.li/Pro01');
  assert.deepEqual(a.docs.get(JOBS),remote);assert.deepEqual(seen,[]);assert.equal(a.calls.writes.length,0);
  await a.engine.adopt(old.job_id,'https://archive.li/Pro01');await a.run();
  restored=(await a.state()).jobs[0];
  assert.equal(restored.state,'succeeded');assert.equal(restored.receipt,'https://archive.li/Pro01');
  assert.equal(restored.rejectedReceiptCorrections.length,1);assert.deepEqual(seen,['https://archive.li/Pro01']);
  assert.equal(Object.hasOwn(a.docs.get(JOBS).jobs[0],'rejectedReceiptCorrections'),false);
  assert.equal(Object.hasOwn(a.docs.get(JOBS).jobs[0],'receiptCorrection'),false);
  assert.equal(a.calls.post,0);assert.equal(a.calls.opened,0);
});

test('a rejected correction preserves a remote success and later applies only that authoritative result',async()=>{
  const a=setup([artist()],'archive.today');a.config.enabled=false;
  const old=await seedBodyFailure(a,{receipt:'https://archive.li/Rep01',last_error:'保存先の対象URLが一致しません'});
  const completed={...old,state:'succeeded',receipt:'https://archive.li/Rem01',last_error:''};
  const page=await a.ghost.inspect(completed);
  completed.verification=C.verify(page,page.frames,completed,a.now());assert.equal(completed.verification.ok,true);
  a.docs.get(JOBS).jobs[0]=clone(completed);
  await assert.rejects(a.engine.adopt(old.job_id,'https://archive.li/Pro01'),/競合/);
  const restored=(await a.state()).jobs[0];
  assert.deepEqual(a.engine.publicJob(restored),completed);assert.equal(restored.applied,false);
  assert.equal(a.calls.writes.length,0);assert.equal(a.docs.get(a.config.path).artists[0].archive_status,undefined);
  a.restart();await a.run();a.restart();await a.run();
  assert.equal((await a.state()).jobs[0].receipt,'https://archive.li/Rem01');
  assert.equal(a.docs.get(a.config.path).artists[0].archive_url,'https://archive.li/Rem01');
  assert.equal(a.calls.writes.filter(k=>k===a.config.path).length,1);
  assert.equal(a.calls.post,0);assert.equal(a.calls.opened,0);
});

test('remote processing after a correction conflict never inspects the refused local selection',async()=>{
  const a=setup([artist()],'archive.today');a.config.enabled=false;
  const old=await seedBodyFailure(a,{receipt:'https://archive.li/Rep01',last_error:'保存先の対象URLが一致しません'});
  a.docs.get(JOBS).jobs[0].state='processing';
  const seen=[];a.ghost.inspect=async job=>{seen.push(job.receipt);return{kind:'loading',receipt:job.receipt};};
  await assert.rejects(a.engine.adopt(old.job_id,'https://archive.li/Pro01'),/競合/);
  assert.equal(a.calls.writes.length,0);
  for(let i=0;i<3;i++){a.restart();a.advance();await a.run();}
  assert.equal((await a.state()).jobs[0].state,'processing');
  assert.equal(a.docs.get(JOBS).jobs[0].receipt,'https://archive.li/Rep01');
  assert.ok(seen.length>0);assert.ok(seen.every(receipt=>receipt==='https://archive.li/Rep01'));
  assert.equal(a.docs.get(a.config.path).artists[0].archive_status,undefined);assert.equal(a.calls.post,0);
});

test('a correction cannot resurrect a deleted shared job across wakeups or restarts',async()=>{
  const a=setup([artist()],'archive.today');a.config.enabled=false;
  const old=await seedBodyFailure(a,{receipt:'https://archive.li/Rep01',last_error:'保存先の対象URLが一致しません'});
  a.docs.get(JOBS).jobs=[];
  await assert.rejects(a.engine.adopt(old.job_id,'https://archive.li/Pro01'),/競合/);
  const state=await a.state();assert.equal(state.jobs.length,0);
  assert.equal(state.rejectedReceiptCorrections[0].job_id,old.job_id);
  assert.equal(state.rejectedReceiptCorrections[0].receipt,'https://archive.li/Pro01');
  for(let i=0;i<3;i++){a.restart();a.advance();await a.run();}
  assert.equal((await a.state()).jobs.length,0);assert.equal(a.docs.get(JOBS).jobs.length,0);
  assert.equal(a.calls.writes.length,0);assert.equal(a.calls.post,0);assert.equal(a.calls.opened,0);
});

test('an old WIP in receipt history cannot bypass manual correction authorization after remote progress',async()=>{
  const a=setup([artist()],'archive.today');a.config.enabled=false;
  const old=await seedBodyFailure(a,{receipt:'https://archive.li/Rep01',receipt_history:['https://archive.li/wip/Rep01'],
    last_error:'保存先の対象URLが一致しません',updated_at:new Date(a.now()).toISOString()});
  Object.assign(a.docs.get(JOBS).jobs[0],{receipt:'https://archive.li/wip/Rep01',state:'processing',
    target_url:'https://x.com/Other',updated_at:new Date(a.now()+1000).toISOString()});
  const remote=clone(a.docs.get(JOBS)),seen=[];
  a.ghost.inspect=async job=>{seen.push(job.receipt);return{kind:'loading',receipt:job.receipt};};
  await assert.rejects(a.engine.adopt(old.job_id,'https://archive.li/Pro01'),/競合/);
  assert.deepEqual(a.docs.get(JOBS),remote);assert.equal(a.calls.writes.length,0);
  assert.deepEqual(a.engine.publicJob((await a.state()).jobs[0]),remote.jobs[0]);
  for(let i=0;i<3;i++){a.restart();a.advance();await a.run();}
  const restored=(await a.state()).jobs[0];
  assert.equal(restored.state,'processing');assert.equal(restored.target_url,'https://x.com/Other');
  assert.equal(restored.receipt,'https://archive.li/wip/Rep01');
  assert.ok(seen.length>0);assert.ok(seen.every(receipt=>receipt==='https://archive.li/wip/Rep01'));
  assert.equal(a.docs.get(a.config.path).artists[0].archive_status,undefined);assert.equal(a.calls.post,0);
});

test('an accepted correction with a lost PUT response retries the same receipt and applies its result once',async()=>{
  const a=setup([artist()],'archive.today');a.config.enabled=false;
  const old=await seedBodyFailure(a,{receipt:'https://archive.li/Rep01',last_error:'保存先の対象URLが一致しません'});
  const update=a.git.update;let loseResponse=true;
  a.git.update=async(key,change)=>{
    const result=await update(key,change);
    if(key===JOBS&&loseResponse){loseResponse=false;throw Error('503 response lost after accepted PUT');}
    return result;
  };
  await assert.rejects(a.engine.adopt(old.job_id,'https://archive.li/Pro01'),/503/);
  assert.equal(a.docs.get(JOBS).jobs[0].receipt,'https://archive.li/Pro01');
  assert.equal((await a.state()).jobs[0].receiptCorrection.to,'https://archive.li/Pro01');
  assert.equal(Object.hasOwn(a.docs.get(JOBS).jobs[0],'receiptCorrection'),false);
  a.restart();await a.run();a.restart();await a.run();
  const saved=(await a.state()).jobs[0];
  assert.equal(saved.state,'succeeded');assert.equal(saved.receipt,'https://archive.li/Pro01');
  assert.equal(Object.hasOwn(saved,'receiptCorrection'),false);
  assert.deepEqual(saved.receipt_history,['https://archive.li/wip/Ab123','https://archive.li/Rep01']);
  assert.equal(a.docs.get(a.config.path).artists[0].archive_url,'https://archive.li/Pro01');
  assert.equal(a.calls.writes.filter(key=>key===a.config.path).length,1);
  assert.equal(a.calls.post,0);assert.equal(a.calls.opened,0);
});

test('same-receipt correction retries cannot overwrite a changed remote target or identity',async()=>{
  for(const change of [{target_url:'https://x.com/Other'},
    {target_kind:'replies',target_url:'https://x.com/Example/with_replies'},
    {expected_x_user_id:'999999999'},{identity:{handle:'Other',name:'例',bio:'自己紹介'}}]){
    const a=setup([artist()],'archive.today');a.config.enabled=false;
    const old=await seedBodyFailure(a,{receipt:'https://archive.li/Rep01',last_error:'保存先の対象URLが一致しません'});
    Object.assign(a.docs.get(JOBS).jobs[0],{receipt:'https://archive.li/Pro01',state:'processing',
      updated_at:new Date(a.now()+1000).toISOString(),...change});
    const remote=clone(a.docs.get(JOBS));
    await assert.rejects(a.engine.adopt(old.job_id,'https://archive.li/Pro01'),/競合|アカウントが一致/);
    assert.deepEqual(a.docs.get(JOBS),remote);
    assert.deepEqual(a.engine.publicJob((await a.state()).jobs[0]),remote.jobs[0]);
    assert.equal(a.calls.writes.length,0);assert.equal(a.calls.post,0);assert.equal(a.calls.opened,0);
  }
});

function captureProof({kind='profile',captured='https://x.com/Example/with_replies',selected=true,receipt='https://archive.li/Rep01'}={}){
  const now=Date.parse('2026-11-14T00:00:00Z'),stamp=new Date(now).toISOString();
  const job={kind:'profile',artist_id:'one',registered_handle:'Example',expected_x_user_id:'1234567890123456789',provider:'archive.today',
    target_kind:kind==='replies'?'replies':undefined,target_url:'https://x.com/Example'+(kind==='replies'?'/with_replies':''),
    identity:{handle:'Example',name:'例',bio:'自己紹介'},submission_started_at:stamp,receipt};
  const body={kind:'profile',handle:'Example',name:'例',bio:'自己紹介',following:true,user_id:job.expected_x_user_id,replies_tab_confirmed:selected};
  const outer={original_url:captured,captured_at:stamp};
  job.verification=C.verify(outer,[body],job,now);
  return{job,body,outer,now};
}

test('target coverage is one-way for the same normalized account and refuses untrusted or different accounts',()=>{
  assert.equal(C.targetCovers('https://x.com/Example','https://twitter.com/EXAMPLE/'),true);
  assert.equal(C.targetCovers('https://x.com/Example','https://www.x.com/EXAMPLE/with_replies/?test=1'),true);
  assert.equal(C.targetCovers('https://x.com/Example/with_replies','https://x.com/Example/with_replies'),true);
  assert.equal(C.targetCovers('https://x.com/Example/with_replies','https://x.com/Example'),false);
  for(const captured of ['https://x.com/Other','https://x.com/Other/with_replies','https://x.com.evil/Example','http://x.com/Example',undefined]){
    assert.equal(C.targetCovers('https://x.com/Example',captured),false);
  }
  assert.equal(C.targetCovers('', 'https://x.com/Example'),false);
});

test('a reply capture proves its profile header without claiming unconfirmed replies and retains identity and time checks',()=>{
  const {job,body,outer,now}=captureProof({selected:false,captured:'https://twitter.com/EXAMPLE/with_replies/?test=1'});
  assert.equal(job.verification.ok,true);assert.deepEqual(job.verification.scope,['profile']);
  assert.equal(job.verification.captured_target_url,'https://x.com/example/with_replies');
  const both=C.verify(outer,[{...body,replies_tab_confirmed:true}],job,now);
  assert.deepEqual(both.scope,['profile','replies']);
  assert.equal(C.verify(outer,[{...body,user_id:'999'}],job,now).ok,false);
  assert.equal(C.verify({...outer,original_url:'https://x.com/Other/with_replies'},[body],job,now).ok,false);
  assert.equal(C.verify(outer,[{...body,handle:'Other'}],job,now).ok,false);
  assert.equal(C.verify(outer,[{...body,user_id:'',bio:'違う自己紹介'}],job,now).ok,false);
  assert.equal(C.verify({...outer,captured_at:new Date(now+10*C.MINUTE).toISOString()},[body],job,now).ok,false);
  assert.equal(C.verify({...outer,captured_at:new Date(now-C.DAY).toISOString()},[{...body,user_id:''}],job,now).ok,false);
  const replyJob={...job,target_kind:'replies',target_url:'https://x.com/Example/with_replies'};
  assert.equal(C.verify(outer,[body],replyJob,now).ok,false);
  assert.equal(C.verify({...outer,original_url:'https://x.com/Example'},[{...body,replies_tab_confirmed:true}],replyJob,now).ok,false);
});

test('archive provenance records the actual reply capture while completing only scopes that were verified',()=>{
  const {job}=captureProof({selected:false});
  const doc={artists:[{...artist(),note:'クソリプ'}]};assert.equal(C.applyResult(doc,job),true);
  const saved=doc.artists[0],event=saved.archives[0];
  assert.equal(event.target_url,'https://x.com/example/with_replies');assert.equal(event.requested_target_url,job.target_url);
  assert.deepEqual(event.verified_scope,['profile']);assert.equal(saved.archive_target_url,event.target_url);
  assert.equal(C.completed(saved,'profile'),true);assert.equal(C.completed(saved,'replies'),false);
});

test('a verified replies job also fills an empty primary profile and completes both scopes',()=>{
  const {job}=captureProof({kind:'replies'});
  const doc={artists:[{...artist(),note:'クソリプ'}]};assert.equal(C.applyResult(doc,job),true);
  const saved=doc.artists[0];
  assert.equal(saved.archive_url,job.receipt);assert.equal(saved.archive_target_url,'https://x.com/example/with_replies');
  assert.deepEqual(saved.archives[0].verified_scope,['profile','replies']);
  assert.equal(C.completed(saved,'profile'),true);assert.equal(C.completed(saved,'replies'),true);
});

test('reply coverage preserves an existing complete primary profile',()=>{
  const {job}=captureProof();
  const original={archive_status:'done',archive_url:'https://archive.li/Old01',archive_provider:'archive.today',
    archive_target_url:'https://x.com/Example',archive_checked_at:'2026-01-01T00:00:00Z'};
  const doc={artists:[{...artist(),...original}]};C.applyResult(doc,job);
  const saved=doc.artists[0];
  for(const [key,value]of Object.entries(original))assert.equal(saved[key],value);
  assert.equal(saved.archives[0].url,job.receipt);assert.equal(C.completed(saved,'profile'),true);assert.equal(C.completed(saved,'replies'),true);
});

test('later profile-only verification preserves broader proof for the same capture and account',()=>{
  const broad=captureProof({kind:'replies'}).job,narrow=captureProof({selected:false}).job;
  const doc={artists:[{...artist(),note:'クソリプ'}]};C.applyResult(doc,broad);C.applyResult(doc,narrow);
  const saved=doc.artists[0];assert.equal(saved.archives.length,1);
  assert.deepEqual(saved.archives[0].verified_scope,['profile','replies']);
  assert.equal(saved.archives[0].requested_target_url,narrow.target_url);
  assert.equal(C.completed(saved,'profile'),true);assert.equal(C.completed(saved,'replies'),true);
  const other={artists:[{...artist(),archives:[{status:'done',url:narrow.receipt,target_url:'https://x.com/Example/with_replies',
    x_user_id:'999',verified_scope:['profile','replies']}]}]};
  C.applyResult(other,narrow);assert.deepEqual(other.artists[0].archives[0].verified_scope,['profile']);
});

test('legacy completion and verification without actual-target metadata remain compatible',()=>{
  const profile={...artist(),archives:[{status:'done',target_url:'https://x.com/Example'}]};
  const replies={...artist(),archives:[{status:'done',target_url:'https://x.com/Example/with_replies'}]};
  assert.equal(C.completed(profile,'profile'),true);assert.equal(C.completed(replies,'replies'),true);
  assert.equal(C.completed(replies,'profile'),false);
  const {job}=captureProof({captured:'https://x.com/Example'});delete job.verification.captured_target_url;
  const doc={artists:[artist()]};assert.equal(C.applyResult(doc,job),true);
  assert.equal(doc.artists[0].archives[0].target_url,'https://x.com/example');
  assert.equal(doc.artists[0].archives[0].requested_target_url,job.target_url);
  const invalid=captureProof().job;invalid.verification.captured_target_url='https://x.com/Other/with_replies';
  assert.throws(()=>C.applyResult({artists:[artist()]},invalid),/未検証/);
});

test('old profile URL mismatches recheck a reply capture once without resubmitting and preserve submission history',async()=>{
  for(const provider of ['archive.today','ghostarchive']){
    const a=setup([artist()],provider);a.config.enabled=false;
    const receipt=provider==='archive.today'?'https://archive.li/Rep01':'https://ghostarchive.org/archive/Rep01';
    const old=await seedBodyFailure(a,{provider,receipt,receipt_history:[],last_error:'保存先は返信タブです。プロフィールの保存結果を選んでください',
      submission_started_at:new Date(a.now()-4*C.DAY).toISOString()});
    const inspect=a.ghost.inspect;a.ghost.inspect=async job=>({...await inspect(job),original_url:'https://x.com/Example/with_replies',
      frames:[{kind:'profile',handle:'Example',name:'例',bio:'自己紹介',following:true,user_id:job.expected_x_user_id,replies_tab_confirmed:true}]});
    assert.equal(await a.engine.recheckKnownBodies(),1);
    let job=(await a.state()).jobs[0];assert.equal(job.state,'processing');assert.equal(job.receipt,receipt);
    assert.equal(job.receipt_recovery_started_at,new Date(a.now()).toISOString());
    await a.run();job=(await a.state()).jobs[0];
    assert.equal(job.state,'succeeded');assert.deepEqual(job.verification.scope,['profile','replies']);
    assert.equal(job.submission_started_at,old.submission_started_at);assert.equal(job.attempt_count,old.attempt_count);
    assert.deepEqual(job.receipt_history,old.receipt_history);assert.equal(a.calls.post,0);assert.equal(a.calls.opened,0);
    const saved=a.docs.get(a.config.path).artists[0];assert.equal(C.completed(saved,'profile'),true);assert.equal(C.completed(saved,'replies'),true);
    a.restart();assert.equal(await a.engine.recheckKnownBodies(),0);
  }
});

test('coverage rechecks do not loop after a wrong account or numeric ID and exclude other executors or reply jobs',async()=>{
  for(const failure of ['account','id']){
    const a=setup([artist()],'archive.today');a.config.enabled=false;
    await seedBodyFailure(a,{last_error:'保存先の対象URLが一致しません'});
    const inspect=a.ghost.inspect;a.ghost.inspect=async job=>{
      const page=await inspect(job);page.original_url='https://x.com/'+(failure==='account'?'Other':'Example')+'/with_replies';
      if(failure==='id')page.frames[0].user_id='999';return page;
    };
    assert.equal(await a.engine.recheckKnownBodies(),1);
    for(let i=0;i<3;i++){await a.run();a.advance();}
    assert.equal((await a.state()).jobs[0].state,'needs_review');a.restart();assert.equal(await a.engine.recheckKnownBodies(),0);
    assert.equal(a.calls.post,0);assert.equal(a.docs.get(a.config.path).artists[0].archive_status,undefined);
  }
  for(const change of [{executor_device_id:'another-device'},
    {target_kind:'replies',target_url:'https://x.com/Example/with_replies'}]){
    const a=setup([artist()],'archive.today');a.config.enabled=false;
    await seedBodyFailure(a,{last_error:'保存先の対象URLが一致しません',...change});
    assert.equal(await a.engine.recheckKnownBodies(),0);assert.equal((await a.state()).jobs[0].state,'needs_review');
    assert.equal(a.calls.post,0);
  }
});

test('a queued replies request is canceled without a POST once an existing capture proves both scopes',async()=>{
  const a=setup([{...artist(),note:'クソリプ'}],'archive.today');
  const old=await seedBodyFailure(a,{last_error:'保存先の対象URLが一致しません',submission_started_at:new Date(a.now()-4*C.DAY).toISOString()});
  const queued={job_id:'queued-replies',kind:'profile',target_kind:'replies',artist_id:'one',registered_handle:'Example',
    expected_x_user_id:old.expected_x_user_id,state:'queued',provider:'archive.today',executor_device_id:'device',
    created_at:new Date(a.now()).toISOString(),attempt_count:0,next_attempt_at:a.now()};
  await a.engine.save({...await a.state(),jobs:[old,queued]});a.docs.get(JOBS).jobs.push(clone(queued));
  const inspect=a.ghost.inspect;a.ghost.inspect=async job=>({...await inspect(job),original_url:'https://x.com/Example/with_replies',
    frames:[{kind:'profile',handle:'Example',name:'例',bio:'自己紹介',following:true,user_id:job.expected_x_user_id,replies_tab_confirmed:true}]});
  await a.run();a.advance();await a.run();
  const state=await a.state();assert.equal(state.jobs.find(job=>job.job_id===old.job_id).state,'succeeded');
  assert.equal(state.jobs.find(job=>job.job_id===queued.job_id).state,'canceled');
  const saved=a.docs.get(a.config.path).artists[0];assert.equal(C.completed(saved,'profile'),true);assert.equal(C.completed(saved,'replies'),true);
  assert.equal(a.calls.post,0);assert.equal(a.calls.opened,0);
});

