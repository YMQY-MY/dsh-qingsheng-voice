param([string]$DshDirectory = '', [string]$StudioRoot = '')
$ErrorActionPreference = 'Stop'
$packageDir = Join-Path $PSScriptRoot 'dsh-qingsheng-voice'
if(!$DshDirectory) { $DshDirectory = Read-Host 'DSH installation directory' }
if(!$StudioRoot) { $StudioRoot = Read-Host 'QingSheng workspace directory' }
if(!$DshDirectory -or !$StudioRoot) { throw 'Both DSH and QingSheng directories are required.' }
$launcher = Join-Path $DshDirectory 'resources/runtime/cli/bin/dsh.cmd'
if(!(Test-Path -LiteralPath $launcher)) { throw 'DSH launcher not found. Select the installed DSH directory.' }
if(!(Test-Path -LiteralPath $StudioRoot -PathType Container)) { throw 'QingSheng workspace directory not found.' }
if(!(Test-Path -LiteralPath (Join-Path $packageDir 'package.json'))) { throw 'Plugin package not found next to this installer.' }
$StudioRoot = [IO.Path]::GetFullPath($StudioRoot)
$cache = Join-Path $StudioRoot 'artifacts/dsh-plugin-install'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$profile = Join-Path $(if($env:DSH_HOME){$env:DSH_HOME}else{Join-Path $env:USERPROFILE '.dsh'}) 'profiles/desktop'
if (!(Test-Path -LiteralPath (Join-Path $profile 'package.json'))) { throw 'Open DSH Desktop once before installing this plugin.' }
$backup = Join-Path $cache ('backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
foreach($name in @('package.json','pnpm-lock.yaml','cordis.patch.yml')) {
  $source = Join-Path $profile $name
  if(Test-Path -LiteralPath $source){Copy-Item -LiteralPath $source -Destination (Join-Path $backup $name)}
}
$url = 'http://127.0.0.1:3210'
$exeName = (-join ([char[]]@(0x6e05,0x58f0,0x5de5,0x4f5c,0x53f0))) + '.exe'
$exePath = Join-Path (Join-Path $StudioRoot 'dist/Qingsheng') $exeName
$patch = @('- insert:', '    - id: qingsheng-voice', '      name: dsh-qingsheng-voice', '      config:', ('        studioUrl: '+($url | ConvertTo-Json -Compress)), ('        dataRoot: '+((Join-Path $StudioRoot 'data/dsh-plugin') | ConvertTo-Json -Compress)), ('        studioExe: '+($exePath | ConvertTo-Json -Compress)))
[IO.File]::WriteAllLines((Join-Path $packageDir 'cordis.patch.yml'),$patch,(New-Object Text.UTF8Encoding($false)))
$env:TEMP = $cache
$env:TMP = $cache
$env:npm_config_cache = Join-Path $cache 'npm-cache'
$env:npm_config_store_dir = Join-Path $cache 'pnpm-store'
$env:COREPACK_HOME = Join-Path $cache 'corepack'
$log = Join-Path $cache ('install-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
Write-Host 'Installing QingSheng voice through the official DSH plugin manager...'
$existingManifest = Get-Content -LiteralPath (Join-Path $profile 'package.json') -Raw | ConvertFrom-Json
$installedDir = Join-Path $profile 'node_modules/dsh-qingsheng-voice'
$alreadyCurrent = ($existingManifest.dsh.profile.bundles -contains 'dsh-qingsheng-voice')
foreach($sourceFile in @(Get-ChildItem -LiteralPath $packageDir -Recurse -File)) {
  $relative = $sourceFile.FullName.Substring($packageDir.Length).TrimStart([char]92,[char]47)
  $installedFile = Join-Path $installedDir $relative
  if(!(Test-Path -LiteralPath $installedFile)){ $alreadyCurrent = $false; break }
  if((Get-FileHash -LiteralPath $sourceFile.FullName).Hash -ne (Get-FileHash -LiteralPath $installedFile).Hash){ $alreadyCurrent = $false; break }
}
if($alreadyCurrent) {
  Write-Host 'The installed plugin matches this package; no package changes are needed.'
  $installExitCode = 0
} else {
$ErrorActionPreference = 'Continue'
& $launcher plugin --profile desktop add ('file:'+$packageDir) --ignore-scripts --offline 2>&1 | Tee-Object -FilePath $log
$installExitCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
}
if ($installExitCode -ne 0) { throw ('DSH plugin installation failed. Log: '+$log) }
$manifest = Get-Content -LiteralPath (Join-Path $profile 'package.json') -Raw | ConvertFrom-Json
if (!($manifest.dsh.profile.bundles -contains 'dsh-qingsheng-voice')) { throw 'DSH did not enable the voice bundle. Check the plugin page before retrying.' }
# pnpm can reuse a file dependency snapshot when its version is unchanged.
# Replace only this plugin's files, breaking store hardlinks before writing.
if(!(Test-Path -LiteralPath (Join-Path $installedDir 'package.json'))) { throw 'DSH did not create the plugin installation directory.' }
$refreshed = 0
foreach($sourceFile in @(Get-ChildItem -LiteralPath $packageDir -Recurse -File)) {
  $relative = $sourceFile.FullName.Substring($packageDir.Length).TrimStart([char]92,[char]47)
  $installedFile = Join-Path $installedDir $relative
  $same = (Test-Path -LiteralPath $installedFile) -and ((Get-FileHash -LiteralPath $sourceFile.FullName).Hash -eq (Get-FileHash -LiteralPath $installedFile).Hash)
  if(!$same) {
    New-Item -ItemType Directory -Force -Path (Split-Path $installedFile -Parent) | Out-Null
    $stagedFile = $installedFile + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
      Copy-Item -LiteralPath $sourceFile.FullName -Destination $stagedFile
      Move-Item -LiteralPath $stagedFile -Destination $installedFile -Force
    } finally {
      if(Test-Path -LiteralPath $stagedFile) { Remove-Item -LiteralPath $stagedFile -Force }
    }
    $refreshed++
  }
  if((Get-FileHash -LiteralPath $sourceFile.FullName).Hash -ne (Get-FileHash -LiteralPath $installedFile).Hash) { throw ('Installed file verification failed: ' + $relative) }
}
Write-Host ('Verified plugin files. Refreshed: ' + $refreshed)
[pscustomobject]@{plugin='dsh-qingsheng-voice';version='0.1.0';profile=$profile;backup=$backup;log=$log;installedAt=(Get-Date -Format o)} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $cache 'receipt.json') -Encoding UTF8
Write-Host 'Installed. If the voice controls do not appear yet, restart DSH after the current task finishes.'
