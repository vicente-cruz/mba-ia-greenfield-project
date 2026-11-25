#!/usr/bin/env bash
# Ensaio TEMPORÁRIO do diagnóstico R-02 com perfil de CPU (não faz parte do repositório): cenário B
# da comparação (cliente no Node nativo do Windows, arquivo de 1 GB preparado antes, os mesmos
# parâmetros, com 4 PUTs simultâneos). A API roda em watch, como antes, com preload-perfil.js:
# perfil de CPU do V8 só do processo da API, pausas de GC, CPU de usuário e de sistema com a duração
# real entre coletas, event loop, requisições e pg. Também: amostrador da VM, sonda do PostgreSQL
# (dbprobe-corrigido.sh), docker stats, 4 sondas e o monitor do Windows (memória, commit, paginação,
# disco, vmmem e node.exe).
# Episódio (fixado antes): algum registro do event loop com atraso >= 500 ms entre o início do
# upload e 1,5 s depois do fim. Sem episódio na 1ª execução, há só mais uma.
set -euo pipefail
SCR=$(cd "$(dirname "$0")" && pwd)
cd <repositório>/nestjs-project
OUT=$1
RUN=$(date -u +%Y%m%d%H%M%S)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
EVID=$OUT/r02c-$RUN
mkdir -p "$EVID"
LOG=$OUT/r02c-$RUN.log
CDIR=/tmp/r02c-$RUN
WINTEMP=$(wslpath -u "$(powershell.exe -NoProfile -Command '[IO.Path]::GetTempPath()' | tr -d '\r')")
WINDIR=${WINTEMP%/}/r02c-$RUN
UB=r02c-$RUN-uploaderb@proofs.streamtube.test
CONTROL=r02c-$RUN-control@proofs.streamtube.test
PROBES=4
PROBE_PIDS=()
BG_PIDS=()
API_PID=
WINMON_PID=
CONTROL_ID=
CLIENT_PARAMS=(--concurrency 4 --sign-batch 10 --register-every 4 --part-urls-interval-ms 1100)

log() { printf '%s\n' "$*" | tee -a "$LOG"; }
api() { docker compose exec -T nestjs-api "$@"; }
support() { api npx ts-node proofs/phase-03/upload-proof-support.ts "$@"; }
now() { api date +%s%3N; }
mark() { local t; t=$(now); echo "$1 $2 $t" >>"$EVID/phases.txt"; log "MARCA | $1 | $2 | $t"; }
run() { log "\$ $*"; "$@" > >(tee -a "$LOG") 2>&1; }
win() { (cd "$WINDIR" && node.exe "$@") 2>&1 | tr -d '\r'; }

clock_offset() {
  local a w b
  a=$(now); w=$( (cd /mnt/c && node.exe -p 'Date.now()') | tr -d '\r'); b=$(now)
  log "relógios: VM $a..$b, Windows $w; diferença Windows − VM ≈ $((w - (a + b) / 2)) ms (incerteza ± $(((b - a) / 2)) ms)"
}

start_api() {
  docker compose exec -T -e NODE_OPTIONS="--require=$CDIR/preload-perfil.js" -e R02_OUT="$CDIR/api" \
    nestjs-api npm run start:dev >"$EVID/api.log" 2>&1 &
  API_PID=$!
  local i
  for i in $(seq 1 120); do
    if curl --noproxy '*' -s -o /dev/null -w '%{http_code}' http://localhost:3000 | grep -q 200; then
      log "API pronta em ${i} s"
      return 0
    fi
    sleep 1
  done
  return 1
}

stop_api() {
  local pids
  pids=$(api ps -eo pid,args | awk '/npm run start:dev|nest start --watch|dist\/main/ {print $1}' | tr '\n' ' ')
  # shellcheck disable=SC2086
  [ -n "${pids// /}" ] && api kill -TERM $pids || true
  [ -n "$API_PID" ] && { wait "$API_PID" 2>/dev/null || true; API_PID=; }
  sleep 2
  log "processos da API restantes: $(api ps -eo args | grep -c '[d]ist/main' || true)"
}

start_monitors() {
  api sh "$CDIR/sampler.sh" "$CDIR" >"$EVID/sampler.txt" 2>"$EVID/sampler.err" &
  BG_PIDS+=($!)
  docker compose exec -T db sh -c "cat > /tmp/r02c-$RUN.dbprobe.sh" <"$SCR/dbprobe-corrigido.sh"
  docker compose exec -T db sh "/tmp/r02c-$RUN.dbprobe.sh" "$CONTROL_ID" "/tmp/r02c-$RUN.dbstop" >"$EVID/dbprobe.txt" 2>&1 &
  BG_PIDS+=($!)
  (while [ ! -e "$EVID/stats.stop" ]; do
    docker stats --no-stream --format "$(date +%s%3N) {{.Name}} cpu {{.CPUPerc}} mem {{.MemUsage}}" \
      $(docker compose ps -q nestjs-api db storage video-worker) $(docker ps --format '{{.Names}}' | grep "^r02c-$RUN-probe") 2>/dev/null || true
    sleep 2
  done) >"$EVID/docker-stats.txt" &
  BG_PIDS+=($!)
  (cd "$WINDIR" && powershell.exe -NoProfile -ExecutionPolicy Bypass -File monitor-windows.ps1 windows.csv parar-monitor) >"$EVID/monitor-windows.err" 2>&1 &
  WINMON_PID=$!
}

