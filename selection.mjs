export function currentSource(sources,tabId){
  return sources.filter(s=>s.tabId===tabId).flatMap(s=>s.groups.filter(g=>g.tracks.some(t=>t.mime.startsWith('video/'))).map(g=>({tabId,frameId:s.frameId,group:g.id,lastReceived:g.lastReceived||0}))).sort((a,b)=>b.lastReceived-a.lastReceived||a.frameId-b.frameId)[0];
}
