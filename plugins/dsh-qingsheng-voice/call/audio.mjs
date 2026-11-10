// 通话要的是「多快能开口、多快能听见」，所以麦克风这一段单独成模块：
// 采样率固定 16k（SenseVoice 的原生采样率，省一次重采样），单声道，只做 VAD 需要的电平计算。
export const MIC_RATE = 16000;

// 一帧 20ms 的 RMS 足够判断「有没有人在说话」，再细就只是白烧 CPU。
export function rms(frame) {
  if (!frame.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

// VAD：自适应噪声底 + 双阈值迟滞。
// 固定阈值在不同房间、不同麦克风下必然翻车，所以底噪是滚动的，开口阈值跟着底噪走。
//
// hangover 为什么必须是 600ms、不能再压——2026-11-04 拿真实语音实测过停顿分布：
//   60–200ms 的字间换气占 71%；再往上还有 380/540/580/680ms 的逗号级停顿，
//   880ms 和 1100ms 才是句号级长停。如果把 hangover 降到 350ms，一半的逗号停顿会被
//   误判成「说完了」，一句话被切成两半。而拆开发识别反而更慢——实测首小句 4428ms、
//   整句一次只要 1005ms，因为每次建任务引擎都要重载上下文。这 600ms 是正确性的必要
//   代价，不是可以省掉的富余。
export class Vad {
  constructor({ floor = 0.004, open = 3.2, close = 1.9, hangover = 600, minSpeech = 220 } = {}) {
    this.floor = floor; this.openK = open; this.closeK = close;
    this.hangover = hangover; this.minSpeech = minSpeech;
    this.noise = floor; this.speaking = false; this.silence = 0; this.voiced = 0;
  }
  // 返回 { speaking, changed }：changed=true 表示这一刻发生了「开口」或「收口」。
  push(level, ms = 20) {
    // 只让噪声底缓慢跟随，说话音量不能把底噪抬高，否则说着说着就聋了。
    if (!this.speaking) this.noise = this.noise * 0.92 + Math.min(level, this.floor * 6) * 0.08;
    const was = this.speaking;
    if (!this.speaking) {
      if (level > this.noise * this.openK) { this.speaking = true; this.silence = 0; this.voiced += ms; }
    } else {
      if (level < this.noise * this.closeK) {
        this.silence += ms;
        if (this.silence >= this.hangover && this.voiced >= this.minSpeech) { this.speaking = false; this.voiced = 0; this.silence = 0; }
      } else { this.silence = 0; this.voiced += ms; }
    }
    return { speaking: this.speaking, changed: this.speaking !== was };
  }
  get threshold() { return this.noise * this.openK; }
  reset() { this.speaking = false; this.silence = 0; this.voiced = 0; }
}

// Float32 单声道 → 16bit PCM，浏览器录什么给什么，这里不做任何增益或滤波，
// 免得把 VAD 看到的电平和真正送去识别的波形搞成两套。
export function floatToPcm16(frames) {
  const out = new Int16Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    const n = Math.max(-1, Math.min(1, frames[i]));
    out[i] = n < 0 ? n * 32768 : n * 32767;
  }
  return Buffer.from(out.buffer);
}

// WAV 封装：清声工作台的识别接口吃 wav，自己封比让浏览器转一道更快也更可控。
// 三种输入都要收：Int16Array（VAD 切出来的一段）、Float32Array（浏览器原始采样）、Buffer（已经封好的）。
// 之前只认 Buffer，实测时传 Int16Array 直接 TypeError——这类类型假设必须在这里一次性收干净。
export function pcmToWav(pcm, sampleRate = MIC_RATE) {
  const body = Buffer.isBuffer(pcm) ? pcm
    : pcm instanceof Int16Array ? Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    : pcm instanceof Float32Array ? floatToPcm16(pcm)
    : null;
  if (!body) throw TypeError('pcmToWav 需要 Int16Array / Float32Array / Buffer，收到 ' + (pcm?.constructor?.name || typeof pcm));
  if (body.length % 2) throw TypeError('16bit PCM 字节数必须是偶数，收到 ' + body.length);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + body.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}