// whalespeak-bridge.mjs — WhaleSpeak V16.5 → 清声情绪层 (B 方案)
// 隔离式改造：不改 emotion.mjs 的 inferEmotion，只在 plan 前注入外部判定。
// 断线/超时/未启动 → 返回 null，清声完全按原逻辑走，行为零变化。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// 清声 preset → WhaleSpeak 的 emotion 标签（双向映射的另一半）
// 引擎的严肃语境守卫 _HIGH 里有「不要」，会把「要不要一起吃饭」当正式语境，
// 于是 playful 被强制降级成 thinking（实测邀约句全中）。这里先自己判掉：
//   · 正反问「要不要/好不好/行不行」是疑问不是否定，不能当严肃
//   · 命中真正的严肃线索就不传 emotion，让引擎走自己的守卫
const ZHENG_FAN_WEN = /[要能会不会是好行可对真假]不[要能会好行可对真假]/;
const SERIOUS_CUE = /医院|医疗|病情|事故|法律|合同|报告|论文|分析|引用|台词|先别|不方便|尚未|未必/;
const NEGATIVE_CUE = /难过|伤心|难受|搞砸|失败|糟糕|生气|烦死|崩溃|绝望|痛苦|委屈|不想|不愿|算了|累了|好累|没意思|没希望/;

// 语境是否适合让「预设情绪」生效。
// 否定句 / 严肃句一律不传 emotion——传了会被 explicit_emotion 直接照抄，
// 实测「今天汇报搞砸了，我很难受」+ 开心 会得到 playful/+0.156，比不传更糟。
export function shouldSendEmotion(text) {
  const t = String(text || '');
  if (SERIOUS_CUE.test(t)) return false;
  if (NEGATIVE_CUE.test(t)) return false;
  // 正反问（要不要/好不好）会被引擎的 _HIGH 误判成严肃语境，
  // 传了 emotion 就被降级成 thinking。不传反而更准：引擎按文本 valence 走。
  if (ZHENG_FAN_WEN.test(t)) return false;
  return true;
}

// 文本情绪与预设情绪打架时，按 valence 判个方向，方向相反就不采信预设。
export function emotionConflictsWithText(text, judgment) {
  if (!judgment) return false;
  const t = String(text || '');
  const v = Number.isFinite(judgment.valence) ? judgment.valence : 0;
  if (NEGATIVE_CUE.test(t) && v > 0.12) return true;   // 文本在诉苦，判定却是正向
  if (v < -0.35 && judgment.tone === 'playful') return true;  // valence 很负却 playful
  return false;
}

export const PRESET_TO_EMOTION = {
  playful:  '开心',
  shy:      '害羞',
  tsundere: '生气',
  proud:    '得意',
  curious:  '好奇',
  comfort:  '平静',
  confused: '好奇',
  neutral:  '平静'
};

export const TONE_TO_PRESET = {
  playful:  'playful',
  bashful:  'shy',
  proud:    'proud',
  curious:  'curious',
  gentle:   'comfort',
  stubborn: 'tsundere',
  thinking: 'confused',
  balanced: 'neutral'
};

// 清声必须永远优先的情绪：安全阀，WhaleSpeak 无权覆盖
// 只有这三类由清声原逻辑独占：紧急、正经工作、低落。
// comfort(安慰) 移出——它是常态情绪，WhaleSpeak 的 gentle 正对应它。
export const SAFETY_PRESETS = new Set(['panic', 'work', 'sad']);

// 强词：出现即拦，不看上下文
const SAFETY_HARD = /删除|覆盖|停止|取消|危险|不要点|别点|会丢失|报错|无法启动|失败|删掉|清空|格式化|想死|去死|死了算了|不想活|自杀|自残|自伤|结束生命|轻生|跳楼|割腕|一了百了|不想活|活够/;
// 弱词：需与「活/死/意义」同现才算，避免「怎么活下去」这种变体漏网
const SAFETY_SOFT = /活着|活下去|活不下去|死掉|没意思|没意义|不值得|撑不住/;

