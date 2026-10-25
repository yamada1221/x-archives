// Playwright 1.51 retains a stale Worker handle when Chrome restarts an MV3
// worker with the same target ID. Attach a fresh debugger session to its actual
// execution context; this helper is never included in the extension.
module.exports=async function attachWorker(cdp,targetId){
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:false});
  let serial=0;const pending=new Map();
  cdp.on('Target.receivedMessageFromTarget',event=>{
    if(event.sessionId!==sessionId)return;
    const message=JSON.parse(event.message),request=pending.get(message.id);
    if(!request)return;pending.delete(message.id);clearTimeout(request.timer);
    if(message.error)request.reject(Error(message.error.message));else request.resolve(message.result);
  });
  return {async evaluate(fn){
    const id=++serial;
    const response=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(Error('Worker evaluation timed out'));},30000);
      pending.set(id,{resolve,reject,timer});
    });
    await cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method:'Runtime.evaluate',params:{expression:'('+fn.toString()+')()',awaitPromise:true,returnByValue:true}})}).catch(error=>{
      const request=pending.get(id);if(request){pending.delete(id);clearTimeout(request.timer);request.reject(error);}
    });
    const result=await response;
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result.value;
  }};
};