stop_monitors() {
  api touch "$CDIR/stop" || true
  docker compose exec -T db touch "/tmp/r02c-$RUN.dbstop" || true
  touch "$EVID/stats.stop"
  touch "$WINDIR/parar-monitor"
  for pid in "${BG_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  [ -n "$WINMON_PID" ] && { wait "$WINMON_PID" 2>/dev/null || true; }
  BG_PIDS=()
  [ -e "$WINDIR/windows.csv" ] && tr -d '\r' <"$WINDIR/windows.csv" >"$EVID/windows.csv"
}

start_probes() {
  local i j ready
  for i in $(seq 1 "$PROBES"); do
    (api cat "$CDIR/control.json" |
      docker compose run --rm --no-deps -T --name "r02c-$RUN-probe-$i" nestjs-api \
        node -r ts-node/register proofs/phase-03/responsiveness-probe.ts --public-id "$CONTROL_ID" --instance "$i" \
        >"$EVID/probe-$i.csv" 2>"$EVID/probe-$i.log") &
    PROBE_PIDS+=($!)
  done
  for i in $(seq 1 120); do
    ready=0
    for j in $(seq 1 "$PROBES"); do
      [ "$(cat "$EVID/probe-$j.csv" 2>/dev/null | wc -l)" -ge 2 ] && ready=$((ready + 1))
    done
    [ "$ready" -eq "$PROBES" ] && { log "sondas prontas: $ready"; return 0; }
    sleep 1
  done
  return 1
}

stop_probes() {
  local i
  for i in $(seq 1 "$PROBES"); do docker kill --signal SIGTERM "r02c-$RUN-probe-$i" >/dev/null 2>&1 || true; done
  for pid in "${PROBE_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  PROBE_PIDS=()
}

residue() {
  docker compose exec -T storage sh -c \
    'cd /data/.minio.sys/tmp && for d in *; do [ -d "$d" ] && echo "$(du -sk "$d" | cut -f1) KiB $d"; done; true'
}

profile_start() {
  api sh -c "printf '%s' '$1' > '$CDIR/api/profile.start'"
  local i
  for i in $(seq 1 50); do
    api test -e "$CDIR/api/$1-meta.json" && { log "perfil $1 iniciado"; return 0; }
    sleep 0.2
  done
  log "perfil $1 não iniciou"
  return 1
}

profile_stop() {
  api touch "$CDIR/api/profile.stop"
  local i
  for i in $(seq 1 100); do
    if api test -e "$CDIR/api/$1.cpuprofile" && ! api test -e "$CDIR/api/profile.start"; then
      api cat "$CDIR/api/$1.cpuprofile" >"$EVID/$1.cpuprofile"
      api cat "$CDIR/api/$1-meta.json" >"$EVID/$1-meta.json"
      log "perfil $1 gravado: $(wc -c <"$EVID/$1.cpuprofile") bytes"
      return 0
    fi
    sleep 0.3
  done
  log "perfil $1 não gravado"
  return 1
}

upload_b() {
  local n=$1
  profile_start "perfil-$n"
  mark "$n" inicio
  log "\$ (Windows) node.exe js/upload-client.js start --file f.bin … --api http://localhost:3000 ${CLIENT_PARAMS[*]}"
  win js/upload-client.js start --file f.bin --file-name "r02c-$RUN-$n.mp4" --credentials uploaderb.json \
    --state "state-$n.json" --events "events-$n.jsonl" --progress "progress-$n.json" \
    --api http://localhost:3000 "${CLIENT_PARAMS[@]}" | tee -a "$LOG"
  mark "$n" fim
  sleep 2
  profile_stop "perfil-$n"
  cp "$WINDIR/events-$n.jsonl" "$EVID/events-$n.jsonl"
}

episode_in() {
  local a b
  a=$(awk -v n="$1" '$1 == n && $2 == "inicio" {print $3}' "$EVID/phases.txt")
  b=$(awk -v n="$1" '$1 == n && $2 == "fim" {print $3}' "$EVID/phases.txt")
  api cat "$CDIR/api/loop.jsonl" | python3 -c "
import json,sys
a,b=$a,$b+1500
hits=[r for r in map(json.loads,sys.stdin) if a<=r['t']<=b and r['elMaxMs']>=500]
print(len(hits)); [print('  episódio:',json.dumps(h),file=sys.stderr) for h in hits]"
}

