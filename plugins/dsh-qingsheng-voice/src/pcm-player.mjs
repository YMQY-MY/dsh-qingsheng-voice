import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseWave} from './voices.mjs';
const newline=String.fromCharCode(10);
// 一条音频流：常驻播放子进程里的一次「朗读会话」。
// 以前每次 speak 都 spawn 一个新进程（PowerShell 启动 + Add-Type 编译就是几百毫秒），
// 通话场景一句接一句时延迟和资源都受不了。现在进程由 NativePlayer 持有并复用，
// 打断只发 cut 把队列清空，进程继续待命等下一句。
class PlaybackStream {
  constructor(player,sampleRate,signal,onProgress){
    this.player=player;this.sampleRate=sampleRate;this.signal=signal;this.onProgress=onProgress;
    this.bytes=0;this.position=0;this.paused=false;this.done=false;this.finishing=false;this.failure=null;
    this.onFinish=null;this.finished=new Promise(resolve=>{this.onFinish=resolve;});
    this.ready=Promise.resolve();
  }
  async writePCM(bytes){
    this.signal.throwIfAborted();
    if(this.done)throw this.failure||Error('这段声音已结束。');
    await this.ready;
    // 背压：落后太多就不再往里塞，避免整段音频堆在进程内存里（打断时也就更干脆）。
    while(!this.done&&(this.bytes-this.position)/(this.sampleRate*2)>6){await delay(40,undefined,{signal:this.signal});}
    this.signal.throwIfAborted();
    if(this.done)throw this.failure||Error('这段声音已结束。');
    this.bytes+=bytes.length;
    // 子进程用 Console.ReadLine() 逐行读命令，单行过长（base64 膨胀 4/3）会让整条命令解析失败、
    // 这块音频被静默丢掉。按 8KB 原始字节切开发送，保证每行远低于行长度上限。
    const slice=8192;
    for(let off=0;off<bytes.length;off+=slice){
      if(this.done)throw this.failure||Error('这段声音已结束。');
      await this.player.send({action:'audio',data:bytes.subarray(off,off+slice).toString('base64')});
    }
  }
  pause(){if(this.done)return;this.paused=true;this.player.send({action:'pause'}).catch(()=>{});}
  resume(){if(this.done)return;this.paused=false;this.player.send({action:'resume'}).catch(()=>{});}
  async finish(){if(this.done)return;this.finishing=true;await this.player.send({action:'finish'});return this.finished;}
  // 被打断：让子进程把还没播的缓冲全部丢掉，然后继续待命。不销毁进程。
  interrupt(reason=Error('声音被打断。')){
    if(this.done)return;
    this.done=true;this.failure=reason;this.finishing=false;
    try{this.player.send({action:'cut'}).catch(()=>{});}catch{}
    this.onFinish();
    this._detach();
  }
  // 播放器进程退出：把这一段标为失败，避免调用方永远等下去。
  _aborted(error){
    if(this.done)return;
    this.done=true;this.failure=error||Error('声音播放器已退出。');this.onFinish();this._detach();
  }
  _detach(){try{this.signal.removeEventListener('abort',this._onAbort);}catch{}}
  _start(signal){this._onAbort=()=>this.interrupt(signal.reason||Error('声音已停止。'));signal.addEventListener('abort',this._onAbort,{once:true});if(signal.aborted)this._onAbort();}
}
export class NativePlayer {
  constructor(root,{idleMs=120000}={}){
    this.root=path.resolve(root,'playback');
    this.idleMs=idleMs;this.child=null;this.ready=null;this.readiness=null;this.current=null;this.failure=null;this.idleTimer=null;this.closed=false;this.recycling=false;
  }
  _fail(error){
    const reject=this.readiness;this.readiness=null;this.ready=null;
    try{reject?.(error);}catch{}
  }
  // 懒启动：第一次真正要出声时才起进程，之后一直复用，直到空闲超时或插件卸载。
  createStream(sampleRate,signal,onProgress=()=>{}){
    signal.throwIfAborted();
    const stream=new PlaybackStream(this,sampleRate,signal,onProgress);
    stream._start(signal);
    // 同一时刻只有一段在播：上一段还没结束就打断它，避免两路音频叠在一起。
    if(this.current&&!this.current.done)this.current.interrupt(Error('被新的朗读替换。'));
    this.current=stream;
    stream.ready=this._ensure(sampleRate).catch(error=>{stream._aborted(error);throw error;});
    stream.ready.catch(()=>{});
    this._touch();
    return stream;
  }
  _ensure(sampleRate){
    if(this.child)return Promise.resolve();
    if(this.readiness)return this.readiness;
    const started=new Promise((resolve,reject)=>{
      this.readiness=reject;
      (async()=>{
        await mkdir(this.root,{recursive:true});
        if(this.closed)throw Error('声音播放器已关闭。');
        const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./stream.ps1',import.meta.url))],{windowsHide:true,env:{...process.env,TEMP:this.root,TMP:this.root},stdio:['pipe','pipe','pipe']});
        this.child=child;this.failure=null;
        let pending='',error='',everReady=false;
        const timer=setTimeout(()=>this._fail(Error('声音播放器启动超时。')),20000);
        child.stderr.on('data',b=>{error=(error+b.toString()).slice(-2000);});
        child.stdout.on('data',b=>{
          pending+=b.toString();let i;
          while((i=pending.indexOf(newline))>=0){
            const line=pending.slice(0,i).trim();pending=pending.slice(i+1);if(!line)continue;
            let event;try{event=JSON.parse(line);}catch{continue;}
            if(event.type==='ready'){if(everReady)continue;everReady=true;clearTimeout(timer);this.readiness=null;resolve();continue;}
            if(event.type==='done'){
              const stream=this.current;
              if(stream&&!stream.done&&stream.finishing){stream.done=true;stream.onFinish();}
              continue;
            }
            if(event.type==='position'){
              const stream=this.current;if(!stream||stream.done)continue;
              stream.position=event.bytes;
              try{stream.onProgress(stream.position/(stream.sampleRate*2));}catch{}
            }
          }
        });
        child.stdin.on('error',()=>{});
        child.on('error',e=>{clearTimeout(timer);this._fail(Error(e.message));this._died(Error(e.message));});
        child.on('close',code=>{clearTimeout(timer);this._fail(Error(error||'声音播放器提前退出。'));this._died(Error(error||('声音播放器退出（'+code+'）。')));});
        await this.send({sampleRate,cacheRoot:this.root});
      })().catch(error=>this._fail(error));
    });
    this.ready=started;
    started.catch(()=>{this.ready=null;});
    return started;
  }
  _died(error){
    this.child=null;this.ready=null;
    clearTimeout(this.idleTimer);this.idleTimer=null;
    // 空闲回收是我们自己主动结束的，不算故障，下次按需重启即可。
    if(this.recycling){this.recycling=false;this.failure=null;return;}
    this.failure=error;
    const stream=this.current;this.current=null;
    if(stream&&!stream.done)stream._aborted(error);
  }
  send(value){
    return new Promise((resolve,reject)=>{
      const child=this.child;
      if(!child||!child.stdin.writable)return reject(Error('声音播放器未就绪。'));
      this._touch();
      child.stdin.write(JSON.stringify(value)+newline,e=>e?reject(e):resolve());
    });
  }
  _touch(){
    clearTimeout(this.idleTimer);this.idleTimer=null;
    if(this.idleMs>0){this.idleTimer=setTimeout(()=>this._recycle(),this.idleMs);this.idleTimer.unref?.();}
  }
  _recycle(){
    if(this.closed||!this.child)return;
    if(this.current&&!this.current.done)return this._touch();
    this.recycling=true;this._kill();
  }
  _kill(){const child=this.child;this.child=null;this.ready=null;this.readiness=null;try{child?.stdin.end();}catch{}try{child?.kill();}catch{}}
  get failureMessage(){return this.failure;}
  // 立即打断当前朗读（不销毁进程），通话里「听到用户开口就住口」用它。
  interrupt(reason){const stream=this.current;if(!stream||stream.done)return false;stream.interrupt(reason||Error('声音被打断。'));return true;}
  get speaking(){return !!(this.current&&!this.current.done);}
  // 插件卸载时调用，别留下孤儿 PowerShell 进程。
  async dispose(){this.closed=true;clearTimeout(this.idleTimer);this.idleTimer=null;if(this.current&&!this.current.done)this.current.interrupt(Error('语音插件已卸载。'));this._kill();}
  async play(bytes,signal){const audio=parseWave(bytes),stream=this.createStream(audio.sampleRate,signal);await stream.writePCM(audio.pcm);await stream.finish();}
}
