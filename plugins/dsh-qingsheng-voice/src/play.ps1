$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
# PS 5.1 的 Console.In 按 ANSI 解码，中文路径（用户名含中文）会变乱码导致无声。
$utf8Enc = [System.Text.Encoding]::GetEncoding(65001, [System.Text.EncoderFallback]::ExceptionFallback, [System.Text.DecoderFallback]::ExceptionFallback)
$stdin = [Console]::OpenStandardInput()
$utf8In = [System.IO.StreamReader]::new($stdin, $utf8Enc)
$inputJson = $utf8In.ReadToEnd()
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
