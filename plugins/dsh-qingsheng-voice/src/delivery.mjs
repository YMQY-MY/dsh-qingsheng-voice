export const deliveryInstruction='自然的日常对话，吐字清楚，语速平稳，按标点自然停顿。情绪适度随语义变化，前后语气连贯，不表演化，不刻意拖长尾音。';
export const calibrationText='你好，我在这里。我们慢慢说，把每一句话都说清楚。';
// 口癖后面若没有停顿标记，引擎会把下一个字直接接上，听不出那口气。
// 用户实测拖长的「哼呜——」「哼呜……」最自然（比逗号、叹号都更像憋出来的哼），统一改写为破折号。
// 2026-11-04 用户原话：「其实有破折号听感更好，有停顿，确实现在有点机械了，真人说话其实有顿挫和节奏感」
// ——破折号提供的顿挫是设计出来的节奏，不要拿「最大静音偏高」这类指标去砍它。
// 2026-11-04 两道手段并存，各管一摊，别互相取消：
//   ① direction 管情绪语气（clone 模式已能接收），语气问题找它；
//   ② 本条 alias 管发音连贯——「哦鲸鲸」引擎会读成「哦、鲸鲸」三段顿开，
//      实测词内凹陷 80ms、前缀能量 0.55；换「吖鲸鲸」后凹陷 20ms、能量 0.07，
//      且只分 2 段跟「鲸鲸」一样连贯。这是发音层的事，direction 管不了。
// 「晶」是打字同音写法，一并归一。
// 注意：替换目标必须同时出现在 mouthTicks 里，否则不认它是对癖就不补破折号（踩过）。
const tickAlias=[
  [/[哦噢吖啊][鲸晶]{2}/g,'吖鲸鲸'],
];
const mouthTicks=['吖鲸鲸','哦鲸鲸','呜咿','哼呜','咦咿','欸嘿','唔唔','咕呜','哇呜','诶咿'];
const tickPattern=new RegExp(`(${mouthTicks.join('|')})[！!，,、。～~—…\\-]*(?![？?])`,'g');
// 引擎对句号的默认停顿只有 170~320ms，人来不及换气，听感就是「上句没说完下句就接上」。
// 实测在句号后补一个省略号，停顿拉到 480/770/950ms 且随句意自然起伏，总时长几乎不变。
// 已有省略号、问号、叹号结尾的不重复叠加，避免把语气拖平。
const sentencePause=/([。；;])(?!\s*[…—])/g;
// 2026-11-04 晚补：上面这条补偿是按句号数量无差别生效的，遇到技术性长文本会过量。
// 说代码/列表/条目的时候，清洗后句号密度是普通对话的好几倍，每个句号都补成「。……」，
// 停顿就一路堆起来。
//
// 限流规则：按「句内字数」判断，短句不补、正常句子照补。
// 实测句长分布（去标点后）：短句连发 1~6 字、正常对话句 8~15 字、实质内容句 29~43 字。
// 所以界线定在 8：低于 8 字的句子交给引擎默认 170~320ms，正好够一个短句的换气；
// 8 字以上才补省略号。这样「好的。行。没问题。」不会把停顿叠成一片，
// 而「吖鲸鲸——你今天来啦。」这类正常句子依然有换气空间。
const MIN_SPAN=8;
// 悬空引导语（2026-11-04 实测的真实病灶）。
// 我说话常写「请重新输入下面这一行：」+ 代码块里的命令。语音只读正文、不读代码块，
// 命令在消息层面就不存在了，于是念出来是「请重新输入下面这一行：」紧跟下一个分句——
// 用户听到的就是「一句话没读完就接下一句」。这不是停顿问题，是台词断了半截。
// 处理：冒号后面不是同一个分句（遇到句号/分号/结束）时，把冒号改成句号，
// 让它成为一个完整的短句收尾，而不是吊着等一个永远不来的下文。
const danglingColon=/([：:])(\s*)(?=[。；;]|$)/g;
export function mouthPause(text){
  let out=String(text||'');
  for(const [re,to] of tickAlias)out=out.replace(re,to);
  out=out.replace(tickPattern,'$1——');
  out=out.replace(danglingColon,'。');
  // 按段扫描：只有「这一句本身够长」才在它后面补停顿，短句一律交给引擎默认值。
  // 用句内字数而不是句间距——「好的。行。没问题。」这种短句连发，间距和句长都短，
  // 任何一种都该判为不补；而「一句 40 字」的长句，句内字数就够长，该补。
  let cursor=0, result='';
  for(const m of out.matchAll(sentencePause)){
    const sentence=out.slice(cursor,m.index);
    const keep=sentence.replace(/[…—\s]/g,'').length>=MIN_SPAN;
    result+=sentence+(m[1])+(keep?'……':'');
    cursor=m.index+m[0].length;
  }
  result+=out.slice(cursor);
  // 结尾那个停顿不会被下一句用上，只会让整段读完后还多留一截，只去掉省略号、句号留着。
  return result.replace(/([。；;])……\s*$/,'$1');
}
export function steadyText(text){
  return text.replace(/(?:[（(](?:laugh|laughing|sigh|sighing|cough|whispering|大笑|笑|叹气|咳嗽|清嗓子)[）)]|[【\[](?:笑|大笑|叹气|咳嗽|清嗓子)[】\]])/gi,'').replace(/[！!]{2,}/g,'！').replace(/[？?]{2,}/g,'？').trim();
}

// ─────────────────────────────────────────────────────────────
// 结构变换（V16.5.1 新增，默认不启用，当前无任何调用方）
// ─────────────────────────────────────────────────────────────
// 【历史前提已作废，2026-11-04 更正】
// 当初写这套规则的依据是「clone 模式下清声不接受 direction，所以情绪只能落到台词结构上」。
// 该前提是错的：clone 模式一直接受 instruction，当时 direction 是在插件侧 studio.mjs:44
// 被 `...(steady?{...}:{})` 这个条件丢掉了，根本没发到引擎；而「三段相反 direction 结果
// MD5 完全相同」也不是因为指令无效——clone 生成本身带随机性，同参数跑两次 MD5 一样不同，
// 拿 MD5 当判据两头都不成立。修复后实测 direction 生效：无指令 3.68s / 高兴 2.96s /
// 悲伤 4.08s，且同义词堆得越多幅度越大。
//
// 【现状】playback.mjs:99 只调 mouthPause，本文件下半部分这些函数全项目零调用。
// 保留原因：作为「不使用 direction 时」的备选加强手段，或将来做明确的 B 档对比。
// 若要启用，注意两点实测结论：①direction 与结构改写叠加会失控（曾出现开心比悲伤还慢）
// ②极短指令也可能反向（单写「低落。」比基线更快），所以不要两者一起上。

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
