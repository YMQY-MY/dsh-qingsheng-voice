import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// 清声工作台原本要用户自己开一个 Electron 窗口。装完插件还得单独开一次才算能用，
// 关掉窗口服务也跟着停——这对「插件自带语音」是错位的。
//
// 桌面版主进程本身就是用 ELECTRON_RUN_AS_NODE=1 去 spawn server/index.mjs 的，
// 所以这里照同一套环境变量直接把后端拉起来：不弹窗口、不占任务栏，
// 模型/音色库/数据目录全部沿用工作区自己那一份，用户只需要开 DSH。
const APP_CANDIDATES = [
  'G:\\ai\\应用\\清声工作台',
  path.join(process.env.LOCALAPPDATA || '', '清声工作台'),
  path.join(process.env.ProgramFiles || '', '清声工作台')
];

const ENTRY = '清声工作台.exe';

export class StudioLauncher {
  constructor({base = 'http://127.0.0.1:3210', dataRoot, workspace, fetcher = fetch, logger} = {}) {
    const url = new URL(base);
    this.base = url.origin;
    this.port = url.port || '3210';
    this.dataRoot = dataRoot;
    this.workspace = workspace;
    this.fetch = fetcher;
    this.logger = logger;
    this.starting = null;
    this.lastAttempt = 0;
    this.child = null;
  }

  async healthy(timeout = 1500) {
    try {
      const r = await this.fetch(this.base + '/api/state', {signal: AbortSignal.timeout(timeout), redirect: 'error'});
      if (!r.ok) return false;
      const value = await r.json();
      return !!value && typeof value === 'object';
    } catch { return false; }
  }

  // 找安装目录：优先用户给的工作区（模型就那儿），否则按常见位置找桌面版。
  async locate() {
    const fs = await import('node:fs/promises');
    const tryDir = async dir => {
      if (!dir) return null;
      try { await fs.access(path.join(dir, ENTRY)); await fs.access(path.join(dir, 'resources', 'app', 'server', 'index.mjs')); return dir; } catch { return null; }
    };
    if (this.workspace) {
      const found = await tryDir(path.join(this.workspace, '清声工作台')) || await tryDir(path.join(this.workspace, '应用', '清声工作台'));
      if (found) return found;
    }
    for (const dir of APP_CANDIDATES) { const found = await tryDir(dir); if (found) return found; }
    return null;
  }

  // 工作区根目录：桌面版用 workspace.json 指定，模型和数据都相对它找。
  async resolveWorkspace(appDir) {
    const fs = await import('node:fs/promises');
    try {
      const raw = await fs.readFile(path.join(appDir, 'workspace.json'), 'utf8');
      const value = JSON.parse(raw);
      if (typeof value?.workspaceRoot === 'string' && value.workspaceRoot) return value.workspaceRoot;
    } catch {}
    return this.workspace || null;
  }

  async ensure({waitMs = 120000} = {}) {
    if (await this.healthy()) return {ready: true, launched: false};
    if (this.starting) return this.starting;
    // 起不来时反复 spawn 只会堆进程，短时间内的重复请求直接放过。
    if (Date.now() - this.lastAttempt < 20000) return {ready: false, launched: false, reason: 'throttled'};
    this.lastAttempt = Date.now();
    this.starting = (async () => {
      const appDir = await this.locate();
      if (!appDir) return {ready: false, launched: false, reason: 'not-installed'};
      const root = await this.resolveWorkspace(appDir);
      if (!root) return {ready: false, launched: false, reason: 'no-workspace'};
      const codeRoot = path.join(appDir, 'resources', 'app');
      const env = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        STUDIO_PORT: this.port,
        STUDIO_DATA_ROOT: path.join(root, 'data'),
        STUDIO_MODEL_ROOT: path.join(root, 'engine', 'models'),
        STUDIO_ENGINE_ROOT: codeRoot,
        NO_PROXY: '127.0.0.1,localhost,::1'
      };
      delete env.NODE_OPTIONS;
      try {
        const child = spawn(path.join(appDir, ENTRY), ['--use-env-proxy', path.join(codeRoot, 'server', 'index.mjs')], {
          cwd: codeRoot, env, windowsHide: true, detached: true, stdio: 'ignore'
        });
        child.once('error', () => {});
        child.unref();
        this.child = child;
        this.logger?.info?.('清声服务已在后台启动，等待模型就绪…');
      } catch (e) {
        return {ready: false, launched: false, reason: e.message};
      }
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await delay(900);
        if (await this.healthy()) return {ready: true, launched: true, appDir, root};
      }
      return {ready: false, launched: true, reason: 'timeout', appDir};
    })().finally(() => { this.starting = null; });
    return this.starting;
  }
}
