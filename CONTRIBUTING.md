# 贡献指南 / Contributing

感谢你对清声语音插件的关注。

## 提交问题

请尽量提供以下信息，能大幅缩短定位时间：

- DSH 版本、插件版本（`package.json` 的 `version`）
- 清声工作台版本（桌面版 `build-info.json`）
- 显卡型号与是否支持 Vulkan
- 复现步骤，以及期望结果与实际结果
- 涉及语音问题时，附上具体台词文本（音频可选择性提供）

## 提交代码

1. Fork 本仓库并新建分支。
2. 保持改动聚焦：一个 PR 解决一个问题。
3. 提交前请确保：
   ```bash
   node --check <改动过的 .mjs 文件>
   npm test
   ```
4. PR 描述中说明**为什么**改、**改了什么**、**如何验证**。

## 代码约定

- 仅支持 Windows x64，Node.js ≥ 22。
- 所有 `.mjs` 使用 ESM，不引入新的运行时依赖除非必要。
- **`stream.ps1` 必须保存为无 BOM + LF**。该文件由 `powershell.exe -File` 直接执行，
  Windows PowerShell 会按本地代码页读取无 BOM 文件；文件内容全是 ASCII，无 BOM 反而在任何
  代码页下都能正确解析。带上 BOM 反而会在部分宿主环境里表现为整篇解析失败
  （典型症状：`Unexpected token '}'`）。仓库通过 `.gitattributes` 锁定 LF。
- 用脚本改这个文件时，落盘方式必须是
  `[IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))`。
- 改完必须用 **Windows PowerShell 5.1** 解析一遍再交付，PowerShell 7 的解析器更宽松，验不出问题：
  ```powershell
  powershell.exe -NoProfile -Command "[void][System.Management.Automation.Language.Parser]::ParseFile('src/stream.ps1',[ref]`$null,[ref]`$e); `$e"
  ```
- 修改内嵌 C# 的 PowerShell 脚本后，请用与生产一致的 `powershell.exe -File` 方式实际运行验证，
  不要只用 `Get-Content` 读取后 `Add-Type` 编译（两种解码路径不同）。

## 不要提交

以下内容已被 `.gitignore` 排除，请勿强行加入：

- 模型权重（`*.gguf`）、音频文件（`*.wav` / `*.mp3`）
- 用户数据、录音、音色库
- 任何密钥、令牌或本地绝对路径

## 许可

提交的代码默认以本仓库的 MIT 许可证发布。