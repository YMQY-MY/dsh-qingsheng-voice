export const deliveryInstruction='自然的日常对话，吐字清楚，语速平稳，按标点自然停顿。情绪适度随语义变化，前后语气连贯，不表演化，不刻意拖长尾音。';
export const calibrationText='你好，我在这里。我们慢慢说，把每一句话都说清楚。';
// 口癖后面若没有停顿标记，引擎会把下一个字直接接上，听不出那口气。
// 用户实测拖长的「哼呜——」「哼呜……」最自然（比逗号、叹号都更像憋出来的哼），统一改写为破折号。
// 「哦鲸鲸」例外：引擎把它读成叹词「哦」+ 名字「鲸鲸」而断开，
// 改用同音字「窝鲸鲸」才念得连贯（句中能量 2152，是喔/噢/哦各版的两倍，用户选为体感最好）。
const mouthTicks=['窝鲸鲸','呜咿','哼呜','咦咿','欸嘿','唔唔','咕呜','哇呜','诶咿'];
const tickPattern=new RegExp(`(${mouthTicks.join('|')})[！!，,、。～~—…\\-]*(?![？?])`,'g');
const tickAlias=[[/哦鲸鲸/g,'窝鲸鲸']];
// 引擎对句号的默认停顿只有 170~320ms，人来不及换气，听感就是「上句没说完下句就接上」。
// 实测在句号后补一个省略号，停顿拉到 480/770/950ms 且随句意自然起伏，总时长几乎不变。
// 已有省略号、问号、叹号结尾的不重复叠加，避免把语气拖平。
const sentencePause=/([。；;])(?!\s*[…—])/g;
export function mouthPause(text){
  let out=String(text||'');
  for(const [re,to] of tickAlias)out=out.replace(re,to);
  out=out.replace(tickPattern,'$1——');
  out=out.replace(sentencePause,'$1……');
  // 结尾那个停顿不会被下一句用上，只会让整段读完后还多留一截，只去掉省略号、句号留着。
  return out.replace(/([。；;])……\s*$/,'$1');
}
export function steadyText(text){
  return text.replace(/(?:[（(](?:laugh|laughing|sigh|sighing|cough|whispering|大笑|笑|叹气|咳嗽|清嗓子)[）)]|[【\[](?:笑|大笑|叹气|咳嗽|清嗓子)[】\]])/gi,'').replace(/[！!]{2,}/g,'！').replace(/[？?]{2,}/g,'？').trim();
}

// ─────────────────────────────────────────────────────────────
// 结构变换（V16.5.1 新增，默认不启用）
// ─────────────────────────────────────────────────────────────
// 背景：clone 模式下清声不接受 direction 参数（engines.mjs 第 46 行写死
// mode!=='clone' 才发 instruction），实测三段相反 direction 合成结果 MD5 完全相同。
// 所以情绪只能落到台词结构上——实测同一句改写法时长能拉开 1.52 秒：
//   平铺 2.56s / 省略号 3.12s / 破折号 3.92s / 征询尾 4.00s / 结巴 4.08s
//
// 这些规则全部**可选**，由调用方传 structure 才生效，不传就完全走原逻辑，
// 不会影响已经调好的口癖破折号和句号省略号。

// 结巴：在句首第一个实词前插入重复（我、我 / 才、才）
const STUTTER_TARGETS = ['我', '你', '才', '就', '那', '这', '好'];
// 征询尾：句尾追加，制造求助感
const PLEAD_TAILS = ['好不好嘛', '行不行', '求求你了'];
// 句末标点
const END_PUNCT = /[。！？!?…～~\s]+$/;

function stripEnd(text) {
  const m = text.match(END_PUNCT);
  return m ? { core: text.slice(0, m.index), tail: m[0] } : { core: text, tail: '' };
}

/** 结巴：只对句首第一个实词做一次重复，已经重复过的不再叠 */
function applyStutter(text) {
  const m = text.match(/^[，,。！？!?…\s]*/);
  const lead = m ? m[0] : '';
  const rest = text.slice(lead.length);
  if (!rest) return '';
  const first = rest[0];
  if (!STUTTER_TARGETS.includes(first)) return '';
  // 已经是「我、我」形式就不动
  if (/^[^、]{1}、/.test(rest)) return '';
  return `${lead}${first}、${rest}`;
}

