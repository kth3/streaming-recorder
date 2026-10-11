import {Input,BlobSource,ALL_FORMATS,EncodedPacketSink,EncodedVideoPacketSource,EncodedAudioPacketSource,Output,Mp4OutputFormat,MkvOutputFormat,StreamTarget} from './vendor/mediabunny.mjs';

export async function remux(blobs, openTarget, groups=[]) {
  const inputs=blobs.map(blob=>new Input({source:new BlobSource(blob),formats:ALL_FORMATS}));
  const tracks=[];
  try {
    for(const input of inputs) for(const track of await input.getTracks()) {
      if(track.type!=='video'&&track.type!=='audio')continue;
      const sink=new EncodedPacketSink(track),first=track.type==='video'?await sink.getFirstKeyPacket({verifyKeyPackets:true}):await sink.getFirstPacket();
      if(first) tracks.push({track,sink,first,end:await track.computeDuration(),config:await track.getDecoderConfig()});
    }
    const videos=tracks.filter(t=>t.track.type==='video'),audios=tracks.filter(t=>t.track.type==='audio');
    if(!videos.length)throw new Error('독립 재생 가능한 영상 키프레임이 없어 파일을 저장할 수 없음.');
    const jobs=[];
    for(const video of videos) {
      const group=groups[inputs.indexOf(video.track.input)],related=group===undefined?audios:audios.filter(a=>groups[inputs.indexOf(a.track.input)]===group);
      const ownAudio=related.filter(a=>a.track.input===video.track.input);
      const audio=ownAudio.length?ownAudio:related.filter(a=>a.end>video.first.timestamp&&a.first.timestamp<video.end).sort((a,b)=>a.first.timestamp-b.first.timestamp);
      if(audio.length>1){
        const ids=audio.map(a=>blobs[inputs.indexOf(a.track.input)].name?.split('-')[0]);
        if(ids.some(id=>!id)||new Set(ids).size!==1)throw new Error('겹치는 음성 트랙을 자동 선택할 수 없음. 원본 데이터를 보존함.');
      }
      if(related.length&&!audio.length)throw new Error('영상에 대응하는 음성 구간이 없음. 원본 데이터를 보존함.');
      if(!audio.length)jobs.push({video,audio:[]});
      for(let i=0;i<audio.length;i++){
        const start=i?Math.max(video.first.timestamp,audio[i].first.timestamp):video.first.timestamp;
        const end=i+1<audio.length?Math.min(video.end,audio[i+1].first.timestamp):video.end;
        let first=video.first;
        if(first.timestamp<start){const previous=await video.sink.getKeyPacket(start,{verifyKeyPackets:true});first=previous?.timestamp>=start?previous:previous?await video.sink.getNextKeyPacket(previous,{verifyKeyPackets:true}):await video.sink.getFirstKeyPacket({verifyKeyPackets:true});}
        if(first&&first.timestamp<end)jobs.push({video:{...video,first,end},audio:[audio[i]]});
      }
    }
    const signature=job=>JSON.stringify([job.video,...job.audio].map(t=>({codec:t.track.codec,config:t.config})),(key,value)=>value instanceof ArrayBuffer?Array.from(new Uint8Array(value)):ArrayBuffer.isView(value)?Array.from(new Uint8Array(value.buffer,value.byteOffset,value.byteLength)):value);
    if(!jobs.length)throw new Error('저장할 영상 구간이 없음.');
    const batches=[];
    for(const job of jobs){const key=signature(job),last=batches.at(-1);if(last?.key===key)last.jobs.push(job);else batches.push({key,jobs:[job]});}
    const outputs=[];
    for(const [part,batch] of batches.entries()){
    const selected=[batch.jobs[0].video,...batch.jobs[0].audio],format=selected.every(t=>['avc','hevc','aac','opus','vp8','vp9','av1','mp3'].includes(t.track.codec))?'mp4':'mkv';
    const target=await openTarget(part,format);
    const output=new Output({format:format==='mp4'?new Mp4OutputFormat({fastStart:false}):new MkvOutputFormat(),target:new StreamTarget(target.stream)});
    const packetSources=selected.map(entry=>{const source=entry.track.type==='video'?new EncodedVideoPacketSource(entry.track.codec):new EncodedAudioPacketSource(entry.track.codec);entry.track.type==='video'?output.addVideoTrack(source):output.addAudioTrack(source);return source;});
    await output.start();let packets=0,offset=0;
    for(const {video,audio} of batch.jobs) {
      const readers=[];
      for(const [trackIndex,entry] of [video,...audio].entries()) {
        const source=packetSources[trackIndex];
        const iterator=entry.sink.packets(entry.first)[Symbol.asyncIterator]();
        let next=await iterator.next();
        if(entry.track.type==='audio')while(!next.done&&next.value.timestamp<video.first.timestamp-0.05)next=await iterator.next();
        readers.push({entry,source,iterator,next,initial:true});
      }
      const base=Math.min(...readers.filter(r=>!r.next.done).map(r=>r.next.value.timestamp));
      let end=offset;
      while(readers.some(r=>!r.next.done)) {
        const ready=readers.filter(r=>!r.next.done).sort((a,b)=>a.next.value.timestamp-b.next.value.timestamp),r=ready[0],p=r.next.value;
        if(p.timestamp>=video.end){r.next={done:true};continue;}
        const timestamp=p.timestamp-base+offset;
        await r.source.add(p.clone({timestamp}),r.initial?{decoderConfig:r.entry.config}:undefined);
        end=Math.max(end,timestamp+p.duration);r.initial=false;packets++;r.next=await r.iterator.next();
      }
      offset=end;
    }
    for(const source of packetSources)source.close();await output.finalize();
    outputs.push({name:target.name,format,packets,trimmedStart:batch.jobs[0].video.first.timestamp});
    }
    return outputs;
  } finally {for(const input of inputs)input.dispose();}
}