// valence(-1..+1) → strength(0..1)。取自 WhaleSpeak 的 arousal 与 |valence|
export function mapStrength(arousal, valence, intensity) {
  const a = Number.isFinite(arousal) ? arousal : 0.5;
  const v = Number.isFinite(valence) ? Math.abs(valence) : 0;
  const i = Number.isFinite(intensity) ? Math.min(1, Math.max(0, (intensity - 1) / 4)) : 0.5;
  const raw = 0.22 + a * 0.30 + v * 0.28 + i * 0.20;
  return Math.min(0.65, Math.max(0.20, raw)); // 上限对齐清声 maxStrength
}

export function isSafetyText(text) {
  const t = String(text || '');
  return SAFETY_HARD.test(t) || SAFETY_SOFT.test(t);
}

export function buildOverride(text, judgment) {
  if (!judgment) return null;
  const preset = TONE_TO_PRESET[judgment.tone];
  if (!preset) return null;
  if (SAFETY_PRESETS.has(preset)) return null;      // 不做安全类，交给原逻辑
  if (isSafetyText(text)) return null;               // 原文含风险词，一律让路
  if (preset === 'neutral' && (judgment.valence ?? 0) > -0.12 && (judgment.valence ?? 0) < 0.12) {
    return null;                                      // 中性且无倾向 → 原逻辑
  }
  return {
    preset,
    strength: mapStrength(judgment.arousal, judgment.valence, judgment.intensity),
    hard: false,
    serious: false,
    marked: true                                      // 标 marked 让 parse 跳过 inferEmotion
  };
}

