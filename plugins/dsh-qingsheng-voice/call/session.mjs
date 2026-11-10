// 一通通话的状态机。只做一件事：决定「现在该谁说话」。
// 说话这件事一律交给语音插件，这里只负责在对的时候叫它、在对的时候打断它。
export const State = {
  IDLE: 'idle',        // 没在通话
  LISTEN: 'listen',    // 听用户
  THINK: 'think',      // 等识别 / 等模型
  SPEAK: 'speak',      // 大肥鱼在说
};

export class CallSession {
  constructor({ recognizer, speak, interrupt, logger } = {}) {
    this.recognizer = recognizer;
    this.speak = speak || (async () => {});
    this.interrupt = interrupt || (() => false);
    this.logger = logger;
    this.state = State.IDLE;
    this.turns = [];
    this.startedAt = 0;
    this.error = '';
    // 预热：用户一开口就偷偷跑一次识别，把引擎和模型叫醒。
    // 通话里最贵的是「第一次」，提前摊掉它。
    this.warm = null;
  }

  get active() { return this.state !== State.IDLE; }

  start(sessionId) {
    this.sessionId = sessionId;
    this.startedAt = Date.now();
    this.turns = [];
    this.error = '';
    this.state = State.LISTEN;
    return this.snapshot();
  }

  stop() {
    this.state = State.IDLE;
    try { this.interrupt('通话已结束。'); } catch {}
    return this.snapshot();
  }

  // 用户开口：如果大肥鱼正在说，立刻住口。这是「能插话」的全部秘密。
  onUserSpeechStart() {
    if (this.state !== State.SPEAK) return { interrupted: false };
    const interrupted = this.interrupt('用户插话。');
    this.state = State.LISTEN;
    return { interrupted };
  }

  // 用户一段说完：识别 → 交给上层去喂会话。
  async onUserSpeechEnd(wav, signal) {
    if (!this.active) throw Error('通话未开始。');
    this.state = State.THINK;
    const started = Date.now();
    const result = await this.recognizer.transcribe(wav, signal);
    const turn = { role: 'user', text: result.text, asrMs: result.ms, at: Date.now() };
    this.turns.push(turn);
    return { ...turn, wallMs: Date.now() - started, path: result.path };
  }

  // 提前把识别引擎叫醒：拿一小段静音走一次完整请求。
  // 结果丢弃，只为让模型留在显存里。不阻塞任何流程。
  prime(signal) {
    if (this.warm) return this.warm;
    const silent = Buffer.alloc(44 + 16000 * 2);
    // 拼一个合法的 0.5 秒 16k 单声道 WAV 头，内容全零
    silent.write('RIFF', 0, 'ascii'); silent.writeUInt32LE(36 + 32000, 4); silent.write('WAVE', 8, 'ascii');
    silent.write('fmt ', 12, 'ascii'); silent.writeUInt32LE(16, 16); silent.writeUInt16LE(1, 20);
    silent.writeUInt16LE(1, 22); silent.writeUInt32LE(16000, 24); silent.writeUInt32LE(32000, 28);
    silent.writeUInt16LE(2, 32); silent.writeUInt16LE(16, 34); silent.write('data', 36, 'ascii');
    silent.writeUInt32LE(32000, 40);
    this.warm = this.recognizer.transcribe(silent, signal).catch(() => null).finally(() => { this.warm = null; });
    return this.warm;
  }

  // 模型回来的整段文字：叫语音插件念，念完回到听。
  async onReply(text, signal) {
    if (!this.active) return;
    this.state = State.SPEAK;
    try { await this.speak(text, signal); }
    finally { if (this.active) this.state = State.LISTEN; }
  }

  snapshot() {
    return {
      state: this.state,
      sessionId: this.sessionId || '',
      turns: this.turns.slice(-12),
      startedAt: this.startedAt,
      error: this.error,
    };
  }
}