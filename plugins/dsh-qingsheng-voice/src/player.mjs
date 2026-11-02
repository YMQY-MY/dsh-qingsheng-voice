import { spawn } from 'node:child_process';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export class NativePlayer {
  constructor(root) { this.root = path.join(root, 'playback'); }
  async play(bytes, signal) {
    signal.throwIfAborted(); await mkdir(this.root, {recursive:true});
    const file = path.join(this.root, randomUUID() + '.wav');
    await writeFile(file, bytes);
    try {
      signal.throwIfAborted();
      await new Promise((resolve,reject) => {
        const child = spawn('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./play.ps1',import.meta.url))], {windowsHide:true,stdio:['pipe','ignore','pipe']});
        let error = '', settled = false;
        const timer = setTimeout(() => { child.kill(); finish(Error('音频播放超时。')); }, 180000);
        const finish = e => { if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);e?reject(e):resolve(); };
        const cancel = () => { child.kill(); finish(signal.reason || Error('播放已停止。')); };
        child.stderr.on('data',b => { error = (error+b.toString()).slice(-1500); });
        child.on('error',finish); child.on('close',code => finish(code ? Error(error || '本机音频播放失败。') : undefined));
        child.stdin.on('error',() => {}); child.stdin.end(JSON.stringify({file}));
        signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
      });
    } finally { await unlink(file).catch(() => {}); }
  }
}
