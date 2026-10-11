import {preference} from './db.js';
const worker=new Worker('disk-worker.mjs',{type:'module'}),waiting=new Map(),urls=new Map();
worker.onmessage=({data})=>{const entry=waiting.get(data.id);if(entry){waiting.delete(data.id);data.error?entry.reject(new Error(data.error)):entry.resolve(data.result);}};
worker.onerror=event=>{for(const entry of waiting.values())entry.reject(new Error(event.message));waiting.clear();};
function disk(m){return new Promise((resolve,reject)=>{const request=crypto.randomUUID();waiting.set(request,{resolve,reject});worker.postMessage({...m,request},m.bytes?[m.bytes]:[]);});}
async function exportRecord(record) {
  const root=await navigator.storage.getDirectory(),folder=await root.getDirectoryHandle(record.id),destination=await preference(),exports=[];
  const permitted=destination&&await destination.queryPermission({mode:'readwrite'})==='granted';
  if(destination&&!permitted){const error=new Error('지정 폴더 권한 필요.');error.code='FOLDER_PERMISSION_REQUIRED';throw error;}
  for(const output of record.outputs) {
    const file=await (await folder.getFileHandle(output.name)).getFile();
    if(permitted) {
      let name=output.name,index=1;while(true){try{await destination.getFileHandle(name);name=output.name.replace(/\.(mp4|mkv)$/,'-'+index+++'.$1');}catch(error){if(error.name==='NotFoundError')break;throw error;}}
      const writable=await (await destination.getFileHandle(name,{create:true})).createWritable();await file.stream().pipeTo(writable);exports.push({name,custom:true});
    } else {
      const url=URL.createObjectURL(file),response=await chrome.runtime.sendMessage({target:'background',kind:'download',url,name:output.name});
      if(response.error){URL.revokeObjectURL(url);throw new Error(response.error);}urls.set(response.result.id,url);exports.push({name:output.name,id:response.result.id});
    }
  }
  return {...record,exports};
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(m.target!=='offscreen')return;
  (async()=>{
    if(m.kind==='chunk'){const bytes=Uint8Array.from(atob(m.data),c=>c.charCodeAt(0));return disk({...m,bytes:bytes.buffer});}
    if(m.kind==='finish')return disk(m);
    if(m.kind==='export')return exportRecord(m.record);
    if(m.kind==='release'){const url=urls.get(m.id);if(url){URL.revokeObjectURL(url);urls.delete(m.id);}return {};}
    return disk(m);
  })().then(result=>reply({result})).catch(error=>reply({error:error.message,code:error.code}));return true;
});
