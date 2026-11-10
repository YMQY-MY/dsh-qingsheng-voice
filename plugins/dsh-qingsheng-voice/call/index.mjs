import { Recognizer, DEFAULT_ASR } from './recognizer.mjs';
import { AsrServer } from './asr-server.mjs';
import path from 'node:path';
import { CallSession, State } from './session.mjs';

// 通话能力内嵌在声音插件里：引擎、模型、播放器都是同一份，不再自己带一套，
// 也不再跨插件 RPC——直接调本插件传进来的 voice 对象。
export const callName = 'qingsheng-call';

export function createCall(ctx, options = {}) {
  const {
    logger = ctx?.logger,
    voice,              // { speak(text, signal), interrupt(reason) }
    studioUrl = 'http://127.0.0.1:3210',
    engineAudioDir,     // <plugin>/studio/engine/audio
    modelRoot,          // <plugin>/studio/engine/models
    asrUrl = DEFAULT_ASR,
  } = options;

  // 识别走常驻服务（快 15–30 倍）；工作台只当退路。
  const asr = new AsrServer({
    exe: path.join(engineAudioDir || path.join(import.meta.dirname, '..', 'studio', 'engine', 'audio'), 'audiocpp_server.exe'),
    config: null,       // 运行时生成，路径跟着安装位置走
    modelRoot,
    url: asrUrl,
    logger,
  });
  // 不阻塞插件加载：服务起得慢，先让插件可用，后台去拉。
  asr.ensure().then(r => {
    if (r.ready) logger?.info?.(r.launched ? '清声话音识别服务已就绪。' : '清声话音识别服务已在运行。');
    else logger?.warn?.('话音识别服务未就绪：' + (r.reason || '未知原因'));
  }).catch(() => {});
  const recognizer = new Recognizer({ base: asrUrl, fallback: studioUrl, logger });

  // 说话交给声音插件自己的常驻播放器，通话层不碰音频输出。
  const session = new CallSession({
    recognizer,
    logger,
    // 只打断当前这一句，通话本身继续。
    interrupt: reason => { Promise.resolve().then(() => voice?.interrupt?.(reason)).catch(() => {}); return true; },
    speak: async (text, signal) => { await voice.speak(text, signal); },
  });

  const handlers = {
    async fetch(request) {
      let message;
      try {
        const raw = await request.text();
        if (raw.length > 12000000) throw Error('音频过大。');
        message = JSON.parse(raw);
        if (message?.type !== 'client-request' || message?.method !== 'qingsheng/call' || typeof message.rpcId !== 'string')
          throw Error('调用格式无效。');
        const input = message.payload || {};
        let value;
        switch (input.action) {
          case 'status':
            value = {
              ...session.snapshot(),
              recognition: {
                ready: await recognizer.health(request.signal),
                path: recognizer.lastPath,
                lastMs: recognizer.lastMs,
              },
            };
            break;
          case 'start':
            value = session.start(input.sessionId || '');
            // 一开始通话就把识别引擎叫醒，别等用户说完第一句才加载。
            session.prime();
            break;
          case 'stop': value = session.stop(); break;
          // 用户开口这一瞬间：先让大肥鱼住口，再继续录。顺序反了就变成两个人抢话。
          case 'speech.start':
            // 用户一开口就先打断她、再顺手预热识别——这一段完全不占用户的时间。
            value = session.onUserSpeechStart();
            session.prime();
            break;
          case 'speech.end': {
            const wav = Buffer.from(String(input.base64 || ''), 'base64');
            if (wav.length < 44) throw Error('没有录到声音。');
            value = await session.onUserSpeechEnd(wav, request.signal);
            break;
          }
          case 'reply': await session.onReply(String(input.text || ''), request.signal); value = session.snapshot(); break;
          default: throw Error('未知通话操作。');
        }
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } });
      } catch (e) {
        return Response.json({
          type: 'server-response', rpcId: message?.rpcId || '',
          result: { ok: false, error: { code: 'qingsheng/call-failed', message: e.message, details: {} } },
        });
      }
    },
  };

  const dispose = () => { try { session.stop(); } catch {} try { asr.dispose(); } catch {} };
  return { asr, recognizer, session, route: { path: '/api/qingsheng/call', methods: ['POST'], requestBody: 'buffered', fetch: handlers.fetch }, dispose };
}