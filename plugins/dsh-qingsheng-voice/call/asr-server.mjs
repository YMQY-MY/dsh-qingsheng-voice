import { spawn } from 'node:child_process';
import path from 'node:path';
import { access, writeFile } from 'node:fs/promises';

// 常驻识别服务的生命周期管理。
// 这条服务的成败直接决定通话能不能用：冷启动 CLI 每句 3.5 秒，常驻 GPU 只要 0.1–0.25 秒。
// 用户不该为了打电话去手动开一个服务，所以插件自己拉起、自己在探活失败时重试。
export class AsrServer {
  constructor({ exe, config, url, logger, port = 8140, modelRoot } = {}) {
    this.exe = exe;
    this.config = config;
    this.modelRoot = modelRoot;
    this.url = (url || 'http://127.0.0.1:' + port).replace(/\/$/, '');
    this.port = port;
    this.logger = logger;
    this.child = null;
    this.starting = null;
    this.lastStart = 0;
  }

  async healthy(signal) {
    try {
      const r = await fetch(this.url + '/health', { signal });
      if (!r.ok) return false;
      const d = await r.json();
      return d?.status === 'ok';
    } catch { return false; }
  }

  // 已经在跑就直接返回；并发调用共用同一次启动。
  async ensure(signal) {
    if (await this.healthy(signal)) return { ready: true, launched: false };
    if (this.starting) return this.starting;
    if (!this.exe || (!this.config && !this.modelRoot)) return { ready: false, reason: 'not-configured' };
    if (Date.now() - this.lastStart < 5000) return { ready: false, reason: 'cooldown' };
    this.starting = this._launch(signal).finally(() => { this.starting = null; });
    return this.starting;
  }

  async _launch(signal) {
    try { await access(this.exe); } catch { return { ready: false, reason: 'no-engine' }; }
    // 配置在运行时生成：模型与 VAD 路径都要跟着插件的实际安装位置走，
    // 不能再像原来那样把绝对路径写死在 asr-server.json 里。
    if (!this.config) {
      const root = this.modelRoot;
      if (!root) return { ready: false, reason: 'no-model-root' };
      const model = path.join(root, 'sensevoice-small-q8-audiocpp-v1.gguf');
      const vad = path.join(path.dirname(this.exe), 'assets', 'framework', 'models', 'silero_vad', 'pulsevad-2.1k-f32.gguf');
      try { await access(model); } catch { return { ready: false, reason: 'models-missing' }; }
      const cfg = {
        models: [{
          id: 'sensevoice-small', family: 'sense_asr', task: 'asr',
          path: model.replace(/\\/g, '/'),
          session_options: { vad_model_path: vad.replace(/\\/g, '/') },
        }],
      };
      const cfgPath = path.join(root, '.asr-server.json');
      await writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
      this.config = cfgPath;
    }
    try { await access(this.config); } catch { return { ready: false, reason: 'not-installed' }; }
    this.lastStart = Date.now();
    // GPU 后端：实测比 CPU 快 10 倍以上（2 秒音频 88–108ms vs 1213ms）。
    // 4090 之前那台没显卡的机器会自动降级成 CPU，慢但能用。
    const args = ['--config', this.config, '--host', '127.0.0.1', '--port', String(this.port),
      '--backend', 'vulkan', '--device', '0', '--threads', '8', '--no-ui'];
    const child = spawn(this.exe, args, {
      cwd: path.dirname(this.exe), windowsHide: true,
      stdio: 'ignore', detached: true,
    });
    // 脱离父进程：插件重载或 DSH 重启时，这个服务不该被一起带走——模型重新加载要好几年秒。
    try { child.unref(); } catch {}
    child.on('error', e => this.logger?.warn?.('识别服务启动失败：' + e.message));
    child.on('exit', code => { if (this.child === child) this.child = null; });
    this.child = child;
    // 模型加载要几秒，边等边探活，别用固定 sleep 猜时间。
    for (let i = 0; i < 40; i++) {
      if (signal?.aborted) return { ready: false, reason: 'aborted' };
      await new Promise(r => setTimeout(r, 500));
      if (await this.healthy(signal)) return { ready: true, launched: true };
      if (child.exitCode !== null) return { ready: false, reason: 'exited' };
    }
    return { ready: false, reason: 'timeout' };
  }

  dispose() {
    // 只结束自己拉起的那个；用户手动开的别去动。
    if (this.child && this.child.exitCode === null) { try { this.child.kill(); } catch {} }
    this.child = null;
  }
}