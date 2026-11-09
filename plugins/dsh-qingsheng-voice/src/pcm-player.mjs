import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseWave} from './voices.mjs';
const rates = new Set([16000,22050,24000,44100,48000]);

// One logical PCM stream on a reusable helper process. Every command and event
// carries its stream identity, so an old position/done cannot settle a new one.
class PlaybackStream {
  constructor(player,id,sampleRate,signal,onProgress){
    this.player=player;this.id=id;this.sampleRate=sampleRate;this.signal=signal;this.onProgress=onProgress;
    this.bytes=0;this.position=0;this.paused=false;this.done=false;this.finishing=false;this.failure=null;this.begun=false;
    this.finished=new Promise(resolve=>{this.onFinish=resolve;});
  }
  _check(){this.signal.throwIfAborted();if(this.done)throw this.failure||Error('这段声音已结束。');}
  async writePCM(bytes){
    this._check();await this.ready;this._check();
    // 前瞻缓冲从 6 秒收到 2.5 秒：6 秒意味着整段回复可以提前塞进声卡队列，
    // 合成只要比播放快就一路压进来，段间那点换气缝被彻底吃掉，
    // 听感变成「上一句还没说完下一句就响」。2.5 秒够抗抖动，又留得住段间间隙。
    while(!this.done&&(this.bytes-this.position)/(this.sampleRate*2)>2.5)await delay(40,undefined,{signal:this.signal});
    this._check();
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length%2)throw Error('PCM 数据无效。');
    // Keep Console.ReadLine JSON commands below its practical line limit.
    for(let off=0;off<bytes.length;off+=8192){
      this._check();const chunk=bytes.subarray(off,off+8192);
      await this.player._sendTo(this.process,{action:'audio',streamId:this.id,data:chunk.toString('base64')});
      this.bytes+=chunk.length;
    }
  }
  pause(){if(this.done)return;this.paused=true;this._command('pause');}
  resume(){if(this.done)return;this.paused=false;this._command('resume');}
  _command(action){this.ready.then(()=>{if(!this.done)return this.player._sendTo(this.process,{action,streamId:this.id});}).catch(()=>{});}
  async finish(){
    await this.ready;
    if(!this.done&&!this.finishing){this.finishing=true;await this.player._sendTo(this.process,{action:'finish',streamId:this.id});}
    if(!this.done)await this.finished;
    if(this.failure)throw this.failure;
  }
  interrupt(reason=Error('声音被打断。')){
    if(this.done)return;
    this.done=true;this.failure=reason;this.finishing=false;
    if(this.begun)this.player._sendTo(this.process,{action:'cut',streamId:this.id}).catch(()=>{});
    this._detach();this.onFinish();
  }
  _aborted(error){if(this.done)return;this.done=true;this.failure=error||Error('声音播放器已退出。');this._detach();this.onFinish();}
  _complete(bytes){if(this.done)return;this.position=bytes;this.done=true;this._detach();this.onFinish();}
  _detach(){this.signal.removeEventListener('abort',this._onAbort);}
  _start(){this._onAbort=()=>this.interrupt(this.signal.reason||Error('声音已停止。'));this.signal.addEventListener('abort',this._onAbort,{once:true});if(this.signal.aborted)this._onAbort();}
}

