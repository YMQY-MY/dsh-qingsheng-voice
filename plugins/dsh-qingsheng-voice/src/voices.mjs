export function voiceId(value) {
  if(typeof value!=='string'||!/^[a-z0-9-]{1,80}$/.test(value))throw Error('音色标识无效。');
  return value;
}
export function voiceInput(value) {
  if(!value||typeof value!=='object')throw Error('缺少音色设定。');
  const {name,description}=value;
  if(typeof name!=='string'||!name.trim()||name.length>40)throw Error('音色名称需要 1–40 字。');
  if(typeof description!=='string'||!description.trim()||description.length>2000)throw Error('声音描述需要 1–2000 字。');
  const seed=value.seed??42,tags=value.tags??['自定义'],transcript=value.transcript??'';
  if(!Number.isInteger(seed)||seed<0||seed>2147483647)throw Error('随机种子需要 0–2147483647 的整数。');
  if(!Array.isArray(tags)||tags.length>4||tags.some(t=>typeof t!=='string'||!t.trim()||t.length>12))throw Error('最多 4 个标签，每个 1–12 字。');
  if(typeof transcript!=='string'||transcript.length>6000)throw Error('参考文字稿最多 6000 字。');
  return{name:name.trim(),description:description.trim(),seed,tags:tags.map(t=>t.trim()),transcript:transcript.trim()};
}
export function safeVoice(v) {
  return{id:v.id,name:v.name,description:v.description||'',seed:v.seed??42,tags:Array.isArray(v.tags)?v.tags:[],kind:v.reference||v.kind==='reference'?'reference':'design',hasReference:!!v.reference,transcript:v.transcript||''};
}
export function parseWave(bytes) {
  if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw Error('请使用有效的 PCM WAV 音频。');
  let format,pcm;
  for(let offset=12;offset+8<=bytes.length;){
    const name=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8;
    if(start+size>bytes.length)throw Error('音频文件不完整。');
    if(name==='fmt '){if(size<16)throw Error('音频格式无效。');format={encoding:bytes.readUInt16LE(start),channels:bytes.readUInt16LE(start+2),sampleRate:bytes.readUInt32LE(start+4),bits:bytes.readUInt16LE(start+14)};}
    if(name==='data')pcm=bytes.subarray(start,start+size);offset=start+size+(size%2);
  }
  if(!format||format.encoding!==1||format.channels!==1||format.bits!==16||format.sampleRate<8000||format.sampleRate>192000||!pcm?.length||pcm.length%2)throw Error('音频必须为 16 位单声道 PCM WAV。');
  return{pcm,sampleRate:format.sampleRate};
}
export function referenceAudio(base64) {
  if(typeof base64!=='string'||base64.length>5600000||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))throw Error('参考音频无效或超过 4 MB。');
  const bytes=Buffer.from(base64,'base64');if(bytes.length>4*1024*1024)throw Error('参考音频超过 4 MB。');
  const {pcm,sampleRate}=parseWave(bytes),seconds=pcm.length/(sampleRate*2);
  if(seconds<0.3||seconds>60)throw Error('请截取 0.3–60 秒的参考音频。');
  return bytes;
}