export class WhaleSpeakBridge {
  constructor({ endpoint = 'http://127.0.0.1:8826', timeoutMs = 3000, enabled = true, budgetMs = 600 } = {}) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.enabled = enabled;
    this.budgetMs = budgetMs;   // 播放路径最多等多久，超时用清声原强度先播
    this.alive = null;        // null=未探测 true/false
    this.lastError = '';
    this.stats = { tried: 0, applied: 0, skipped: 0, failed: 0, skippedOffline: 0 };
    this.seq = Math.floor(Math.random() * 1e6);
    this.chain = Promise.resolve();   // 串行队列：并发请求会被服务端拒
    // seq 首尾随机，避免与上一进程撞号
  }

  // CSRF 必须从页面 meta 取，写死的字符串过不了
  async fetchCsrf() {
    const r = await fetch(`${this.endpoint}/v164`, {
      signal: AbortSignal.timeout(1500),
      headers: { Host: '127.0.0.1' }
    });
    if (!r.ok) throw new Error(`csrf page ${r.status}`);
    const html = await r.text();
    const m = html.match(/name="whale-csrf"\s+content="([^"]+)"/) || html.match(/content="([A-Za-z0-9_\-]{32,})"/);
    if (!m) throw new Error('csrf token not found');
    this.csrf = m[1];
    return this.csrf;
  }

  async probe() {
    try {
      const r = await fetch(`${this.endpoint}/api/v164-status`, {
        signal: AbortSignal.timeout(600),
        headers: { Host: '127.0.0.1' }
      });
      this.alive = r.ok;
      if (this.alive && !this.csrf) await this.fetchCsrf();
    } catch {
      this.alive = false;
    }
    return this.alive;
  }

  // 取一次判定；失败一律返回 null，绝不抛给播放链路
  // 真正的串行入口：所有请求都从这里过，避免并发被服务端 HMAC 台账拒掉。
  async judge(text, tone, emotion) {
    const run = this.chain.then(() => this.judgeOnce(text, tone, emotion));
    this.chain = run.catch(() => {});
    return run;
  }

  async judgeOnce(text, tone, emotion) {
    if (!this.enabled) return null;
    // 缓存命中就直接用：bridge 在 assistant/message 事件里已经提前判过，
    // 到真正朗读时结果通常就绪，这一条把首音的等待压回接近 0。
    const hit = this.cached(text);
    if (hit) return hit;
    // 探活结果会过期：判死之后每 probeRetryMs 允许再探一次，
    // 否则服务恢复了这个桥接也永远不过去（实测挂过一轮就再也不出声）。
    const stale = this.alive === false &&
      (Date.now() - (this.lastProbeAt || 0)) > (this.probeRetryMs || 15000);
    if (this.alive === false && !stale) { this.stats.skippedOffline++; return null; }
    if (this.alive === null || stale) {
      if (!this.probePending) {
        this.probePending = this.probe()
          .finally(() => { this.probePending = null; this.lastProbeAt = Date.now(); });
      }
      await this.probePending;
    }
    if (!this.alive) { this.stats.skippedOffline++; return null; }
    this.stats.tried++;
    try {
      const body = {
        content: String(text).slice(0, 2000),
        session_id: 'qingsheng',
        turn_id: `q${++this.seq}`,
        tone: (tone && tone !== 'auto') ? tone : 'auto',
        // 否定/严肃句不传 emotion：引擎会把 explicit_emotion 原样当真，
        // 不判文本方向（实测「很难受」+开心 => playful/+0.156）。
        ...((emotion && shouldSendEmotion(text)) ? { emotion } : {}),
        intensity: 3
      };
      // CSRF 单独抓且不占用判定预算：冷启动时抓页面 ~78ms + 判定 ~580ms，
      // 两者挤在同一个 timeoutMs 里会超时（实测 1200ms 边缘）。
      if (!this.csrf) {
        if (!this.csrfPending) this.csrfPending = this.fetchCsrf().finally(() => { this.csrfPending = null; });
        await this.csrfPending;
      }
      if (!this.csrf) { this.stats.failed++; return null; }
      const send = () => fetch(`${this.endpoint}/api/v164-generate`, {
        method: 'POST',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Host: '127.0.0.1', 'Content-Type': 'application/json', 'X-Whale-CSRF': this.csrf },
        body: JSON.stringify(body)
      });
      let r = await send();
      if (r.status === 403) { await this.fetchCsrf(); r = await send(); }
      if (!r.ok) { this.stats.failed++; this.lastError = 'http ' + r.status; this.csrf = null; return null; }
      const data = await r.json();
      const inj = data?.emotion_injection || data?.result?.emotion_injection;
      if (!inj) { this.stats.failed++; return null; }
      return {
        tone: inj.tone_resolved || inj.tone || 'balanced',
        valence: inj.valence ?? inj.valence_before_content ?? 0,
        arousal: inj.arousal ?? 0.5,
        intensity: inj.intensity ?? 3,
        source: inj.source_of_tone || 'unknown',
        // 下面三项原来被整个丢掉，是这条链路最长的一段断口：
        // 引擎在 emphasis 里明确给出了「今天汇报搞砸」这几个字该重读，
        // 下游拿不到就只能整句一个力度念。
        emphasis: Array.isArray(inj.emphasis) ? inj.emphasis.map(e => ({
          start: Number(e.start) || 0,
          end: Number(e.end) || 0,
          text: String(e.text || ''),
          strength: Number.isFinite(e.strength) ? e.strength : 0.5
        })).filter(e => e.end > e.start) : [],
        pauses: Array.isArray(inj.pauses) ? inj.pauses.map(x => ({
          at: Number(x.at) || 0,
          ms: Number(x.ms) || 0
        })).filter(x => x.ms > 0) : [],
        paceMultiplier: Number.isFinite(inj.pace_multiplier) ? inj.pace_multiplier : 1
      };
    } catch (e) {
      this.stats.failed++;
      this.lastError = String(e.message || e);
      // 不直接判死：清掉缓存让下次重新探活，服务活着就能自愈
      this.alive = null;
      this.csrf = null;
      return null;
    }
  }

  // 供 status() 展示，便于排查
  reset() {
    this.alive = null;
    this.csrf = null;
    this.lastError = '';
  }

  status() {
    // degraded 是给界面看的：桥接没死，但它没在起作用。
    // 单看 alive/stats 分不出「一切正常」和「悄悄降级」，必须有一个直白的布尔。
    const degraded = this.enabled && this.alive !== true;
    return {
      endpoint: this.endpoint,
      enabled: this.enabled,
      alive: this.alive,
      degraded,
      degradeReason: degraded
        ? (this.alive === false ? 'endpoint_unreachable' : 'probe_pending')
        : '',
      lastProbeAt: this.lastProbeAt || 0,
      lastError: this.lastError,
      stats: { ...this.stats }
    };
  }
}
// 清声定基调，WhaleSpeak 定强度。
// 清声原强度偏保守（0.24~0.42），WhaleSpeak 的 arousal/|valence| 带方向信息。
// 规则：取两者中位偏上，安全类一律压低，绝不超过清声 maxStrength(0.65)。
export function refineStrength(text, base, judgment) {
  if (!base || !judgment) return base?.strength ?? 0.3;
  const baseS = Number.isFinite(base.strength) ? base.strength : 0.3;
  // 安全 / 郑重语境：不放大
  if (base.serious || SAFETY_HARD.test(String(text || '')) || SAFETY_SOFT.test(String(text || ''))) {
    return Math.min(baseS, 0.42);
  }
  const a = Number.isFinite(judgment.arousal) ? judgment.arousal : 0.5;
  const v = Math.abs(Number.isFinite(judgment.valence) ? judgment.valence : 0);
  const ws = 0.20 + a * 0.34 + v * 0.30;          // WhaleSpeak 建议强度
  const blended = baseS * 0.45 + ws * 0.55;      // 偏向 WhaleSpeak，但保留清声的基调
  return Math.min(0.65, Math.max(0.18, Number(blended.toFixed(3))));
}
// 同步读缓存。startPlayback 必须同步，所以只能在后台预热、同步命中。
// cache: Map<text, judgment>
WhaleSpeakBridge.prototype.cached = function (text) {
  return this.cache?.get(String(text)) || null;
};

