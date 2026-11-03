# 清声 · 大肥鱼语音插件

为 DeepSeek-Harness（DSH）的对话加上本地语音能力：回答自动朗读、麦克风转文字、音色工作室，全部在本机跑，不联网、不上传。

> 本仓库只包含插件代码（约 150 KB）。**声音模型约 5.4 GB，不在此仓库**，见下方「模型获取」。

## 功能

- **自动朗读**：当前会话新完成的回答边生成边播放，不必等整段合成完。
- **语音输入**：录音转文字，结果进 DSH 草稿框，确认后再发送。
- **音色工作室**：内嵌工作台界面，选音色、录参考音、试听、调情绪。
- **情绪表达**：按语义自动切换语气，口癖、停顿、尾音都落在台词层，不靠指令硬拉。
- **本地优先**：TTS 与 ASR 都跑在本机 GPU（Vulkan），无 API 用量。

## 环境要求

- Windows x64
- Node.js ≥ 22
- DSH ≥ 0.2.1-rc.5
- 清声工作台桌面版（或独立部署的 `server/`）
- 支持 Vulkan 的显卡（无独显也可跑，速度会慢）

## 安装

1. 安装清声工作台桌面版，确认声音模型可正常加载。
2. 下载或克隆本仓库。
3. 双击 `plugins/安装到DSH.cmd`，按提示输入 DSH 安装目录与清声工作区目录；也可直接执行：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\plugins\install-dsh-plugin.ps1 `
  -DshDirectory "D:\Apps\DSH" -StudioRoot "D:\Apps\QingSheng"
~~~

4. 重启 DSH。

插件会在 DSH 启动时**自动拉起清声服务**（无窗口后台运行），不需要你另外打开工作台。模型、音色库、数据目录全部沿用工作区自己那一份。

## 使用

- 输入框旁：语音输入、停止朗读、自动朗读开关。
- 语音设置 → **工作台** 标签：完整的工作台界面，用来管音色和调情绪。
- 语音设置 → **音色与情绪** 标签：本插件的音色库、试听、参考音设置。

## 模型获取

三份模型合计约 5.4 GB，请按需下载后放入工作区的 `engine/models/`：

| 文件 | 大小 | 用途 |
|---|---|---|
| `breeze-tts-2-q4_k.gguf` | 2.4 GB | TTS 主引擎（推荐） |
| `voxcpm2-q8_0.gguf` | 2.8 GB | 备用 TTS 引擎 |
| `sensevoice-small-q8-audiocpp-v1.gguf` | 242 MB | 中文语音识别 |

### 从 HuggingFace 下载

模型托管在 [YMQY-MY/dsh-qingsheng-voice-models](https://huggingface.co/YMQY-MY/dsh-qingsheng-voice-models)。

**方式一：逐一下载**

```bash
BASE=https://huggingface.co/YMQY-MY/dsh-qingsheng-voice-models/resolve/main
mkdir -p engine/models && cd engine/models
curl -L -O $BASE/breeze-tts-2-q4_k.gguf
curl -L -O $BASE/voxcpm2-q8_0.gguf
curl -L -O $BASE/sensevoice-small-q8-audiocpp-v1.gguf
```

**方式二：用 huggingface-cli（支持断点续传，推荐大文件）**

```bash
pip install -U "huggingface_hub[cli]"
huggingface-cli download YMQY-MY/dsh-qingsheng-voice-models \
  --local-dir engine/models --local-dir-use-symlinks False
```

> 只想要 TTS、不需要语音识别的话，`sensevoice-small` 可以不下载，插件会禁用语音输入功能。

### 目录结构

下载完成后工作区应是这样：

```
<工作区根目录>/
├── data/                     # 数据、音色库、会话（运行时生成）
└── engine/
    └── models/
        ├── breeze-tts-2-q4_k.gguf
        ├── voxcpm2-q8_0.gguf
        └── sensevoice-small-q8-audiocpp-v1.gguf
```

> 本仓库不托管模型权重：GitHub 单文件上限 100 MB，且模型体积远超仓库建议大小。
> 模型权重来自各自上游项目，本仓库仅作镜像分发，不主张所有权，详见 [NOTICE.md](./NOTICE.md)。

## 架构

```
DSH ──RPC──> 插件后台 (src/index.mjs)
                │
                ├─ launcher.mjs   自动拉起/健康检查清声服务
                ├─ bridge.mjs     会话事件、朗读调度
                ├─ playback.mjs   分段、缓存、串行播放
                ├─ emotion.mjs    情绪规划与连续性平滑
                ├─ delivery.mjs   口癖停顿、句间停顿改写
                ├─ pcm-player.mjs 子进程管道
                ├─ stream.ps1     waveOut 播放（内嵌 C#）
                └─ studio.mjs     调用清声 HTTP 接口
                        │
                        ▼
                清声服务 :3210 ──> Breeze TTS ──> GPU
```

## 已知限制

- 仅 Windows：音频播放依赖 `waveOut` API。
- `stream.ps1` 必须存为 **UTF-8 with BOM**。Windows PowerShell 5.x 在无 BOM 时按 ANSI 解码，中文注释会吞掉换行、破坏内嵌 C# 的编译。
- 单次合成受引擎上下文限制，超长文本会自动分段。

## 作者

**YMQY-MY**

- GitHub：[@YMQY-MY](https://github.com/YMQY-MY)
- 问题反馈：[Issues](https://github.com/YMQY-MY/dsh-qingsheng-voice/issues)

## 致谢

本插件建立在以下项目之上，它们是各自作者的作品：

- **Breeze TTS 2** — 本地 TTS 主引擎
- **VoxCPM2** — 备选 TTS 引擎
- **SenseVoice Small** — 中文语音识别
- **清声工作台** — 本地语音服务与音色管理界面
- **DeepSeek-Harness (DSH)** — 插件宿主

这些组件的模型权重与二进制**均不随本仓库分发**，各有独立许可，详见 [NOTICE.md](./NOTICE.md)。

## 贡献

欢迎提交 Issue 与 Pull Request，请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可

[MIT License](./LICENSE) © 2026 YMQY-MY

你可以自由使用、修改、分发，包括商业用途，只需保留版权声明。
第三方组件的许可见 [NOTICE.md](./NOTICE.md)。
