$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$inputJson = [Console]::In.ReadToEnd()
$settings = $inputJson | ConvertFrom-Json
$player = New-Object System.Media.SoundPlayer
try {
  $player.SoundLocation = [string]$settings.file
  $player.Load()
  $player.PlaySync()
} finally {
  $player.Stop()
  $player.Dispose()
}
