  function VoiceControls({sessionId,inputActions,locked,onActiveChange,call}) {
    const {status,error:connectionError,setStatus}=useStatus(call);
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
