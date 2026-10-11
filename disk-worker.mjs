import {remux} from './mux.mjs';
import {recordingName} from './filename.mjs';
let root,folder,record,handles=new Map();
async function journal() {
  const file=await folder.getFileHandle('state.json',{create:true}),h=await file.createSyncAccessHandle();
  const bytes=new TextEncoder().encode(JSON.stringify(record));h.truncate(0);h.write(bytes);h.flush();h.close();
}
async function closeHandles(){for(const h of handles.values()){h.flush();h.close();}handles.clear();}
async function operate(m) {
  root??=await navigator.storage.getDirectory();
  if(m.kind==='start') {
    folder=await root.getDirectoryHandle(m.session.id,{create:true});record={id:m.session.id,title:m.session.title||'',status:'recording',createdAt:m.session.createdAt||new Date().toISOString(),bytes:0,tracks:{},outputs:[]};await journal();return record;
  }
  if(m.kind==='chunk') {
    if(record?.id!==m.session||record.status!=='recording')throw new Error('녹화 세션이 활성 상태가 아님.');
    let track=record.tracks[m.track];
    if(!track){track=record.tracks[m.track]={file:m.track+'.media',mime:m.mime,group:m.group,bytes:0};const f=await folder.getFileHandle(track.file,{create:true});handles.set(m.track,await f.createSyncAccessHandle());}
    const bytes=new Uint8Array(m.bytes),h=handles.get(m.track);let written=0;
    while(written<bytes.length){const count=h.write(bytes.subarray(written),{at:track.bytes+written});if(!count)throw new Error('디스크 쓰기가 진행되지 않음.');written+=count;}
    h.flush();track.bytes+=written;record.bytes+=written;await journal();return {bytes:record.bytes};
  }
  if(m.kind==='fail'){record.status='terminal_failure';record.error=m.message;await closeHandles();await journal();return record;}
  if(m.kind==='finish') {
    await closeHandles();record.status='finalizing';await journal();
    const blobs=[],groups=[];for(const t of Object.values(record.tracks))if(t.bytes){blobs.push(await (await folder.getFileHandle(t.file)).getFile());groups.push(t.group);}
    record.outputs=await remux(blobs,async(index,format)=>{
      const name=recordingName(record.title,record.createdAt,index,format);
      const f=await folder.getFileHandle(name,{create:true}),h=await f.createSyncAccessHandle();h.truncate(0);handles.set('output:'+name,h);
      return {name,stream:new WritableStream({write(chunk){let offset=0;while(offset<chunk.data.length){const count=h.write(chunk.data.subarray(offset),{at:chunk.position+offset});if(!count)throw new Error('디스크 쓰기 중단.');offset+=count;}h.flush();},close(){h.flush();h.close();handles.delete('output:'+name);},abort(){h.close();handles.delete('output:'+name);}})};
    },groups);
    record.status='ready';await journal();return record;
  }
  if(m.kind==='current')return record||null;
  throw new Error('알 수 없는 저장 명령.');
}
let queue=Promise.resolve();
onmessage=event=>{
  const m=event.data;
  queue=queue.then(async()=>{
    try{postMessage({id:m.request,result:await operate(m)});}
    catch(error){let journalError;try{if(record){record.status='terminal_failure';record.error=error.message;await closeHandles();await journal();}}catch(e){journalError=e.message;}
      postMessage({id:m.request,error:error.message+(journalError?' / 상태 저장 실패: '+journalError:'')});}
  });
};