export class NativePlayer {
  constructor(root,{idleMs=120000}={}){
    this.root=path.resolve(root,'playback');this.idleMs=idleMs;
    this.process=null;this.child=null;this.ready=null;this.current=null;this.failure=null;this.idleTimer=null;this.closed=false;this.sequence=0;
  }
  // Starts only the audio helper/device, without opening a logical utterance or
  // sending PCM. Call when a voice call starts, overlapping model/ASR latency.
  async warm(sampleRate=24000,signal){
    signal?.throwIfAborted();
    if(this.current&&!this.current.done&&this.current.sampleRate!==sampleRate)return{ready:false,reason:'busy-sample-rate'};
    const pending=this._ensure(sampleRate);const state=this.process;await pending;signal?.throwIfAborted();this._touch();
    return{ready:true,pid:state.child.pid,sampleRate:state.sampleRate};
  }
  createStream(sampleRate,signal=new AbortController().signal,onProgress=()=>{}){
    signal.throwIfAborted();
    if(!rates.has(sampleRate))throw Error('不支持的音频采样率。');
    if(this.closed)throw Error('声音播放器已关闭。');
    if(this.current&&!this.current.done)this.current.interrupt(Error('被新的朗读替换。'));
    const stream=new PlaybackStream(this,String(++this.sequence),sampleRate,signal,onProgress);
    this.current=stream;stream._start();
    const pending=this._ensure(sampleRate);stream.process=this.process;
    stream.ready=pending.then(async()=>{
      stream._check();
      if(stream.process!==this.process)throw Error('声音播放器已更换。');
      // Mark first: an abort while the write callback is pending must queue cut
      // after begin, rather than leave an unowned logical stream in the helper.
      stream.begun=true;
      await this._sendTo(stream.process,{action:'begin',streamId:stream.id});
      stream._check();
    }).catch(error=>{stream._aborted(error);throw error;});
    stream.ready.catch(()=>{});this._touch();return stream;
  }
  _ensure(sampleRate){
    if(this.closed)return Promise.reject(Error('声音播放器已关闭。'));
    if(!rates.has(sampleRate))return Promise.reject(Error('不支持的音频采样率。'));
    // A spawned child is not yet a ready child. Share this exact Promise through
    // mkdir, PowerShell initialization, Add-Type and the first ready handshake.
    if(this.process?.sampleRate===sampleRate)return this.process.ready;
    if(this.process)this._retire(this.process,Error('音频采样率改变。'));
    const state={sampleRate,child:null,pending:'',stderr:'',settled:false,retired:false};
    state.ready=new Promise((resolve,reject)=>{state.resolve=resolve;state.reject=reject;});
    state.ready.catch(()=>{});this.process=state;this.ready=state.ready;this.failure=null;
    void this._launch(state);return state.ready;
  }
  async _launch(state){
    try{
      await mkdir(this.root,{recursive:true});
      if(state!==this.process||state.retired||this.closed)throw Error('声音播放器启动已取消。');
      const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./stream.ps1',import.meta.url))],{windowsHide:true,env:{...process.env,TEMP:this.root,TMP:this.root},stdio:['pipe','pipe','pipe']});
      state.child=child;this.child=child;
      state.timer=setTimeout(()=>this._died(state,Error('声音播放器启动超时。')),20000);state.timer.unref?.();
      child.stderr.on('data',b=>{state.stderr=(state.stderr+b.toString()).slice(-2000);});
      child.stdout.on('data',b=>{
        if(state!==this.process||state.retired)return;
        state.pending+=b.toString();let index;
        while((index=state.pending.indexOf('\n'))>=0){
          const line=state.pending.slice(0,index).trim();state.pending=state.pending.slice(index+1);if(!line)continue;
          try{this._event(state,JSON.parse(line));}catch{}
        }
      });
      child.stdin.on('error',()=>{});
      child.on('error',error=>this._died(state,error));
      child.on('close',code=>this._died(state,Error(state.stderr||'声音播放器退出（'+code+'）。')));
      // The first line is the process configuration, not an utterance command.
      await this._sendTo(state,{sampleRate:state.sampleRate,cacheRoot:this.root});
    }catch(error){this._died(state,error);}
  }
  _event(state,event){
    if(state!==this.process||state.retired)return;
    if(event.type==='ready'){
      if(!state.settled){state.settled=true;clearTimeout(state.timer);state.resolve();}return;
    }
    const stream=this.current;
    if(!stream||stream.done||stream.process!==state||String(event.streamId)!==stream.id)return;
    if(event.type==='position'){
      const bytes=Number(event.bytes);if(!Number.isSafeInteger(bytes)||bytes<0)return;
      stream.position=Math.min(bytes,stream.bytes);try{stream.onProgress(stream.position/(stream.sampleRate*2));}catch{}
    }else if(event.type==='done'&&stream.finishing){stream._complete(stream.bytes);}
    else if(event.type==='error'){stream._aborted(Error(event.message||'声音播放失败。'));}
  }
  _died(state,error){
    // Retiring process A must never clear or reject the readiness/current stream
    // of process B, even when A's close callback runs after B is already ready.
    if(state!==this.process||state.retired)return;
    this.failure=error;const stream=this.current;
    this._retire(state,error);
    if(stream?.process===state&&!stream.done)stream._aborted(error);
  }
  _retire(state,error){
    if(state.retired)return;state.retired=true;clearTimeout(state.timer);
    if(!state.settled){state.settled=true;state.reject(error||Error('声音播放器已结束。'));}
    if(state===this.process){this.process=null;this.child=null;this.ready=null;clearTimeout(this.idleTimer);this.idleTimer=null;}
    try{state.child?.stdin.end();}catch{}try{state.child?.kill();}catch{}
  }
  _sendTo(state,value){
    return new Promise((resolve,reject)=>{
      const child=state?.child;
      if(!state||state!==this.process||state.retired||!child?.stdin.writable)return reject(Error('声音播放器未就绪。'));
      this._touch();child.stdin.write(JSON.stringify(value)+'\n',error=>error?reject(error):resolve());
    });
  }
  send(value){return this._sendTo(this.process,value);}
  _touch(){clearTimeout(this.idleTimer);this.idleTimer=null;if(this.idleMs>0){this.idleTimer=setTimeout(()=>this._recycle(),this.idleMs);this.idleTimer.unref?.();}}
  _recycle(){if(this.closed||!this.process)return;if(this.current&&!this.current.done){this._touch();return;}this._retire(this.process);}
  get failureMessage(){return this.failure;}
  interrupt(reason){if(!this.current||this.current.done)return false;this.current.interrupt(reason||Error('声音被打断。'));return true;}
  get speaking(){return !!(this.current&&!this.current.done);}
  async dispose(){this.closed=true;clearTimeout(this.idleTimer);this.idleTimer=null;if(this.current&&!this.current.done)this.current.interrupt(Error('语音插件已卸载。'));if(this.process)this._retire(this.process);}
  async play(bytes,signal){const audio=parseWave(bytes),stream=this.createStream(audio.sampleRate,signal);await stream.writePCM(audio.pcm);await stream.finish();}
}
