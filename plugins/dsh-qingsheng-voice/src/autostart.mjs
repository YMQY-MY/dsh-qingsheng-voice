import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

// 开机自启：清声工作台原本要用户自己开窗口，关掉服务就停。
// 这里把「开机自动拉起服务」做进插件，用户装完插件就长期可用。
//
// 关键：清声工作台.exe 本身就是 Electron，自带 node 运行时，
// 加 ELECTRON_RUN_AS_NODE=1 就能当 node 用，因此不依赖任何系统 node。
// 注册表 Run 无法设置环境变量，所以用「启动器自举」：
// 被以应用模式唤起时，先用该变量重新执行自己。
//
// 另：不用 powershell 读写注册表——子进程里它读 HKCU 恒为空（实测），
// reg.exe 稳定，但输出是控制台代码页（GBK），必须按 GBK 解码。

const RUN_KEY = 'QingshengStudio';
const RUN_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

// reg.exe 输出按 GBK 解码，避免中文路径乱码
function runReg(args) {
  return new Promise(resolve => {
    const child = spawn('reg.exe', args, {windowsHide: true});
    const out = [];
    child.stdout?.on('data', d => out.push(d));
    child.once('error', e => resolve({ok: false, out: '', error: e.message}));
    child.once('exit', code => {
      const buf = Buffer.concat(out);
      let text;
      try { text = new TextDecoder('gbk').decode(buf); } catch { text = buf.toString('utf8'); }
      resolve({ok: code === 0, code, out: text.trim(), error: code === 0 ? undefined : text.trim()});
    });
  });
}

export class Autostart {
  constructor({appDir, workspaceRoot, logger} = {}) {
    this.appDir = appDir;
    this.root = workspaceRoot;
    this.logger = logger;
    this.exe = appDir ? path.join(appDir, '清声工作台.exe') : null;
    this.script = workspaceRoot ? path.join(workspaceRoot, 'start-studio.mjs') : null;
  }

  async install() {
    if (!this.exe || !this.script) return {ok: false, reason: 'missing-paths'};
    try { await fs.access(this.exe); } catch { return {ok: false, reason: 'exe-not-found'}; }
    const body = AWAKEN_SOURCE
      .replaceAll('__EXE__', this.exe.replaceAll('\\', '\\\\'))
      .replaceAll('__ROOT__', this.root.replaceAll('\\', '\\\\'));
    try {
      const old = await fs.readFile(this.script, 'utf8');
      if (old === body) return {ok: true, unchanged: true};
    } catch {}
    await fs.writeFile(this.script, body, 'utf8');
    return {ok: true, written: true};
  }

  async register() {
    if (!this.exe || !this.script) return {ok: false, reason: 'missing-paths'};
    const value = '"' + this.exe + '" "' + this.script + '"';
    const r = await runReg(['add', RUN_PATH, '/v', RUN_KEY, '/t', 'REG_SZ', '/d', value, '/f']);
    return {ok: r.ok, value, code: r.code, reason: r.error};
  }

  async unregister() {
    const r = await runReg(['delete', RUN_PATH, '/v', RUN_KEY, '/f']);
    return {ok: r.ok, reason: r.error};
  }

  async status() {
    const r = await runReg(['query', RUN_PATH, '/v', RUN_KEY]);
    let value = '';
    if (r.ok) {
      const m = r.out.match(/REG_SZ\s+(.+)$/m);
      if (m) value = m[1].trim();
    }
    const exists = !!(this.script && await fs.access(this.script).then(() => true).catch(() => false));
    return {registered: !!value, value, script: this.script, exists};
  }

  async ensure({register = true} = {}) {
    const installed = await this.install();
    if (!installed.ok) return installed;
    if (!register) return {...installed, registered: false};
    const reg = await this.register();
    return {...installed, registered: reg.ok, value: reg.value, error: reg.reason};
  }
}

// 启动器脚本：自举 + 带齐环境变量 + 唤醒引擎（由插件自动生成，勿手改）
const AWAKEN_SOURCE = `// 清声工作台后台启动器（由插件自动生成，勿手改）
// 注册表 Run 直接调用本脚本：清声工作台.exe start-studio.mjs
// 不是 node 模式就用 ELECTRON_RUN_AS_NODE=1 重新拉起自己。
const { spawn } = await import('node:child_process');
const path = await import('node:path');

const EXE = '__EXE__';
const ROOT = '__ROOT__';
const SRV = path.join(path.dirname(EXE), 'resources', 'app', 'server', 'index.mjs');
const SELF = path.join(ROOT, 'start-studio.mjs');
const STATE = 'http://127.0.0.1:3210/api/state';

const healthy = async () => { try { return (await fetch(STATE, { signal: AbortSignal.timeout(1500) })).ok } catch { return false } };

if (await healthy()) process.exit(0);

if (process.env.ELECTRON_RUN_AS_NODE !== '1') {
  spawn(EXE, [SELF], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true, detached: true, stdio: 'ignore'
  }).on('error', () => {}).unref();
  process.exit(0);
}

const env = { ...process.env,
  ELECTRON_RUN_AS_NODE: '1', STUDIO_PORT: '3210',
  STUDIO_DATA_ROOT: path.join(ROOT, 'data'),
  STUDIO_MODEL_ROOT: path.join(ROOT, 'engine', 'models'),
  STUDIO_ENGINE_ROOT: ROOT,
  NO_PROXY: '127.0.0.1,localhost,::1' };
delete env.NODE_OPTIONS;

spawn(EXE, [SRV], { cwd: path.join(path.dirname(EXE), 'resources', 'app'), env, windowsHide: true, detached: true, stdio: 'ignore' })
  .on('error', () => {}).unref();

(async () => {
  for (let i = 0; i < 90; i++) {
    await new Promise(s => setTimeout(s, 1000));
    if (!await healthy()) continue;
    try {
      const s = await (await fetch(STATE)).json();
      if (!s?.engine?.ready) {
        await fetch('http://127.0.0.1:3210/api/engine/start', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: s?.engine?.kind || 'breeze' })
        }).catch(() => {});
      }
    } catch {}
    break;
  }
  process.exit(0);
})();
`;