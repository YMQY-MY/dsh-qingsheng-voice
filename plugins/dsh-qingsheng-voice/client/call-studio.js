// 通话界面：内嵌在声音插件里，复用它的工具栏扩展点与 RPC 通道。
// 由 lib/client.js 在加载完成后调用 apply 挂上去。
window.__QingShengCall__ = (function (shared) {
  let require, React;   // 由 apply() 在拿到 shared 后才赋值（脚本加载时 shared 还是空的）
  const RATE = 16000;
  const btnStyle = {font:'inherit',fontSize:12,border:'1px solid #83918a66',borderRadius:7,padding:'5px 8px',background:'transparent',color:'inherit',cursor:'pointer',minHeight:32};

  class Mic {
    constructor(){this.closed=false;}
    async start(){
      if(!navigator.mediaDevices?.getUserMedia) throw Error('此窗口没有麦克风访问能力。');
      this.stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      if(this.closed){this.stream.getTracks().forEach(t=>t.stop());throw Error('已取消。');}
      this.ctx=new AudioContext({sampleRate:RATE});
      await this.ctx.resume();
      if(this.closed) throw Error('已取消。');
      this.source=this.ctx.createMediaStreamSource(this.stream);
      // ScriptProcessor only accepts powers of two from 256 through 16384.
      this.node=this.ctx.createScriptProcessor(1024,1,1);
      this.node.onaudioprocess=e=>{
        e.outputBuffer.getChannelData(0).fill(0);
        if(this.closed) return;
        const frame=e.inputBuffer.getChannelData(0);
        let sum=0;for(let i=0;i<frame.length;i++) sum+=frame[i]*frame[i];
        this.onFrame?.(Math.sqrt(sum/frame.length),frame,frame.length/this.ctx.sampleRate*1000);
      };
      this.source.connect(this.node);this.node.connect(this.ctx.destination);
      this.stream.getAudioTracks().forEach(t=>t.addEventListener('ended',()=>{if(!this.closed)this.onEnded?.();}));
    }
    async dispose(){
      this.closed=true;
      if(this.node)this.node.onaudioprocess=null;
      try{this.node?.disconnect();this.source?.disconnect();}catch{}
      this.stream?.getTracks().forEach(t=>t.stop());
      if(this.ctx&&this.ctx.state!=='closed')await this.ctx.close().catch(()=>{});
    }
  }
  function pcmToWav(samples,rate){
    const bytes=new Uint8Array(44+samples.length*2),v=new DataView(bytes.buffer);
    const str=(o,s)=>[...s].forEach((c,i)=>v.setUint8(o+i,c.charCodeAt(0)));
    str(0,'RIFF');v.setUint32(4,36+samples.length*2,true);str(8,'WAVE');str(12,'fmt ');
    v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);
    v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,samples.length*2,true);
    for(let i=0;i<samples.length;i++){const n=Math.max(-1,Math.min(1,samples[i]));v.setInt16(44+i*2,n<0?n*32768:n*32767,true);}return bytes;
  }
  function b64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
  class Vad {
    constructor(){this.noise=0.004;this.speaking=false;this.silence=0;this.elapsed=0;this.openMs=0;}
    push(level,ms){
      if(!this.speaking)this.noise=this.noise*0.92+Math.min(level,0.025)*0.08;
      const was=this.speaking;
      if(!this.speaking){this.openMs=level>this.noise*3.2?this.openMs+ms:0;if(this.openMs>=100){this.speaking=true;this.silence=0;this.elapsed=ms;this.openMs=0;}}
      else{this.elapsed+=ms;this.silence=level<this.noise*1.9?this.silence+ms:0;if(this.silence>=600||this.elapsed>=20000)this.speaking=false;}
      return {speaking:this.speaking,changed:this.speaking!==was};
    }
  }
  class CallAudio {
    constructor(ctx,ack){this.ctx=ctx;this.ack=ack;this.nodes=new Set();this.blocked=new Set();this.nextAt=0;this.streamId='';this.firstAudioAt=null;this.output=ctx.createGain();this.output.connect(ctx.destination);}
    setMuted(muted){this.output.gain.value=muted?0:1;}
    cut(){
      if(this.streamId)this.blocked.add(this.streamId);
      if(this.blocked.size>100)this.blocked.delete(this.blocked.values().next().value);
      for(const node of this.nodes){node.onended=null;try{node.stop();node.disconnect();}catch{}}
      this.nodes.clear();this.nextAt=0;this.streamId='';
    }
    accept(packet){
      if(packet.event==='cut'){if(packet.streamId===this.streamId)this.cut();return;}
      if(this.blocked.has(packet.streamId))return;
      if(packet.event==='begin'){this.cut();this.streamId=packet.streamId;this.firstAudioAt=null;return;}
      if(packet.event!=='pcm'||packet.streamId!==this.streamId)return;
      const binary=atob(packet.base64),buffer=this.ctx.createBuffer(1,binary.length/2,packet.sampleRate),out=buffer.getChannelData(0);
      for(let i=0;i<out.length;i++){let n=binary.charCodeAt(i*2)|(binary.charCodeAt(i*2+1)<<8);if(n>32767)n-=65536;out[i]=n/32768;}
      const node=this.ctx.createBufferSource();node.buffer=buffer;node.connect(this.output);this.nodes.add(node);
      const at=Math.max(this.ctx.currentTime+0.025,this.nextAt);this.nextAt=at+buffer.duration;
      node.onended=()=>{node.disconnect();this.nodes.delete(node);if(packet.streamId===this.streamId)this.ack(packet);};
      this.firstAudioAt??=Date.now();node.start(at);
    }
  }
  function join(parts){const count=parts.reduce((n,p)=>n+p.length,0),all=new Float32Array(count);let offset=0;for(const p of parts){all.set(p,offset);offset+=p.length;}return all;}
  function CallIcon({name,size=22}){
    const paths={phone:['M5 3h4l2 5-3 2a15 15 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2C10 21 3 14 3 5a2 2 0 0 1 2-2Z'],mic:['M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0Z','M5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8'],volume:['M11 5 6 9H3v6h3l5 4Z','M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14'],captions:['M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z','M10 9H7v6h3M18 9h-3v6h3'],minimize:['M5 16h14'],expand:['M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5']};
    return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},...(paths[name]||paths.phone).map((d,i)=>h('path',{d,key:i})));
  }
  function CallPanel({controller,phase,level,muted,speakerMuted,captions,seconds,status,error,duplexStatus,onMute,onSpeaker,onCaptions,onStop}){
    const [minimized,setMinimized]=useState(false),[position,setPosition]=useState(null);
    const panel=useRef(null),drag=useRef(null);
    const clock=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
    useEffect(()=>{controller.reveal=()=>{setMinimized(false);requestAnimationFrame(()=>panel.current?.focus());};return()=>{controller.reveal=null;};},[controller]);
    useEffect(()=>{const fit=()=>setPosition(p=>p?{left:Math.max(8,Math.min(p.left,innerWidth-(panel.current?.offsetWidth||360)-8)),top:Math.max(8,Math.min(p.top,innerHeight-(panel.current?.offsetHeight||400)-8))}:p);window.addEventListener('resize',fit);return()=>window.removeEventListener('resize',fit);},[]);
    const beginDrag=e=>{if(e.target.closest('button')||e.button!==0)return;const box=panel.current.getBoundingClientRect();drag.current={x:e.clientX,y:e.clientY,left:box.left,top:box.top};e.currentTarget.setPointerCapture(e.pointerId);};
    const move=e=>{if(!drag.current)return;const d=drag.current;setPosition({left:Math.max(8,Math.min(d.left+e.clientX-d.x,innerWidth-panel.current.offsetWidth-8)),top:Math.max(8,Math.min(d.top+e.clientY-d.y,innerHeight-panel.current.offsetHeight-8))});};
    const small={...btnStyle,width:44,height:44,minWidth:44,padding:0,display:'grid',placeItems:'center',border:'none',color:'#d1dfdb'};
    const control=(icon,text,handler,pressed,danger=false)=>h('button',{type:'button',onClick:handler,'aria-label':text,...(pressed===undefined?{}:{'aria-pressed':pressed}),className:'qs-call-control',style:{border:0,color:danger?'#fff':pressed?'#122b25':'#e8f0ed',background:danger?'#b53d47':pressed?'#a0d2bc':'#2b3b3e',borderRadius:16,minWidth:76,minHeight:76,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:8,font:'inherit',fontSize:12,cursor:'pointer'}},h(CallIcon,{name:icon}),text);
    const label=phase==='starting'?'正在连接…':muted?'麦克风已静音':phase==='hearing'?'正在听你说':duplexStatus||'我在听，你可以直接说';
    return h('section',{ref:panel,role:'dialog','aria-modal':false,'aria-label':'清声通话',tabIndex:-1,'data-qingsheng-call-room':true,'data-minimized':minimized,onKeyDown:e=>{if(e.key==='Escape'){e.stopPropagation();setMinimized(true);}},style:{position:'fixed',zIndex:10000,...(position?position:{right:24,bottom:24}),width:minimized?'min(280px,calc(100vw - 16px))':'min(360px,calc(100vw - 16px))',maxHeight:'calc(100vh - 16px)',overflow:'auto',boxSizing:'border-box',border:'1px solid #4c6361',borderRadius:20,background:'#172527',color:'#f1f6f3',boxShadow:'0 16px 48px #0005',fontFamily:'"Microsoft YaHei UI","Segoe UI",sans-serif'}},
      h('header',{onPointerDown:beginDrag,onPointerMove:move,onPointerUp:()=>{drag.current=null;},onPointerCancel:()=>{drag.current=null;},style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,padding:'8px 8px 8px 20px',cursor:'move',touchAction:'none',userSelect:'none',borderBottom:minimized?'none':'1px solid #ffffff14'}},
        h('div',{style:{display:'flex',alignItems:'center',gap:8,fontSize:13,color:'#cbdbd6'}},h(CallIcon,{name:'phone',size:16}),'清声通话',minimized&&h('span',{style:{fontVariantNumeric:'tabular-nums',color:'#a8c1b8'}},clock)),
        h('div',{style:{display:'flex'}},h('button',{type:'button',style:small,className:'qs-call-control','aria-label':minimized?'展开通话面板':'缩小通话面板',onClick:()=>setMinimized(!minimized)},h(CallIcon,{name:minimized?'expand':'minimize',size:18})),minimized&&h('button',{type:'button',style:{...small,color:'#ffadb2'},className:'qs-call-control','aria-label':'挂断',onClick:onStop},h(CallIcon,{name:'phone',size:18})))),
      !minimized&&h('div',{style:{padding:'24px 24px 20px',textAlign:'center'}},
        h('div',{'aria-hidden':true,style:{margin:'0 auto 16px',width:80,height:80,borderRadius:28,display:'grid',placeItems:'center',fontSize:32,fontWeight:500,color:'#c5ebd9',background:phase==='hearing'?'#35574a':'#293e3e',boxShadow:'0 0 0 '+Math.round(level*16)+'px #a0d2bc10'}},'声'),
        h('h2',{style:{fontSize:22,lineHeight:1.4,fontWeight:600,margin:'0 0 8px'}},'清声'),
        h('div',{style:{fontSize:14,color:'#b4c7bf',fontVariantNumeric:'tabular-nums'}},clock),
        h('div',{role:'status',style:{fontSize:16,minHeight:24,marginTop:24,color:'#e2eee8'}},label),
        h('meter',{value:level,min:0,max:1,'aria-label':'通话麦克风音量',style:{width:96,height:8,marginTop:12,accentColor:'#a0d2bc'}}),
        h('p',{style:{fontSize:12,color:'#b4c7bf',margin:'12px 0 24px'}},'直接说话即可，开口就能打断'),
        error&&h('p',{role:'alert',style:{color:'#ffbda9',fontSize:13,textAlign:'left'}},error),
        h('div',{style:{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12}},control('mic',muted?'取消静音':'静音',onMute,muted),control('volume',speakerMuted?'打开扬声器':'扬声器',onSpeaker,!speakerMuted),control('phone','挂断',onStop,undefined,true)),
        h('button',{type:'button',onClick:onCaptions,'aria-pressed':captions,'aria-label':captions?'关闭字幕':'字幕',className:'qs-call-control',style:{...btnStyle,display:'inline-flex',alignItems:'center',gap:8,minHeight:44,marginTop:16,border:0,color:'#c3d6cc',fontSize:13}},h(CallIcon,{name:'captions',size:18}),captions?'关闭字幕':'显示字幕'),
        captions&&h('div',{'data-call-captions':true,style:{textAlign:'left',fontSize:14,lineHeight:1.7,marginTop:8,maxHeight:180,overflow:'auto',borderTop:'1px solid #ffffff26',paddingTop:12}},...(status?.captions||[]).map(row=>h('p',{key:row.id,style:{margin:'8px 0',color:row.interrupted?'#b4c7bf':'#e8f1eb'}},h('strong',null,row.role==='user'?'你：':'清声：'),row.text,row.interrupted?'（已打断）':'')),status?.partial&&h('p',{style:{color:'#b4c7bf'}},'正在听：'+status.partial)))
    );
  }
  function CallButton({call,sessionId,inputActions,locked,panelOnly=false,launchToken=0,initialMode='chat',controller}){
    const [phase,setPhase]=useState('idle'),[level,setLevel]=useState(0),[error,setError]=useState('');
    const [pending,setPending]=useState(''),[duplexStatus,setDuplexStatus]=useState('');
    const [mode,setMode]=useState('chat');
    const [status,setStatus]=useState(null),[muted,setMuted]=useState(false),[speakerMuted,setSpeakerMuted]=useState(false),[captions,setCaptions]=useState(false),[seconds,setSeconds]=useState(0);
    const current=useRef(null),generation=useRef(0),alive=useRef(true);
    const active=phase!=='idle';
    useEffect(()=>{if(controller){controller.active=active;controller.notify();}},[active,controller]);
    useEffect(()=>{
      if(!active)return;
      const tick=setInterval(()=>{const run=current.current;if(run)setSeconds(Math.floor((Date.now()-run.startedAt)/1000));},500);
      return()=>clearInterval(tick);
    },[active]);
    const stop=()=>{
      generation.current++;
      const run=current.current;current.current=null;
      if(run){run.player?.cut();run.abort.abort();run.mic.dispose().catch(()=>{});call({action:'stop',sessionId:run.sessionId,callId:run.callId}).catch(()=>{});}
      if(alive.current){setPhase('idle');setLevel(0);}
    };
    useEffect(()=>{alive.current=true;return()=>{alive.current=false;stop();};},[]);
    useEffect(()=>{stop();setPending('');setError('');},[sessionId]);
    const valid=run=>alive.current&&current.current===run&&!run.abort.signal.aborted;
    const invoke=(run,input)=>call({sessionId:run.sessionId,callId:run.callId,...input},run.abort.signal);
    const receive=(run,s)=>{
      if(!valid(run))return;
      if(s.type==='audio'){run.player.accept(s);return;}
      if(s.callId!==run.callId)return;
      setStatus(s);
      setDuplexStatus(s.hearing?'正在听你说':s.speaking?'正在与你说话':s.generating?'正在想怎么回答':s.realtime?.synthesizing?'正在组织语音':'我在听，你可以直接说');
      if(s.error)setError(s.error);
      if(!s.active){stop();setError(s.error||'通话已结束。');}
    };
    const connect=async run=>{
      const response=await fetch('/api/qingsheng/call/events?callId='+encodeURIComponent(run.callId),{signal:run.abort.signal});
      if(!response.ok||!response.body)throw Error('通话音频连接失败。');
      const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
      const next=async()=>{const chunk=await reader.read();if(chunk.done)throw Error('通话音频连接已断开。');pending+=decoder.decode(chunk.value,{stream:true});let end;while((end=pending.indexOf('\n\n'))>=0){const event=pending.slice(0,end);pending=pending.slice(end+2);if(event.startsWith('data: '))receive(run,JSON.parse(event.slice(6)));}};
      await next();
      run.channel=(async()=>{try{while(valid(run))await next();}catch(e){if(valid(run)){stop();setError(e.message);}}finally{try{await reader.cancel();}catch{}}})();
    };
    const preview=async(run,id,parts,begin)=>{
      if(run.previewBusy)return;run.previewBusy=true;
      try{await begin;if(valid(run)&&run.utteranceId===id&&run.vad.speaking)await invoke(run,{action:'speech.partial',utteranceId:id,base64:b64(pcmToWav(join(parts),RATE))});}
      catch(e){if(valid(run))run.previewError=e.message;}finally{run.previewBusy=false;}
    };
    const finish=async (run,utterance)=>{
      const parts=utterance.parts;
      const total=parts.reduce((n,p)=>n+p.length,0);
      if(total<RATE*0.2)return;
      const joined=join(parts);
      run.busy=true;setPhase('thinking');
      try{
        await utterance.begin;if(!valid(run))return;
        const r=await invoke(run,{action:'speech.end',utteranceId:utterance.id,base64:b64(pcmToWav(joined,RATE))});
        if(!valid(run))return;
        if(r.text && !r.submitted && !r.deferred){setPending(r.text);throw Error('识别结果尚未进入通话，请重试。');}
      }catch(e){if(valid(run))setError(e.message);}
      finally{if(valid(run)){run.busy=false;if(!run.vad.speaking)setPhase('listening');}}
    };
    const start=async requestedMode=>{
      const chosenMode=typeof requestedMode==='string'?requestedMode:mode;
      if(current.current)return;
      setError('');setPending('');setStatus(null);setMuted(false);setSpeakerMuted(false);setSeconds(0);
      if(!sessionId){setError('会话输入接口尚未就绪。');return;}
      const run={sessionId:String(sessionId),mic:new Mic(),abort:new AbortController(),vad:new Vad(),parts:[],pre:[],busy:false,ready:false,recognition:Promise.resolve(),control:Promise.resolve(),utteranceId:0,startedAt:Date.now(),previewAt:0,muted:false};
      const ticket=++generation.current;current.current=run;setPhase('starting');
      run.mic.onEnded=()=>{if(valid(run)){stop();setError('麦克风已断开。');}};
      run.mic.onFrame=(lvl,frame,ms)=>{
        if(!valid(run)||!run.ready||run.muted)return;
        setLevel(Math.min(1,lvl*8));
        // Capture keeps running while an earlier utterance is being recognized.
        const copy=new Float32Array(frame),v=run.vad.push(lvl,ms);
        if(v.changed&&v.speaking){
          run.parts=run.pre;run.pre=[];
          // Cut WebAudio synchronously, before waiting on any network roundtrip.
          run.player.cut();const id=++run.utteranceId;run.previewAt=Date.now();
          run.control=run.control.catch(()=>{}).then(()=>invoke(run,{action:'speech.start',utteranceId:id}));
          run.begin=run.control;run.control.catch(e=>{if(valid(run))setError(e.message);});
          setPhase('hearing');
        }
        if(v.speaking||run.parts.length)run.parts.push(copy);
        else{run.pre.push(copy);if(run.pre.length>3)run.pre.shift();}
        if(v.speaking&&Date.now()-run.previewAt>=1100){run.previewAt=Date.now();void preview(run,run.utteranceId,run.parts.slice(),run.begin);}
        if(v.changed&&!v.speaking){
          const utterance={parts:run.parts,id:run.utteranceId,begin:run.begin};run.parts=[];
          run.recognition=run.recognition.catch(()=>{}).then(async()=>{
            if(!valid(run))return;
            // finish uses the current run identity while consuming this utterance's immutable buffer.
            await finish(run,utterance);
          });
        }
      };
      try{
        await run.mic.start();
        if(!valid(run)||ticket!==generation.current)return;
        run.player=new CallAudio(run.mic.ctx,packet=>{if(valid(run))invoke(run,{action:'playback.ack',streamId:packet.streamId,seq:packet.seq}).catch(()=>{});});
        const initial=await call({action:'start',sessionId:run.sessionId,mode:chosenMode,browserAudio:true},run.abort.signal);run.callId=initial.callId;
        if(initial.protocolVersion!==2)throw Error('通话服务需要重新加载后才能连接。');
        await connect(run);
        if(!valid(run))return;
        run.ready=true;setPhase('listening');setStatus(initial);
      }catch(e){if(valid(run)){stop();setError(e.message);}}
      finally{if(!valid(run))run.mic.dispose().catch(()=>{});}
    };
    const toggleMute=()=>{
      const run=current.current;if(!run?.ready)return;run.muted=!run.muted;setMuted(run.muted);
      run.mic.stream.getAudioTracks().forEach(track=>track.enabled=!run.muted);
      if(run.muted){const hearing=run.vad.speaking;run.parts=[];run.pre=[];run.vad=new Vad();setLevel(0);if(hearing)invoke(run,{action:'speech.cancel',utteranceId:run.utteranceId}).catch(e=>{if(valid(run))setError(e.message);});}
    };
    const toggleSpeaker=()=>{const run=current.current;if(!run?.player)return;const value=!speakerMuted;setSpeakerMuted(value);run.player.setMuted(value);};
    useEffect(()=>{if(launchToken){setMode(initialMode);void start(initialMode);}},[launchToken]);
    const label=phase==='idle'?'通话':phase==='starting'?'连接中…':phase==='hearing'?'听见了…':phase==='thinking'?'识别中…':'挂断';
    const callView=active&&h('dialog',{ref:dialog,'aria-label':'清声通话','data-qingsheng-call-room':true,onCancel:e=>{e.preventDefault();stop();},style:{width:'min(520px,90vw)',maxHeight:'85vh',overflow:'auto',boxSizing:'border-box',border:'1px solid #718f89',borderRadius:20,padding:28,background:'#152024',color:'#eef4f2',boxShadow:'0 18px 70px #0006',fontFamily:'inherit',textAlign:'center'}},
      h('div',{style:{fontSize:13,letterSpacing:2,opacity:.7}},'清声 · 通话中'),
      h('div',{style:{margin:'20px auto 12px',width:88,height:88,borderRadius:'50%',display:'grid',placeItems:'center',fontSize:32,background:phase==='hearing'?'#355d51':'#263d40',boxShadow:'0 0 0 '+Math.round(level*22)+'px #79b39b18'}},'声'),
      h('div',{role:'status',style:{fontSize:18,minHeight:28}},phase==='starting'?'正在连接通话…':muted?'麦克风已静音':phase==='hearing'?'正在听你说':duplexStatus||'我在听，你可以直接说'),
      h('div',{style:{fontVariantNumeric:'tabular-nums',opacity:.6,marginTop:8}},String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0')),
      h('p',{style:{fontSize:12,opacity:.65,lineHeight:1.7}},'直接说话即可，对方说话时也可以插话。'),
      h('meter',{value:level,min:0,max:1,'aria-label':'通话麦克风音量',style:{width:120}}),
      error&&h('p',{role:'alert',style:{color:'#ffbda9',fontSize:13}},error),
      h('div',{style:{display:'flex',justifyContent:'center',gap:12,marginTop:22}},
        h('button',{type:'button',onClick:toggleMute,disabled:phase==='starting','aria-pressed':muted,style:{...btnStyle,padding:'10px 18px',color:'inherit'}},muted?'取消静音':'静音'),
        h('button',{type:'button',onClick:stop,style:{...btnStyle,padding:'10px 22px',background:'#a8433c',borderColor:'#b95e56',color:'#fff'}},'挂断'),
        h('button',{type:'button',onClick:()=>setCaptions(!captions),'aria-pressed':captions,style:{...btnStyle,padding:'10px 18px',color:'inherit'}},captions?'关闭字幕':'字幕')),
      captions&&h('div',{'data-call-captions':true,style:{textAlign:'left',fontSize:13,lineHeight:1.7,marginTop:20,maxHeight:200,overflow:'auto',borderTop:'1px solid #ffffff26',paddingTop:12}},
        ...(status?.captions||[]).map(row=>h('p',{key:row.id,style:{margin:'6px 0',opacity:row.interrupted?.65:1}},h('strong',null,row.role==='user'?'你：':'对方：'),row.text,row.interrupted?'（已插话）':'')),
        status?.partial&&h('p',{style:{opacity:.6}},'正在听：'+status.partial)),
      h('p',{style:{fontSize:11,opacity:.45,marginTop:20}},'清声音色与语气链保持原样 · 通话记录单独保存'));
    return h(React.Fragment,null,!panelOnly&&h('span',{'data-qingsheng-call':true,style:{display:'inline-flex',gap:4,alignItems:'center'}},
      h('select',{value:mode,disabled:active,onChange:e=>setMode(e.target.value),'aria-label':'通话模式',title:'快速聊天保留会话记忆和音色，暂停工具调用；完整任务可执行工具操作。',style:{...btnStyle,fontSize:11,maxWidth:96}},
        h('option',{value:'chat'},'快速聊天'),h('option',{value:'tools'},'完整任务')),
      h('button',{type:'button',style:{...btnStyle,...(active?{borderColor:'#b47b5b'}:{})},disabled:!active&&locked,onClick:active?stop:start,'aria-label':active?'结束通话':'开始通话'},label),
      active&&h('span',{'aria-live':'polite',style:{fontSize:11,opacity:0.75}},duplexStatus),
      active&&h('meter',{value:level,min:0,max:1,style:{width:30},'aria-label':'麦克风音量'}),
      error&&h('span',{role:'alert',style:{fontSize:11,color:'#b4553b',maxWidth:240},title:pending||error},error),
      pending&&h('button',{type:'button',style:btnStyle,onClick:()=>{if(inputActions.insertText(pending,inputActions.captureInsertion())){setPending('');setError('');}}},'插入识别结果')),callView,
      panelOnly&&!active&&error&&h('div',{role:'alert','data-qingsheng-call-error':true,style:{position:'fixed',bottom:24,right:24,zIndex:10000,maxWidth:420,padding:16,border:'1px solid #9d665a',borderRadius:8,background:'#252024',color:'#ffdbd1',fontSize:13}},error,h('button',{type:'button',style:{...btnStyle,marginLeft:12},onClick:()=>setError(''),'aria-label':'关闭通话错误提示'},'关闭')));
  }
  function CallHost({call,controller}){
    const [request,setRequest]=useState(null);
    controller.launch=value=>{if(controller.active){controller.reveal?.();return;}setRequest({...value,token:Date.now()});};
    return h(CallButton,{call,controller,panelOnly:true,sessionId:request?.sessionId,initialMode:request?.mode,launchToken:request?.token||0});
  }
  function CallTrigger({controller,sessionId,locked}){
    const [mode,setMode]=useState('chat'),[,refresh]=useState(0);
    useEffect(()=>{const update=()=>refresh(n=>n+1);controller.listeners.add(update);return()=>controller.listeners.delete(update);},[controller]);
    return h('span',{'data-qingsheng-call':true,style:{display:'inline-flex',gap:4,alignItems:'center'}},
      h('select',{value:mode,onChange:e=>setMode(e.target.value),disabled:controller.active,'aria-label':'通话模式',style:{...btnStyle,fontSize:11,maxWidth:96}},h('option',{value:'chat'},'快速聊天'),h('option',{value:'tools'},'完整任务')),
      h('button',{type:'button','aria-label':controller.active?'回到通话':'开始通话',disabled:!controller.active&&(!sessionId||locked),style:btnStyle,onClick:()=>controller.launch?.({sessionId:String(sessionId),mode})},controller.active?'回到通话':'通话'));
  }
  async function preserveChatSelection(workspace,input,start){
    const before=input.action==='start'?workspace?.selection?.getSnapshot():null;
    const value=await start();
    if(before?.sessionId&&value.recordingSessionId&&value.recordingSessionId!==before.sessionId){
      const after=workspace.selection.getSnapshot();
      // Restore only an automatic jump to this new call record. A user's
      // selection of another chat always takes precedence.
      if(after.sessionId===value.recordingSessionId)workspace.openSession(before.subagentAddress||before.sessionId);
    }
    return value;
  }
  function apply(ctx, shared){
    require = shared.require; React = require('react');   // 此刻 shared 才真正可用
    const {createRoot} = require('react-dom/client');
    const {useState,useEffect,useRef} = React, h = React.createElement;
    const workspace = ctx.get ? ctx.get('uiWorkspace') : shared.workspace;
    const call=(input,signal)=>preserveChatSelection(workspace,input,async()=>{const r=await shared.rpc('qingsheng/call',input,signal);if(!r.ok)throw Error(r.error?.message||'通话连接失败。');return r.value;});
    const controller={active:false,listeners:new Set(),notify(){for(const listener of this.listeners)listener();}};
    const container=document.createElement('div');container.dataset.qingshengCallHost='true';document.body.appendChild(container);
    const root=createRoot(container);root.render(h(CallHost,{call,controller}));
    // 挂进语音插件已经暴露的工具栏扩展点，而不是自己抢 conversation.input.right 插槽——
    // 同一个插槽只能有一个主人，抢了就会把语音按钮整组替换掉。
    if (shared.toolbar?.add) shared.toolbar.add(()=>h(CallTrigger,{controller}));
    return ()=>{try{root.unmount();}catch{} try{container.remove();}catch{}};
  }
  return {apply};
})({});