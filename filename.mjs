export function recordingName(title,createdAt,index,format) {
  const chars=Array.from(String(title||'').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\\/:*?"<>|]/g,' ').replace(/\s+/g,' ').trim().replace(/^[. ]+|[. ]+$/g,''));
  const encoder=new TextEncoder();while(encoder.encode(chars.join('')).length>150)chars.pop();
  const titlePart=chars.join('').replace(/[. ]+$/g,'')||'recording';
  return titlePart+'-'+createdAt.replace(/[:.]/g,'-')+(index?'-part-'+(index+1):'')+'.'+format;
}
