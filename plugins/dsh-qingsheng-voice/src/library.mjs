import {voiceId,voiceInput,safeVoice,referenceAudio} from './voices.mjs';
export class VoiceLibrary {
  async rawVoice(id,signal) {
    voiceId(id);const state=await this.request('/api/state',undefined,signal);
    const voice=state.voices.find(v=>v.id===id);if(!voice)throw Error('音色已删除，请刷新音色库。');return voice;
  }
  async saveVoice({id,voice,audio},signal) {
    const value=voiceInput(voice),existing=id?await this.rawVoice(id,signal):null;
    if((audio||existing?.reference)&&!value.transcript)throw Error('参考音色需要准确文字稿。');
    if(audio){referenceAudio(audio);const saved=await this.request('/api/references',{base64:audio},signal,30000);value.reference=saved.id;}
    if(id)voiceId(id);
    return safeVoice(await this.request('/api/voices'+(id?'/'+id:''),value,signal,15000,id?'PUT':'POST'));
  }
  async deleteVoice(id,signal) {return this.request('/api/voices/'+voiceId(id),{},signal,15000,'DELETE');}
  async duplicateVoice(id,signal) {
    const source=await this.rawVoice(id,signal),value=voiceInput({...source,name:source.name.slice(0,36)+' 副本'});
    if(source.reference)value.reference=source.reference;return safeVoice(await this.request('/api/voices',value,signal));
  }
  async voiceAudio(id,signal) {
    const voice=await this.rawVoice(id,signal);if(!/^[a-f0-9-]+[.]wav$/.test(voice.reference||''))throw Error('这个音色还没有固定参考录音。');
    const response=await this.fetch(this.base+'/media/references/'+voice.reference,{signal,redirect:'error'});
    if(!response.ok||Number(response.headers.get('content-length')||0)>4*1024*1024)throw Error('参考音频读取失败或超过 4 MB，请重新导入一个较短选段。');
    const bytes=Buffer.from(await response.arrayBuffer());referenceAudio(bytes.toString('base64'));return bytes.toString('base64');
  }
  async exportVoice(id,signal) {
    const voice=await this.rawVoice(id,signal);return{format:'qingsheng-voice',version:1,voice:voiceInput(voice),...(voice.reference?{audio:{mime:'audio/wav',base64:await this.voiceAudio(id,signal)}}:{})};
  }
  async importVoice(bundle,signal) {
    if(bundle?.format!=='qingsheng-voice'||bundle.version!==1)throw Error('不是受支持的清声音色文件。');
    if(bundle.audio&&bundle.audio.mime!=='audio/wav')throw Error('音色文件需要 WAV 参考录音。');
    return this.saveVoice({voice:bundle.voice,audio:bundle.audio?.base64},signal);
  }
  async promoteVoice(jobId,name,signal) {
    if(!/^[a-f0-9-]+$/.test(jobId||''))throw Error('试听任务无效。');
    return safeVoice(await this.request('/api/jobs/'+jobId+'/voice',{name},signal));
  }
}