/** 征询尾：核心句 + 求助短语。问句和短句不改，避免变成讨要 */
function applyPlead(text) {
  const PLEAD_WORDS = ['好不好', '行不行', '求求你', '嘛'];
  if (PLEAD_WORDS.some(w => text.includes(w))) return '';
  const { core, tail } = stripEnd(text);
  if (!core) return '';
  // 太短的不加：「我饿？好不好嘛」很怪
  if (core.length < 5) return '';
  // 纯疑问句（今天吃什么 / 那是啥）不加求助尾，否则变成讨要
  if (/什么|啥|哪|谁|怎么|为什么|吗$/.test(core) && !/陪我|给我|带我去|一起/.test(core)) return '';
  // 已有问号的不重复加
  if (tail.includes('？') || tail.includes('?')) return `${core}？${PLEAD_TAILS[0]}`;
  return `${core}？${PLEAD_TAILS[0]}`;
}

/** 感叹号提亮：句号改感叹号，句子切短。只在没有感叹号时用 */
function applyExcite(text) {
  if (/[！!]/.test(text)) return '';
  const { core, tail } = stripEnd(text);
  if (!core) return '';
  // 有逗号就在逗号处切成两句，各自收感叹号
  const idx = core.search(/[，,]/);
  if (idx > 2) {
    const a = core.slice(0, idx);
    const b = core.slice(idx + 1);
    if (b.length > 1) return `${a}！${b}！`;
  }
  return `${core}！`;
}

/** 低落：句子放短，用省略号拖出迟疑，去掉感叹号 */
function applyLowMood(text) {
  let out = text.replace(/[！!]/g, '，');
  const { core, tail } = stripEnd(out);
  if (!core) return '';
  // 长句在最后一个逗号处断开，制造气弱
  const idx = core.lastIndexOf('，') > 0 ? core.lastIndexOf('，') : core.lastIndexOf(',');
  if (idx > 4) {
    const a = core.slice(0, idx);
    const b = core.slice(idx + 1);
    if (b.length > 1) return `${a}……${b}。`;
  }
  return `${core}……`;
}

/** 减速：逗号改破折号，制造停顿 */
function applyDecelerate(text) {
  if (/[—]/.test(text)) return '';
  const idx = text.search(/[，,]/);
  if (idx <= 0) return '';
  const a = text.slice(0, idx);
  const b = text.slice(idx + 1).replace(/[。！？!?…～~\s]+$/, '');
  if (!b) return '';
  return `${a}——${b}`;
}

const STRUCTURES = {
  hesitate: applyStutter,
  plead: applyPlead,
  excite: applyExcite,
  low_mood: applyLowMood,
  decelerate: applyDecelerate,
};

/**
 * 按结构意图改写台词。不改就返回空串。
 *
 * @param {string} text      原始台词
 * @param {string} structure 结构名（hesitate/plead/excite/low_mood/decelerate）
 * @returns {string} 改写结果；无法改写返回空串，调用方应退回原文
 */
// 低落语义词表。刻意和 WhaleSpeak 意图层保持同步——
// 两边各维护一份必然脱节（已经踩过一次），这里至少把意图层那份抄全。
const LOW_MOOD_WORDS = [
  '难受','难过','想哭','不开心','低落','心情不好','好累','撑不住','扛不住',
  '熬不住','受不了','搞砸','失败','绝望','无助','孤独','寂寞','没意思',
  '没希望','不想活','活不下去','都是我的错','我的错','没用','废物','拖累','被讨厌','没人理'
];

/** 这句话是不是在表达低落 */
export function isLowMood(text) {
  const s = String(text || '');
  return LOW_MOOD_WORDS.some(w => s.includes(w));
}

export function restructure(text, structure) {
  const src = String(text || '').trim();
  if (!src || !structure) return '';
  const fn = STRUCTURES[structure];
  if (!fn) return '';
  // 语义安全阀：低落的话不许走提亮/欢快结构。
  // 实测踩过：restructure('我不想活了','excite') 会返回「我不想活了！」——
  // 纯规则函数不懂语义，必须在这里拦住，不能只靠调用方自觉。
  if (isLowMood(src) && (structure === 'excite' || structure === 'hesitate' || structure === 'plead')) return '';
  const out = fn(src);
  if (!out || out === src) return '';
  // 安全阀：实词必须全部还在，顺序不许变，只允许增删标点和虚词
  if (!meaningKept(src, out)) return '';
  return out;
}

/** 粗校验：原句里的非标点字符必须按顺序都还在 */
function meaningKept(original, candidate) {
  const kept = [...original].filter(ch => !'，,。！？!?…～~—、；;：:\s'.includes(ch));
  let i = 0;
  for (const ch of candidate) {
    if (i < kept.length && ch === kept[i]) i++;
  }
  return i >= kept.length;
}

/** 组合：先按结构改写，再走原有的口癖/停顿修正 */
export function deliveryText(text, structure) {
  const structured = structure ? restructure(text, structure) : '';
  return mouthPause(structured || String(text || ''));
}
