(() => {
  const channel='local-media-recorder';let active=null;
  const post=m=>window.postMessage({channel,direction:'bridge',...m},'*');
  async function send(m){const response=await chrome.runtime.sendMessage(m);if(response?.error)throw new Error(response.error);return response?.result;}
  function transportFailure(error,session=active){
    const message=String(error.message||error);active=null;window.removeEventListener('message',receive);
    post({kind:'disconnect',message});
    if(/Extension context invalidated/i.test(message)){console.warn('확장 연결이 무효화됨. 재생 탭을 새로고침해야 다시 녹화할 수 있음. '+message);return;}
    if(session)send({kind:'capture-error',session,message}).catch(saveError=>console.error(message+' / 중단 상태 전달 실패: '+saveError.message));
    else console.error(message);
  }
  try{
    chrome.runtime.onMessage.addListener((m,sender,reply)=>{
      if(m.target!=='bridge')return;
      if(m.kind==='probe'){reply({ok:true,session:active});return;}
      if(m.kind==='start')active=m.session.id;
      post(m);reply({ok:true});
    });
  }catch(error){transportFailure(error);return;}
  async function receive(event){
    const m=event.data;if(event.source!==window||m?.channel!==channel||m.direction!=='capture')return;
    if(m.kind==='inventory'&&Array.isArray(m.groups)&&m.groups.length<=64){const groups=m.groups.filter(g=>g&&/^\d+$/.test(g.id)&&Array.isArray(g.tracks)&&g.tracks.length<=16).map(g=>({id:g.id,lastReceived:Number.isFinite(g.lastReceived)?g.lastReceived:0,tracks:g.tracks.filter(t=>t&&/^\d+$/.test(t.id)&&typeof t.mime==='string'&&t.mime.length<200&&/^(video|audio)\/(mp4|webm)/i.test(t.mime)).map(t=>({id:t.id,mime:t.mime}))}));send({kind:'inventory',groups}).catch(error=>transportFailure(error));return;}
    if(!active||m.session?.id!==active)return;
    if(m.kind==='stopped'){const session=active;active=null;send({kind:'stopped',session}).catch(error=>transportFailure(error,session));return;}
    if(m.kind==='error'){const session=active;active=null;send({kind:'capture-error',session,message:String(m.message).slice(0,500)}).catch(error=>transportFailure(error,session));return;}
    if(m.kind==='chunk'&&typeof m.data==='string'&&m.data.length<=262144&&/^[\w-]+$/.test(m.track)){
      try{await send({kind:'chunk',session:active,track:m.track,group:/^\d+$/.test(m.group)?m.group:undefined,mime:m.mime,data:m.data});post({kind:'ack',id:m.id});}
      catch(error){post({kind:'ack',id:m.id,error:error.message});transportFailure(error,m.session.id);}
    }
  }
  window.addEventListener('message',receive);
  post({kind:'inventory'});
})();
