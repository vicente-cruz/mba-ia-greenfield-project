# Repetição da P-10GB (R-02): envia um Ctrl+C real (CTRL_C_EVENT) ao console de um processo, o mesmo
# evento de um Ctrl+C digitado, que o Node no Windows entrega ao handler process.on('SIGINT').
# Anexa-se ao console do processo, ignora o evento em si mesmo e o gera para os processos desse
# console. Não encerra processos à força nem simula eventos. Registra cada passo em $Log, com o
# instante em ms (relógio do Windows).
# Modo armado (-TriggerFile): parte e prepara as chamadas antes (a partida do PowerShell e o Add-Type
# levam ~3 s, o que atrasou a interrupção na 2ª pré-checagem), espera o arquivo de gatilho em ciclos
# de 10 ms e só então envia o Ctrl+C.
# Com -PidFile, o PID do console é lido desse arquivo só depois do gatilho, o que permite armar o envio
# antes de o cliente iniciar.
# Uso: powershell.exe -NoProfile -ExecutionPolicy Bypass -File ctrl-c.ps1 (-TargetPid <pid> | -PidFile <arquivo>) -Log <arquivo> [-TriggerFile <arquivo>]
param([int]$TargetPid = 0, [string]$PidFile = '', [string]$Log, [string]$TriggerFile = '')
Add-Type -Namespace P10GB -Name ConsoleCtrl -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint dwProcessId);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(System.IntPtr handler, bool add);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
'@
function L($m) { Add-Content -Path $Log -Value "$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) $m" -Encoding ascii }
if ($TriggerFile -ne '') {
  L "armado: esperando $TriggerFile"
  $deadline = [DateTime]::UtcNow.AddMinutes(30)
  while (-not (Test-Path $TriggerFile)) {
    if ([DateTime]::UtcNow -gt $deadline) { L 'gatilho não veio em 30 min'; exit 4 }
    Start-Sleep -Milliseconds 10
  }
  L 'gatilho visto'
}
if ($TargetPid -eq 0 -and $PidFile -ne '') { $TargetPid = [int]((Get-Content -Path $PidFile -Raw).Trim()) }
[P10GB.ConsoleCtrl]::FreeConsole() | Out-Null
$a = [P10GB.ConsoleCtrl]::AttachConsole([uint32]$TargetPid)
L "AttachConsole($TargetPid): $a ($([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
if (-not $a) { exit 2 }
[P10GB.ConsoleCtrl]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
$g = [P10GB.ConsoleCtrl]::GenerateConsoleCtrlEvent(0, 0)
L "GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0): $g"
Start-Sleep -Milliseconds 500
[P10GB.ConsoleCtrl]::FreeConsole() | Out-Null
if ($g) { exit 0 } else { exit 3 }
