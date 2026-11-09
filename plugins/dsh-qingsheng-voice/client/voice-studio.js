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
    return h('dialog',{ref:dialog,'aria-label':'声音工作室',onCancel:e=>{e.preventDefault();onClose();},style:{boxSizing:'border-box',minWidth:0,width:'min(960px,94vw)',maxWidth:'94vw',maxHeight:'86vh',padding:24,border:'1px solid #bbc2bf',borderRadius:12,overflow:'auto',color:'inherit',background:'Canvas'}},
      h('div',{style:{display:'flex',justifyContent:'flex-end',marginBottom:12}},h('button',{type:'button',style:{...style,minHeight:40},onClick:onClose,'aria-label':'关闭声音工作室'},'关闭')),h(VoiceSettings,{call}));
  }
