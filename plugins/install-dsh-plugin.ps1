param([string]$DshDirectory = '', [string]$Profile = 'desktop')
# 清声语音插件安装器。
# 工作台和推理引擎都在插件包内（studio/），所以这个脚本只做一件事：
# 把插件装进 DSH 的 profile 并启用。不需要问工作区、不需要问工作台在哪、不需要先装任何东西。
$ErrorActionPreference = 'Stop'
$packageDir = Join-Path $PSScriptRoot 'dsh-qingsheng-voice'
if(!(Test-Path -LiteralPath (Join-Path $packageDir 'package.json'))) { throw 'Plugin package not found next to this installer.' }

# 没给 DSH 目录就自己找：常见安装位置 + 当前 .dsh 根。
if(!$DshDirectory) {
  $candidates = @()
  if($env:DSH_HOME) { $candidates += $env:DSH_HOME }
  $candidates += (Join-Path $env:USERPROFILE '.dsh')
  $candidates += @('C:\dsh-data','D:\dsh-data','E:\dsh-data')
  foreach($c in $candidates) {
    if($c -and (Test-Path -LiteralPath (Join-Path $c 'profiles'))) { $DshDirectory = $c; break }
  }
}
if(!$DshDirectory) { $DshDirectory = Read-Host 'DSH data directory (the one containing profiles\)' }

$dshHome = [IO.Path]::GetFullPath($DshDirectory)
$profileDir = Join-Path $dshHome ('profiles/' + $Profile)
if (!(Test-Path -LiteralPath (Join-Path $profileDir 'package.json'))) { throw ('Not a DSH profile: ' + $profileDir + ' — open DSH Desktop once first.') }

# 宿主真正加载的是 profile 的 node_modules；这里直接放装，不依赖 npm/pnpm 网络。
$installedDir = Join-Path $profileDir 'node_modules/dsh-qingsheng-voice'

$cache = Join-Path (Join-Path (Join-Path $env:USERPROFILE '.dsh') 'artifacts') 'qingsheng-install'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$backup = Join-Path $cache ('backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
foreach($name in @('package.json','cordis.patch.yml')) {
  $source = Join-Path $profileDir $name
  if(Test-Path -LiteralPath $source){ Copy-Item -LiteralPath $source -Destination (Join-Path $backup $name) }
}

Write-Host ('Installing QingSheng voice into ' + $profileDir + ' ...')
New-Item -ItemType Directory -Force -Path $installedDir | Out-Null
$copied = 0
foreach($sourceFile in @(Get-ChildItem -LiteralPath $packageDir -Recurse -File)) {
  $relative = $sourceFile.FullName.Substring($packageDir.Length).TrimStart([char]92,[char]47)
  # 不覆盖用户已有的数据目录与已下载模型
  if($relative -like 'studio\data\*' -or $relative -like 'studio/engine/models/*') { continue }
  $installedFile = Join-Path $installedDir $relative
  New-Item -ItemType Directory -Force -Path (Split-Path $installedFile -Parent) | Out-Null
  $stagedFile = $installedFile + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  try {
    Copy-Item -LiteralPath $sourceFile.FullName -Destination $stagedFile
    Move-Item -LiteralPath $stagedFile -Destination $installedFile -Force
  } finally {
    if(Test-Path -LiteralPath $stagedFile) { Remove-Item -LiteralPath $stagedFile -Force }
  }
  $copied++
}
Write-Host ('Copied ' + $copied + ' files.')

# 启用 bundle：写 profiles 的 package.json 依赖 + dsh.profile.bundles
$manifestPath = Join-Path $profileDir 'package.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if(!$manifest.dependencies) { $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
$deps = @{}
foreach($p in $manifest.dependencies.PSObject.Properties) { $deps[$p.Name] = $p.Value }
$deps['dsh-qingsheng-voice'] = 'file:' + ($packageDir -replace '\\','/')
$manifest.dependencies = [pscustomobject]$deps
$bundles = @()
if($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) { $bundles = @($manifest.dsh.profile.bundles) }
if($bundles -notcontains 'dsh-qingsheng-voice') { $bundles += 'dsh-qingsheng-voice' }
if(!$manifest.dsh) { $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
if(!$manifest.dsh.profile) { $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
$manifest.dsh.profile.bundles = $bundles
$json = $manifest | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText($manifestPath, $json, (New-Object Text.UTF8Encoding($false)))
Write-Host 'Enabled the voice bundle.'

# 挂载配置：studioUrl 与数据目录都指向包内的 studio/
$dataRoot = Join-Path $installedDir 'studio/data/dsh-plugin'
$patchPath = Join-Path $installedDir 'cordis.patch.yml'
$patch = @(
  '- insert:',
  '    - id: qingsheng-voice',
  '      name: dsh-qingsheng-voice',
  '      config:',
  '        studioUrl: "http://127.0.0.1:3210"',
  ('        dataRoot: ' + ($dataRoot | ConvertTo-Json -Compress))
)
[IO.File]::WriteAllLines($patchPath, $patch, (New-Object Text.UTF8Encoding($false)))
Write-Host 'Wrote mount config.'

$version = (Get-Content -LiteralPath (Join-Path $packageDir 'package.json') -Raw | ConvertFrom-Json).version
[pscustomobject]@{plugin='dsh-qingsheng-voice';version=$version;profile=$profileDir;backup=$backup;installedAt=(Get-Date -Format o)} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $cache 'receipt.json') -Encoding UTF8
Write-Host ''
Write-Host 'Installed. 下次启动 DSH 时插件会自动拉起包内的工作台与引擎；'
Write-Host '首次运行需要下载声音模型（约 2.7 GB），放在 studio/engine/models/。'
