# Monitor do Windows da repetição da P-10GB (R-02), no Windows, com ferramentas nativas (CIM e Get-Process),
# sem instalação nem mudança de configuração. A cada ~1 s, até existir o arquivo de parada, grava:
# instante (ms UTC), memória disponível e comprometida, limite de commit, paginação (páginas/s,
# leituras e escritas, entradas e saídas), uso do arquivo de paginação, disco físico (% de tempo,
# fila, leitura e escrita em bytes/s), working set do processo da VM do WSL (vmmem*) e CPU
# acumulada dos processos node.exe (o cliente de prova).
# Uso: powershell.exe -NoProfile -ExecutionPolicy Bypass -File monitor-windows.ps1 <saída.csv> <parada>
param([string]$Out, [string]$Stop)
'epoch_ms,available_mb,committed_bytes,commit_limit,pages_per_sec,page_reads_per_sec,page_writes_per_sec,pages_input_per_sec,pages_output_per_sec,pagefile_pct,disk_pct_time,disk_queue,disk_read_bps,disk_write_bps,vmmem_ws_bytes,node_cpu_ms' | Out-File -FilePath $Out -Encoding ascii
while (-not (Test-Path $Stop)) {
  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
  $pf = Get-CimInstance Win32_PerfFormattedData_PerfOS_PagingFile -Filter "Name='_Total'"
  $d = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
  $vm = (Get-Process -Name 'vmmem*' -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum).Sum
  $nd = (Get-Process -Name 'node' -ErrorAction SilentlyContinue | ForEach-Object { $_.TotalProcessorTime.TotalMilliseconds } | Measure-Object -Sum).Sum
  "$t,$($m.AvailableMBytes),$($m.CommittedBytes),$($m.CommitLimit),$($m.PagesPersec),$($m.PageReadsPersec),$($m.PageWritesPersec),$($m.PagesInputPersec),$($m.PagesOutputPersec),$($pf.PercentUsage),$($d.PercentDiskTime),$($d.CurrentDiskQueueLength),$($d.DiskReadBytesPersec),$($d.DiskWriteBytesPersec),$vm,$([math]::Round([double]$nd))" | Out-File -FilePath $Out -Append -Encoding ascii
  Start-Sleep -Milliseconds 700
}
