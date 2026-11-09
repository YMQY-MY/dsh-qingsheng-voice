import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// 清声工作台以前是独立安装的 Electron 程序，插件只负责把它找出来拉起来。
// 那样「装上插件」离「能用」还差一步：别人得先自己装一个工作台。
//
// 现在工作台是插件自己的东西：随包分发在 studio/ 下，只保留后端运行时
// （server / public / engine），去掉 Electron 外壳——服务本来就是一个 node 脚本，
// 外壳那 238 MB 一行都用不到。
//
// 于是启动变成纯本地解析：从插件自己的安装位置往上找 studio/，不猜用户机器长什么样。
const STUDIO_DIR = 'studio';

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

  // 工作台就在插件包里。从本文件所在目录逐级上溯，找第一个带 server/index.mjs 的 studio/。
  // 这样不管插件被 pnpm 装成软链、被 npm 拍平成普通目录、还是被放进 monorepo，
  // 解析出来的都是真实的包内路径，不需要任何硬编码。
  async locate() {
    const fs = await import('node:fs/promises');
    const usable = async dir => {
      if (!dir) return null;
      try {
        await fs.access(path.join(dir, 'server', 'index.mjs'));
        return dir;
      } catch { return null; }
    };
    // 环境变量留给高级用户覆盖（例如想指向自己调过的工作台）
    const override = await usable(process.env.QINGSHENG_STUDIO_DIR);
    if (override) return override;

    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 6; depth += 1) {
      const direct = await usable(path.join(dir, STUDIO_DIR));
      if (direct) return direct;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  // 工作台目录自己带 data/ 和 engine/models/。数据放在包内可写位置，
  // 模型也可以被工作室重新指向（STUDIO_MODEL_ROOT），方便想放别的盘的人。
  async resolveRoots(studioDir) {
    const fs = await import('node:fs/promises');
    let dataRoot = this.dataRoot || process.env.STUDIO_DATA_ROOT;
    if (!dataRoot) {
      try {
        await fs.access(path.join(studioDir, 'data'));
        dataRoot = path.join(studioDir, 'data');
      } catch { dataRoot = path.join(studioDir, 'data'); }
    }
    const modelRoot = process.env.STUDIO_MODEL_ROOT || path.join(studioDir, 'engine', 'models');
    return {dataRoot, modelRoot};
  }

  // 模型权重 5.4 GB，不可能塞进插件包。缺了就自动下，用户在等的时候知道在等什么。
  async ensureModels(modelRoot, timeout = 30 * 60 * 1000) {
    const fs = await import('node:fs/promises');
    const REQUIRED = [
      {file: 'breeze-tts-2-q4_k.gguf', size: 2421.3 * 1024 * 1024},
      {file: 'sensevoice-small-q8-audiocpp-v1.gguf', size: 242.4 * 1024 * 1024}
    ];
    const missing = [];
    for (const item of REQUIRED) {
      try {
        const st = await fs.stat(path.join(modelRoot, item.file));
        // 允许一点点误差，别因为字节数对不上就重下 2.4 GB
        if (st.size < item.size * 0.95) missing.push(item);
      } catch { missing.push(item); }
    }
    if (!missing.length) return {ok: true, downloaded: []};
    const base = process.env.QINGSHENG_MODEL_BASE
      || 'https://huggingface.co/YMQY-MY/dsh-qingsheng-voice-models/resolve/main';
    await fs.mkdir(modelRoot, {recursive: true});
    for (const item of missing) {
      this.logger?.info?.(`正在下载声音模型 ${item.file}（${Math.round(item.size / 1024 / 1024)} MB）…`);
      try {
        const r = await this.fetch(`${base}/${item.file}`, {redirect: 'follow', signal: AbortSignal.timeout(timeout)});
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        await fs.writeFile(path.join(modelRoot, item.file), buf);
        this.logger?.info?.(`${item.file} 下载完成。`);
      } catch (e) {
        return {ok: false, downloaded: [], reason: `${item.file}: ${e.message}`};
      }
    }
    return {ok: true, downloaded: missing.map(m => m.file)};
  }

  // 服务起来了不等于能出声：引擎是独立进程，还得把它叫醒。
  // 否则用户点朗读时才发现「本地引擎未启动」，等于白等一场。
  async ensureEngine(timeout = 90000) {
    const deadline = Date.now() + timeout;
    let started = false;
    while (Date.now() < deadline) {
      try {
        const r = await this.fetch(this.base + '/api/engine', {signal: AbortSignal.timeout(1500)});
        const value = await r.json();
        if (value?.ready) return {ready: true, started};
        if (!value?.starting && !started && value?.kind !== 'system') {
          started = true;
          await this.fetch(this.base + '/api/engine/start', {
            method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify({kind: value?.kind || 'breeze'}),
            signal: AbortSignal.timeout(10000)
          }).catch(() => {});
        }
      } catch {}
      await delay(1200);
    }
    return {ready: false, started};
  }

  async ensure({waitMs = 120000} = {}) {
    if (await this.healthy()) {
      const engine = await this.ensureEngine();
      return {ready: true, launched: false, engine: engine.ready};
    }
    if (this.starting) return this.starting;
    // 起不来时反复 spawn 只会堆进程，短时间内的重复请求直接放过。
    if (Date.now() - this.lastAttempt < 20000) return {ready: false, launched: false, reason: 'throttled'};
    this.lastAttempt = Date.now();
    this.starting = (async () => {
      const studioDir = await this.locate();
      if (!studioDir) return {ready: false, launched: false, reason: 'studio-missing'};
      const {dataRoot, modelRoot} = await this.resolveRoots(studioDir);
      const models = await this.ensureModels(modelRoot);
      if (!models.ok) {
        this.logger?.error?.(`声音模型下载失败：${models.reason}。可从 HuggingFace 手动下载后放入 ${modelRoot}。`);
        return {ready: false, launched: false, reason: 'models-missing', modelRoot, detail: models.reason};
      }
      const env = {
        ...process.env,
        STUDIO_PORT: this.port,
        STUDIO_DATA_ROOT: dataRoot,
        STUDIO_MODEL_ROOT: modelRoot,
        STUDIO_ENGINE_ROOT: studioDir,
        NO_PROXY: '127.0.0.1,localhost,::1'
      };
      delete env.NODE_OPTIONS;
      try {
        // 直接用自己的 node 跑后端：没有 Electron 外壳了，也就不需要 ELECTRON_RUN_AS_NODE。
        const child = spawn(process.execPath, [path.join(studioDir, 'server', 'index.mjs')], {
          cwd: studioDir, env, windowsHide: true, detached: true, stdio: 'ignore'
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
        if (await this.healthy()) {
          const engine = await this.ensureEngine();
          this.logger?.info?.(engine.ready ? '清声引擎已就绪。' : '清声服务已起，引擎仍在加载。');
          return {ready: true, launched: true, studioDir, dataRoot, modelRoot, engine: engine.ready};
        }
      }
      return {ready: false, launched: true, reason: 'timeout', studioDir};
    })().finally(() => { this.starting = null; });
    return this.starting;
  }
}
