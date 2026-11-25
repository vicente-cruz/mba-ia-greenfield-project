#!/bin/sh
# Amostrador da VM na repetição da P-10GB (R-02), dentro do nestjs-api, a cada 0,5 s, até existir $1/stop.
# Linhas "V": instante (ms), contadores da VM (/proc/vmstat: swap e faltas de página maiores),
#   pressão (PSI total, em µs, de cpu, io e memória), memória (/proc/meminfo) e a linha cpu do
#   /proc/stat. Os valores são da VM inteira, compartilhada por todos os containers.
# Linhas "P": por processo do container de interesse (API, estressor, cliente): utime e stime
#   (ticks), faltas de página maiores, RSS (páginas), VmSwap (kB) e bytes lidos do disco.
D=$1
while [ ! -e "$D/stop" ]; do
  t=$(date +%s%3N)
  vm=$(awk '/^(pswpin|pswpout|pgmajfault|pgpgin|pgpgout) /{printf "%s=%s ", $1, $2}' /proc/vmstat)
  psi=""
  for r in cpu io memory; do
    psi="$psi$(awk -v r=$r '{split($5, a, "="); printf "%s_%s=%s ", r, $1, a[2]}' /proc/pressure/$r)"
  done
  mem=$(awk '/^(MemAvailable|SwapFree|Cached|Dirty|Writeback):/{printf "%s=%s ", substr($1, 1, length($1) - 1), $2}' /proc/meminfo)
  cpu=$(head -1 /proc/stat)
  echo "V $t $vm$psi$mem| $cpu"
  for p in /proc/[0-9]*; do
    cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
    case "$cmd" in
      *dist/main*) lab=api ;;
      *stress.js*) lab=stress ;;
      *upload-client*) lab=client ;;
      *) continue ;;
    esac
    st=$(cut -d')' -f2- "$p/stat" 2>/dev/null | awk '{print $12, $13, $10, $22}')
    sw=$(awk '/^VmSwap:/{print $2}' "$p/status" 2>/dev/null)
    rb=$(awk '/^read_bytes:/{print $2}' "$p/io" 2>/dev/null)
    [ -n "$st" ] && echo "P $t $lab ${p#/proc/} $st ${sw:-0} ${rb:-0}"
  done
  sleep 0.5
done
