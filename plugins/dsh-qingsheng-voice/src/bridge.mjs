import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { StudioClient } from './studio.mjs';
import { NativePlayer } from './pcm-player.mjs';
import {ConversationPlayback} from './playback.mjs';
import { assistantText, assistantHistory, spokenText, splitSpeech } from './text.mjs';
import {EmotionController} from './emotion.mjs';
export class VoiceBridge extends ConversationPlayback {
  constructor(config, {studio,player,readLatest,readHistory} = {}) {
    super();this.readLatest=readLatest;this.readHistory=readHistory;
    this.config = config; this.studio = studio || new StudioClient(config.studioUrl);
    this.player = player || new NativePlayer(config.dataRoot);
    this.preferences = {autoSpeak:true,voiceId:'8172d1f5-4524-4219-89c5-3907f4e201c8',delivery:'steady',voiceStrategy:'clone'}; this.focus = '';
    this.pending = new Map(); this.seen = new Set(); this.active = new Set();
    this.phase = 'idle'; this.error = ''; this.generation = 0; this.saves = Promise.resolve();
    this.emotion=new EmotionController(config.dataRoot);
  }
  async init() {
    await mkdir(this.config.dataRoot,{recursive:true});
    this.file = path.join(this.config.dataRoot,'preferences.json');
    try { this.updatePreferences(JSON.parse(await readFile(this.file,'utf8'))); } catch(e) { if(e.code !== 'ENOENT') this.error = '偏好文件无法读取，本次使用默认值。'; }
    await this.loadPlayback();await this.emotion.init();return this;
  }
  updatePreferences(value) {
    if(['steady','reference'].includes(value.delivery))this.preferences.delivery=value.delivery;
    if(['clone','regenerate'].includes(value.voiceStrategy))this.preferences.voiceStrategy=value.voiceStrategy;
    if(typeof value.autoSpeak === 'boolean') this.preferences.autoSpeak = value.autoSpeak;
    if(typeof value.voiceId === 'string' && (value.voiceId===''||/^[a-z0-9-]{1,80}$/.test(value.voiceId))) this.preferences.voiceId = value.voiceId;
  }
  async configure(value) {
    const oldVoice=this.preferences.voiceId,oldDelivery=this.preferences.delivery;this.updatePreferences(value); if(!this.preferences.autoSpeak||oldVoice!==this.preferences.voiceId||oldDelivery!==this.preferences.delivery)this.stop();
    const json = JSON.stringify(this.preferences,null,2);
    this.saves = this.saves.catch(() => {}).then(async () => { await writeFile(this.file+'.tmp',json); await rename(this.file+'.tmp',this.file); });
    await this.saves; return {...this.preferences};
  }
  select(sessionId) {
    if(typeof sessionId !== 'string' || sessionId.length > 160) throw Error('会话标识无效。');
    if(this.focus !== sessionId) { this.stop(); this.pending.clear(); this.focus = sessionId; }
  }
  event(session,event) {
    if(this.closed || session?.header?.origin === 'subagent' || Number(session?.header?.delegationDepth || 0)>0) return;
    const id = String(session?.id || session?.header?.id || '');
    if(!this.focus || id !== this.focus || !event) return;
    const key = id + ':' + event.seq;
    if(event.seq !== undefined) { if(this.seen.has(key))return;this.seen.add(key); if(this.seen.size>1024)this.seen.delete(this.seen.values().next().value); }
    if(event.type === 'turn/start' || event.type === 'user/message') { this.stop(); this.pending.delete(id); }
    if(event.type === 'assistant/message') {
      const text = assistantText(event);
      if(text)this.pending.set(id,text); else this.pending.delete(id);
    }
    if(event.type === 'turn/end') {
      const text = this.pending.get(id); this.pending.delete(id);
      if(text && event.data?.reason?.kind === 'completed'){const messageId=event.data?.messageId||event.data?.message?.id||event.data?.id||event.seq;this.rememberReply(text,{id:String(messageId||`${id}-${event.seq||Date.now()}`)});if(this.preferences.autoSpeak)this.speak(text,{replyId:String(messageId||`${id}-${event.seq||Date.now()}`)});}
    }
  }
  stop() {
    return this.stopPlayback();
  }
  speak(text,options={}) {
    return this.startPlayback(text,options);
  }
  async status(signal) {
    let state, connectionError;
    try { state = await this.studio.state(signal); } catch(e) { connectionError = '清声未连接：请先启动清声工作台。'; }
    const selected=state?.voices.find(v=>v.id===this.preferences.voiceId);
    return {connected:!!state,capabilities:state?.capabilities||{},emotion:{available:true,config:{...this.emotion.config},lastPlan:this.emotion.lastPlan,warning:this.emotion.warning||''},engine:state?.engine,recognition:state?.recognition,voices:state?.voices || [],preferences:{...this.preferences},phase:this.phase,error:this.error || connectionError || '',warning:this.warning||'',preview:this.preview||null,playback:{paused:this.paused,positionSeconds:this.positionSeconds,totalSeconds:this.totalSeconds,firstAudioMs:this.firstAudioMs,cached:!!this.replayedFromCache,canReplay:!!this.lastAnswers.get(this.focus)||!!this.readLatest,voiceLocked:selected?.kind==='reference'||!!(selected&&this.voiceLocks[this.voiceKey(selected)])},sessionId:this.focus};
  }
  async dispose() { this.closed = true; this.stop(); this.pending.clear(); await Promise.allSettled([...this.active,this.saves,this.lockSaves,this.emotion.saves]); }
}
