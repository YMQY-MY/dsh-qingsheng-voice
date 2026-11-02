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
