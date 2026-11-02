import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseWave} from './voices.mjs';
const newline=String.fromCharCode(10);
export class NativePlayer {
  constructor(root){this.root=path.resolve(root,'playback');}
  createStream(sampleRate,signal,onProgress=()=>{}) {
    signal.throwIfAborted();
    let child,resolveReady,rejectReady,resolveDone,rejectDone,done=false,finishing=false,failure;
    const ready=new Promise((r,j)=>{resolveReady=r;rejectReady=j;}),finished=new Promise((r,j)=>{resolveDone=r;rejectDone=j;});
    ready.catch(()=>{});finished.catch(()=>{});
    const session={sampleRate,bytes:0,position:0,paused:false,ready,
      async writePCM(bytes){
        await ready;signal.throwIfAborted();
        while((session.bytes-session.position)/(sampleRate*2)>6){if(done)throw failure||Error('声音播放器已退出。');await delay(40,undefined,{signal});}
        signal.throwIfAborted();session.bytes+=bytes.length;
        // 子进程用 Console.ReadLine() 逐行读命令，单行过长（base64 膨胀 4/3）会让整条命令解析失败、
        // 这块音频被静默丢掉。按 8KB 原始字节切开发送，保证每行远低于行长度上限。
        const slice=8192;
        for(let off=0;off<bytes.length;off+=slice){
          await send({action:'audio',data:bytes.subarray(off,off+slice).toString('base64')});
        }
      },
      pause(){session.paused=true;if(child)send({action:'pause'}).catch(()=>{});},
      resume(){session.paused=false;if(child)send({action:'resume'}).catch(()=>{});},
      async finish(){await ready;finishing=true;await send({action:'finish'});return finished;}
    };
    const send=value=>new Promise((resolve,reject)=>{if(done||!child?.stdin.writable)return reject(Error('声音播放器已退出。'));child.stdin.write(JSON.stringify(value)+newline,e=>e?reject(e):resolve());});
    const complete=error=>{if(done)return;done=true;failure=error;clearTimeout(timer);signal.removeEventListener('abort',cancel);if(error){rejectReady(error);rejectDone(error);}else{resolveReady();resolveDone();}};
    const cancel=()=>{child?.kill();complete(signal.reason||Error('声音已停止。'));};
    const timer=setTimeout(()=>{child?.kill();complete(Error('声音播放器启动超时。'));},20000);
    signal.addEventListener('abort',cancel,{once:true});
    mkdir(this.root,{recursive:true}).then(()=>{
      if(signal.aborted)return cancel();
      child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./stream.ps1',import.meta.url))],{windowsHide:true,env:{...process.env,TEMP:this.root,TMP:this.root},stdio:['pipe','pipe','pipe']});
      let pending='',error='';
      child.stderr.on('data',b=>error=(error+b.toString()).slice(-2000));
      child.stdout.on('data',b=>{
        pending+=b.toString();let i;while((i=pending.indexOf(newline))>=0){const line=pending.slice(0,i).trim();pending=pending.slice(i+1);if(!line)continue;
          try{const event=JSON.parse(line);if(event.type==='ready'){clearTimeout(timer);resolveReady();if(session.paused)send({action:'pause'}).catch(()=>{});}if(event.type==='position'||event.type==='done'){session.position=event.bytes;onProgress(session.position/(sampleRate*2));}}catch{}
        }
      });
      child.stdin.on('error',()=>{});child.on('error',complete);child.on('close',code=>complete(code||!finishing?Error(error||'声音播放器提前退出。'):undefined));
      send({sampleRate,cacheRoot:this.root}).catch(complete);if(signal.aborted)cancel();
    }).catch(complete);
    return session;
  }
  async play(bytes,signal){const audio=parseWave(bytes),stream=this.createStream(audio.sampleRate,signal);await stream.writePCM(audio.pcm);await stream.finish();}
}
