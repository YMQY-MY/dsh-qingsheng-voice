export function assistantText(event) {
  if (event?.type !== 'assistant/message' || event.data?.interrupted) return '';
  const blocks = event.data?.message?.content;
  if (!Array.isArray(blocks) || blocks.some(b => b.type === 'tool-call')) return '';
  return blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join(String.fromCharCode(10));
}
function userText(message){
  if(message?.role!=='user'||!Array.isArray(message.content))return '';
  return message.content.filter(block=>block?.type==='text'&&typeof block.text==='string').map(block=>block.text).join('\n').slice(0,2000);
}
function isChildSession(header){return header?.origin==='subagent'||Number(header?.delegationDepth||0)>0;}
export async function assistantHistory(sessions,id,{limit=50}={}){
  const session=sessions.get(id),header=session?.header;
  if(!session||isChildSession(header))return [];
  const messages=await session.deriveMessages();
  const result=[];
  for(let i=0;i<messages.length;i++){
    const message=messages[i];if(message.role!=='assistant')continue;
    const text=assistantText({type:'assistant/message',data:{message,interrupted:message.interrupted}});
    const clean=spokenText(text);if(!clean.trim())continue;
    let context='';for(let j=i-1;j>=0;j--){context=userText(messages[j]);if(context)break;}
    const identity=String(message.id||message.uuid||message.messageId||i);
    result.push({id:`${i}-${identity}`.slice(0,180),text:clean,context,role:message.role,index:i});
  }
  return result.slice(-Math.max(1,Math.min(100,limit)));
}
export async function latestReplyText(sessions,id) {
  return (await assistantHistory(sessions,id,{limit:1}))[0]?.text||'';
}
export async function historyReply(sessions,id,messageId){
  if(typeof messageId!=='string'||messageId.length>180)return null;
  return (await assistantHistory(sessions,id,{limit:100})).find(message=>message.id===messageId)||null;
}
export function spokenText(text) {
  const kept = []; let code = false, thought = false;
  for (let line of String(text).split(String.fromCharCode(10))) {
    if (line.trimStart().startsWith('~~~') || line.trimStart().startsWith(String.fromCharCode(96).repeat(3))) { code = !code; continue; }
    if (code) continue;
    if (line.includes('<think>')) thought = true;
    if (thought) { if (line.includes('</think>')) thought = false; continue; }
    line = line.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    line = line.replace(/https?:[/][/][^\s)]+/g, '').replace(/^[\s#>*-]+/g, '').replace(/[*_]/g, '').split(String.fromCharCode(96)).join('').trim();
    if (line && !/^[-| :]+$/.test(line)) kept.push(line);
  }
  return kept.reduce((all,line)=>all+(all&&!/[。！？.!?；;：:]$/.test(all)?'。':'')+line,'').replace(/[。]{2,}/g, '。').slice(0, 6000);
}
export function splitSpeech(text, limit = 140) {
  const result=[];let pending=text;
  const words=new Intl.Segmenter('zh',{granularity:'word'});
  while(pending.length>limit){
    const window=pending.slice(0,limit+1),boundaries=[...window.matchAll(/[。！？!?；;\n，,：:、]\s*/g)].filter(m=>!/[，,]/.test(m[0][0])||!(/\d/.test(pending[m.index-1]||'')&&/\d/.test(pending[m.index+1]||''))).map(m=>m.index+m[0].length).filter(n=>n>=Math.floor(limit*.4)&&n<=limit);
    let cut=boundaries.at(-1);
    if(!cut){
      const wordEnds=[...words.segment(pending)].map(s=>s.index+s.segment.length).filter(n=>n<=limit);
      cut=wordEnds.at(-1);
      // A single long Latin token or number stays intact rather than being pronounced in halves.
      if(!cut)cut=[...words.segment(pending)][0].segment.length;
    }
    result.push(pending.slice(0,cut));pending=pending.slice(cut);
  }
  if(pending.trim())result.push(pending);
  return result;
}
