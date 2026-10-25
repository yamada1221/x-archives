const assert=require('node:assert/strict');
module.exports=async worker=>{
  const state=await worker.evaluate(()=>{
    const result={core:typeof AutoArchiveCore,storage:typeof AutoArchiveStore,github:typeof AutoArchiveGitHub,ghost:typeof AutoArchiveGhost,engine:typeof AutoArchiveEngine,runtime:typeof AutoArchiveRuntime};
    if(result.runtime==='undefined') {
      try {importScripts('auto-core.js','auto-storage.js','auto-github.js','auto-ghost.js','auto-engine.js','auto-runtime.js');}
      catch(e){result.importError=e.stack||e.message;}
    }
    return result;
  });
  assert.equal(state.runtime,'object','Worker initialization: '+JSON.stringify(state));
};
