window.__ModuleLoader__.load({id:'dsh-qingsheng-voice',factory:(require) => {
  const React = require('react');
  const {useState,useEffect,useRef} = React, h = React.createElement;
  const style = {font:'inherit',fontSize:12,border:'1px solid var(--border-color, #d4d7d5)',borderRadius:7,padding:'5px 8px',background:'transparent',color:'inherit',cursor:'pointer'};
  function wave(buffer,sampleRate=16000) {
    const samples = buffer.getChannelData(0), bytes = new Uint8Array(44+samples.length*2), v = new DataView(bytes.buffer);
    const str = (o,s) => [...s].forEach((c,i) => v.setUint8(o+i,c.charCodeAt(0)));
    str(0,'RIFF');v.setUint32(4,36+samples.length*2,true);str(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
    v.setUint32(24,sampleRate,true);v.setUint32(28,sampleRate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,samples.length*2,true);
    for(let i=0;i<samples.length;i++){const n=Math.max(-1,Math.min(1,samples[i]));v.setInt16(44+i*2,n<0?n*32768:n*32767,true);}
    let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);
  }
  class Capture {
    constructor(onLevel,onEnded) {this.onLevel=onLevel;this.onEnded=onEnded;this.cancelled=false;this.parts=[];}
    async start() {
      if(!navigator.mediaDevices?.getUserMedia)throw Error('此窗口没有麦克风访问能力。');
      const stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      if(this.cancelled){stream.getTracks().forEach(t=>t.stop());throw Error('录音已取消。');}
      this.stream=stream;this.ctx=new AudioContext();await this.ctx.resume();
      if(this.cancelled){await this.dispose();throw Error('录音已取消。');}
      this.source=this.ctx.createMediaStreamSource(stream);this.analyser=this.ctx.createAnalyser();this.analyser.fftSize=512;this.source.connect(this.analyser);
      const level=()=>{const data=new Float32Array(512);this.analyser.getFloatTimeDomainData(data);this.onLevel(Math.min(1,Math.sqrt(data.reduce((s,n)=>s+n*n,0)/512)*8));this.frame=requestAnimationFrame(level);};level();
      this.recorder=new MediaRecorder(stream);
      this.recorder.ondataavailable=e=>{if(e.data.size)this.parts.push(e.data);};
      this.ended=new Promise(resolve=>{this.recorder.onstop=resolve;});
      this.recorder.start(250);
      stream.getAudioTracks()[0].onended=()=>{if(!this.cancelled)this.onEnded();};
    }
    async finish() {
      if(!this.recorder || this.cancelled)throw Error('没有可用录音。');
      if(this.recorder.state!=='inactive')this.recorder.stop();await this.ended;
      const bytes=await new Blob(this.parts,{type:this.recorder.mimeType}).arrayBuffer();
      const decoded=await this.ctx.decodeAudioData(bytes);
      if(decoded.duration>60.5 || decoded.duration<0.3)throw Error('请录制 0.3–60 秒的语音。');
      const offline=new OfflineAudioContext(1,Math.ceil(decoded.duration*16000),16000),source=offline.createBufferSource();
      source.buffer=decoded;source.connect(offline.destination);source.start();return wave(await offline.startRendering());
    }
    async dispose() {
      this.cancelled=true;cancelAnimationFrame(this.frame);
      if(this.recorder?.state==='recording')this.recorder.stop();
      this.stream?.getTracks().forEach(t=>t.stop());this.source?.disconnect();
      if(this.ctx && this.ctx.state!=='closed')await this.ctx.close();this.onLevel(0);
    }
  }
  function useStatus(call) {
    const [status,setStatus]=useState(null),[error,setError]=useState('');
    useEffect(()=>{let alive=true,busy=false;const poll=async()=>{if(busy)return;busy=true;try{const s=await call({action:'status'});if(alive){setStatus(s);setError('');}}catch(e){if(alive)setError(e.message);}finally{busy=false;}};poll();const timer=setInterval(poll,700);return()=>{alive=false;clearInterval(timer);};},[call]);
    return {status,error,setStatus};
  }
  function VoiceControls({sessionId,inputActions,locked,onActiveChange,call,extra,subscribeExtra}) {
    const {status,error:connectionError,setStatus}=useStatus(call);
    // 通话插件可能在组件渲染之后才把按钮加进来，所以订阅一次，免得拿到的是空快照。
    const [liveExtra,setLiveExtra]=useState(Array.isArray(extra)?extra:[]);
    useEffect(()=>{
      if(typeof subscribeExtra!=='function') return;
      return subscribeExtra(()=>setLiveExtra(Array.isArray(extra)?extra.slice():[]));
    },[]);
    const shownExtra = Array.isArray(liveExtra)&&liveExtra.filter(Boolean).length ? liveExtra.filter(Boolean) : (Array.isArray(extra)?extra.filter(Boolean):[]);
    const [phase,setPhase]=useState('idle'),[error,setError]=useState(''),[level,setLevel]=useState(0),[pending,setPending]=useState(''),[savingAuto,setSavingAuto]=useState(false);
    const active=useRef(null),generation=useRef(0),alive=useRef(true);
    const [showStudio,setShowStudio]=useState(false),[showPanel,setShowPanel]=useState(false),[showEmotion,setShowEmotion]=useState(false),[showHistory,setShowHistory]=useState(false),[history,setHistory]=useState([]);
    const cancel=()=>{generation.current++;const a=active.current;active.current=null;if(a){clearTimeout(a.timer);a.abort.abort();a.capture.dispose().catch(()=>{});}if(alive.current){setPhase('idle');setLevel(0);}};
    useEffect(()=>{alive.current=true;return()=>{alive.current=false;cancel();};},[]);
    useEffect(()=>{cancel();setPending('');const focus=()=>{if(!document.hidden)call({action:'focus',sessionId:String(sessionId)}).catch(e=>{if(alive.current)setError(e.message);});};focus();document.addEventListener('visibilitychange',focus);return()=>{document.removeEventListener('visibilitychange',focus);cancel();};},[sessionId]);
    useEffect(()=>{onActiveChange?.(showStudio||showPanel||showEmotion||showHistory||phase==='recording'||phase==='requesting'||phase==='transcribing');return()=>onActiveChange?.(false);},[phase,showStudio,showPanel,showEmotion,showHistory,onActiveChange]);
    useEffect(()=>{const escape=e=>{if(e.key==='Escape' && active.current)cancel();};const hidden=()=>{if(document.hidden)cancel();};document.addEventListener('keydown',escape);document.addEventListener('visibilitychange',hidden);return()=>{document.removeEventListener('keydown',escape);document.removeEventListener('visibilitychange',hidden);};},[]);
    const stopVoice=async()=>{try{await call({action:'stop'});}catch(e){setError(e.message);}};
    const playback=async(action,replyId)=>{setError('');try{await call({action,sessionId:String(sessionId),...(replyId?{replyId}:{})});setStatus(await call({action:'status'}));}catch(e){setError(e.message);onActiveChange?.(true);setShowPanel(true);}};
    const openHistory=async()=>{setError('');try{const list=await call({action:'history',sessionId:String(sessionId)});setHistory(list);onActiveChange?.(true);setShowPanel(false);setShowHistory(true);}catch(e){setError(e.message);}};
    const finish=async()=>{
      const a=active.current;if(!a||a.phase!=='recording')return;a.phase='transcribing';clearTimeout(a.timer);setPhase('transcribing');
      try{const base64=await a.capture.finish();await a.capture.dispose();if(a.run!==generation.current)return;const result=await call({action:'transcribe',base64},a.abort.signal);
        if(a.run!==generation.current)return;if(!result.text?.trim())throw Error('没有识别到语音。');
        if(!inputActions.insertText(result.text,a.span)){setPending(result.text);setError('草稿已变化，识别结果已保留，请点击插入。');}
      }catch(e){if(a.run===generation.current)setError(e.message);}
      finally{await a.capture.dispose().catch(()=>{});if(a.run===generation.current){active.current=null;setPhase('idle');}}
    };
    const start=async()=>{
      if(locked||active.current)return;setError('');setPending('');const run=++generation.current;
      const a={run,phase:'requesting',abort:new AbortController(),span:inputActions.captureInsertion(),capture:new Capture(n=>{if(alive.current)setLevel(n);},()=>{cancel();if(alive.current)setError('麦克风已断开。');})};
      active.current=a;setPhase('requesting');
      try{await call({action:'stop'});if(run!==generation.current)return;await a.capture.start();if(run!==generation.current){await a.capture.dispose();return;}a.phase='recording';setPhase('recording');a.timer=setTimeout(finish,59000);}
      catch(e){await a.capture.dispose().catch(()=>{});if(run===generation.current){active.current=null;setPhase('idle');setError(e.message);}}
    };
    const toggle=async checked=>{const previous=status?.preferences?.autoSpeak;setSavingAuto(true);setStatus(s=>s?{...s,preferences:{...s.preferences,autoSpeak:checked}}:s);try{const p=await call({action:'configure',preferences:{autoSpeak:checked}});setStatus(s=>s?{...s,preferences:p}:s);}catch(e){setStatus(s=>s?{...s,preferences:{...s.preferences,autoSpeak:previous}}:s);setError(e.message);}finally{setSavingAuto(false);}};
    const setDelivery=async value=>{setError('');try{const preferences=await call({action:'configure',preferences:{delivery:value}});setStatus(s=>({...s,preferences}));}catch(e){setError(e.message);}};
    const setStrategy=async value=>{setError('');try{const preferences=await call({action:'configure',preferences:{voiceStrategy:value}});setStatus(s=>({...s,preferences}));}catch(e){setError(e.message);}};
    const compatible=Number(status?.protocolVersion)>=4;
    const mismatch=!!status&&!compatible;
    const readable=e=>String(e||'').includes('未知语音操作')?'插件界面与后台版本不同，请在 DSH 中重新加载清声插件或重启 DSH。':e;
    const feedback=readable(error||connectionError||status?.error);
    const busyPlaying=['playing','generating','paused'].includes(status?.phase);
    const health=mismatch?'插件需要重新加载':feedback?'语音需要处理':!status?'正在检查连接':!status.connected?'清声未连接':!status.engine?.ready?'模型未就绪':'语音已就绪';
    const openPanel=()=>{onActiveChange?.(true);setShowPanel(true);};
    const openStudio=()=>{onActiveChange?.(true);setShowPanel(false);setShowStudio(true);};
    const retry=async()=>{setError('');try{setStatus(await call({action:'status'}));}catch(e){setError(e.message);}};
    const actionButton=(label,onClick,extra={})=>h('button',{type:'button',style,onClick,...extra},label);
    return h('div',{'data-qingsheng-voice':true,className:'qs-toolbar'},
      h('style',null,'.qs-toolbar{display:flex;align-items:center;gap:4px;max-width:100%;min-width:0;flex-wrap:wrap}.qs-toolbar>button{display:inline-flex;gap:5px;align-items:center;justify-content:center;min-height:32px;white-space:nowrap;padding:5px 8px!important}.qs-toolbar>button:disabled{opacity:.45;cursor:not-allowed}.qs-toolbar :focus-visible{outline:2px solid #658d9a;outline-offset:2px}.qs-health-dot{width:6px;height:6px;border-radius:50%;background:#729a82;flex-shrink:0}.qs-health-dot[data-warning=true]{background:#c68860}.qs-controls-dialog{box-sizing:border-box;width:min(420px,92vw);max-width:92vw;max-height:84vh;overflow:auto;border:1px solid var(--border-color,#84908c);border-radius:12px;padding:20px;background:Canvas;color:CanvasText;font:inherit}.qs-controls-dialog::backdrop{background:#10191866}.qs-controls-dialog header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:18px}.qs-controls-dialog h3{font-size:16px;margin:0}.qs-controls-dialog p{font-size:13px;line-height:1.7;overflow-wrap:anywhere}.qs-controls-dialog .qs-control-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:48px;border-top:1px solid #83918a33;font-size:13px}.qs-controls-dialog button{font:inherit;min-height:36px;border-radius:7px;border:1px solid #83918a66;background:transparent;color:inherit;padding:7px 11px;cursor:pointer}.qs-controls-dialog button:disabled{opacity:.45;cursor:not-allowed}.qs-controls-dialog .qs-control-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.qs-controls-dialog .qs-control-error{padding:10px 12px;border:1px solid #b47b5b66;border-radius:8px}.qs-controls-dialog small{font-size:11px;opacity:.7}.qs-controls-dialog input[type=checkbox]{accent-color:#547d6a;width:16px;height:16px}.qs-controls-dialog a{color:inherit}'),
      actionButton(phase==='recording'?'结束录音':phase==='transcribing'?'识别中…':phase==='requesting'?'等待麦克风…':'语音输入',phase==='recording'?finish:start,{disabled:locked||phase==='requesting'||phase==='transcribing','aria-label':phase==='recording'?'结束录音并识别':'清声语音输入'}),
      phase!=='idle'&&actionButton('取消',cancel),
      phase==='recording'&&h('meter',{'aria-label':'麦克风音量',value:level,min:0,max:1,style:{width:32}}),
      actionButton(status?.phase==='paused'?'继续':busyPlaying?'暂停':'朗读',()=>playback(status?.phase==='paused'?'resume':busyPlaying?'pause':'replay'),{disabled:!compatible||!status?.connected||!status?.engine?.ready,'aria-label':status?.phase==='paused'?'继续朗读':busyPlaying?'暂停朗读':'朗读或重播最新回复'}),
      busyPlaying&&actionButton('■',stopVoice,{'aria-label':'停止大肥鱼朗读',title:'停止朗读'}),
      h('button',{type:'button',style,onClick:openPanel,'aria-label':'更多语音设置','aria-haspopup':'dialog','aria-expanded':showPanel,title:health},h('span',{className:'qs-health-dot','data-warning':mismatch||!!feedback||!status?.connected||!status?.engine?.ready}),'更多'),
      Array.isArray(shownExtra)&&shownExtra.length>0&&shownExtra.map((item,i)=>h('span',{key:'qs-extra-'+i,style:{display:'inline-flex'}},item)),
      pending&&actionButton('插入识别结果',()=>{if(inputActions.insertText(pending,inputActions.captureInsertion())){setPending('');setError('');}}),
      showPanel&&h(ControlsDialog,{onClose:()=>setShowPanel(false)},
        h('p',{role:'status'},health),
        mismatch&&h('p',{className:'qs-control-error',role:'alert'},'插件界面是 0.4.0，当前后台'+(status.pluginVersion?'为 '+status.pluginVersion:'尚未提供版本信息')+'。请在 DSH 插件管理中重新加载清声插件，或退出并重新打开 DSH。刷新网页只会更新界面。'),
        feedback&&h('p',{className:'qs-control-error',role:'alert'},feedback),
        h('div',{className:'qs-control-row'},h('span',null,'插件后台'),h('small',null,status?.pluginVersion||'未确认版本')),
        h('div',{className:'qs-control-row'},h('span',null,'清声服务'),h('span',null,status?.connected?'已连接':'未连接')),
        h('div',{className:'qs-control-row'},h('span',null,'声音模型'),h('span',null,status?.engine?.ready?'已就绪':'未就绪')),
        compatible&&status?.connected&&!status?.capabilities?.referenceLock&&h('p',{className:'qs-control-error'},'当前清声服务版本较旧，请重启已更新的清声工作台。'),
        h('label',{className:'qs-control-row'},h('span',null,'自动朗读'),h('input',{type:'checkbox',checked:status?.preferences?.autoSpeak??true,onChange:e=>toggle(e.target.checked),disabled:!status||savingAuto})),
        h('div',{className:'qs-control-row'},h('span',null,'当前音色'),h('span',null,status?.voices?.find(v=>v.id===status?.preferences?.voiceId)?.name||'未选择')),
        h('label',{className:'qs-control-row'},h('span',null,'表达方式'),h('select',{'aria-label':'表达方式',value:status?.preferences?.delivery||'steady',disabled:!status?.preferences?.delivery,onChange:event=>setDelivery(event.target.value),style:{font:'inherit',padding:7,borderRadius:6,background:'Canvas',color:'CanvasText'}},h('option',{value:'steady'},'克制连贯'),h('option',{value:'reference'},'跟随参考'))),
        h('p',null,'自动表达启用时固定使用克制连贯模式，保证语义表达指令与同一声纹一起生效。关闭自动表达后，可选跟随参考；首次校准会增加等待。'),
        h('label',{className:'qs-control-row'},h('span',null,'声线策略'),h('select',{'aria-label':'声线策略',value:status?.preferences?.voiceStrategy||'clone',disabled:!status?.connected,onChange:event=>setStrategy(event.target.value),style:{font:'inherit',padding:7,borderRadius:6,background:'Canvas',color:'CanvasText'}},h('option',{value:'clone'},'克隆固定（音色不变）'),h('option',{value:'regenerate'},'每次重造（音色会变）'))),
        h('p',null,'克隆固定：选定音色后声纹保持稳定，同一句话每次听都一样。每次重造：每次重新生成声线，听感会有差异。'),
        actionButton('历史回答与朗读',openHistory),
        h('div',{className:'qs-control-actions'},
          actionButton('音色管理',openStudio,{'aria-label':'打开声音工作室',disabled:!compatible||!status?.connected}),
          actionButton('情绪控制',()=>{onActiveChange?.(true);setShowPanel(false);setShowEmotion(true);},{'aria-label':'打开情绪表达控制',disabled:!status?.emotion?.available}),
          actionButton('重播最新回答',()=>playback('replay'),{disabled:!compatible||!status?.connected||!status?.engine?.ready}),
          actionButton('停止朗读',stopVoice),actionButton('重新检测',retry),
          actionButton('重新校准',()=>playback('voice.resetReference'),{disabled:!status?.preferences?.delivery||status?.voices?.find(v=>v.id===status?.preferences?.voiceId)?.kind==='reference'}),
          !status?.connected&&actionButton('启动清声',()=>playback('launch'))),
        status?.warning&&h('p',null,status.warning),
        h('small',null,'音色导入、设计和管理在声音工作室内。')),
      showStudio&&h(VoiceDialog,{call,onClose:()=>setShowStudio(false)}),
      showEmotion&&h(EmotionDialog,{call,onClose:()=>setShowEmotion(false)}),
      showHistory&&h(HistoryDialog,{items:history,sessionId:String(sessionId),play:replyId=>playback('replay.message',replyId),onClose:()=>setShowHistory(false)})
    );
  }
  function ControlsDialog({children,onClose}){
    const dialog=useRef(null);useEffect(()=>{dialog.current.showModal();return()=>dialog.current?.close();},[]);
    return h('dialog',{ref:dialog,className:'qs-controls-dialog','aria-label':'语音设置',onCancel:event=>{event.preventDefault();onClose();}},
      h('header',null,h('h3',null,'语音设置'),h('button',{type:'button',onClick:onClose,'aria-label':'关闭语音设置'},'关闭')),children);
  }

  function HistoryDialog({items,play,onClose}){
    const dialog=useRef(null);useEffect(()=>{dialog.current.showModal();return()=>dialog.current?.close();},[]);
    return h('dialog',{ref:dialog,className:'qs-controls-dialog','aria-label':'会话历史朗读',onCancel:event=>{event.preventDefault();onClose();}},
      h('header',null,h('h3',null,'会话历史朗读'),h('button',{type:'button',onClick:onClose,'aria-label':'关闭历史朗读'},'关闭')),
      items.length?items.slice().reverse().map((item,index)=>h('article',{key:item.id,className:'qs-history-item'},h('p',null,item.text),item.context&&h('small',null,'你：'+item.context.slice(0,180)),h('button',{type:'button',onClick:()=>play(item.id)},index===0?'朗读最新回答':'朗读这条'))):h('p',null,'当前分支还没有可朗读的回答。'));
  }

  function EmotionStudio({call}){
    const [data,setData]=useState(null),[config,setConfig]=useState(null),[tab,setTab]=useState('expression'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[text,setText]=useState('没关系，先别急。我在这里，我们一件一件来。'),[plan,setPlan]=useState(null);
    const alive=useRef(true),operation=useRef(null);
    const load=async()=>{const value=await call({action:'emotion.status'});if(alive.current){setData(value);setConfig(value.config);}};
    useEffect(()=>{alive.current=true;load().catch(e=>{if(alive.current)setError(e.message);});return()=>{alive.current=false;operation.current?.abort();};},[]);
    const run=async fn=>{if(busy)return;const controller=new AbortController();operation.current=controller;setBusy(true);setError('');setMessage('');try{await fn(controller.signal);}catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setBusy(false);}};
    const change=(key,value)=>setConfig(c=>({...c,[key]:value}));
    const apply=async signal=>{const value=await call({action:'emotion.configure',config},signal);if(alive.current){setData(value);setConfig(value.config);}return value;};
    const preview=audio=>run(async signal=>{await apply(signal);const p=await call({action:'emotion.plan',text},signal);if(!alive.current)return;setPlan(p);if(audio){await call({action:'emotion.preview',text},signal);setMessage('正在使用当前音色试听。试听不会推进当前对话的情绪与口癖冷却。');}else setMessage('计划已生成；以下为指令与设计目标，不是听感测量结果。');});
    const button=(label,onClick,extra={})=>h('button',{type:'button',onClick,disabled:busy,...extra},label);
    const label=(name,child,note)=>h('label',{className:'qe-field'},h('span',null,name),child,note&&h('small',null,note));
    const tabs=[['expression','表达控制'],['profile','声纹与档案'],['preview','试听与计划'],['integration','智能体接入']];
    if(!data||!config)return h('div',{'data-qs-emotion':true},error?h('p',{role:'alert'},error):h('p',null,'正在读取情绪档案…'));
    const profile=data.profile,presets=Object.entries(profile.emotion_presets),names=data.labels||{};
    const select=(name,value,items,onChange)=>h('select',{'aria-label':name,value,onChange:event=>onChange(event.target.value)},...items.map(([id,name])=>h('option',{key:id,value:id},name)));
    const range=(key,title,note)=>label(title,h('div',{className:'qe-range'},h('input',{type:'range',min:0,max:1,step:.05,value:config[key],'aria-label':title,onChange:e=>change(key,Number(e.target.value))}),h('output',null,Math.round(config[key]*100)+'%')),note);
    return h('section',{'data-qs-emotion':true},
      h('style',null,'[data-qs-emotion]{display:grid;gap:16px;font:inherit;min-width:0}[data-qs-emotion] *{box-sizing:border-box}[data-qs-emotion] h3,[data-qs-emotion] h4,[data-qs-emotion] p{margin:0}[data-qs-emotion] p{font-size:13px;line-height:1.8}[data-qs-emotion] small{font-size:12px;line-height:1.6;opacity:.75}[data-qs-emotion] button,[data-qs-emotion] select,[data-qs-emotion] textarea,[data-qs-emotion] input[type=file]{font:inherit;color:inherit;background:transparent;border:1px solid #87968c66;border-radius:7px;padding:9px 11px;min-height:40px;max-width:100%;min-width:0}[data-qs-emotion] select,[data-qs-emotion] textarea{width:100%}[data-qs-emotion] select{background:Canvas;color:CanvasText}[data-qs-emotion] textarea{resize:vertical;line-height:1.7}[data-qs-emotion] button{cursor:pointer}[data-qs-emotion] button:disabled{opacity:.45;cursor:not-allowed}[data-qs-emotion] :focus-visible{outline:2px solid #719a8e;outline-offset:2px}[data-qs-emotion] .qe-tabs,[data-qs-emotion] .qe-actions{display:flex;gap:8px;flex-wrap:wrap}[data-qs-emotion] .qe-tabs [aria-selected=true]{background:#355a4d;color:white}[data-qs-emotion] .qe-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:18px}[data-qs-emotion] .qe-field{display:grid;gap:8px;font-size:13px}[data-qs-emotion] .qe-range{display:flex;gap:12px;align-items:center}[data-qs-emotion] .qe-range input{flex:1;min-width:0;accent-color:#547d6a}[data-qs-emotion] output{font-variant-numeric:tabular-nums;min-width:40px}[data-qs-emotion] .qe-check{display:flex;gap:9px;align-items:center;font-size:13px;min-height:40px}[data-qs-emotion] .qe-check input{accent-color:#547d6a;width:17px;height:17px}[data-qs-emotion] .qe-box{padding:15px;border:1px solid #87968c44;border-radius:9px;display:grid;gap:12px;overflow-wrap:anywhere}[data-qs-emotion] pre{font:12px/1.7 monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}[data-qs-emotion] details{margin:0}[data-qs-emotion] summary{cursor:pointer;padding-block:7px}[data-qs-emotion] .qe-notice{padding:12px;border:1px solid #87968c66;border-radius:8px;font-size:13px;line-height:1.7}'),
      h('header',null,h('h3',null,profile.character+' · 自动表达引擎'),h('p',null,'默认自动理解回答的语用意图，并结合当前会话状态平滑调整表达；手动选择和智能体标记只用于覆盖特殊场景。')),
      h('div',{role:'tablist','aria-label':'情绪控制功能',className:'qe-tabs'},...tabs.map(([id,title])=>h('button',{type:'button',role:'tab',key:id,'aria-selected':tab===id,onClick:()=>setTab(id)},title))),
      error&&h('div',{className:'qe-notice',role:'alert'},error),message&&h('div',{className:'qe-notice',role:'status'},message),data.warning&&h('p',null,data.warning),
      tab==='expression'&&h('div',{className:'qe-box'},
        h('label',{className:'qe-check'},h('input',{type:'checkbox','aria-label':'启用自动表达引擎',checked:config.enabled,onChange:e=>change('enabled',e.target.checked)}),'启用自动表达引擎'),
        h('div',{className:'qe-grid'},label('控制来源',select('控制来源',config.mode,[['auto','自动理解'],['manual','手动选择'],['marked','智能体显式标记']],v=>change('mode',v)),'自动模式按整句语义做保守判断，严肃任务优先清晰度，不用单个关键词决定情绪。'),
          label('情绪预设',select('情绪预设',config.preset,presets.map(([id])=>[id,names[id]||id]),v=>change('preset',v)),profile.emotion_presets[config.preset]?.direction)),
        h('div',{className:'qe-grid'},range('strength','表达强度','目标强度；最终还受强度上限和连续性约束。'),range('maxStrength','强度上限','限制惊讶、嘴硬等状态的表达幅度。'),range('continuity','情绪延续','越高越缓慢靠近目标；100% 保持当前数值目标。')),
        h('label',{className:'qe-check'},h('input',{type:'checkbox','aria-label':'严肃任务优先',checked:config.serious,onChange:e=>change('serious',e.target.checked)}),'严肃任务优先：清晰解释，收敛装饰语气'),
        h('label',{className:'qe-check'},h('input',{type:'checkbox','aria-label':'口癖节制演绎',checked:config.signature,onChange:e=>change('signature',e.target.checked)}),'口癖节制演绎'),
        h('small',null,'仅演绎原文已有口癖，不额外插入或删除台词。自动表达会固定使用克制连贯声线模式；受冷却 '+profile.signature_policy.cooldown_turns+' 轮、每次 '+profile.signature_policy.utterance_phrase_cap+' 个和覆盖率 '+Math.round(profile.signature_policy.approx_phrase_coverage_cap*100)+'% 限制；严肃、安慰、低落和紧急状态收敛。'),
        h('div',{className:'qe-actions'},button('应用到后续朗读',()=>run(async signal=>{await apply(signal);setMessage('情绪设置已保存，后续朗读生效。');})),button('重置当前会话情绪',()=>run(async signal=>{await call({action:'emotion.reset'},signal);setPlan(null);setMessage('当前会话回到中性起点，声纹参考保留。');}))),
        h('details',null,h('summary',null,'查看预设设计目标'),h('pre',null,JSON.stringify(profile.emotion_presets[config.preset],null,2)),h('small',null,'rate、半音、气声和毫秒停顿是设计目标。本引擎不提供这些数值的精确声学执行；连续性也不是音频交叉淡化。'))),
      tab==='profile'&&h('div',{className:'qe-box'},h('h4',null,'声纹与情绪分开'),
        h('p',null,profile.voice_identity.description),h('p',null,'导入情绪档案不会替换你已选择的参考音色。设计包没有录音；要建立鲸鲸声线，可新建基础音色后试听，再保存满意的固定参考。'),
        button('按档案新建基础音色',()=>run(async signal=>{await call({action:'emotion.createVoice'},signal);setMessage('已建立新的基础音色并选用；原音色保留。首次朗读需校准，请试听确认。');})),
        label('导入情绪档案 JSON',h('input',{type:'file',accept:'.json,application/json','aria-label':'导入情绪档案 JSON',disabled:busy,onChange:e=>{const file=e.target.files?.[0];if(file)run(async signal=>{if(file.size>100000)throw Error('情绪档案最多 100 KB。');const value=await call({action:'emotion.import',profile:JSON.parse(await file.text())},signal);setData(value);setConfig(value.config);setPlan(null);setMessage('情绪档案已导入；当前声纹未替换。');});}}),'可使用压缩包中的 voice_profile.json；参数会先校验再保存。'),
        button('导出情绪档案',()=>run(async signal=>{const value=await call({action:'emotion.export'},signal),url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='qingsheng-emotion-profile.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),5000);setMessage('情绪档案已导出，不含录音与会话。');})),
        h('details',null,h('summary',null,'查看完整档案'),h('pre',null,JSON.stringify(profile,null,2)))),
      tab==='preview'&&h('div',{className:'qe-box'},
        label('测试台词',select('测试台词','', [['','选择设计包测试台词'],...data.testLines.map((line,index)=>[String(index),(names[line.emotion]||line.emotion)+' · '+line.text])],index=>{if(index!==''){const line=data.testLines[Number(index)];setText(line.text);setConfig(c=>({...c,mode:'manual',preset:line.emotion}));setPlan(null);}})),
        label('试听文本',h('textarea',{'aria-label':'情绪试听文本',value:text,rows:4,maxLength:1000,onChange:e=>setText(e.target.value)})),
        h('div',{className:'qe-actions'},button('应用并查看计划',()=>preview(false)),button('应用并试听',()=>preview(true)),button('停止试听',()=>run(signal=>call({action:'stop'},signal)))),
        plan&&h('div',{'data-emotion-plan':true,className:'qe-box'},h('strong',null,plan.segments.length+' 段 · '+plan.method),...plan.segments.map((s,index)=>h('article',{key:index,className:'qe-box'},h('strong',null,(index+1)+'. '+s.label+' · 目标 '+Math.round(s.strength*100)+'% / 平滑目标 '+Math.round(s.appliedStrength*100)+'%'),h('p',null,s.text),h('small',null,s.hardTransition?'显式紧急切换':s.serious?'严肃表达，装饰收敛':'按当前会话状态逐步过渡'),h('details',null,h('summary',null,'查看生成指令与参数目标'),h('p',null,s.instruction),h('pre',null,JSON.stringify(s.smoothedTarget,null,2)))))),
        h('details',null,h('summary',null,'最近完成的朗读计划'),h('pre',null,JSON.stringify(data.lastPlan,null,2)))),
      tab==='integration'&&h('div',{className:'qe-box'},h('h4',null,'自主引擎与覆盖协议'),h('p',null,'默认使用“自动理解”：插件在本机根据整句语义、任务风险和当前会话余韵生成表达计划，不调用云端模型，也不会因为一个词就强行改变声音。需要智能体明确控制时再切到“智能体显式标记”，标记不会朗读；没有标记的部分仍可回到自动判断。'),
        h('pre',null,'[情绪:comfort:0.4]没关系，我们一件一件来。\n[情绪:work:0.5]这个结论还没有验证，我先查来源。\n[情绪:surprise:0.65]你真的做到了！\n[情绪:panic:0.7:急]先别点，那个选项会覆盖文件。'),
        h('p',null,'“急”仅在 surprise / panic 接受，用于显式允许快速切换。其他过渡遵循连续性设置。未知情绪或错误标记会报错，不把控制文字念出来。'),
        h('small',null,'接口支持 emotion.status / configure / plan / preview / import / export / reset。所有请求沿用 DSH 已认证通道；完整接入说明见插件文档。'))
    );
  }
  function EmotionDialog({call,onClose}){
    const dialog=useRef(null);useEffect(()=>{dialog.current.showModal();return()=>dialog.current?.close();},[]);
    return h('dialog',{ref:dialog,'aria-label':'情绪表达控制',onCancel:e=>{e.preventDefault();onClose();},style:{boxSizing:'border-box',width:'min(900px,94vw)',maxWidth:'94vw',maxHeight:'88vh',padding:22,border:'1px solid #87968c',borderRadius:12,overflow:'auto',background:'Canvas',color:'CanvasText'}},h('div',{style:{display:'flex',justifyContent:'flex-end',marginBottom:12}},h('button',{type:'button',style,onClick:onClose,'aria-label':'关闭情绪控制'},'关闭')),h(EmotionStudio,{call}));
  }

  async function clipWave(buffer,start,end,rate=24000){
    if(!buffer||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>buffer.duration+.01||end-start<.3||end-start>60)throw Error('请选择 0.3–60 秒的有效音频选段。');
    const offline=new OfflineAudioContext(1,Math.round((end-start)*rate),rate),source=offline.createBufferSource();source.buffer=buffer;source.connect(offline.destination);source.start(0,start,end-start);return wave(await offline.startRendering(),rate);
  }
  function VoiceSettings({call}) {
    const {status,error:connectionError,setStatus}=useStatus(call),[view,setView]=useState('library'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
    const empty={name:'',description:'',tags:'',seed:42,transcript:''};
    const [fields,setFields]=useState(empty),[editing,setEditing]=useState(null),[query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[removeId,setRemoveId]=useState('');
    const [fileName,setFileName]=useState(''),[buffer,setBuffer]=useState(null),[bundle,setBundle]=useState(null),[begin,setBegin]=useState(0),[end,setEnd]=useState(12),[sourceUrl,setSourceUrl]=useState(''),[originalUrl,setOriginalUrl]=useState('');
    const [previewText,setPreviewText]=useState('你好，我是大肥鱼。今天想和你聊点什么？');
    const alive=useRef(true),operation=useRef(null),fileRun=useRef(0),uid=React.useId();
    useEffect(()=>{alive.current=true;return()=>{alive.current=false;operation.current?.abort();fileRun.current++;};},[]);
    useEffect(()=>()=>{if(sourceUrl)URL.revokeObjectURL(sourceUrl);},[sourceUrl]);
    useEffect(()=>()=>{if(originalUrl)URL.revokeObjectURL(originalUrl);},[originalUrl]);
    const refresh=async()=>{const result=await call({action:'status'});if(alive.current)setStatus(result);};
    const run=async(input,after)=>{
      if(busy)return;const abort=new AbortController();operation.current=abort;setBusy(true);setError('');setMessage('');
      try{const result=await call(input,abort.signal);if(!alive.current)return;await after?.(result);await refresh();}
      catch(e){if(alive.current)setError(e.message);}
      finally{if(alive.current)setBusy(false);if(operation.current===abort)operation.current=null;}
    };
    const note=text=>setMessage(text);
    const change=(key,value)=>setFields(s=>({...s,[key]:value}));
    const metadata=()=>({name:fields.name,description:fields.description,transcript:fields.transcript,seed:Number(fields.seed),tags:fields.tags.split(/[，,]/).map(s=>s.trim()).filter(Boolean)});
    const reset=(next='design')=>{fileRun.current++;setEditing(null);setFields(empty);setFileName('');setBuffer(null);setBundle(null);setSourceUrl('');setView(next);setError('');setMessage('');};
    const field=(name,control,hint)=>h('label',{className:'qs-field'},h('span',null,name),control,hint&&h('small',null,hint));
    const text=(name,value,onChange,props={})=>h('input',{value,onChange:e=>onChange(e.target.value),'aria-label':name,...props});
    const area=(name,value,onChange,props={})=>h('textarea',{value,onChange:e=>onChange(e.target.value),'aria-label':name,rows:3,...props});
    const button=(label,onClick,props={})=>h('button',{type:'button',onClick,disabled:busy,...props},label);
    const tabs=[['library','音色库'],['import','导入音色'],['design','设计音色']];
    const chooseTab=key=>{setView(key);setError('');setMessage('');};
    const loadFile=async file=>{
      if(!file)return;const generation=++fileRun.current;setError('');setMessage('');setBuffer(null);setBundle(null);setSourceUrl('');setFileName(file.name);
      let context;try{
        if(file.size>20*1024*1024)throw Error('源文件请控制在 20 MB 内。');
        if(file.name.toLowerCase().endsWith('.json')){
          if(file.size>6*1024*1024)throw Error('音色文件最多 6 MB。');const value=JSON.parse(await file.text());
          if(value.format!=='qingsheng-voice'||value.version!==1||!value.voice)throw Error('不是受支持的清声音色文件。');
          if(generation!==fileRun.current)return;setBundle(value);setFields({...empty,...value.voice,tags:(value.voice.tags||[]).join('，')});note('已读取音色文件，确认信息后导入。');return;
        }
        context=new AudioContext();const decoded=await context.decodeAudioData(await file.arrayBuffer());
        if(generation!==fileRun.current)return;if(decoded.duration<.3)throw Error('音频太短，请使用至少 0.3 秒的录音。');
        setBuffer(decoded);setBegin(0);setEnd(Math.min(12,decoded.duration));setSourceUrl(URL.createObjectURL(file));
        setFields(s=>({...s,name:s.name||file.name.replace(/[.][^.]+$/,'').slice(0,40),description:s.description||'导入的参考声线，自然、清晰，保留原始音色特征。'}));
      }catch(e){if(generation===fileRun.current)setError(e.message);}finally{if(context)await context.close();}
    };
    const save=async(preview=false)=>{
      const voice=metadata();if(!voice.name.trim()||!voice.description.trim()){setError('请填写音色名称和声音描述。');return;}
      if(view==='import'){
        if(bundle){await run({action:'voice.import',bundle:{...bundle,voice}},()=>{note('音色已导入并用于朗读。');setView('library');});return;}
        if(!buffer){setError('请先选择参考录音或清声音色文件。');return;}
        if(!voice.transcript.trim()){setError('请填写准确文字稿，或先识别选段文字。');return;}
        let audio;try{audio=await clipWave(buffer,Number(begin),Number(end));}catch(e){setError(e.message);return;}
        await run({action:'voice.save',voice,audio},()=>{note('参考音色已保存并用于朗读。');setView('library');});return;
      }
      await run({action:'voice.save',id:editing?.id,voice},async saved=>{
        setEditing(saved);note(preview?'设定已保存，正在生成试听。':'音色设定已保存。');
        if(preview)await call({action:'voice.preview',id:saved.id,text:previewText});
      });
    };
    const transcribeClip=async()=>{
      let base64;try{base64=await clipWave(buffer,Number(begin),Number(end),16000);}catch(e){setError(e.message);return;}
      await run({action:'transcribe',base64},result=>{change('transcript',result.text||'');note('已识别选段文字，请听录音校正后保存。');});
    };
    const exportVoice=voice=>run({action:'voice.export',id:voice.id},bundle=>{
      const url=URL.createObjectURL(new Blob([JSON.stringify(bundle,null,2)],{type:'application/json'})),link=document.createElement('a');
      link.href=url;link.download='qingsheng-'+voice.id+'.qvoice.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),5000);note('音色文件已导出，参考音色会包含录音。');
    });
    const edit=voice=>{setEditing(voice);setFields({...voice,tags:(voice.tags||[]).join('，')});setView('design');setError('');setMessage('');};
    const preview=status?.preview,voices=(status?.voices||[]),selected=voices.find(v=>v.id===status?.preferences?.voiceId);
    const matching=voices.filter(v=>(filter==='all'||v.kind===filter)&&[v.name,v.description,...(v.tags||[])].join(' ').toLowerCase().includes(query.toLowerCase()));
    const previewVisible=!!preview&&!!editing&&preview.voiceId===editing.id;
    const editor=h('div',{className:'qs-form'},
      field('音色名称',text('音色名称',fields.name,v=>change('name',v),{maxLength:40,required:true})),
      field('声音描述',area('声音描述',fields.description,v=>change('description',v),{maxLength:2000,placeholder:'例如：成年男性，中低音，温润沉稳，咬字自然，适合日常交流。',required:true})),
      h('div',{className:'qs-grid'},field('标签',text('标签',fields.tags,v=>change('tags',v)), '逗号分隔，最多 4 个，每个最多 12 字。'),
        field('随机种子',h('div',{className:'qs-actions'},text('随机种子',fields.seed,v=>change('seed',v),{type:'number',min:0,max:2147483647,step:1}),button('换一个种子',()=>change('seed',Math.floor(Math.random()*2147483647)))),'相同设定沿用种子；稳定声线需要参考录音。')),
      (view==='import'||editing?.kind==='reference')&&field('准确文字稿',area('准确文字稿',fields.transcript,v=>change('transcript',v),{maxLength:6000,placeholder:'与参考选段逐字对应；识别结果请人工校正。'})),
      view==='design'&&field('试听台词',area('试听台词',previewText,setPreviewText,{maxLength:180,rows:2})),
      h('div',{className:'qs-actions'},button(view==='import'?'保存并使用音色':editing?'保存修改':'保存文字设定',()=>save(false),{className:'qs-primary'}),
        view==='design'&&button('保存并生成试听',()=>save(true),{disabled:busy||!status?.engine?.ready}),editing&&button('新建设定',()=>reset('design'))),
      previewVisible&&h('div',{className:'qs-result'},
        h('strong',null,preview.status==='completed'?'试听已生成':preview.status==='generating'?'正在生成试听…':preview.status==='cancelled'?'试听已停止':'试听生成失败'),
        preview.error&&h('p',null,preview.error),
        preview.status==='completed'&&!preview.savedVoiceId&&button('将本次试听保存为固定声线',()=>run({action:'voice.promote',jobId:preview.jobId,name:(fields.name||'新音色').slice(0,34)+' · 固定'},()=>{note('固定声线已保存并用于朗读。');setView('library');})),
        preview.savedVoiceId&&h('span',null,'已保存到音色库。'))
    );
    return h('section',{'data-qingsheng-settings':true,'data-qs-studio':true},
      h('style',null,'[data-qs-studio]{font:inherit;font-size:14px;display:grid;gap:16px;min-width:0}[data-qs-studio] *{box-sizing:border-box}[data-qs-studio] h3,[data-qs-studio] p{margin:0}[data-qs-studio] small{font-size:12px;line-height:1.5;opacity:.8}[data-qs-studio] button,[data-qs-studio] input,[data-qs-studio] select,[data-qs-studio] textarea{font:inherit;color:inherit;border:1px solid var(--border-color,#b8bfc0);border-radius:8px;background:transparent;padding:10px 12px;min-height:44px;min-width:0}[data-qs-studio] button{cursor:pointer}[data-qs-studio] button:disabled{opacity:.5;cursor:not-allowed}[data-qs-studio] :focus-visible{outline:2px solid #4d73bb;outline-offset:2px}[data-qs-studio] input,[data-qs-studio] textarea{width:100%}[data-qs-studio] textarea{resize:vertical;line-height:1.6}[data-qs-studio] .qs-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}[data-qs-studio] .qs-field,[data-qs-studio] .qs-form{display:grid;gap:8px}[data-qs-studio] .qs-form{gap:16px}[data-qs-studio] .qs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:16px}[data-qs-studio] .qs-card,[data-qs-studio] .qs-result{padding:16px;border:1px solid var(--border-color,#cfd4d3);border-radius:10px;display:grid;gap:12px;overflow-wrap:anywhere}[data-qs-studio] .qs-card[data-selected=true]{border-color:#517a6a;border-width:2px}[data-qs-studio] .qs-card p{font-size:13px;line-height:1.6}[data-qs-studio] [role=tab][aria-selected=true],[data-qs-studio] .qs-primary{background:#355a4d;color:white;border-color:#355a4d}[data-qs-studio] audio{width:100%;max-width:100%}[data-qs-studio] .qs-feedback{padding:12px;border:1px solid currentColor;border-radius:8px;line-height:1.6}[data-qs-studio] .qs-actions input{flex:1;min-width:120px}'),
      h('header',{className:'qs-form'},h('h3',null,'大肥鱼 · 声音工作室'),h('small',null,'本地音色库 · 导入参考录音 · 设计并固定声线'),
        h('div',{className:'qs-actions'},h('span',null,status?.connected?(status.engine?.ready?'声音模型已就绪':'清声已连接，模型未就绪'):'清声未连接'),button('启动清声',()=>run({action:'launch'},()=>note('启动请求已发送，请等待模型就绪。'))),button('刷新',refresh),button('停止声音',()=>run({action:'stop'}))),
        selected&&h('small',null,'当前朗读：'+selected.name+' · '+(status?.playback?.voiceLocked?'参考声线已固定':'首次回复后自动固定会话声线'))),
      h('div',{className:'qs-actions',role:'tablist','aria-label':'音色功能'},...tabs.map(([key,label],index)=>h('button',{type:'button',key,role:'tab',id:uid+'-'+key,'aria-selected':view===key,'aria-controls':uid+'-panel',tabIndex:view===key?0:-1,onClick:()=>chooseTab(key),onKeyDown:e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();const next=tabs[(index+(e.key==='ArrowRight'?1:2))%3][0];chooseTab(next);document.getElementById(uid+'-'+next)?.focus();}}},label))),
      (error||connectionError)&&h('div',{className:'qs-feedback',role:'alert'},error||connectionError),
      message&&h('div',{className:'qs-feedback',role:'status'},message),busy&&h('div',{role:'status'},'正在处理…'),
      h('div',{id:uid+'-panel',role:'tabpanel','aria-labelledby':uid+'-'+view},
        view==='library'?h('div',{className:'qs-form'},
          h('div',{className:'qs-actions'},text('搜索音色',query,setQuery,{type:'search',placeholder:'搜索名称、描述或标签'}),h('select',{'aria-label':'音色类型',value:filter,onChange:e=>setFilter(e.target.value)},h('option',{value:'all'},'全部音色'),h('option',{value:'reference'},'固定参考'),h('option',{value:'design'},'文字设定')),button('新建音色',()=>reset('design'))),
          h('small',null,matching.length+' 个音色；与清声工作台共用同一音色库。'),
          originalUrl&&h('audio',{controls:true,src:originalUrl,'aria-label':'参考录音回听'}),
          !matching.length&&h('div',{className:'qs-card'},h('strong',null,voices.length?'没有匹配的音色':'音色库为空'),h('p',null,'可以导入已有录音，也可以用文字设计一个声音。'),h('div',{className:'qs-actions'},button('导入录音',()=>reset('import')),button('设计声音',()=>reset('design')))),
          h('div',{className:'qs-grid'},...matching.map(voice=>h('article',{className:'qs-card',key:voice.id,'data-selected':selected?.id===voice.id},
            h('div',null,h('strong',null,voice.name),h('small',{style:{display:'block',marginTop:4}},voice.kind==='reference'?'固定参考声线':'文字设定 · 会话内自动固定')),h('p',null,voice.description),voice.tags?.length>0&&h('small',null,voice.tags.join(' / ')),
            h('div',{className:'qs-actions'},button(selected?.id===voice.id?'正在用于朗读':'用于朗读',()=>run({action:'configure',preferences:{voiceId:voice.id}},()=>note('已切换朗读音色。')),{disabled:busy||selected?.id===voice.id}),button('试听',()=>run({action:'voice.preview',id:voice.id,text:previewText}),{disabled:busy||!status?.engine?.ready}),voice.kind==='reference'&&button('听参考',()=>run({action:'voice.audio',id:voice.id},audio=>{const bytes=Uint8Array.from(atob(audio.base64),c=>c.charCodeAt(0));setOriginalUrl(URL.createObjectURL(new Blob([bytes],{type:'audio/wav'})));}))),
            h('div',{className:'qs-actions'},button('编辑',()=>edit(voice)),button('复制',()=>run({action:'voice.duplicate',id:voice.id},()=>note('副本已添加到音色库。'))),button('导出',()=>exportVoice(voice)),button('删除',()=>setRemoveId(voice.id),{'aria-label':'删除音色 '+voice.name})),
            removeId===voice.id&&h('div',{className:'qs-result',role:'alertdialog','aria-label':'删除音色确认'},h('p',null,'删除“'+voice.name+'”的音色档案？生成记录和原始录音会保留。'),h('div',{className:'qs-actions'},button('确认删除',()=>run({action:'voice.delete',id:voice.id},()=>{setRemoveId('');note('音色档案已删除。');})),button('取消删除',()=>setRemoveId(''),{autoFocus:true})))
          )))
        ):h('div',{className:'qs-form'},
          h('h3',null,view==='import'?'导入参考音色':editing?'编辑音色':'设计一个声音'),
          view==='import'&&h('div',{className:'qs-form'},field('参考音频或音色文件',h('input',{type:'file',accept:'audio/*,.json,.qvoice.json',onChange:e=>loadFile(e.target.files?.[0]),disabled:busy}),'音频最多 20 MB，可截取 0.3–60 秒；也支持导入 .qvoice.json 音色文件。'),fileName&&h('small',null,fileName),
            sourceUrl&&h('audio',{controls:true,src:sourceUrl,'aria-label':'导入录音回听'}),buffer&&h('div',{className:'qs-form'},h('small',null,'源录音 '+buffer.duration.toFixed(2)+' 秒；保存时转换为 24 kHz 单声道 WAV。'),
              h('div',{className:'qs-grid'},field('开始秒数',text('开始秒数',begin,setBegin,{type:'number',min:0,max:buffer.duration,step:.1})),field('结束秒数',text('结束秒数',end,setEnd,{type:'number',min:0,max:buffer.duration,step:.1}))),button('识别选段文字',transcribeClip))),
          view==='design'&&h('small',null,'先保存设定并试听；满意后保存为固定参考声线，可以更稳定地复用音色。'),editor
        )
      ),
      status?.warning&&h('small',{role:'status'},status.warning),status?.error&&h('small',{role:'alert'},status.error)
    );
  }
  function VoiceDialog({call,onClose}){
    const dialog=useRef(null);useEffect(()=>{dialog.current.showModal();return()=>dialog.current?.close();},[]);
    const [tab,setTab]=useState('studio'),[url,setUrl]=useState(''),[note,setNote]=useState('正在准备本地声音服务…');
    // 工作台是独立进程，插件后台没起来时这里主动叫一次；起不来就说清楚原因，别让用户对着空白 iframe 猜。
    useEffect(()=>{
      let alive=true;
      (async()=>{
        try{
          const r=await call({action:'studio.ensure'});
          if(!alive)return;
          if(r?.ready){setUrl(r.url||'http://127.0.0.1:3210');setNote('');}
          else setNote(r?.reason==='not-installed'?'没有找到清声工作台安装目录，请先安装桌面版。':'本地声音服务还没起来，稍后再试或稍等模型加载。');
        }catch(e){if(alive)setNote(e.message);}
      })();
      return()=>{alive=false;};
    },[call]);
    const tabStyle=key=>({...style,minHeight:36,marginRight:8,...(tab===key?{fontWeight:600,textDecoration:'underline'}:{})});
    return h('dialog',{ref:dialog,'aria-label':'声音工作室',onCancel:e=>{e.preventDefault();onClose();},style:{boxSizing:'border-box',minWidth:0,width:'min(1180px,96vw)',maxWidth:'96vw',maxHeight:'90vh',padding:16,border:'1px solid #bbc2bf',borderRadius:12,overflow:'auto',color:'inherit',background:'Canvas'}},
      h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}},
        h('div',{role:'tablist','aria-label':'声音工作室分页'},
          h('button',{type:'button',role:'tab',style:tabStyle('studio'),'aria-selected':tab==='studio',onClick:()=>setTab('studio')},'工作台'),
          h('button',{type:'button',role:'tab',style:tabStyle('voice'),'aria-selected':tab==='voice',onClick:()=>setTab('voice')},'音色与情绪')),
        h('button',{type:'button',style:{...style,minHeight:40},onClick:onClose,'aria-label':'关闭声音工作室'},'关闭')),
      tab==='studio'
        ? (url
            ? h('iframe',{src:url,title:'清声工作台',style:{width:'100%',height:'min(78vh,860px)',border:'1px solid #bbc2bf',borderRadius:8,background:'#fff'},allow:'microphone; autoplay; clipboard-write'})
            : h('div',{style:{padding:'28px 8px',textAlign:'center'}},note))
        : h(VoiceSettings,{call}));
  }

  function apply(ctx) {
    const call=async(input,signal)=>{const r=await ctx.connection.rpc.call('/api','qingsheng/control',input,signal);if(!r.ok){const message=r.error?.message||'语音插件连接失败。';throw Error(message.includes('未知语音操作')?'插件界面与后台版本不同，请在 DSH 中重新加载清声插件或重启 DSH。':message);}return r.value;};
    // 扩展点：其它插件（如通话）把按钮挂进这条工具栏，而不是抢占同一个插槽把整组按钮替换掉。
    const extras=[];
    const listeners=new Set();
    const notify=()=>{ for(const fn of listeners) { try{ fn(); }catch{} } };
    const subscribe=fn=>{ listeners.add(fn); return ()=>listeners.delete(fn); };
    const extraApi=Object.freeze({
      subscribe,
      add:render=>{if(typeof render!=='function')throw Error('按钮必须是渲染函数。');const id={n:extras.length};extras.push(render);notify();return id;},
      remove:id=>{if(id&&typeof id.n==='number'){extras[id.n]=null;notify();}},
    });
    // 扩展点：通话插件把按钮挂进这条工具栏，而不是抢占同一个插槽。
    // 用 ctx.provide 注册服务（DSH 客户端没有 ctx.set），第三个参数 check 必须给，
    // 否则 ctx.inject 侧可能判定为不可用而永远等不到。
    // provide 内部只在 fiber.state===2 时 notify 等待者；直接在 apply 里调用可能早于 fiber 激活，
    // 导致 ctx.inject 侧永远收不到通知。所以放进 ctx.effect 里注册。
    const registerExtra = () => {
      try { ctx.provide('qingshengVoiceToolbar', extraApi, () => true); }
      catch (e) { ctx.logger?.warn?.('扩展点注册失败：' + e.message); }
    };
    try {
      if(typeof ctx.effect === 'function') ctx.effect(registerExtra);
      else registerExtra();
    } catch (e) { ctx.logger?.warn?.('扩展点注册失败：' + e.message); }
    ctx.slots.inject('conversation.input.activity',()=>ctx.slots.register({name:'conversation.input.activity',inject:()=>({call,extra:Array.isArray(extras)?extras.filter(Boolean):[],subscribeExtra:subscribe})},VoiceControls));
    ctx.slots.inject('plugins.bundle.config',()=>ctx.slots.register({name:'plugins.bundle.config',key:'dsh-qingsheng-voice',inject:()=>({call})},VoiceSettings));
  }
  return {apply,inject:['connection','slots']};
}});
