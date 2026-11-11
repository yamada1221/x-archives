const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Today}=require('../extensions/mute-screen-capture/auto-today.js');
function fixture(tabs=[],pages={}) {
  const session={},calls={read:[],moves:[],created:0,removed:[]};
  const chrome={storage:{session:{get:async key=>({[key]:session[key]}),set:async values=>Object.assign(session,values),remove:async key=>{delete session[key];}}},
    tabs:{query:async()=>structuredClone(tabs),get:async id=>{const t=tabs.find(t=>t.id===id);if(!t)throw Error('closed');return structuredClone(t);},
      create:async()=>{calls.created++;throw Error('recovery must not create a tab');},
      update:async(id,props)=>{calls.moves.push({id,props});return{id,...props};},remove:async id=>calls.removed.push(id)},
    scripting:{executeScript:async args=>{calls.read.push(args.target.tabId);return[{frameId:0,result:pages[args.target.tabId]||{kind:'untrusted'}}];}}};
  const job={job_id:'one',provider:'archive.today',state:'submission_unknown',target_url:'https://x.com/Example',submission_started_at:'2026-10-29T08:29:01.607Z'};
  return {today:new Today(chrome),chrome,session,calls,job};
}
const fresh=()=>({kind:'archive',receipt:'https://archive.li/Ab123',original_url:'https://x.com/Example',captured_at:'2026-10-29T08:30:00Z'});
test('reload recovery binds only the exact submitted GET target and reads its CAPTCHA without submitting',async()=>{
  const a=fixture([{id:1,url:'https://archive.li/submit/?url=https%3A%2F%2Fx.com%2FOther',status:'complete'},
    {id:2,url:'https://archive.li/submit/?url=https%3A%2F%2Fx.com%2FExample',status:'complete'}],{2:{kind:'blocked',block_type:'human'}});
  const result=await a.today.reconcile(a.job);
  assert.equal(result.kind,'blocked');assert.equal(a.session['autoArchiveTab:one'],2);
  assert.deepEqual(a.calls.read,[2]);assert.deepEqual(a.calls.moves,[]);assert.equal(a.calls.created,0);
});
test('reload recovery finds a fresh open capture by wrapper target and capture time',async()=>{
  const a=fixture([{id:3,url:'https://archive.li/Ab123',status:'complete'}],{3:fresh()});
  const result=await a.today.reconcile(a.job);
  assert.equal(result.receipt,'https://archive.li/Ab123');assert.equal(a.session['autoArchiveTab:one'],3);
  assert.equal(a.calls.created,0);assert.deepEqual(a.calls.moves,[]);
});
test('reload recovery rejects old, different-account, invalid-time, foreign and ambiguous captures',async()=>{
  for(const page of [{...fresh(),captured_at:'2026-10-28T08:30:00Z'},{...fresh(),original_url:'https://x.com/Other'},
    {...fresh(),captured_at:'invalid'},{...fresh(),captured_at:'2099-01-01T00:00:00Z'},{kind:'blocked',receipt:'https://archive.li/Ab123'}]){
    const a=fixture([{id:3,url:'https://archive.li/Ab123',status:'complete'}],{3:page});
    assert.equal((await a.today.reconcile(a.job)).kind,'unresolved');assert.deepEqual(a.session,{});assert.equal(a.calls.created,0);
  }
  const a=fixture([{id:1,url:'https://evil.example/Ab123',status:'complete'},{id:2,url:'https://archive.li/Ab123',status:'complete'},
    {id:3,url:'https://archive.md/Cd456',status:'complete'}],{2:fresh(),3:{...fresh(),receipt:'https://archive.md/Cd456'}});
  assert.equal((await a.today.reconcile(a.job)).kind,'unresolved');assert.deepEqual(a.session,{});
  assert.deepEqual(a.calls.read,[2,3]);assert.deepEqual(a.calls.moves,[]);
});
test('a recorded receipt can be reopened after reload even while the job waits for human confirmation',async()=>{
  const a=fixture();a.job.receipt='https://archive.li/Ab123';let opened;
  a.today.open=async(job,url)=>{opened=url;return{id:9,url,status:'loading'};};
  assert.equal((await a.today.reconcile(a.job)).kind,'loading');assert.equal(opened,a.job.receipt);
});
test('an unbound unknown submission gives actionable manual guidance without navigating or starting a new capture',async()=>{
  const a=fixture([{id:3,url:'https://archive.li/',status:'complete'}]);
  const result=await a.today.reconcile(a.job);
  assert.equal(result.kind,'unresolved');assert.match(result.reason,/送信済み.*タブ/);assert.match(result.reason,/保存先で確認/);
  assert.deepEqual(a.calls.moves,[]);assert.equal(a.calls.created,0);assert.deepEqual(a.calls.read,[]);
});
test('a recovered user-opened result tab stays open after verification; newly created tabs retain normal cleanup',async()=>{
  const a=fixture([{id:3,url:'https://archive.li/Ab123',status:'complete'}],{3:fresh()});
  await a.today.reconcile(a.job);await a.today.close(a.job);
  assert.deepEqual(a.calls.removed,[]);assert.deepEqual(a.session,{});
  a.session['autoArchiveTab:one']=3;a.session['autoArchiveBorrowedTab:one']=false;
  await a.today.close(a.job);assert.deepEqual(a.calls.removed,[3]);assert.deepEqual(a.session,{});
});
