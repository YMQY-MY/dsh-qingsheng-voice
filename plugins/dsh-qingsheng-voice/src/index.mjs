import path from 'node:path';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { VoiceBridge } from './bridge.mjs';
import { StudioLauncher } from './launcher.mjs';
import { Autostart } from './autostart.mjs';
import {latestReplyText,assistantHistory,historyReply} from './text.mjs';
import {createCall} from '../call/index.mjs';
export const name = 'qingsheng-voice';
export const inject = ['sessions','connection'];
export async function apply(ctx, options = {}) {
  const config = {studioUrl:options.studioUrl || 'http://127.0.0.1:3210',dataRoot:path.resolve(options.dataRoot || process.env.QINGSHENG_PLUGIN_DATA || path.join(import.meta.dirname,'../../../data/dsh-plugin')),studioExe:options.studioExe};
  const launcher = new StudioLauncher({base:config.studioUrl, workspace:options.workspace || process.env.QINGSHENG_WORKSPACE, logger:ctx.logger});
  // 开机自启：装一次，以后开机服务自己起来，不用用户记着开工作台。
  // 用户可用 QINGSHENG_AUTOSTART=0 关闭。
  const autostart = new Autostart({appDir:options.appDir || 'G:\\ai\\应用\\清声工作台', workspaceRoot:options.workspace || process.env.QINGSHENG_WORKSPACE || 'G:\\ai\\AI组件\\声音', logger:ctx.logger});
  if(process.env.QINGSHENG_AUTOSTART !== '0'){
    autostart.ensure().then(r => {
      if(r.registered) ctx.logger?.info?.('清声开机自启已就绪。');
      else if(!r.ok) ctx.logger?.warn?.('清声自启注册跳过：' + (r.reason || r.error || '未知'));
    }).catch(() => {});
  }
  // 不阻塞插件加载：工作台启动要十几秒，先把 bridge 建好，后台再去确认/拉起。
  launcher.ensure().then(r => {
    if(r.ready) ctx.logger?.info?.(r.launched ? '清声工作台已自动就绪。' : '清声工作台已在运行。');
    else ctx.logger?.warn?.('清声工作台未就绪：' + (r.reason === 'not-installed' ? '未找到安装目录' : r.reason || '未知原因'));
  }).catch(() => {});
  const bridge = await new VoiceBridge(config,{readLatest:id=>latestReplyText(ctx.sessions,id),readHistory:id=>assistantHistory(ctx.sessions,id)}).init();
  // 通话能力内嵌：引擎、模型、播放器全用本插件这一份，不再是另一个插件。
  // 用户可用 QINGSHENG_CALL=0 关掉。
  let call = null;
  if (process.env.QINGSHENG_CALL !== '0') {
    try {
      call = createCall(ctx, {
        logger: ctx.logger,
        voice: {speak: (text, signal) => bridge.speak(text, signal), interrupt: reason => bridge.interrupt(reason)},
        studioUrl: config.studioUrl,
        engineAudioDir: path.join(import.meta.dirname, '..', 'studio', 'engine', 'audio'),
        modelRoot: path.join(import.meta.dirname, '..', 'studio', 'engine', 'models'),
      });
      ctx.connection.fetch.register(call.route);
      ctx.logger?.info?.('清声 · 通话功能已就绪。');
    } catch (e) {
      ctx.logger?.warn?.('通话功能初始化失败：' + e.message);
      call = null;
    }
  }
  const root = ctx.root || ctx;
  const offEvent = root.on('session/event',(session,event) => {
    try { bridge.event(session,event); } catch(e) { bridge.error = e.message; ctx.logger?.warn?.('清声语音事件处理失败：'+e.message); }
  },{global:true});
  const offDisposed = root.on('session/disposed',session => { if(String(session?.id || session?.header?.id) === bridge.focus)bridge.select(''); },{global:true});
  const transcriptions = new Set();
  ctx.effect(() => async () => { offEvent(); offDisposed(); for(const c of transcriptions)c.abort(); try{call?.dispose();}catch{} await bridge.dispose(); });
  let lastLaunch = 0;
  ctx.connection.fetch.register({
    path:'/api/qingsheng/control',methods:['POST'],requestBody:'buffered',
    fetch:async request => {
      let message;
      try {
        if(Number(request.headers.get('content-length') || 0)>8500000)throw Error('请求过大，音色文件请控制在 6 MB 内。');
        const raw = await request.text(); if(raw.length>8500000)throw Error('请求过大，音色文件请控制在 6 MB 内。');
        message = JSON.parse(raw);
        if(message.type !== 'client-request' || message.method !== 'qingsheng/control' || typeof message.rpcId !== 'string' || message.rpcId.length>120)throw Error('调用格式无效。');
        const input = message.payload; if(!input || typeof input !== 'object')throw Error('缺少操作。');
        let value;
        switch(input.action) {
          case 'status': value = {...await bridge.status(request.signal),pluginVersion:'0.5.0',protocolVersion:5,studio:{url:config.studioUrl,ready:await launcher.healthy()}}; break;
          case 'studio.ensure': value = {url:config.studioUrl, ...await launcher.ensure()}; break;
      case 'autostart.status': value = await autostart.status(); break;
      case 'autostart.install': value = await autostart.ensure(); break;
          case 'focus': bridge.select(input.sessionId); value = {selected:true}; break;
          case 'configure': value = await bridge.configure(input.preferences || {}); break;
          case 'stop': bridge.stop(); value = {stopped:true}; break;
          // 通话插件用：只打断正在播的这一句，不结束这一轮对话，也不销毁常驻播放进程。
          case 'interrupt': value=bridge.interrupt(input.reason); break;
          case 'speech.state': value={...bridge.speechState,pluginVersion:'0.5.0'}; break;
          case 'pause': value=bridge.pause();break;
          case 'resume': value=bridge.resume();break;
          case 'replay': if(input.sessionId)bridge.select(input.sessionId);value=await bridge.replay(input.replyId);break;
          case 'history': value=await bridge.history(input.sessionId||bridge.focus);break;
          case 'replay.message': {
            if(input.sessionId)bridge.select(input.sessionId);
            const item=input.replyId?await bridge.history(bridge.focus).then(list=>list.find(value=>value.id===input.replyId)):null;
            if(!item)throw Error('找不到这条可朗读的回答。');
            value=await bridge.replay(item.id);break;
          }
          case 'voice.save': {
            bridge.stop();value=await bridge.studio.saveVoice(input,request.signal);
            if(input.activate!==false)await bridge.configure({voiceId:value.id});break;
          }
          case 'voice.import': {
            bridge.stop();value=await bridge.studio.importVoice(input.bundle,request.signal);
            if(input.activate!==false)await bridge.configure({voiceId:value.id});break;
          }
          case 'voice.delete': {
            if(bridge.preferences.voiceId===input.id||bridge.preview?.voiceId===input.id)bridge.stop();
            value=await bridge.studio.deleteVoice(input.id,request.signal);
            if(bridge.preferences.voiceId===input.id){const state=await bridge.studio.state(request.signal);await bridge.configure({voiceId:state.voices[0]?.id||''});}break;
          }
          case 'voice.duplicate': value=await bridge.studio.duplicateVoice(input.id,request.signal);break;
          case 'voice.export': value=await bridge.studio.exportVoice(input.id,request.signal);break;
          case 'voice.audio': value={base64:await bridge.studio.voiceAudio(input.id,request.signal)};break;
          case 'voice.preview': value=bridge.previewVoice(input.id,input.text);break;
          case 'voice.resetReference': value=await bridge.resetReference();break;
          case 'emotion.status': value=bridge.emotion.public();break;
          case 'emotion.configure': bridge.stop();value=await bridge.emotion.configure(input.config||{});bridge.audioCache.clear();break;
          case 'emotion.import': bridge.stop();value=await bridge.emotion.importProfile(input.profile);bridge.audioCache.clear();break;
          case 'emotion.export': value=bridge.emotion.exportProfile();break;
          case 'emotion.reset': bridge.stop();value=await bridge.emotion.reset(bridge.focus||'local');bridge.audioCache.clear();break;
          case 'emotion.plan': value=bridge.emotion.preview(input.text,bridge.focus||'local',{override:input.override});break;
          case 'emotion.preview':
            if(typeof input.text!=='string'||input.text.length>1000||!input.text.trim())throw Error('情绪试听需要 1–1000 字。');
            bridge.speak(input.text,{emotionPreview:true,emotionOverride:input.override});value={started:true};break;
          case 'emotion.createVoice': {
            bridge.stop();const p=bridge.emotion.profile;
            value=await bridge.studio.saveVoice({voice:{name:(p.character.split(/[／/]/)[1]||p.character).slice(0,25)+' · 基础声线',description:p.voice_identity.description+'。普通话清晰，语气中性自然。',tags:['情绪基声'],seed:42}},request.signal);
            await bridge.configure({voiceId:value.id});break;
          }
          case 'voice.promote': {
            const preview=bridge.preview;if(!preview||preview.status!=='completed'||preview.jobId!==input.jobId)throw Error('请先完成一次音色设计试听。');
            if(preview.savedVoiceId)throw Error('这次试听已保存，请到音色库管理。');
            if(bridge.promoting)throw Error('正在保存这次试听，请稍候。');bridge.promoting=true;
            try{value=await bridge.studio.promoteVoice(preview.jobId,input.name,request.signal);preview.savedVoiceId=value.id;await bridge.configure({voiceId:value.id});}finally{bridge.promoting=false;}break;
          }
          case 'speak': if(typeof input.text !== 'string' || input.text.length>6000)throw Error('试听文字无效。'); bridge.speak(input.text); value = {started:true}; break;
          // 通话插件要的是「念完再回来」：这里等这一段真正播完才回包，它拿到回包才回去继续听。
          case 'speak.await': {
            if(typeof input.text !== 'string' || !input.text.trim() || input.text.length>6000)throw Error('朗读文字无效。');
            if(input.sessionId)bridge.select(input.sessionId);
            await bridge.speak(input.text);
            value={spoken:true,speaking:bridge.speechState.speaking};
            break;
          }
          case 'transcribe': {
            bridge.stop(); const controller = new AbortController(); transcriptions.add(controller);
            try { value = await bridge.studio.transcribe(input.base64,AbortSignal.any([controller.signal,request.signal])); }
            finally { transcriptions.delete(controller); }
            break;
          }
          case 'launch': {
            if(!config.studioExe || !path.isAbsolute(config.studioExe))throw Error('请先配置清声桌面版路径。');
            await access(config.studioExe);
            if(Date.now()-lastLaunch>5000) {
              await new Promise((resolve,reject) => { const p=spawn(config.studioExe,[],{detached:true,windowsHide:true,stdio:'ignore'});p.once('error',reject);p.once('spawn',() => {p.unref();resolve();}); });
              lastLaunch = Date.now();
            }
            value = {launched:true}; break;
          }
          default: throw Error('未知语音操作。');
        }
        return Response.json({type:'server-response',rpcId:message.rpcId,result:{ok:true,value}});
      } catch(e) {
        return Response.json({type:'server-response',rpcId:message?.rpcId || '',result:{ok:false,error:{code:'qingsheng/failed',message:e.message,details:{}}}});
      }
    }
  });
  ctx.logger?.info?.('清声 · 大肥鱼语音插件已加载。');
}