cleanup() {
  local rc=$?
  set +e
  log "=== limpeza"
  stop_probes
  stop_monitors
  for k in requests loop db gc; do
    api test -e "$CDIR/api/$k.jsonl" && api cat "$CDIR/api/$k.jsonl" >"$EVID/api-$k.jsonl"
  done
  stop_api
  docker ps -a --format '{{.Names}}' | grep "^r02c-$RUN" | xargs -r docker rm -f >/dev/null
  log "containers r02c restantes: $(docker ps -a --format '{{.Names}}' | grep -c "^r02c-$RUN" || true)"
  run support cleanup --emails "$UB,$CONTROL"
  api rm -rf "$CDIR"
  log "diretório no nestjs-api presente: $(api test -e "$CDIR" && echo sim || echo não)"
  case "$WINDIR" in
    /mnt/c/*/r02c-"$RUN") rm -rf -- "$WINDIR" ;;
    *) log "WINDIR inesperado, não removido" ;;
  esac
  log "diretório no Windows presente: $([ -e "$WINDIR" ] && echo sim || echo não)"
  docker compose exec -T db rm -f "/tmp/r02c-$RUN.dbprobe.sh" "/tmp/r02c-$RUN.dbstop"
  local waited=0 trash
  while :; do
    trash=$(docker compose exec -T storage sh -c 'du -sk /data/.minio.sys/tmp/.trash 2>/dev/null | cut -f1')
    [ "${trash:-0}" -le 10240 ] && break
    [ "$waited" -ge 900 ] && break
    sleep 10
    waited=$((waited + 10))
  done
  log "lixeira do storage: ${trash:-0} KiB depois de $waited s"
  residue >"$EVID/residue-after.txt"
  if cmp -s "$EVID/residue-before.txt" "$EVID/residue-after.txt"; then log "temporários do Silo: lista igual, nenhum novo"; else log "temporários do Silo: listas diferentes"; diff "$EVID/residue-before.txt" "$EVID/residue-after.txt" | tee -a "$LOG"; fi
  support snapshot >"$EVID/snapshot-after.txt"
  if cmp -s "$EVID/snapshot-before.txt" "$EVID/snapshot-after.txt"; then log "retratos iguais"; else log "retratos diferentes"; fi
  log "livre em C: $(df -B1 --output=avail /mnt/c | tail -1)"
  log "código: $rc"
  exit "$rc"
}
trap cleanup EXIT

log "=== R-02 perfil (cenário B) — runId $RUN ($(date -u +%H:%M:%SZ))"
log "livre em C: $(df -B1 --output=avail /mnt/c | tail -1)"
support snapshot >"$EVID/snapshot-before.txt"
residue >"$EVID/residue-before.txt"
api sh -c "umask 077 && mkdir -p '$CDIR/js' '$CDIR/api'"
mkdir -p "$WINDIR/js"
for f in preload-perfil.js sampler.sh; do api sh -c "cat > '$CDIR/$f'" <"$SCR/$f"; done
cp "$SCR/monitor-windows.ps1" "$WINDIR/"
run api npx tsc --outDir "$CDIR/js" --module nodenext --moduleResolution nodenext --target ES2023 \
  --esModuleInterop --skipLibCheck --strictNullChecks proofs/phase-03/upload-client.ts
for f in upload-client.js proof-api.js; do api cat "$CDIR/js/$f" >"$WINDIR/js/$f"; done
log "cliente compilado: $(sha256sum "$WINDIR/js/upload-client.js" | cut -c1-16)"
start_api
run support account --email "$UB" --credentials "$CDIR/uploaderb.json"
run support account --email "$CONTROL" --credentials "$CDIR/control.json"
api cat "$CDIR/uploaderb.json" >"$WINDIR/uploaderb.json"
run support control-video --credentials "$CDIR/control.json" --state "$CDIR/control-state.json" --file-name "r02c-$RUN-control.mp4"
CONTROL_ID=$(api cat "$CDIR/control-state.json" | python3 -c "import json,sys; print(json.load(sys.stdin)['publicId'])")
log "$(win js/upload-client.js generate --file f.bin --size 1000000000 --seed "r02c-$RUN-b")"
clock_offset
start_monitors
start_probes
sleep 20
mark R0-repouso inicio; sleep 30; mark R0-repouso fim
upload_b B1
EP=$(episode_in B1 2> >(tee -a "$LOG" >&2))
log "episódios (event loop >= 500 ms) na B1: $EP"
if [ "$EP" -eq 0 ]; then
  log "sem episódio na B1: uma única execução extra (B2)"
  sleep 20
  upload_b B2
  EP2=$(episode_in B2 2> >(tee -a "$LOG" >&2))
  log "episódios (event loop >= 500 ms) na B2: $EP2"
fi
clock_offset
sleep 6
