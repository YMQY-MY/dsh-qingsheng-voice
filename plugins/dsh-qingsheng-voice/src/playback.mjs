import {readFile,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {spokenText,splitSpeech} from './text.mjs';
import {steadyText,calibrationText,mouthPause} from './delivery.mjs';
import {stripEmotionMarkers, inferEmotion} from './emotion.mjs';
import {WhaleSpeakBridge, PRESET_TO_EMOTION, refineStrength} from './whalespeak-bridge.mjs';
export class ConversationPlayback {
  constructor(){this.lastAnswers=new Map();this.replyHistory=new Map();this.voiceLocks={};this.audioCache=new Map();this.lockSaves=Promise.resolve();this.paused=false;this.positionSeconds=0;this.totalSeconds=0;}
  async loadPlayback(){
    this.lockFile=path.join(this.config.dataRoot,'voice-locks.json');
    try{const data=JSON.parse(await readFile(this.lockFile,'utf8'));if(data&&typeof data==='object'&&!Array.isArray(data))this.voiceLocks=data;}catch(e){if(e.code!=='ENOENT')this.warning='会话声线记录无法读取，将重新固定声线。';}
  }
  rememberReply(text,meta={}){
    if(!this.focus)return null;const clean=spokenText(text);if(!clean)return null;
    const existingList=this.replyHistory.get(this.focus)||[],existing=existingList.at(-1);
    const id=String(meta.id||((existing?.text===clean)?existing.id:`${Date.now()}-${existingList.length}`)).slice(0,180);
    const list=this.replyHistory.get(this.focus)||[];const item={id,text:clean,context:String(meta.context||'').slice(0,2000),index:Number.isInteger(meta.index)?meta.index:null};
    const existingIndex=list.findIndex(value=>value.id===id);if(existingIndex>=0)list[existingIndex]=item;else list.push(item);
    while(list.length>50)list.shift();this.replyHistory.set(this.focus,list);this.lastAnswers.set(this.focus,clean);
    if(this.lastAnswers.size>30)this.lastAnswers.delete(this.lastAnswers.keys().next().value);return item;
  }
  // 段落之间的过渡停顿：情绪差距越大停得越久，让下一段有起音空间，避免硬切。
  // 段与段之间必须留换气间隙。原来 plan 为空时直接 return 0，
  // 调用处又是 if(pause>0) 才插静音，于是两段只剩 12ms 淡出接 12ms 淡入硬拼，
  // 听感就是「上一句还没收尾下一句就响了」（用户实测偶发）。
  // 现在无论有没有 plan 都给一个下限，没有情绪计划时也不能贴在一起。
  transitionPause(previous,current,plan){
    if(!previous)return 0;
    // 段间下限：低于 80ms 人耳会判成一句话被硬接
    const floor=80;
    const a=previous?.preset,b=current?.preset;
    if(!plan?.segments||!a||!b)return floor;
    if(a===b)return Math.max(floor,140);
    const diff=Math.max(Math.abs((previous.appliedStrength??previous.strength??0)-(current.appliedStrength??current.strength??0)),0.12);
    if(current.hardTransition||previous.hardTransition)return Math.max(floor,90);
    return Math.round(Math.min(520,Math.max(floor,220+diff*1400)));
  }
  // 段尾不落在零点、下一段又从满幅起音，直接拼会「咔」；
  // 对交界两侧各做 12ms 余弦淡出/淡入，才是自然的换气而不是被剪断。
  applyFades(bytes,rate,fadeIn,fadeOut){
    if(!bytes||bytes.length<4)return bytes;
    const out=Buffer.from(bytes);
    const total=Math.floor(out.length/2);
    const ramp=Math.min(total,Math.round(rate*0.012));
    if(fadeIn)for(let i=0;i<ramp;i++){const g=0.5-0.5*Math.cos(Math.PI*i/ramp);out.writeInt16LE(Math.round(out.readInt16LE(i*2)*g),i*2);}
    if(fadeOut)for(let i=0;i<ramp;i++){const p=total-1-i,g=0.5-0.5*Math.cos(Math.PI*i/ramp);out.writeInt16LE(Math.round(out.readInt16LE(p*2)*g),p*2);}
    return out;
  }
  async history(sessionId=this.focus){
    if(!sessionId)return[];const local=this.replyHistory.get(sessionId)||[];
    const loaded=this.readHistory?await this.readHistory(sessionId):[];
    if(!Array.isArray(loaded))return local.slice();
    const merged=new Map(loaded.map(item=>[item.id,item]));for(const item of local){const previous=merged.get(item.id);merged.set(item.id,{...previous,...item,context:item.context||previous?.context||''});}
    const result=[...merged.values()].slice(-50);this.replyHistory.set(sessionId,result);return result;
  }
  voiceKey(voice,forceSteady=false){const steady=forceSteady||this.preferences.delivery==='steady';return (steady?'neutral-v1':this.focus)+':'+createHash('sha256').update(JSON.stringify([voice.id,voice.description,voice.seed,voice.kind,voice.transcript])).digest('hex').slice(0,24);}
  async storeLock(key,reference){
    if(!/^[a-f0-9-]+[.]wav$/.test(reference?.reference||'')||typeof reference.transcript!=='string')throw Error('固定声线返回无效。');
    this.voiceLocks[key]=reference;const keys=Object.keys(this.voiceLocks);while(keys.length>80)delete this.voiceLocks[keys.shift()];
    await this.saveLocks();
  }
  async saveLocks(){
    const data=JSON.stringify(this.voiceLocks,null,2);
    this.lockSaves=this.lockSaves.catch(()=>{}).then(async()=>{await writeFile(this.lockFile+'.tmp',data);await rename(this.lockFile+'.tmp',this.lockFile);});await this.lockSaves;
  }
  async resetReference(){
    this.stop();await Promise.allSettled([...this.active]);const state=await this.studio.state();
    const voice=state.voices.find(v=>v.id===this.preferences.voiceId)||state.voices[0];
    if(!voice)throw Error('请先选择音色。');if(voice.kind==='reference')throw Error('固定参考音色使用原始录音，请更换参考录音或重新设计音色。');
    delete this.voiceLocks[this.voiceKey(voice)];this.audioCache.clear();await this.saveLocks();this.warning='已清除自动参考，下次朗读时重新建立。';return{reset:true};
  }
  stopPlayback(){
    this.generation++;this.controller?.abort(Error('声音已停止。'));this.controller=null;this.output=null;this.paused=false;this.phase='idle';
    if(this.preview?.status==='generating')this.preview.status='cancelled';
  }
  // 立即打断当前朗读，但不停止这一轮对话、也不销毁播放进程。
  // 通话插件听出用户开口时调它，让清声「听见就住口」；返回是否真的打断了在播的声音。
  interrupt(reason){
    const had=!!this.controller;
    this.generation++;this.controller?.abort(reason?Error(reason):Error('声音被打断。'));this.controller=null;
    try{this.player?.interrupt?.(Error(reason||'声音被打断。'));}catch{}
    this.output=null;this.paused=false;
    if(this.preview?.status==='generating')this.preview.status='cancelled';
    if(!this.phase||this.phase!=='error')this.phase='idle';
    return {interrupted:had,speaking:!!this.player?.speaking};
  }
  pause(){if(!this.controller)return{paused:false};this.paused=true;this.output?.pause();this.phase='paused';return{paused:true};}
  resume(){if(!this.controller||!this.paused)return{resumed:false};this.paused=false;this.output?.resume();this.phase=this.output?'playing':'generating';return{resumed:true};}
  async replay(replyId){
    const focus=this.focus,generation=this.generation;let item;
    if(replyId)item=(await this.history(focus)).find(value=>value.id===replyId);
    let text=item?.text||this.lastAnswers.get(focus);if(!text&&this.readLatest)text=await this.readLatest(focus);
    if(this.closed||this.focus!==focus||this.generation!==generation)return{started:false};
    if(!text?.trim())throw Error('当前会话还没有可以朗读的回答。');const remembered=this.rememberReply(text,item||{});this.speak(text,{replay:true,replyId:remembered?.id});return{started:true,replyId:remembered?.id};
  }
  previewVoice(id,text){
    if(typeof text!=='string'||!text.trim()||text.length>180)throw Error('试听台词需要 1–180 字。');
    this.speak(text,{voiceId:id,preview:true});return{started:true};
  }
  // 判定可以被打断，也有硬预算：默认最多等 whaleSpeak.budgetMs（0.6s），
  // 超时就用清声原强度先播——网络再慢也不能让朗读停摆。
  async waitJudgment(text,tone,emotion,signal){
    if(!this.whaleSpeak?.enabled) return null;
    const pending=this.whaleSpeak.judge(text,tone,emotion);
    const budget=Number(this.whaleSpeak.budgetMs)||600;
    const stoppers=[new Promise(resolve=>setTimeout(()=>resolve(null),budget))];
    if(signal){
      if(signal.aborted) return null;
      stoppers.push(new Promise(resolve=>{
        signal.addEventListener('abort',()=>resolve(null),{once:true});
      }));
    }
    return Promise.race([pending,...stoppers]);
  }
  async speechEmotionPlan(spoken,options={},signal){
    let override=options.emotionOverride;
    // 「[情绪:xx]」是她自己给出的心情，比任何关键词表都准，优先级最高。
    // 有标记时整个绕过 WhaleSpeak：让 plan 走 auto 模式解析标记。
    // 注意不能只把 override 置 undefined —— 下面判断 !override 就成立了，
    // WhaleSpeak 会照样跑并重新把 override 赋回来（踩过一次）。
    const hasMark=/\[情绪:[a-z_]+(?:[:：][^\]]*)?\]/.test(spoken);
    if(!hasMark&&!override&&this.whaleSpeak?.enabled){
      try{
        const base=inferEmotion(spoken),emotion=PRESET_TO_EMOTION[base.preset];
        const judgment=await this.waitJudgment(spoken,options.tone,emotion,signal);
        if(judgment){
          // emphasis 一并带下去：引擎已经算好哪几个字该重读，
          // 不带的话这段信息到这就断了，TTS 只能整句一个力度。
          override={...base,strength:refineStrength(spoken,base,judgment),emphasis:judgment.emphasis};
          this.whaleSpeak.stats.applied++;
        }else{
          // 判不动就退回清声原强度，绝不卡住播放。
          this.whaleSpeak.stats.skipped++;
        }
      }catch(error){this.whaleSpeak.stats.skipped++;this.whaleSpeak.lastError=String(error.message||error);}
    }
    return this.emotion.plan(spoken,this.focus||'local',{
      override,replay:!!options.replay,previousState:options.previousState,continuation:!!options.continuation,
    });
  }
  startPlayback(text,options={}){
    this.stop();this.error='';this.warning='';
    const player=options.player||this.player;
    const useEmotion=!options.preview&&(this.emotion.config.enabled||options.emotionPreview);
    const delivery=options.preview?'reference':useEmotion?'steady':this.preferences.delivery;
    const spoken=spokenText(text),knownReply=[...(this.replyHistory.get(this.focus)||[])].reverse().find(item=>item.text===spoken),replyId=options.replyId||knownReply?.id;
    // 清声本地规划与 WhaleSpeak 缓存同步完成；新判定在后台补，不阻塞首音。
    // 同步段不能 await（speak() 直接返回本函数的返回值，测试与打断依赖同步时序），
    // 但播放本身是异步的，所以把计算挪进 promise 里，首遍朗读就能吃到判定。
    let emotionPlan=null;
    const spokenRaw=spoken;
    const unmarked=stripEmotionMarkers(spoken);
    let clean=mouthPause(delivery==='steady'?steadyText(unmarked):unmarked);
    if(!clean)return Promise.resolve();
    const controller=new AbortController(),generation=this.generation,signal=controller.signal;this.controller=controller;
    const following=options.followingPhrases;
    const cancelFollowing=()=>{void following?.return?.();};
    if(following)signal.addEventListener('abort',cancelFollowing,{once:true});
    let heardText=clean;
    const focus=this.focus,voiceId=options.voiceId||this.preferences.voiceId;this.positionSeconds=0;this.totalSeconds=0;this.firstAudioMs=null;
    const preview=options.preview?{voiceId,status:'generating',jobId:null}:null;if(preview)this.preview=preview;
    const started=Date.now();
    const promise=(async()=>{
      try{
        // 清声定基调与安全阀，WhaleSpeak 的已有判定补 valence/arousal 强度；
        // 通话和普通朗读都走原有语气链，缓存未命中时不 await 网络。
        if(useEmotion){
          signal.throwIfAborted();
          // 首段合成必须保持同步时序（stop/打断依赖它），所以这里不排队等网络：
          // 命中已判好的结果就直接用，没命中就先按清声原强度播，
          // 判定在后台补、同时喂给下一句。bridge 在 assistant/message 时已提前发起，
          // 正常对话里到这一步基本都已就绪。
          // 解析情绪必须用带标记的原文：「[情绪:hungry:0.9]」是她在告诉我们
          // 这句话什么心情，剥早了就只剩关键词兜底，标记还会被当正文念出来。
          // 取到 plan 之后，plan.text 自己已经不含标记。
          const plan=await this.speechEmotionPlan(spokenRaw,options,signal);
          if(this.generation!==generation||signal.aborted)return;
          emotionPlan=plan;
          if(emotionPlan?.text){const t=mouthPause(delivery==='steady'?steadyText(emotionPlan.text):emotionPlan.text);if(t)clean=t;}
          heardText=clean;
        }
        if(!player.createStream){
          // 降级路径（无流式播放器）也要带情绪，否则情绪在实际环境里完全不生效。
          const fallbackParts=emotionPlan?.segments||splitSpeech(clean).map(text=>({text}));
          for(const part of fallbackParts){
            signal.throwIfAborted();this.phase='generating';
            const bytes=await this.studio.synthesize(part.text,voiceId,signal,()=>{},{direction:part.instruction});
            signal.throwIfAborted();this.phase='playing';await player.play(bytes,signal);
          }
          return;
        }
        this.phase='generating';const state=await this.studio.state(signal),voice=state.voices.find(v=>v.id===voiceId)||state.voices[0];
        if(!voice)throw Error('请先导入或设计一个音色。');if(!state.engine?.ready)throw Error('声音模型尚未就绪，请先启动清声。');
        const key=this.voiceKey(voice,delivery==='steady'),cacheKey=focus+':'+(replyId||'live')+':'+key+':'+(replyId?'historical':emotionPlan?.id||'plain')+':'+clean;
        const cached=!following&&!preview&&!options.emotionPreview&&this.audioCache.get(cacheKey);let stream,rate,stored=[],storedBytes=0,cacheable=true;
        const receive=async(bytes,sampleRate)=>{
          signal.throwIfAborted();
          if(!stream){rate=sampleRate;stream=player.createStream(rate,signal,position=>{if(this.generation===generation)this.positionSeconds=position;});this.output=stream;if(this.paused)stream.pause?.();}
          if(rate!==sampleRate)throw Error('音频采样率改变，请停止后重试。');
          if(this.firstAudioMs===null){await stream.ready;signal.throwIfAborted();this.firstAudioMs=Date.now()-started;options.onFirstAudio?.({firstAudioMs:this.firstAudioMs});}
          this.phase=this.paused?'paused':'playing';this.totalSeconds+=bytes.length/(rate*2);
          if(cacheable){storedBytes+=bytes.length;if(storedBytes>40*1024*1024){cacheable=false;stored=[];}else stored.push(bytes);}
          await stream.writePCM(bytes);
        };
        if(cached){for(const bytes of cached.chunks)await receive(bytes,cached.rate);this.replayedFromCache=true;}
        else{
          this.replayedFromCache=false;let reference=this.voiceLocks[key];
          const strategy=this.preferences.voiceStrategy||'clone';
          const lock=strategy==='clone'&&!preview&&voice.kind!=='reference'&&state.capabilities?.referenceLock;
          if(strategy==='clone'&&!preview&&voice.kind!=='reference'&&!lock)this.warning='清声版本尚不支持会话声线固定，请更新清声服务。';
          if(lock&&!reference&&delivery==='steady'){
            this.warning='首次建立中性参考声线，请稍候；后续会复用，不会朗读校准台词。';
            await this.studio.synthesize(calibrationText,voice.id,signal,()=>{},{state,voice,delivery,onChunk:async()=>{},onReference:async value=>{reference=value;await this.storeLock(key,value);}});
            signal.throwIfAborted();this.warning='';
          }
          // 逐段串行合成播放。此前试过预取（并行生成下一段），但清声一次只跑一个任务、
          // 并行只会把音频堆在内存里，还引入过未捕获 rejection 导致插件崩溃，已撤回。
          let previousPart=null;
          const initialParts=emotionPlan?.segments||(preview?[clean]:splitSpeech(clean)).map(text=>({text}));
          // A single consumer synthesizes the next phrase while the same native
          // stream plays queued PCM. No parallel TTS jobs and no per-phrase drain.
          const playback=this;
          const parts=following?(async function*(){
            yield* initialParts;
            for await(const phrase of following){
              signal.throwIfAborted();
              const phraseSpoken=spokenText(phrase);
              const plan=useEmotion?await playback.speechEmotionPlan(phraseSpoken,{
                ...options,previousState:emotionPlan?.nextState,continuation:true,
              }):null;
              const spoken=plan?.text||stripEmotionMarkers(phraseSpoken);
              const next=mouthPause(delivery==='steady'?steadyText(spoken):spoken);
              if(!next)continue;
              heardText+=next;
              if(plan){
                emotionPlan={...plan,source:emotionPlan.source+phraseSpoken,text:emotionPlan.text+plan.text,segments:[...emotionPlan.segments,...plan.segments]};
                yield* plan.segments;
              }else for(const text of splitSpeech(next))yield{text};
            }
          })():initialParts;
          for await(const part of parts){
            signal.throwIfAborted();
            if(previousPart&&rate){
              const pause=this.transitionPause(previousPart,part,emotionPlan);
              if(pause>0){const silence=Buffer.alloc(Math.round(rate*2*pause/1000));await receive(silence,rate);}
            }
            // 只截留本段最后 12ms 做淡出，其余边收边播；段尾才不会硬切到下一段的满幅起音。
            let tail=Buffer.alloc(0),segmentRate=rate||24000,segmentPlayed=false;
            const edge=()=>Math.max(2,Math.round(segmentRate*0.012)*2);
            const staged=async(bytes,sampleRate)=>{
              segmentRate=sampleRate;
              const joined=Buffer.concat([tail,Buffer.from(bytes)]);
              const keep=edge();
              if(joined.length<=keep){tail=joined;return;}
              const body=joined.subarray(0,joined.length-keep);
              tail=joined.subarray(joined.length-keep);
              if(!segmentPlayed){segmentPlayed=true;await receive(this.applyFades(body,sampleRate,true,false),sampleRate);}
              else await receive(body,sampleRate);
            };
            await this.studio.synthesize(part.text,voice.id,signal,id=>{if(preview&&id)preview.jobId=id;},{state,voice,reference,delivery,voiceStrategy:strategy,direction:part.instruction,onChunk:staged,...(lock&&!reference?{onReference:async value=>{reference=value;await this.storeLock(key,value);}}:{})});
            if(tail.length){
              const faded=this.applyFades(tail,segmentRate,!segmentPlayed,true);
              if(faded&&faded.length)await receive(faded,segmentRate);
            }
            previousPart=part;
          }
          if(preview)preview.status='completed';
        }
        if(stream)await stream.finish();signal.throwIfAborted();
        // 把自己刚念的音频落盘，供事后自己听、自己校准音色（不再依赖用户替我听）。
        // 只留最近 40 条，避免占满磁盘；失败不影响朗读本身。
        if(!preview&&!options.emotionPreview&&stored.length&&rate){
          try{
            const fs=await import('node:fs/promises');
            const outDir=path.join(this.config?.dataRoot||path.dirname(this.lockFile||'.'),'heard');
            await fs.mkdir(outDir,{recursive:true});
            const pcm=Buffer.concat(stored);
            const hdr=Buffer.alloc(44);
            hdr.write('RIFF',0,'ascii');hdr.writeUInt32LE(36+pcm.length,4);hdr.write('WAVE',8,'ascii');
            hdr.write('fmt ',12,'ascii');hdr.writeUInt32LE(16,16);hdr.writeUInt16LE(1,20);hdr.writeUInt16LE(1,22);
            hdr.writeUInt32LE(rate,24);hdr.writeUInt32LE(rate*2,28);hdr.writeUInt16LE(2,32);hdr.writeUInt16LE(16,34);
            hdr.write('data',36,'ascii');hdr.writeUInt32LE(pcm.length,40);
            const stamp=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
            const name=`${stamp}-${(replyId||'live').toString().replace(/[^\w.-]/g,'').slice(0,48)}.wav`;
            const txt=path.join(outDir,name.replace(/\.wav$/,'.txt'));
            await fs.writeFile(path.join(outDir,name),Buffer.concat([hdr,pcm]));
            await fs.writeFile(txt,heardText,'utf8');
            const all=(await fs.readdir(outDir)).filter(n=>n.endsWith('.wav')).sort();
            for(const old of all.slice(0,Math.max(0,all.length-40-1))){await fs.unlink(path.join(outDir,old)).catch(()=>{});await fs.unlink(path.join(outDir,old.replace(/\.wav$/,'.txt'))).catch(()=>{});}
            this.lastHeard={file:path.join(outDir,name),text:heardText,seconds:+(pcm.length/(rate*2)).toFixed(2)};
          }catch(e){this.warning='音频回存失败：'+e.message;}
        }
        if(emotionPlan){this.emotion.lastPlan=this.emotion.display(emotionPlan);if(!options.emotionPreview)await this.emotion.commit(emotionPlan);}
        if(!following&&!preview&&!options.emotionPreview&&!cached&&cacheable){this.audioCache.set(cacheKey,{chunks:stored,rate});while(this.audioCache.size>2)this.audioCache.delete(this.audioCache.keys().next().value);}
      }catch(e){if(!signal.aborted){this.error=e.message;this.phase='error';if(preview){preview.status='failed';preview.error=e.message;}controller.abort(e);}}
      finally{signal.removeEventListener('abort',cancelFollowing);if(following)await following.return?.();if(this.generation===generation){this.controller=null;this.output=null;this.paused=false;if(!this.error)this.phase='idle';}}
    })();
    this.active.add(promise);promise.finally(()=>this.active.delete(promise));return promise;
  }
  // 读取最近 N 条自己念过的音频（文件路径 + 对应台词 + 时长），用于自我试听与音色校准。
  async heardList(limit=10){
    const fs=await import('node:fs/promises');
    const dir=path.join(this.config?.dataRoot||path.dirname(this.lockFile||'.'),'heard');
    let names=[];try{names=await fs.readdir(dir);}catch{return [];}
    const wavs=names.filter(n=>n.endsWith('.wav')).sort().reverse().slice(0,Math.max(1,Math.min(50,limit)));
    const out=[];
    for(const n of wavs){
      let text='';try{text=await fs.readFile(path.join(dir,n.replace(/\.wav$/,'.txt')),'utf8');}catch{}
      let seconds=0;try{const st=await fs.stat(path.join(dir,n));seconds=+((st.size-44)/48000).toFixed(2);}catch{}
      out.push({file:path.join(dir,n),text,seconds});
    }
    return out;
  }
}
