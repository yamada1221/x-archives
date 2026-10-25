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
function setup(rows=[artist()]) {
  let now=Date.parse('2026-10-25T15:00:00Z'), n=0;
  const config=C.config({token:'fixture',enabled:true,providerReady:C.ADAPTER_VERSION});
  const docs=new Map([[config.path,{artists:clone(rows),unrelated_summary:{keep:true}}],[CONFIG,{version:1,enabled:true,executor_device_id:'device',artists_path:config.path}]]);
  const store=new MemoryStore(), calls={post:0,opened:0,closed:0,ready:[],writes:[]};
  const git={get:async k=>({data:clone(docs.get(k)||null),sha:'v'}),update:async(k,f)=>{
    if(calls.failSync&&k===JOBS)throw Error('fixture offline');
    const next=f(clone(docs.get(k)||null));if(next!==undefined){docs.set(k,clone(next));calls.writes.push(k);}return clone(docs.get(k));
  }};
  const ghost={open:async()=>{calls.opened++;},close:async()=>{calls.closed++;},show:async()=>{},
    inspect:async j=>j.state==='opening'?{kind:'form'}:{kind:'archive',receipt:j.receipt,original_url:j.target_url,captured_at:new Date(now).toISOString(),frames:[{kind:'profile',handle:'Example',name:'例',bio:'自己紹介',following:true,user_id:'1234567890123456789',post_ids:['987654321']}]},
    submit:async()=>{calls.post++;if(calls.crashPost)throw Error('fixture worker shutdown');return{submitted:true};},
    reconcile:async()=>calls.lostReceipt?{kind:'unresolved',reason:'URL不明'}:{kind:'processing',receipt:'https://ghostarchive.org/archive/Ab123'}
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
  a.advance();await a.run();a.advance();await a.run();assert.deepEqual(a.calls.ready,[C.ADAPTER_VERSION]);assert.equal(a.docs.get(a.config.path).artists.length,0);
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
  assert.deepEqual(m.optional_permissions,['scripting']);assert.deepEqual(m.optional_host_permissions,['https://api.github.com/*','https://api.fxtwitter.com/*','https://ghostarchive.org/*']);
  assert.ok(m.content_scripts.every(c=>c.matches.every(p=>p.startsWith('https://yamada1221.github.io/x-archives/'))));
});
test('web pages and other extensions cannot save credentials, start tests or take over the executor',async()=>{
  const ctx={URL,Date,Set,Map,Promise,structuredClone,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout,crypto:require('node:crypto').webcrypto};
  const data={},listeners=[];ctx.chrome={runtime:{id:'mine',getURL:p=>'chrome-extension://mine/'+p,onStartup:{addListener:f=>listeners.push(f)},onInstalled:{addListener:f=>listeners.push(f)}},
    storage:{local:{get:async k=>({[k]:data[k]}),set:async d=>Object.assign(data,d),setAccessLevel:async()=>{}}},alarms:{onAlarm:{addListener:()=>{}}}};
  vm.createContext(ctx);for(const name of ['auto-core','auto-storage','auto-github','auto-ghost','auto-engine','auto-runtime'])vm.runInContext(fs.readFileSync(base+'/'+name+'.js','utf8'),ctx);
  for(const type of ['AUTO_SAVE','AUTO_START','AUTO_TEST','AUTO_CLAIM','AUTO_ADOPT']){
    await assert.rejects(ctx.AutoArchiveRuntime.handle({type},{id:'mine',url:'https://yamada1221.github.io/x-archives/',frameId:0,tab:{id:1}}),/拡張機能の画面/);
    await assert.rejects(ctx.AutoArchiveRuntime.handle({type},{id:'other',url:'chrome-extension://mine/auto-options.html'}));
  }
  const result=await ctx.AutoArchiveRuntime.handle({type:'AUTO_STATUS'},{id:'mine',url:'chrome-extension://mine/auto-options.html'});assert.equal(result.configured,false);assert.equal('token' in result,false);
});
