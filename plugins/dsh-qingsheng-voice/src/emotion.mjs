import {readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {splitSpeech} from './text.mjs';
import {steadyText} from './delivery.mjs';
const asset=JSON.parse(await readFile(new URL('./emotion-assets.json',import.meta.url),'utf8'));
const clone=value=>structuredClone(value),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
export function stripEmotionMarkers(source){const text=source.replace(/\[情绪:[^\]\r\n]{1,80}\]/g,'');if(text.includes('[情绪:'))throw Error('情绪标记格式无效。');return text;}
export const emotionLabels={neutral:'中性陪伴',surprise:'惊讶',proud:'小得意',shy:'害羞',tsundere:'嘴硬',curious:'好奇',hungry:'馋嘴',confused:'困惑',sad:'低落',comfort:'安慰',work:'认真工作',panic:'紧急提醒',playful:'调皮'};
const defaults={enabled:true,mode:'auto',preset:'neutral',strength:.45,maxStrength:.85,continuity:.72,signature:true,serious:false,automationVersion:1};
const fields={rate:[.75,1.25],pitch_offset_st:[-3,3],pitch_range_st:[.5,5],breathiness:[0,.4],intensity:[0,1]};
function number(value,min,max,name){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw Error(name+'超出支持范围。');return value;}
function text(value,max,name){if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(name+'无效。');return value.trim();}
function envelope(value){
  const out={};for(const [key,[min,max]] of Object.entries(fields))out[key]=number(value?.[key],min,max,key);
  if(!Array.isArray(value.pause_ms)||value.pause_ms.length!==2)throw Error('停顿范围无效。');
  out.pause_ms=value.pause_ms.map(v=>number(v,0,1000,'停顿'));if(out.pause_ms[0]>out.pause_ms[1])throw Error('停顿范围顺序无效。');
  return out;
}
export function validateProfile(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||JSON.stringify(value).length>100000)throw Error('情绪档案无效或超过 100 KB。');
  const presets={};for(const [id,preset] of Object.entries(value.emotion_presets||{})){
    if(!/^[a-z][a-z_]{0,24}$/.test(id)||Object.keys(presets).length>=20)throw Error('情绪标识无效。');
    presets[id]={...envelope(preset),direction:text(preset.direction,400,'演绎方向')};
  }
  if(!presets.neutral)throw Error('情绪档案必须包含 neutral。');
  const policy=value.signature_policy||{},transition=value.emotion_transition||{};
  const stringList=(values,max)=>{if(!Array.isArray(values)||values.length>20)throw Error('档案列表无效。');return values.map(v=>text(v,max,'档案条目'));};
  return{version:text(value.version,40,'档案版本'),character:text(value.character,80,'角色名称'),
    voice_identity:{voice_id:String(value.voice_identity?.voice_id||'UNBOUND').slice(0,80),lang:'zh-CN',description:text(value.voice_identity?.description,1000,'基础声纹描述'),timbre_anchor:stringList(value.voice_identity?.timbre_anchor||[],80),avoid:stringList(value.voice_identity?.avoid||[],100)},
    default:envelope(value.default),emotion_presets:presets,
    signature_policy:{strength:number(policy.strength??.6,0,1,'口癖强度'),cooldown_turns:number(policy.cooldown_turns??3,0,20,'口癖冷却'),utterance_phrase_cap:number(policy.utterance_phrase_cap??1,0,1,'口癖上限'),approx_phrase_coverage_cap:number(policy.approx_phrase_coverage_cap??.35,0,.5,'口癖覆盖率'),suppress_when:stringList(policy.suppress_when||[],100)},
    emotion_transition:{unit:'semantic_clause',smooth_ms:Array.isArray(transition.smooth_ms)?transition.smooth_ms.map(v=>number(v,100,2000,'过渡设计目标')):[220,650],hard_cut_allowed:'surprise/interruption only',timbre_consistency:'fixed speaker identity'}};
}
const hasAny=(text,words)=>words.some(word=>text.includes(word));
const semanticClauses=source=>{
  const raw=source.match(/[^。！？!?；;\n]+[。！？!?；;\n]*/g)||[];
  // 过短的小句（如「哼呜！」）单独成段会让情绪悬空、引擎只能凭两个音节重新起音。
  // 短感叹通常是引出后文（哼呜！我才没有…），所以往后并；末尾实在没有下文才向前并。
  const body=part=>part.replace(/[。！？!?；;\s]/g,"");
  const merged=[];
  for(const part of raw){
    if(!body(part))continue;
    if(body(part).length<4){merged.push({text:part,short:true});continue;}
    const last=merged[merged.length-1];
    if(last&&last.short){merged[merged.length-1]={text:last.text+part,short:false};continue;}
    if(!last){merged.push({text:part,short:false});continue;}
    if(body(last.text).length<6){merged[merged.length-1]={text:last.text+part,short:false};continue;}
    merged.push({text:part,short:false});
  }
  if(merged.length>1&&merged[merged.length-1].short){
    const tail=merged.pop();
    merged[merged.length-1]={text:merged[merged.length-1].text+tail.text,short:false};
  }
  return merged.map(item=>item.text);
};
export function inferEmotion(text){
  const value=String(text||'').trim(),plain=value.replace(/\s+/g,'');
  if(!plain)return{preset:'neutral',strength:0,serious:false,reason:'empty'};
  if(hasAny(plain,['删除','覆盖','停止','取消','危险','不要点','别点','会丢失','报错','无法启动','失败','删掉','清空','格式化']))
    return{preset:plain.includes('不要')||plain.includes('别点')||plain.includes('危险')?'panic':'work',strength:.42,serious:true,hard:plain.includes('不要')||plain.includes('别点')||plain.includes('停止'),reason:'risk-or-interruption'};
  if(hasAny(plain,['嘿嘿','不用夸','我早就','轮到本鲸','厉害一下','才不是运气','发现啦','做到啦']))
    return{preset:'proud',strength:.32,serious:false,reason:'achievement'};
  if(hasAny(plain,['哼呜','我才','才没有','才不','谁要','谁稀罕','不许','别叫','只是','而已嘛','干嘛','说什么呢','听不见']))
    return{preset:'tsundere',strength:.36,serious:false,reason:'tsundere-protest'};
  if(hasAny(plain,['呜咿','脸红','害羞','不好意思','不知道怎','别看我','太难为情','好羞','不好意思啦']))
    return{preset:'shy',strength:.34,serious:false,reason:'shy'};
  if(hasAny(plain,['没关系','别急','先别急','对不起','抱歉','辛苦了','我在这里','难过','遗憾']))
    return{preset:hasAny(plain,['难过','遗憾'])?'sad':'comfort',strength:.34,serious:true,reason:'care'};
  if(hasAny(plain,['嘿嘿','不用夸','我早就','轮到本鲸','厉害一下','才不是运气','发现啦','做到啦']))
    return{preset:'proud',strength:.32,serious:false,reason:'achievement'};
  if(hasAny(plain,['真的','居然','突然','没想到','太好了','？','！'])&&hasAny(plain,['突然','居然','没想到','？！','?!']))
    return{preset:'surprise',strength:.34,serious:false,reason:'surprise'};
  if(/[？?]$/.test(plain)||hasAny(plain,['为什么','怎么','如何','什么','哪一个','能不能','是否','请问']))
    return{preset:'curious',strength:.3,serious:false,reason:'question'};
  if(hasAny(plain,['真的','居然','突然','没想到','太好了'])||/[！!]$/.test(plain)&&plain.length<36)
    return{preset:'surprise',strength:.32,serious:false,reason:'surprise'};
  if(hasAny(plain,['完成','成功','做到了','厉害','很棒','不错']))
    return{preset:'proud',strength:.3,serious:false,reason:'achievement'};
  if(hasAny(plain,['饿了','肚子饿','想吃饭','想吃点','好想吃','该吃饭了'])&&plain.length<80)
    return{preset:'hungry',strength:.28,serious:false,reason:'food-context'};
  if(hasAny(plain,['不明白','搞不懂','不确定','有点乱','疑问']))
    return{preset:'confused',strength:.28,serious:false,reason:'uncertainty'};
  if(hasAny(plain,['嘿嘿','开个玩笑','逗你','好玩']))
    return{preset:'playful',strength:.25,serious:false,reason:'play'};
  if(hasAny(plain,['核对','检查','验证','步骤','配置','文件','结果','来源','说明','注意']))
    return{preset:'work',strength:.24,serious:true,reason:'task'};
  return{preset:'neutral',strength:0,serious:false,reason:'neutral'};
}
export class EmotionController{
  constructor(root){this.root=root;this.profile=validateProfile(asset.profile);this.config={...defaults};this.sessions={};this.lastPlans=new Map();this.saves=Promise.resolve();this.lastPlan=null;this.revision=0;}
  async init(){
    try{const saved=JSON.parse(await readFile(path.join(this.root,'emotion-profile.json'),'utf8'));this.profile=validateProfile(saved.profile);this.config=this.validateConfig(saved.config);if(!saved.config?.automationVersion){this.config.mode='auto';this.config.enabled=true;this.config.automationVersion=1;await this.queueSave('emotion-profile.json',{profile:this.profile,config:this.config});}}catch(e){if(e.code!=='ENOENT')this.warning='情绪档案读取失败，已使用内置档案。';}
    try{const saved=JSON.parse(await readFile(path.join(this.root,'emotion-state.json'),'utf8'));for(const [id,s] of Object.entries(saved).slice(-80)){if(id.length<=160&&Number.isInteger(s.turn)&&s.turn>=0){try{this.sessions[id]={turn:s.turn,strength:typeof s.strength==='number'?number(s.strength,0,1,'已保存强度'):0,envelope:envelope(s.envelope),preset:this.profile.emotion_presets[s.preset]?s.preset:'neutral',signatures:typeof s.signatures==='object'&&s.signatures?s.signatures:{}};}catch{}}}}catch{}
    return this;
  }
  validateConfig(input){
    const c={...this.config,automationVersion:1};
    for(const key of ['enabled','signature','serious'])if(Object.hasOwn(input||{},key)){if(typeof input[key]!=='boolean')throw Error('情绪开关无效。');c[key]=input[key];}
    for(const key of ['strength','maxStrength','continuity'])if(Object.hasOwn(input||{},key))c[key]=number(input[key],0,1,key);
    if(Object.hasOwn(input||{},'mode')){if(!['auto','manual','marked'].includes(input.mode))throw Error('只支持自动理解、手动选择或显式标记模式。');c.mode=input.mode;}
    if(Object.hasOwn(input||{},'preset')){if(!Object.hasOwn(this.profile.emotion_presets,input.preset))throw Error('未知情绪预设。');c.preset=input.preset;}
    return c;
  }
  queueSave(file,data){this.saves=this.saves.catch(()=>{}).then(async()=>{const target=path.join(this.root,file);await writeFile(target+'.tmp',JSON.stringify(data,null,2));await rename(target+'.tmp',target);});return this.saves;}
  async configure(input){const next=this.validateConfig(input);await this.queueSave('emotion-profile.json',{profile:this.profile,config:next});this.config=next;this.revision++;this.lastPlans.clear();return this.public();}
  async importProfile(value){const profile=validateProfile(value);const config={...this.config,preset:profile.emotion_presets[this.config.preset]?this.config.preset:'neutral'};await this.queueSave('emotion-profile.json',{profile,config});this.profile=profile;this.config=config;this.sessions={};this.lastPlans.clear();this.revision++;await this.queueSave('emotion-state.json',{});return this.public();}
  exportProfile(){return clone(this.profile);}
  public(){return{available:true,config:{...this.config},profile:clone(this.profile),labels:emotionLabels,testLines:clone(asset.testLines),signatures:clone(asset.signatures),lastPlan:this.lastPlan?clone(this.lastPlan):null,warning:this.warning||'',capabilities:{method:'text-instruction',exactPitch:false,exactRate:false,exactBreathiness:false,exactPause:false,semanticClassifier:'deterministic-v1',automation:'conservative-auto-with-session-continuity'}};}
  parse(source,override){
    const mode=override?'manual':this.config.mode,preset=override?.preset||this.config.preset,strength=override?.strength??this.config.strength;
    if(!Object.hasOwn(this.profile.emotion_presets,preset))throw Error('未知情绪。');number(strength,0,1,'情绪强度');
    const result=[],append=(value,current)=>{for(const part of (mode==='auto'?semanticClauses(value):[value]))if(part.trim())result.push({text:part,...(mode==='auto'&&!current.marked?inferEmotion(part):current)});},pattern=/\[情绪:([a-z_]+)(?::(0(?:[.]\d+)?|1(?:[.]0+)?))?(?::(急))?\]/g;let selected={preset,strength,hard:false,serious:false,marked:false},cursor=0;
    for(const match of source.matchAll(pattern)){
      if(match.index>cursor)append(source.slice(cursor,match.index),selected);
      if(mode==='marked'||mode==='auto'){if(!Object.hasOwn(this.profile.emotion_presets,match[1]))throw Error('未知情绪标记：'+match[1]);selected={preset:match[1],strength:match[2]===undefined?strength:Number(match[2]),hard:match[3]==='急'&&['surprise','panic'].includes(match[1]),serious:['work','panic','sad','comfort'].includes(match[1]),marked:true};}
      cursor=match.index+match[0].length;
    }
    append(source.slice(cursor),selected);
    if(result.some(s=>s.text.includes('[情绪:')))throw Error('情绪标记格式无效，请使用 [情绪:comfort:0.5]。');
    return result.filter(s=>s.text.trim());
  }
  // 把 WhaleSpeak 的 emphasis 折成一句普通话指令。
  // 只在拿得到字符位置时才说，且最多点三个词——点太多等于没点。
  _emphasisHint(override){
    const list=override?.emphasis;
    if(!Array.isArray(list)||!list.length) return '';
    // 不能把 WhaleSpeak 给的 emphasis 原文直接写进指令：
    // 它的 text 可能是整句（"哦鲸鲸也饿"），也可能带 [情绪:xx] 内部标记，
    // 一旦写进去 TTS 会照着念出来（实测 direction 里出现过 "[情绪:hungry:0.9]、哦鲸鲸、也饿"）。
    const clean=w=>String(w||'')
      .replace(/\[情绪:[^\]\r\n]*\]/g,'')       // 内部情绪标记，绝不能念
      .replace(/[\r\n]/g,'')
      .trim();
    const words=list.map(e=>clean(e?.text)).filter(w=>{
      if(!w) return false;
      const n=[...w].length;
      // 太短（单字）没有强调意义；中文里要重读的词极少超过 4 字，
      // 5 字以上基本是整句（实测「哦鲸鲸也饿」5 字就是整句，点了等于整句加重）
      if(n<2 || n>4) return false;
      // 带分句标点的必是整句片段
      if(/[，。！？!?,、；;…—]/.test(w)) return false;
      return true;
    }).slice(0,3);
    if(!words.length) return '';
    return '这几个词读得稍重一点、稍慢一点，其余保持自然：' + words.join('、') + '。';
  }

  // 强度整形成「低段照实、高段渐收」，而不是一刀切上限。
  // 原来 Math.min(strength, 0.65) 的问题是：她标 0.7 和标 1.0 听起来一模一样，
  // 高情绪全被压成同一个值，反而失去了表达力；而中性句又挤在 0.3 附近
  // 抬不起来。整形后曲线连续单调：标多少都能听出差别，只是越高越收敛，
  // 避免 1.0 时夸张到不像同一个人。
  shapeStrength(value){
    const v=Math.max(0,Math.min(1,Number(value)||0));
    if(v<=0)return 0;
    const max=Math.max(.3,Math.min(1,this.config.maxStrength??.85));
    // 低段保持线性、不压缩：0.1 就该是 0.1，各档之间要拉开差距，
    // 否则前几档会挤成同一个值（试过抬底版，0.1~0.5 听起来几乎一样）。
    // 真正需要处理的是上限那一头：
    // 原来 Math.min(v, 0.65) 让标 0.7 和标 1.0 完全一样，高情绪被压平；
    // 这里改成接近上限时用 1-e^-x 渐收，永远不硬撞顶，
    // 既保住 0.7/0.8/0.9/1.0 的区分度，又不会夸张到不像同一个人。
    const knee=max*.75;
    if(v<=knee)return v;
    const room=max-knee;
    const t=(v-knee)/Math.max(1e-6,1-knee);
    return Math.max(0,Math.min(1,knee+room*(1-Math.exp(-2.2*t))/(1-Math.exp(-2.2))));
  }
  plan(source,sessionId,{override,replay=false,previousState,continuation=false}={}){
    if(typeof source!=='string'||source.length>12000)throw Error('情绪文本最多 12000 字。');if(typeof sessionId!=='string'||sessionId.length>160)throw Error('会话无效。');
    const version=hash([this.profile,this.config]),previous=this.lastPlans.get(sessionId);
    if(replay&&!previousState&&previous?.source===source&&previous.version===version)return{...clone(previous.plan),replay:true};
    const original=previousState||this.sessions[sessionId]||{turn:0,strength:0,envelope:clone(this.profile.default),preset:'neutral',signatures:{}};
    const next=clone(original),clauses=this.parse(source,override),segments=[];let used=0,signatureChars=0;const turn=original.turn+(continuation?0:1),total=clauses.reduce((sum,s)=>sum+s.text.length,0);
    for(const clause of clauses){
      const id=this.config.serious?'work':clause.preset,preset=this.profile.emotion_presets[id]||this.profile.emotion_presets.neutral;
      const strength=this.shapeStrength(clause.strength??this.config.strength),serious=this.config.serious||clause.serious||['work','panic','sad','comfort'].includes(id);
      const target={};for(const key of Object.keys(fields))target[key]=this.profile.default[key]+(preset[key]-this.profile.default[key])*strength;
      target.pause_ms=preset.pause_ms.map((v,i)=>this.profile.default.pause_ms[i]+(v-this.profile.default.pause_ms[i])*strength);
      for(const chunk of splitSpeech(steadyText(clause.text))){
        const from=next.preset,hard=clause.hard,alpha=hard?1:1-this.config.continuity;
        // 起始段直接落到位，避免开头几句因为从 0 爬升而情绪减半。
        const first=segments.length===0,reach=first?1:alpha;
        // 连续同情绪超过两段时向中性回拉，让情绪有起伏而不是一路单向爬升。
        const streak=from===id?(next.streak=(next.streak||0)+1):(next.streak=0);
        const relax=streak>=1?Math.min(.55,.18*streak):0;
        const base=this.profile.default;
        next.strength=Math.min(1,(next.strength||0)+reach*(strength-(next.strength||0))-relax*Math.max(0,(next.strength||0)-strength*.6));
        for(const key of Object.keys(fields)){
          let value=next.envelope[key]+reach*(target[key]-next.envelope[key]);
          if(relax>0)value+=relax*(base[key]-value);
          next.envelope[key]=value;
        }
        next.envelope.pause_ms=next.envelope.pause_ms.map((v,i)=>v+reach*(target.pause_ms[i]-v));
        next.preset=id;
        const phrases=['哦鲸鲸','呜咿','哼呜','咦咿','欸嘿','唔唔','咕呜','哇呜','诶咿'].filter(p=>chunk.includes(p));
        const signature=phrases.find(p=>this.config.signature&&!serious&&used<this.profile.signature_policy.utterance_phrase_cap&&turn-Number(next.signatures[p]??-100)>this.profile.signature_policy.cooldown_turns&&(signatureChars+p.length)/Math.max(1,total)<=this.profile.signature_policy.approx_phrase_coverage_cap);
        if(signature){used++;signatureChars+=signature.length;next.signatures[signature]=turn;}
        const rate=next.envelope.rate<.96?'略慢但不拖沓':next.envelope.rate>1.04?'略快但逐字清楚':'语速自然稳定';
        const appliedStrength=next.strength;
        const force=appliedStrength<.25?'情绪非常轻，接近中性':appliedStrength<.6?'情绪适度，避免表演化':'情绪较明显，仍保持清晰和同一声纹';
        const performance=asset.signatures.find(s=>s.emotion===id)?.intended_effect;
        // WhaleSpeak 会给出这段里该重读的字（emphasis），原来整条链路把它丢了，
        // 下游只能整句一个力度念。这里把它折进 direction：TTS 只认自然语言指令，
        // 没有 emphasis 参数位，所以必须翻译成「哪几个字读重一点」。
        const emphHint=this._emphasisHint?.(override)||'';
        const instruction=['固定当前参考声纹，保持同一说话人。普通话清楚，保留汉字声调；不夹嗓，不持续高扬尾音。',strength===0?'中性清楚地朗读，不额外演绎。':id+'（'+(emotionLabels[id]||id)+'）：'+preset.direction+'。',force+'，'+rate+'；前后语气平滑承接。',...(emphHint?[emphHint]:[]),serious?'以事实与指令可懂度为先，减少装饰语气，不卖萌、不夸张哭笑。':'气息轻微，辅音完整，句尾自然收拢。',signature?'仅对原文已有的“'+signature+'”轻度演绎：'+(performance||'自然、短促')+'，不额外插入口癖。':'原文口癖按普通文字清楚读出，不额外加强或插入。'].join('');
        segments.push({text:chunk,preset:id,label:emotionLabels[id]||id,strength,appliedStrength,serious,hardTransition:hard,signature:signature||null,designTarget:clone(target),smoothedTarget:clone(next.envelope),instruction:instruction+(hard?'允许本次紧急切换。':'从'+(emotionLabels[from]||from)+'的余韵逐渐过渡，不突然换说话方式。')});
        if(segments.length>80)throw Error('情绪分段过多，单次最多 80 段。');
      }
    }
    next.turn=turn;
    // 引擎每次合成都独立重新提取参考韵律，拼接点越多接缝越明显、越容易卡顿；
    // 实测整段合成的连贯性和情绪变化反而更自然，所以合并条件放得很宽：
    // 不限于同情绪，只要不是「强烈对比 + 紧急切换」，就并进当前段，
    // 段的首个情绪作为主导，后并入的情绪靠台词本身的语气词/停顿体现。
    const strongMix=[['panic','playful'],['sad','playful'],['panic','proud']];
    const clashes=(a,b)=>strongMix.some(([x,y])=>(a===x&&b===y)||(a===y&&b===x));
    const joined=[];
    for(const seg of segments){
      const last=joined[joined.length-1];
      const mergeable=last&&!seg.hardTransition&&!last.hardTransition
        &&!clashes(last.preset,seg.preset)
        &&last.text.length+seg.text.length<=400;
      if(mergeable){
        last.text+=seg.text;
        // 主导情绪取「更有个性的那个」而不是第一个：整段以 neutral 开头的句子
        // 若占了主导，后面的惊讶/嘴硬会被压平。中性让位给有情绪的一方。
        if(last.preset==='neutral'&&seg.preset!=='neutral'){
          last.preset=seg.preset;last.label=seg.label;last.instruction=seg.instruction;
          last.appliedStrength=seg.appliedStrength;last.smoothedTarget=seg.smoothedTarget;last.designTarget=seg.designTarget;
        }else if(seg.preset!=='neutral'){
          last.appliedStrength=Math.max(last.appliedStrength??0,seg.appliedStrength??0);
        }
        last.signature=last.signature||seg.signature;
        continue;
      }
      joined.push({...seg});
    }
    // text 是要拿去朗读的正文，标记只用于表达情绪，绝不能念出来。
    // 每段单独剥：这样段与段之间的边界仍然保留，不会把两段的字黏在一起。
    const plan={id:hash([version,joined]),text:joined.map(s=>stripEmotionMarkers(s.text)).join(''),segments:joined.map(s=>({...s,text:stripEmotionMarkers(s.text)})),mode:override?'preview':this.config.mode,method:this.config.mode==='auto'?'deterministic-semantic-v1':'text-instruction',revision:this.revision,sessionId,source,version,nextState:next,replay};
    return plan;
  }
  preview(source,sessionId,options){const plan=this.plan(source,sessionId,options);this.lastPlan=this.display(plan);return this.lastPlan;}
  display(plan){const {source,version,nextState,...out}=plan;return clone(out);}
  async commit(plan){
    this.lastPlan=this.display(plan);if(plan.replay)return;
    if(plan.revision!==this.revision)return;
    this.sessions[plan.sessionId]=plan.nextState;while(Object.keys(this.sessions).length>80)delete this.sessions[Object.keys(this.sessions)[0]];
    this.lastPlans.set(plan.sessionId,{source:plan.source,version:plan.version,plan:clone(plan)});while(this.lastPlans.size>30)this.lastPlans.delete(this.lastPlans.keys().next().value);
    await this.queueSave('emotion-state.json',clone(this.sessions));
  }
  async reset(sessionId){delete this.sessions[sessionId];this.lastPlans.delete(sessionId);this.lastPlan=null;this.revision++;await this.queueSave('emotion-state.json',clone(this.sessions));return{reset:true};}
}
