// 识别：通话里最要命的一段延迟。
// 清声工作台的 /api/transcribe 每句都重新拉起 audiocpp_cli 并加载模型，实测 2 秒音频稳定 3.4–3.6 秒，
// 通话直接废掉。所以这里改成打常驻的 audiocpp_server（默认 8140，模型已在显存里）：
// GPU 后端实测 1 秒音频 186ms、2 秒 88–108ms、5 秒 252ms，比原来快 15–30 倍。
export const DEFAULT_ASR = 'http://127.0.0.1:8140';

export class Recognizer {
  constructor({ base, model = 'sensevoice-small', fallback, logger } = {}) {
    this.base = (base || DEFAULT_ASR).replace(/\/$/, '');
    this.model = model;
    // 常驻服务没起来时的退路：工作台的一次性接口，慢但能用。
    this.fallback = fallback ? fallback.replace(/\/$/, '') : null;
    this.logger = logger;
    this.lastMs = 0;
    this.lastText = '';
    this.lastPath = 'resident';
    this.ready = null;
  }

  // 探活：常驻服务在不在。
  async health(signal) {
    try {
      const r = await fetch(this.base + '/health', { signal });
      if (!r.ok) return false;
      const data = await r.json();
      return data?.status === 'ok';
    } catch { return false; }
  }

  async transcribe(wav, signal) {
    const started = performance.now();
    let text, path;
    try {
      text = await this._resident(wav, signal);
      path = 'resident';
    } catch (e) {
      if (signal?.aborted) throw e;
      if (!this.fallback) throw Error('识别服务不可用：' + e.message);
      this.logger?.warn?.('常驻识别失败，退回工作台接口：' + e.message);
      text = await this._buffered(wav, signal);
      path = 'buffered';
    }
    this.lastMs = Math.round(performance.now() - started);
    this.lastText = text;
    this.lastPath = path;
    return { text, ms: this.lastMs, path };
  }

  // 常驻服务：一次请求，模型不重载。
  async _resident(wav, signal) {
    const form = new FormData();
    form.set('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    form.set('model', this.model);
    const r = await fetch(this.base + '/v1/audio/transcriptions', { method: 'POST', body: form, signal });
    if (!r.ok) throw Error('识别失败 ' + r.status + ' ' + (await r.text()).slice(0, 160));
    const data = await r.json();
    return String(data.text ?? data.transcript ?? '').trim();
  }

  // 退路：清声工作台的两段式接口。
  async _buffered(wav, signal) {
    const created = await fetch(this.fallback + '/api/recordings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base64: wav.toString('base64') }), signal,
    });
    if (!created.ok) throw Error('录音上传失败 ' + created.status);
    const { id } = await created.json();
    const r = await fetch(this.fallback + '/api/transcribe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recording: id }), signal,
    });
    if (!r.ok) throw Error('识别失败 ' + r.status);
    const data = await r.json();
    return String(data.text ?? data.transcript ?? '').trim();
  }
}