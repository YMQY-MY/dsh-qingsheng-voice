$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$config = [Console]::In.ReadLine() | ConvertFrom-Json
$source = @'
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;
public sealed class QingShengWave : IDisposable {
  [StructLayout(LayoutKind.Sequential, Pack=2)] struct Format { public ushort tag,channels; public uint rate,bytesPerSecond; public ushort align,bits,extra; }
  [StructLayout(LayoutKind.Sequential)] struct Header { public IntPtr data; public uint length,recorded; public IntPtr user; public uint flags,loops; public IntPtr next,reserved; }
  [StructLayout(LayoutKind.Explicit, Size=12)] struct Position { [FieldOffset(0)] public uint type; [FieldOffset(4)] public uint value; }
  [DllImport("winmm.dll")] static extern uint waveOutOpen(out IntPtr handle,uint device,ref Format format,IntPtr callback,IntPtr instance,uint flags);
  [DllImport("winmm.dll")] static extern uint waveOutPrepareHeader(IntPtr h,IntPtr header,uint size);
  [DllImport("winmm.dll")] static extern uint waveOutWrite(IntPtr h,IntPtr header,uint size);
  [DllImport("winmm.dll")] static extern uint waveOutUnprepareHeader(IntPtr h,IntPtr header,uint size);
  [DllImport("winmm.dll")] static extern uint waveOutReset(IntPtr h);
  [DllImport("winmm.dll")] static extern uint waveOutPause(IntPtr h);
  [DllImport("winmm.dll")] static extern uint waveOutRestart(IntPtr h);
  [DllImport("winmm.dll")] static extern uint waveOutClose(IntPtr h);
  [DllImport("winmm.dll")] static extern uint waveOutGetPosition(IntPtr h,ref Position position,uint size);
  IntPtr handle; readonly List<IntPtr> buffers = new List<IntPtr>(); readonly uint size=(uint)Marshal.SizeOf(typeof(Header));
  static readonly BlockingCollection<string> commands = new BlockingCollection<string>();
  static void Check(uint code) { if(code!=0)throw new InvalidOperationException("Windows audio error "+code); }
  public QingShengWave(int rate) { var f=new Format{tag=1,channels=1,rate=(uint)rate,bytesPerSecond=(uint)rate*2,align=2,bits=16,extra=0}; Check(waveOutOpen(out handle,unchecked((uint)-1),ref f,IntPtr.Zero,IntPtr.Zero,0)); }
  public static void StartInput() { var thread=new Thread(()=>{try{string line;while((line=Console.ReadLine())!=null)commands.Add(line);}finally{commands.CompleteAdding();}});thread.IsBackground=true;thread.Start(); }
  public static string ReadCommand(int timeout) { string line;return commands.TryTake(out line,timeout)?line:null; }
  public static bool InputClosed { get{return commands.IsCompleted;} }
  public void Add(byte[] bytes) {
    if(bytes.Length==0||bytes.Length%2!=0)throw new InvalidOperationException("Invalid PCM data");
    var data=Marshal.AllocHGlobal(bytes.Length);var header=Marshal.AllocHGlobal((int)size);
    Marshal.Copy(bytes,0,data,bytes.Length);Marshal.StructureToPtr(new Header{data=data,length=(uint)bytes.Length},header,false);
    try{Check(waveOutPrepareHeader(handle,header,size));Check(waveOutWrite(handle,header,size));buffers.Add(header);}catch{waveOutUnprepareHeader(handle,header,size);Marshal.FreeHGlobal(data);Marshal.FreeHGlobal(header);throw;}
  }
  void Free(IntPtr header) { var h=(Header)Marshal.PtrToStructure(header,typeof(Header));waveOutUnprepareHeader(handle,header,size);Marshal.FreeHGlobal(h.data);Marshal.FreeHGlobal(header); }
  public int Collect() { for(int i=buffers.Count-1;i>=0;i--){var h=(Header)Marshal.PtrToStructure(buffers[i],typeof(Header));if((h.flags&1)!=0){Free(buffers[i]);buffers.RemoveAt(i);}}return buffers.Count; }
  public uint BytesPlayed { get { var p=new Position{type=4};Check(waveOutGetPosition(handle,ref p,12));if(p.type!=4)throw new InvalidOperationException("Unsupported audio clock");return p.value; } }
  public void Pause(){Check(waveOutPause(handle));} public void Resume(){Check(waveOutRestart(handle));}
  public void Cut(){Check(waveOutReset(handle));for(int i=buffers.Count-1;i>=0;i--){Free(buffers[i]);buffers.RemoveAt(i);}Check(waveOutRestart(handle));}
  public void Dispose(){if(handle==IntPtr.Zero)return;waveOutReset(handle);foreach(var h in buffers)Free(h);buffers.Clear();waveOutClose(handle);handle=IntPtr.Zero;}
}
'@
$bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($source)
$digest = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
$stamp = [BitConverter]::ToString($digest).Replace('-', '').ToLower().Substring(0, 12)
$assembly = Join-Path ([string]$config.cacheRoot) ('waveout-' + $stamp + '.dll')
if (-not (Test-Path -LiteralPath $assembly)) {
  try { Add-Type -TypeDefinition $source -OutputAssembly $assembly -ErrorAction Stop }
  catch { if (-not (Test-Path -LiteralPath $assembly)) { throw } }
}
Add-Type -Path $assembly
$player = New-Object QingShengWave ([int]$config.sampleRate)
[QingShengWave]::StartInput()
$paused = $false
$cursor = 0L
$last = -1000
$clock = [Diagnostics.Stopwatch]::StartNew()
$running = $true
try {
  [Console]::Out.WriteLine('{"type":"ready"}')
  while ($running) {
    $line = [QingShengWave]::ReadCommand(10)
    if ($null -ne $line) {
      $command = $line | ConvertFrom-Json
      $action = [string]$command.action
      switch ($action) {
        'audio' { $player.Add([Convert]::FromBase64String([string]$command.data)) }
        'pause' { $player.Pause(); $paused = $true }
        'resume' { $player.Resume(); $paused = $false }
        'cut' { $player.Cut(); $paused = $false }
        'finish' { }
        'stop' { $running = $false }
        default { throw ('Unknown audio command: ' + $action) }
      }
    }
    $queued = $player.Collect()
    $played = [long]$player.BytesPlayed
    $due = (($clock.ElapsedMilliseconds - $last) -ge 100)
    if ($due -and ($played -ne $cursor)) {
      $last = $clock.ElapsedMilliseconds
      $cursor = $played
      [Console]::Out.WriteLine((@{type='position';bytes=$played;paused=$paused} | ConvertTo-Json -Compress))
    }
    if (($queued -eq 0) -and (-not $paused) -and ($played -gt 0)) {
      [Console]::Out.WriteLine((@{type='done';bytes=$played} | ConvertTo-Json -Compress))
      $cursor = 0
    }
    if ([QingShengWave]::InputClosed) { $running = $false }
  }
} finally {
  $player.Dispose()
}
