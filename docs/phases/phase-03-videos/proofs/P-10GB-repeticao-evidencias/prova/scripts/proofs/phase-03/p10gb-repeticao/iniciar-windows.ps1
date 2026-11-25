# Repetição da P-10GB (R-02): inicia um comando no Windows num console próprio e oculto (cmd /c,
# com a saída em arquivo), com o processamento normal de Ctrl+C reativado, grava o PID do processo
# do console e devolve o código de saída do comando.
# Por que reativar o Ctrl+C: o atributo "ignorar Ctrl+C" é herdado pelos processos filhos e vem
# ligado da cadeia de inicialização pela interoperação do WSL. Sem reativá-lo, o CTRL_C_EVENT do
# console não chega ao Node, e o SIGINT do cliente não é acionado (pré-checagem de 2026-11-25).
# Uso: powershell.exe -NoProfile -ExecutionPolicy Bypass -File iniciar-windows.ps1 -Dir <pasta> -PidFile <arquivo> -Command "<comando>"
param([string]$Dir, [string]$PidFile, [string]$Command)
Add-Type -Namespace P10GB -Name ConsoleStart -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(System.IntPtr handler, bool add);
'@
[P10GB.ConsoleStart]::SetConsoleCtrlHandler([IntPtr]::Zero, $false) | Out-Null
$p = Start-Process -FilePath cmd.exe -ArgumentList '/c', $Command -WorkingDirectory $Dir -WindowStyle Hidden -PassThru
Set-Content -Path $PidFile -Value $p.Id -Encoding ascii
$p.WaitForExit()
exit $p.ExitCode
