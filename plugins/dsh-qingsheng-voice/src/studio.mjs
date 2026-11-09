import { setTimeout as delay } from 'node:timers/promises';
import {VoiceLibrary} from './library.mjs';
import {safeVoice} from './voices.mjs';
import {deliveryInstruction} from './delivery.mjs';
export class StudioClient extends VoiceLibrary {
  constructor(base = 'http://127.0.0.1:3210', fetcher = fetch) {
    super();
    const url = new URL(base);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('清声地址必须是本机 HTTP 地址。');
    this.base = url.origin; this.fetch = fetcher;
  }
  async request(route, body, signal, timeout = 15000, method='POST') {
    const response = await this.fetch(this.base + route, {
      signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
      redirect: 'error',
      ...(body === undefined ? {} : {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)})
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || '清声接口调用失败。');
    return value;
  }
  async state(signal) {
    const value = await this.request('/api/state', undefined, signal);
    return {capabilities:value.capabilities||{},engine:value.engine, recognition:value.recognition, voices:value.voices.map(safeVoice)};
  }
  cancel(id) { return this.request('/api/jobs/' + id + '/cancel', {}).catch(() => {}); }
  async audio(id, signal) {
    if (!/^[a-f0-9-]+$/.test(id)) throw Error('音频任务无效。');
    const r = await this.fetch(this.base + '/media/audio/' + id + '.wav', {signal, redirect:'error'});
    if (!r.ok || Number(r.headers.get('content-length') || 0) > 40 * 1024 * 1024) throw Error('生成音频读取失败。');
    const buffer = Buffer.from(await r.arrayBuffer());
    if (buffer.length > 40 * 1024 * 1024 || buffer.toString('ascii',0,4) !== 'RIFF') throw Error('生成音频格式无效。');
    return buffer;
  }
  async synthesize(text, voiceId, signal, onJob = () => {}, options={}) {
    const state = options.state || await this.state(signal), voice = options.voice || state.voices.find(v => v.id === voiceId) || state.voices[0];
    if (!voice) throw Error('清声音色库为空。');
    if (!state.engine?.ready) throw Error('清声引擎尚未就绪，请先在工作台加载模型。');
    signal.throwIfAborted();
    // Retain the returned id even when Stop races with job admission.
    const reference=options.reference;
    const hasReference=!!reference||voice.kind==='reference',steady=options.delivery==='steady',strategy=options.voiceStrategy||'clone';
    const useRef=strategy==='clone'&&hasReference;
    // 已确认 Breeze 在 clone 模式下也接受 instruction：走 clone 既锁住参考声纹又能带情绪，
    // 不要再为了表达而切到 direction——那会把声纹重新造一遍。
    // 2026-11-04 实测：同一参考音频下无指令 2.96s / 情绪指令 3.52s，音高方差与过零率同步分开，
    // 且同组两次逐位一致。因此只要有 direction 就发出去，不再限制在 steady 档；steady 档额外把 cfg 调到 1。
    const job = await this.request('/api/jobs', {text, voiceId:voice.id, seed:voice.seed??42, mode:useRef?'clone':'design',...((options.direction||steady)?{cfg:state.engine.kind==='breeze'?1:3,direction:options.direction||deliveryInstruction}:{}),...((useRef&&reference)?{reference:reference.reference,transcript:reference.transcript}:{})});
    onJob(job.id);
    try {
      signal.throwIfAborted();
      if(options.onChunk) {
        const current=await this.streamJob(job.id,signal,options.onChunk);
        if(current.status!=='completed')throw Error(current.error||'生成已取消。');
        if(options.onReference&&voice.kind!=='reference'&&!reference){const locked=await this.request('/api/jobs/'+job.id+'/reference',{},signal);await options.onReference(locked);}
        return null;
      }
      const deadline = Date.now() + 240000;
      for (;;) {
        signal.throwIfAborted();
        const current = await this.request('/api/jobs/' + job.id, undefined, signal);
        if (current.status === 'completed') {
          if(options.onReference&&voice.kind!=='reference'&&!reference){const locked=await this.request('/api/jobs/'+job.id+'/reference',{},signal);await options.onReference(locked);}
          return await this.audio(job.id, signal);
        }
        if (['failed','cancelled'].includes(current.status)) throw Error(current.error || '生成已取消。');
        if (Date.now() > deadline) throw Error('声音生成超时。');
        await delay(250, undefined, {signal});
      }
    } finally { await this.cancel(job.id); onJob(null); }
  }
  async streamJob(id,signal,onChunk) {
    const idle=new AbortController(),streamSignal=AbortSignal.any([signal,idle.signal]);
    // Only time out while waiting on the network, never while the user has paused playback.
    const waiting=async promise=>{const timer=setTimeout(()=>idle.abort(Error('声音分片等待超时。')),240000);try{return await promise;}finally{clearTimeout(timer);}};
    const response=await waiting(this.fetch(this.base+'/api/jobs/'+id+'/events',{signal:streamSignal,redirect:'error'}));
    if(!response.ok)throw Error('无法连接声音分片。');
    const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',total=0;
    try {
      for(;;){
        const {value,done}=await waiting(reader.read());if(done)break;pending+=decoder.decode(value,{stream:true});
        if(pending.length>16*1024*1024)throw Error('声音分片过大。');
        let split;while((split=pending.indexOf('\n\n'))>=0){
          const block=pending.slice(0,split);pending=pending.slice(split+2);
          if(!block.startsWith('data: '))continue;const event=JSON.parse(block.slice(6));
          if(event.type==='audio'){
            const bytes=Buffer.from(event.data,'base64');total+=bytes.length;
            if(!bytes.length||bytes.length%2||total>40*1024*1024||![16000,22050,24000,44100,48000].includes(event.sampleRate))throw Error('声音分片格式无效。');
            await onChunk(bytes,event.sampleRate);
          }
          if(event.type==='done'){
            if(!total&&event.job.status==='completed'){const bytes=await this.audio(id,signal);const {parseWave}=await import('./voices.mjs');const audio=parseWave(bytes);await onChunk(audio.pcm,audio.sampleRate);}
            return event.job;
          }
        }
      }throw Error('声音流提前结束，请重试。');
    }finally{await reader.cancel().catch(()=>{});}
  }
  async transcribe(base64, signal) {
    if (typeof base64 !== 'string' || base64.length > 2800000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw Error('录音无效，最多录制 60 秒。');
    const recording = await this.request('/api/recordings', {base64}, signal);
    signal?.throwIfAborted();
    return await this.request('/api/transcribe', {recording:recording.id}, signal, 185000);
  }
}