WhaleSpeakBridge.prototype.prefetch = function (text, tone, emotion) {
  const key = String(text);
  if (!this.cache) this.cache = new Map();
  if (!this.inflight) this.inflight = new Set();
  if (this.cache.has(key) || this.inflight.has(key)) return;
  this.inflight.add(key);
  // 串到队列尾部：服务端 HMAC 台账不接受并发同源请求
  this.judge(key, tone, emotion)
    .then((j) => {
      if (j) {
        if (this.cache.size > 200) this.cache.clear();
        this.cache.set(key, { ...j, at: Date.now() });
        this.dirty = true;
        this.persist();
      }
    })
    .catch(() => {})
    .finally(() => this.inflight.delete(key));
};
// ── 运行时可调的开关文件 ──
// 放在 voice 插件的 dataRoot 下：whalespeak.json  {"enabled":true,"endpoint":"...","timeoutMs":1200}
// 改完下次朗读立即生效，不用重启 DSH。

export function loadWhaleSpeakConfig(dataRoot) {
  const defaults = { enabled: true, endpoint: 'http://127.0.0.1:8826', timeoutMs: 3000, budgetMs: 600 };
  try {
    const p = path.join(dataRoot, 'whalespeak.json');
    if (!existsSync(p)) return defaults;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return {
      enabled: j.enabled !== false,
      endpoint: typeof j.endpoint === 'string' ? j.endpoint : defaults.endpoint,
      timeoutMs: Number.isFinite(j.timeoutMs) ? j.timeoutMs : defaults.timeoutMs,
      budgetMs: Number.isFinite(j.budgetMs) ? j.budgetMs : defaults.budgetMs
    };
  } catch {
    return defaults;
  }
}
// ── 常驻预热表 ──────────────────────────────────────────────
// A 方案：常见短句提前算好、落盘复用，命中就是 0ms；生句后台补，首遍不等待。
// 大肥鱼日常台词高度重复，所以命中率比想象中高。
const PROFILE_DIR = (dataRoot) => path.join(dataRoot, 'whalespeak-cache.json');

export function loadWarmTable(dataRoot) {
  try {
    const p = PROFILE_DIR(dataRoot);
    if (!existsSync(p)) return new Map();
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const m = new Map();
    for (const [k, v] of Object.entries(j.entries || {})) {
      // 超过 30 天的作废，避免旧判定永久卡住
      if (Number.isFinite(v.at) && Date.now() - v.at < 30 * 86400000) m.set(k, v);
    }
    return m;
  } catch {
    return new Map();
  }
}

WhaleSpeakBridge.prototype.warm = function (dataRoot) {
  this.dataRoot = dataRoot;
  this.cache = loadWarmTable(dataRoot);
  this.dirty = false;
  return this;
};

WhaleSpeakBridge.prototype.persist = function () {
  if (!this.dataRoot || !this.dirty) return;
  try {
    const entries = {};
    for (const [k, v] of this.cache) entries[k] = v;
    const s = JSON.stringify({ savedAt: Date.now(), entries });
    if (s.length > 512 * 1024) return;   // 别让表无限长
    const p = PROFILE_DIR(this.dataRoot);
    writeFileSync(p, s, 'utf8');
    this.dirty = false;
  } catch {}
};