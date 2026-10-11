let opening;const finishing=new Map();let diagnosticQueue=Promise.resolve();
function errorText(error){return String(error?.message||error).replace(/(?:https?:\/\/|blob:|chrome-extension:\/\/)[^\s"'<>]+/gi,'[주소 제외]').replace(/(?:[a-z]:[\\/]|\\\\|\/(?:Users|home|mnt)\/)[^\r\n"'<>]+/gi,'[경로 제외]').replace(/Bearer\s+\S+/gi,'Bearer [제외]').replace(/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g,'[토큰 제외]').replace(/((?:cookie|token|authorization|session|password|key)\s*[=:]\s*)[^\s,;]+/gi,'$1[제외]').slice(0,500);}
function diagnostic(value){
  const task=diagnosticQueue.then(async()=>{const {diagnostics=[]}=await chrome.storage.local.get('diagnostics'),entries=[...diagnostics,{at:new Date().toISOString(),...value}].slice(-100);await chrome.storage.local.set({diagnostics:entries});const stored=(await chrome.storage.local.get('diagnostics')).diagnostics;if(stored?.at(-1)?.at!==entries.at(-1).at)throw new Error('진단 기록 저장 확인 실패.');});
  diagnosticQueue=task.catch(()=>{});return task;
}
async function storagePage(){if(await chrome.offscreen.hasDocument())return;if(!opening)opening=chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS','WORKERS'],justification:'수신 영상의 로컬 디스크 기록과 무손실 병합'}).finally(()=>{opening=null;});await opening;}
async function disk(m){await storagePage();const r=await chrome.runtime.sendMessage({target:'offscreen',...m});if(r?.error){const error=new Error(errorText(r.error));error.code=r.code;throw error;}return r.result;}
async function status(value){if(value?.error)value={...value,error:errorText(value.error)};await chrome.storage.local.set({recording:value});await diagnostic({status:value?.status||'idle',id:value?.id,bytes:value?.bytes,endReason:value?.endReason,...(value?.error?{error:value.error}:{})});await chrome.action.setIcon({path:value?.status==='recording'?'icons/recording.png':'icons/idle.png'});await chrome.action.setBadgeText({text:value?.status==='recording'?'REC':''});}
async function savedState(id,exports){
  const current=(await chrome.storage.local.get('recording')).recording;
  if(current?.id!==id)return;
  exports??=current.exports;if(!exports?.length)return;
  const downloads=await Promise.all(exports.filter(e=>!e.custom).map(e=>chrome.downloads.search({id:e.id}).then(items=>items[0])));
  const failed=downloads.find(d=>d?.state==='interrupted'),complete=downloads.every(d=>d?.state==='complete');
  if((await chrome.storage.local.get('recording')).recording?.id!==id)return;
  await status({...current,exports,status:failed?'terminal_failure':complete?'saved':'saving',...(failed?{error:failed.error||'파일 저장 중단.'}:{})});
}
async function save(record){
  try{const exported=await disk({kind:'export',record});await savedState(record.id,exported.exports);}
  catch(error){
    const failure={id:record.id,status:'terminal_failure',error:errorText(error),at:new Date().toISOString()};await chrome.storage.local.set({lastSaveFailure:failure});
    if((await chrome.storage.local.get('recording')).recording?.id===record.id)await status({...record,status:error.code==='FOLDER_PERMISSION_REQUIRED'?'awaiting_permission':'terminal_failure',error:error.message});
  }
}
async function finish(record,reason='unspecified'){
  if(finishing.has(record.id))return finishing.get(record.id);
  const task=(async()=>{
    const current=(await chrome.storage.local.get('recording')).recording;
    if(current?.id!==record.id||!['recording','stopping'].includes(current.status))return;
    record={...record,endReason:reason};
    await status({...record,status:'finalizing'});
    try{
      const result={...await disk({kind:'finish'}),endReason:reason};
      if((await chrome.storage.local.get('recording')).recording?.id===record.id)await status({...result,status:'saving',tabId:record.tabId,frameId:record.frameId});
      await save({...result,tabId:record.tabId,frameId:record.frameId});
    }catch(error){
      await chrome.storage.local.set({lastSaveFailure:{id:record.id,status:'terminal_failure',error:errorText(error),at:new Date().toISOString()}});
      if((await chrome.storage.local.get('recording')).recording?.id===record.id)await status({...record,status:'terminal_failure',error:error.message});
    }
  })();
  finishing.set(record.id,task);try{await task;}finally{finishing.delete(record.id);}
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(m.target==='offscreen'||m.target==='bridge')return;
  (async()=>{
    const local=!sender.tab || sender.url?.startsWith(chrome.runtime.getURL(''));
    if(m.kind==='inventory'&&sender.tab){
      const {recording}=await chrome.storage.local.get('recording');
      if(recording?.tabId===sender.tab.id&&recording.frameId===sender.frameId&&recording.documentId&&sender.documentId&&recording.documentId!==sender.documentId&&['recording','stopping'].includes(recording.status))await finish(recording,'document_replaced');
      const {sources={}}=await chrome.storage.session.get('sources');sources[sender.tab.id+':'+sender.frameId]={tabId:sender.tab.id,frameId:sender.frameId,documentId:sender.documentId,groups:m.groups};await chrome.storage.session.set({sources});return {};
    }
    const {recording}=await chrome.storage.local.get('recording');
    const owner=sender.tab?.id===recording?.tabId&&sender.frameId===recording?.frameId;
    if(m.kind==='chunk') {
      if(owner&&m.session===recording?.id&&!['recording','stopping'].includes(recording.status)){await diagnostic({status:'ignored',operation:'late_chunk',recordingStatus:recording.status});return {ignored:true};}
      if(!owner||m.session!==recording?.id||!['recording','stopping'].includes(recording.status)){await diagnostic({status:'error',operation:'session_mismatch',recordingStatus:recording?.status||'none',owner,sessionMatches:m.session===recording?.id});throw new Error('녹화 세션 불일치.');}
      const result=await disk(m);return result;
    }
    if(m.kind==='stopped'&&owner&&m.session===recording.id){await finish(recording,recording.status==='stopping'?'stop_button':'capture_stopped');return {};}
    if(m.kind==='capture-error'&&owner&&m.session===recording.id){if(!['recording','stopping'].includes(recording.status)){await diagnostic({status:'ignored',operation:'late_capture_error',recordingStatus:recording.status,error:errorText(m.message)});return {};}const message=errorText(m.message);await disk({kind:'fail',message});await status({...recording,status:'terminal_failure',error:message});return {};}
    if(!local)throw new Error('확장 관리 화면에서만 조작 가능.');
    if(m.kind==='diagnostics'){await diagnosticQueue;const stored=await chrome.storage.local.get(['diagnostics','popupDiagnostics']);return [...stored.diagnostics||[],...stored.popupDiagnostics||[]].sort((a,b)=>a.at.localeCompare(b.at)).slice(-100);}
    if(m.kind==='popup-error'){await diagnostic({status:'error',operation:'popup',error:errorText(m.message)});return {};}
    if(m.kind==='clear-diagnostics'){const task=diagnosticQueue.then(async()=>{await chrome.storage.local.set({diagnostics:[],popupDiagnostics:[]});const stored=await chrome.storage.local.get(['diagnostics','popupDiagnostics']);if(stored.diagnostics?.length!==0||stored.popupDiagnostics?.length!==0)throw new Error('로그 비우기 확인 실패.');});diagnosticQueue=task.catch(()=>{});await task;return {};}
    if(m.kind==='state'){const {sources={}}=await chrome.storage.session.get('sources'),current=await disk({kind:'current'});return {recording:current&&recording&&current.id===recording.id?{...recording,bytes:current.bytes,createdAt:current.createdAt}:recording,sources:Object.values(sources)};}
    if(m.kind==='start'){
      if(recording&&['recording','stopping','finalizing','awaiting_permission'].includes(recording.status))throw new Error('현재 녹화 저장을 먼저 완료해줘.');
      const {sources={}}=await chrome.storage.session.get('sources'),source=sources[m.tabId+':'+m.frameId];
      if(!source?.groups.some(g=>g.id===m.group))throw new Error('재생 데이터가 없음. 영상 탭을 새로고침해 준비해줘.');
      const record={id:crypto.randomUUID(),tabId:m.tabId,frameId:m.frameId,documentId:source.documentId,group:m.group,status:'recording',createdAt:new Date().toISOString(),bytes:0};
      const title=(await chrome.tabs.get(source.tabId)).title||'';
      await disk({kind:'start',session:{...record,title}});await status(record);
      try{const response=await chrome.tabs.sendMessage(record.tabId,{target:'bridge',kind:'start',session:record,group:record.group},{frameId:record.frameId});if(response?.error)throw new Error(response.error);}
      catch(error){await disk({kind:'fail',message:error.message});await status({...record,status:'terminal_failure',error:error.message});throw error;}return record;
    }
    if(m.kind==='stop'){
      if(recording?.status!=='recording')return {};
      await status({...recording,status:'stopping'});
      try{await chrome.tabs.sendMessage(recording.tabId,{target:'bridge',kind:'stop'},{frameId:recording.frameId});}catch{await finish(recording,'stop_button_bridge_unavailable');}return {};
    }
    if(m.kind==='save-current'){
      if(recording?.status!=='awaiting_permission')throw new Error('권한 승인 대기 중인 파일이 없음.');
      const record={...recording,status:'saving'};delete record.error;await status(record);await save(record);return {};
    }
    if(m.kind==='download'){if(!m.url.startsWith('blob:'+chrome.runtime.getURL(''))||/[\\/]/.test(m.name))throw new Error('로컬 녹화 파일만 저장 가능.');return {id:await chrome.downloads.download({url:m.url,filename:m.name,conflictAction:'uniquify',saveAs:false})};}
    throw new Error('알 수 없는 명령.');
  })().then(result=>reply({result})).catch(async error=>{let message=errorText(error);try{await diagnostic({status:'error',operation:String(m.kind).slice(0,60),error:message});}catch(logError){message+=' / 로그 기록 실패: '+errorText(logError);}reply({error:message});});return true;
});
chrome.downloads.onChanged.addListener(async delta=>{if(delta.state?.current==='complete'||delta.error){chrome.runtime.sendMessage({target:'offscreen',kind:'release',id:delta.id}).catch(()=>{});const {recording}=await chrome.storage.local.get('recording');if(recording?.exports?.some(e=>e.id===delta.id))await savedState(recording.id);}});
async function resetTab(tabId,reason='tab_loading'){
  const {recording}=await chrome.storage.local.get('recording');
  const {sources={}}=await chrome.storage.session.get('sources');for(const key of Object.keys(sources))if(sources[key].tabId===tabId)delete sources[key];await chrome.storage.session.set({sources});
  if(recording?.tabId===tabId){if(['recording','stopping'].includes(recording.status))await finish(recording,reason);const current=(await chrome.storage.local.get('recording')).recording;if(current?.id===recording.id&&current.status!=='awaiting_permission')await status(null);}
}
chrome.tabs.onRemoved.addListener(tabId=>resetTab(tabId,'tab_closed'));
chrome.tabs.onUpdated.addListener(async(tabId,change)=>{
  if(!['loading','complete'].includes(change.status))return;
  const {recording}=await chrome.storage.local.get('recording');
  if(recording?.tabId!==tabId)return;
  if(!['recording','stopping'].includes(recording.status)){if(change.status==='loading')await resetTab(tabId);return;}
  if(change.status==='loading'){await diagnostic({status:'ignored',operation:'tab_loading',id:recording.id});return;}
  let connected=false;
  try{const response=await chrome.tabs.sendMessage(tabId,{target:'bridge',kind:'probe'},{frameId:recording.frameId});connected=response?.session===recording.id;}catch{}
  if(!connected)await finish(recording,'document_disconnected');
});
chrome.runtime.onStartup.addListener(async()=>{const {recording}=await chrome.storage.local.get('recording');if(recording&&['recording','stopping','finalizing'].includes(recording.status))await status({...recording,status:'terminal_failure',error:'브라우저 종료로 녹화가 중단됨. 새 녹화를 시작할 수 있음.'});});
