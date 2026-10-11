import {preference} from './db.js';
import {currentSource} from './selection.mjs';
import {ensureFolderPermission} from './permission.mjs';
const $=id=>document.getElementById(id);let state,tab,busy=false,selectedFolder;
async function call(m){const response=await chrome.runtime.sendMessage({target:'background',...m});if(response.error)throw new Error(response.error);return response.result;}
async function showError(error){$('status').textContent=error.message;try{await call({kind:'popup-error',message:error.message});}catch(logError){try{const {popupDiagnostics=[]}=await chrome.storage.local.get('popupDiagnostics');await chrome.storage.local.set({popupDiagnostics:[...popupDiagnostics,{at:new Date().toISOString(),status:'error',operation:'popup_connection',error:String(error.name||'Error'),logError:String(logError.name||'Error')}].slice(-100)});const stored=await chrome.storage.local.get('popupDiagnostics');if(!stored.popupDiagnostics?.length)throw new Error('로그 저장 확인 실패');}catch(storageError){$('status').textContent+=' / 로그 기록 실패: '+storageError.message;}}}
const labels={recording:'녹화 중',stopping:'중지 중',finalizing:'병합 중',ready:'저장 대기',saving:'저장 중',saved:'저장 완료',awaiting_permission:'폴더 권한 필요',terminal_failure:'저장 실패'};
async function refresh(){
  state=await call({kind:'state'});const source=currentSource(state.sources,tab?.id);
  const r=state.recording,active=['recording','stopping','finalizing'].includes(r?.status);$('start').disabled=active||r?.status==='awaiting_permission'||!source;$('stop').disabled=!['recording','awaiting_permission'].includes(r?.status);$('stop').textContent=r?.status==='awaiting_permission'?'저장':'■ 녹화 중지';$('badge').textContent=labels[r?.status]||'대기';
  $('status').textContent=r?(r.error||(active&&r.tabId!==tab?.id?'다른 탭 녹화 중. ':'')+(labels[r.status]||r.status))+' · '+((r.bytes||0)/1048576).toFixed(1)+' MiB'+(r.createdAt?'\n시작: '+new Date(r.createdAt).toLocaleString():''):source?'대기':'영상 없음';
}
async function run(action){if(busy)return;busy=true;try{await action();await refresh();}catch(error){await showError(error);}finally{busy=false;}}
$('start').onclick=()=>run(async()=>{if(!await ensureFolderPermission(selectedFolder))throw new Error('저장 폴더 접근을 허용해줘.');const latest=await call({kind:'state'}),source=currentSource(latest.sources,tab?.id);if(!source)throw new Error('현재 탭에서 수집 가능한 영상이 없음.');await call({kind:'start',tabId:source.tabId,frameId:source.frameId,group:source.group});});
$('stop').onclick=()=>run(async()=>{const saving=state.recording?.status==='awaiting_permission',granted=await ensureFolderPermission(selectedFolder);if(saving&&!granted)throw new Error('지정 폴더 접근을 허용해줘.');await call({kind:saving?'save-current':'stop'});});
$('choose').onclick=()=>run(async()=>{const folder=await showDirectoryPicker({mode:'readwrite',startIn:'downloads'});await preference(folder);selectedFolder=folder;$('folder').textContent=folder.name;});
$('default').onclick=()=>run(async()=>{await preference(null);selectedFolder=null;$('folder').textContent='기본 다운로드 폴더';});
$('log-address').value=chrome.runtime.getURL('diagnostics.html');
$('logs').onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL('diagnostics.html')});
$('clear-logs').onclick=async()=>{try{await call({kind:'clear-diagnostics'});$('log-status').textContent='로그 비움';}catch(error){$('log-status').textContent=error.message;}};
[tab]=await chrome.tabs.query({active:true,currentWindow:true});$('tab-title').textContent=tab?.title||'현재 탭';
const folder=await preference();selectedFolder=folder;$('folder').textContent=folder?.name||'기본 다운로드 폴더';
try{await refresh();}catch(error){await showError(error);}setInterval(()=>{if(!busy)refresh().catch(showError);},2000);
