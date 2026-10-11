(() => {
  'use strict';
  const channel='local-media-recorder', groups=new Map(), buffers=new WeakMap(), sources=new WeakMap();
  let serial=0, session=null, player=null, queue=Promise.resolve(), pending=0, draining=0;
  const send=m=>window.postMessage({channel,direction:'capture',...m},'*');
  const inventory=()=>send({kind:'inventory',groups:[...groups.values()].map(g=>({id:g.id,lastReceived:g.lastReceived||0,tracks:g.tracks.map(t=>({id:t.id,mime:t.mime}))}))});
  const encrypted=()=>[...document.querySelectorAll('video,audio')].some(v=>v.mediaKeys);
  function fail(message) { if(session) {send({kind:'error',session,message});session=null;} }
  document.addEventListener('encrypted',()=>fail('암호화 영상은 녹화할 수 없음.'),true);
  function group(source) {let g=sources.get(source);if(!g){g={id:String(++serial),tracks:[]};sources.set(source,g);groups.set(g.id,g);}return g;}
  function init(bytes,mime) {
    if(mime.includes('webm')) {
      if(bytes.length<4 || bytes[0]!==0x1a || bytes[1]!==0x45 || bytes[2]!==0xdf || bytes[3]!==0xa3) return null;
      for(let i=4;i+4<=bytes.length;i++) if(bytes[i]===0x1f && bytes[i+1]===0x43 && bytes[i+2]===0xb6 && bytes[i+3]===0x75) return bytes.slice(0,i);
      return bytes.slice();
    }
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let offset=0;
    while(offset+8<=bytes.length) {
      const size=view.getUint32(offset),type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
      if(size<8 || offset+size>bytes.length) return null;
      if(type==='moov') return bytes.slice(0,offset+size);
      if(!['ftyp','free'].includes(type)) return null;offset+=size;
    }
    return null;
  }
  function emit(track,bytes,owner) {
    const identity=track.id+'-'+track.version,mime=track.mime,source=track.group;
    if(pending+bytes.length>64*1048576) {fail('디스크 전달 지연으로 녹화를 중단함.');return;}
    pending+=bytes.length;
    queue=queue.then(async()=>{
      for(let offset=0;offset<bytes.length;offset+=196608) {
        const part=bytes.subarray(offset,offset+196608);let text='';
        for(let i=0;i<part.length;i+=8192) text+=String.fromCharCode(...part.subarray(i,i+8192));
        const id=crypto.randomUUID();
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{window.removeEventListener('message',ack);reject(new Error('로컬 저장 응답 시간 초과.'));},30000);
          function ack(event) {
            if(event.source!==window || event.data?.channel!==channel || event.data.direction!=='bridge' || event.data.kind!=='ack' || event.data.id!==id) return;
            clearTimeout(timer);window.removeEventListener('message',ack);
            event.data.error?reject(new Error(event.data.error)):resolve();
          }
          window.addEventListener('message',ack);
          send({kind:'chunk',session:owner,id,track:identity,group:source,mime,data:btoa(text)});
        });
      }
    }).catch(error=>fail(error.message)).finally(()=>{pending-=bytes.length;});
  }
  if(window.MediaSource && window.SourceBuffer) {
    const add=MediaSource.prototype.addSourceBuffer,append=SourceBuffer.prototype.appendBuffer;
    MediaSource.prototype.addSourceBuffer=function(mime) {
      const buffer=add.call(this,mime);
      if(/^(video|audio)\/(mp4|webm)\b/i.test(mime)) {
        const g=group(this),t={id:String(++serial),mime,group:g.id,init:null,version:0,started:false,cached:[],cachedBytes:0};buffers.set(buffer,t);g.tracks.push(t);inventory();
      }
      return buffer;
    };
    SourceBuffer.prototype.appendBuffer=function(data) {
      const t=buffers.get(this);if(!t) return append.call(this,data);
      const g=groups.get(t.group),now=Date.now();g.lastReceived=now;if(!g.reported||now-g.reported>1000){g.reported=now;inventory();}
      if(session&&player&&g.url&&(player.currentSrc===g.url||player.src===g.url)&&session.group!==g.id){session={...session,group:g.id};for(const track of g.tracks)track.started=false;}
      let bytes,header;const previous={init:t.init,version:t.version,started:t.started};
      try {
        const view=ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):new Uint8Array(data);
        header=init(view,t.mime);
        if(/^audio\//i.test(t.mime))bytes=view.slice();
        if(header) {
          let text='';for(let i=0;i<header.length;i+=8192)text+=String.fromCharCode(...header.subarray(i,i+8192));
          if(/pssh|tenc|encv|enca/.test(text)){fail('암호화 데이터는 녹화할 수 없음.');return append.call(this,data);}
          if(t.started){t.version++;t.started=false;}t.init=header;
        }
        if(session && t.group===session.group) {
          if(encrypted()) fail('암호화 영상은 녹화할 수 없음.');
          else if(!t.init) fail('초기화 데이터가 없음. 영상 탭을 새로고침한 뒤 다시 시작해줘.');
          else bytes=view.slice();
        }
      } catch(error) {fail('수신 데이터 처리 실패: '+error.message);}
      const owner=session&&session.group===t.group?session:null;let result;
      try{result=append.call(this,data);}catch(error){if(header)Object.assign(t,previous);if(!['InvalidStateError','QuotaExceededError'].includes(error.name))fail('플레이어 데이터 입력 실패.');throw error;}
      if(!bytes) return result;
      draining++;let rejected=false;const reject=()=>{rejected=true;};
      this.addEventListener('error',reject);this.addEventListener('abort',reject);
      this.addEventListener('updateend',()=>{
        this.removeEventListener('error',reject);this.removeEventListener('abort',reject);
        if(rejected){if(header)Object.assign(t,previous);}
        else {
          const receiver=owner||session&&session.group===t.group&&session;
          if(receiver){if(!t.started && !header) emit(t,t.init.slice(),receiver);t.started=true;emit(t,bytes,receiver);}
          else if(/^audio\//i.test(t.mime)){
            if(header){t.cached=[];t.cachedBytes=0;}
            const payload=header?bytes.slice(header.length):bytes;
            if(payload.length){t.cached.push(payload);t.cachedBytes+=payload.length;while(t.cachedBytes>16*1048576)t.cachedBytes-=t.cached.shift().length;}
          }
        }
        draining--;
      },{once:true});return result;
    };
    if(SourceBuffer.prototype.changeType) {
      const change=SourceBuffer.prototype.changeType;
      SourceBuffer.prototype.changeType=function(mime) {const result=change.call(this,mime),t=buffers.get(this);if(t){t.version++;t.mime=mime;t.init=null;t.started=false;t.cached=[];t.cachedBytes=0;inventory();}return result;};
    }
  }
  const create=URL.createObjectURL;
  URL.createObjectURL=function(object) {
    const url=create.call(this,object);
    if(window.MediaSource&&object instanceof MediaSource)group(object).url=url;
    if(object instanceof Blob && /^(video|audio)\/(mp4|webm)/i.test(object.type)){const g=group(object);g.blob=object;if(!g.tracks.length)g.tracks.push({id:String(++serial),mime:object.type});inventory();}
    return url;
  };
  window.addEventListener('message',async event=>{
    const m=event.data;if(event.source!==window || m?.channel!==channel || m.direction!=='bridge') return;
    if(m.kind==='disconnect'){fail('확장 연결이 끊어짐: '+m.message);return;}
    if(m.kind==='inventory') inventory();
    if(m.kind==='start') {
      if(session) return;
      if(!groups.has(m.group) || encrypted()){send({kind:'error',session:m.session,message:'선택한 재생 데이터를 수집할 수 없음.'});return;}
      session={id:m.session.id,group:m.group};const g=groups.get(m.group);player=[...document.querySelectorAll('video,audio')].find(v=>g.url&&(v.currentSrc===g.url||v.src===g.url))||null;for(const t of g.tracks)t.started=false;
      for(const t of g.tracks)if(t.init&&t.cached?.length){emit(t,t.init.slice(),session);for(const bytes of t.cached)emit(t,bytes,session);t.started=true;t.cached=[];t.cachedBytes=0;}
      if(g.blob){const owner=session,track={...g.tracks[0],group:g.id,version:0};try{for await(const bytes of g.blob.stream()){if(session!==owner)break;emit(track,bytes,owner);await queue;}}catch(error){fail(error.message);}}
    }
    if(m.kind==='stop'){const owner=session;session=null;while(draining)await new Promise(resolve=>setTimeout(resolve,20));await queue;send({kind:'stopped',session:owner});}
  });
})();
