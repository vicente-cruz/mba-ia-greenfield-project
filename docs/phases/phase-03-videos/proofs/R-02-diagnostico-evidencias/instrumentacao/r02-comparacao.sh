#!/usr/bin/env bash
# Comparação TEMPORÁRIA do diagnóstico R-02 (não faz parte do repositório): upload de 1 GB com o
# cliente no ambiente atual (A, container nestjs-api) e fora do Docker/WSL (B, Node nativo do
# Windows), alternando A1, B1, A2 e B2. O mesmo cliente (upload-client.ts compilado uma vez para JS,
# sem mudança de lógica) e os mesmos parâmetros nos dois cenários (4 PUTs simultâneos, lotes de 10,
# registro a cada 4, 1,1 s entre part-urls). API (watch, como na P-10GB), banco, storage, worker,
# sondas e instrumentação iguais nos dois. Os arquivos de 1 GB são gerados antes da medição.
# Diferenças inevitáveis: o caminho de rede (A: rede do Compose, com --storage-connect; B: portas
# publicadas no localhost do Windows, o caminho do navegador), o disco do arquivo (A: ext4 no VHDX
# do Docker; B: NTFS do Windows) e o Node (A: v25.6.0 no container; B: v22.17.0 no Windows).
set -euo pipefail
SCR=$(cd "$(dirname "$0")" && pwd)
cd <repositório>/nestjs-project
OUT=$1
RUN=$(date -u +%Y%m%d%H%M%S)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
EVID=$OUT/r02b-$RUN
mkdir -p "$EVID"
LOG=$OUT/r02b-$RUN.log
CDIR=/tmp/r02b-$RUN
WINTEMP=$(wslpath -u "$(powershell.exe -NoProfile -Command '[IO.Path]::GetTempPath()' | tr -d '\r')")
WINDIR=${WINTEMP%/}/r02b-$RUN
UA=r02b-$RUN-uploadera@proofs.streamtube.test
UB=r02b-$RUN-uploaderb@proofs.streamtube.test
CONTROL=r02b-$RUN-control@proofs.streamtube.test
PROBES=4
PROBE_PIDS=()
BG_PIDS=()
API_PID=
CONTROL_ID=
CLIENT_PARAMS=(--concurrency 4 --sign-batch 10 --register-every 4 --part-urls-interval-ms 1100)

log() { printf '%s\n' "$*" | tee -a "$LOG"; }
api() { docker compose exec -T nestjs-api "$@"; }
support() { api npx ts-node proofs/phase-03/upload-proof-support.ts "$@"; }
now() { api date +%s%3N; }
mark() { local t; t=$(now); echo "$1 $2 $t" >>"$EVID/phases.txt"; log "MARCA | $1 | $2 | $t"; }
run() { log "\$ $*"; "$@" > >(tee -a "$LOG") 2>&1; }
win() { (cd "$WINDIR" && node.exe "$@") 2>&1 | tr -d '\r'; }

start_api() {
  docker compose exec -T -e NODE_OPTIONS="--require=$CDIR/preload.js" -e R02_OUT="$CDIR/api" \
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
  log "API sem resposta em 120 s"
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
  # A versão com o \timing corrigido (printf) foi arquivada como dbprobe-corrigido.sh; o dbprobe.sh
  # original, dos primeiros ensaios, não ativa o \timing.
  docker compose exec -T db sh -c "cat > /tmp/r02b-$RUN.dbprobe.sh" <"$SCR/dbprobe-corrigido.sh"
  docker compose exec -T db sh "/tmp/r02b-$RUN.dbprobe.sh" "$CONTROL_ID" "/tmp/r02b-$RUN.dbstop" >"$EVID/dbprobe.txt" 2>&1 &
  BG_PIDS+=($!)
  (while [ ! -e "$EVID/stats.stop" ]; do
    docker stats --no-stream --format "$(date +%s%3N) {{.Name}} cpu {{.CPUPerc}} mem {{.MemUsage}}" \
      $(docker compose ps -q nestjs-api db storage video-worker) $(docker ps --format '{{.Names}}' | grep "^r02b-$RUN-probe") 2>/dev/null || true
    sleep 2
  done) >"$EVID/docker-stats.txt" &
  BG_PIDS+=($!)
}

stop_monitors() {
  api touch "$CDIR/stop" || true
  docker compose exec -T db touch "/tmp/r02b-$RUN.dbstop" || true
  touch "$EVID/stats.stop"
  for pid in "${BG_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  BG_PIDS=()
}

start_probes() {
  local i j ready
  for i in $(seq 1 "$PROBES"); do
    (api cat "$CDIR/control.json" |
      docker compose run --rm --no-deps -T --name "r02b-$RUN-probe-$i" nestjs-api \
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
  for i in $(seq 1 "$PROBES"); do docker kill --signal SIGTERM "r02b-$RUN-probe-$i" >/dev/null 2>&1 || true; done
  for pid in "${PROBE_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  PROBE_PIDS=()
  for i in $(seq 1 "$PROBES"); do tail -1 "$EVID/probe-$i.log" | tee -a "$LOG"; done
}

residue() {
  docker compose exec -T storage sh -c \
    'cd /data/.minio.sys/tmp && for d in *; do [ -d "$d" ] && echo "$(du -sk "$d" | cut -f1) KiB $d"; done; true'
}

upload_a() {
  local n=$1
  mark "$n" inicio
  run api node "$CDIR/js/upload-client.js" start --file "$CDIR/f.bin" --file-name "r02b-$RUN-$n.mp4" \
    --credentials "$CDIR/uploadera.json" --state "$CDIR/state-$n.json" --events "$CDIR/events-$n.jsonl" \
    --progress "$CDIR/progress-$n.json" --storage-connect localhost:9000=storage:9000 "${CLIENT_PARAMS[@]}"
  mark "$n" fim
  api cat "$CDIR/events-$n.jsonl" >"$EVID/events-$n.jsonl"
}

upload_b() {
  local n=$1
  mark "$n" inicio
  log "\$ (Windows) node.exe js/upload-client.js start --file f.bin … --api http://localhost:3000 ${CLIENT_PARAMS[*]}"
  win js/upload-client.js start --file f.bin --file-name "r02b-$RUN-$n.mp4" --credentials uploaderb.json \
    --state "state-$n.json" --events "events-$n.jsonl" --progress "progress-$n.json" \
    --api http://localhost:3000 "${CLIENT_PARAMS[@]}" | tee -a "$LOG"
  mark "$n" fim
  cp "$WINDIR/events-$n.jsonl" "$EVID/events-$n.jsonl"
}

cleanup() {
  local rc=$?
  set +e
  log "=== limpeza"
  stop_probes
  stop_monitors
  for k in requests loop db; do
    api test -e "$CDIR/api/$k.jsonl" && api cat "$CDIR/api/$k.jsonl" >"$EVID/api-$k.jsonl"
  done
  stop_api
  docker ps -a --format '{{.Names}}' | grep "^r02b-$RUN" | xargs -r docker rm -f >/dev/null
  log "containers r02b restantes: $(docker ps -a --format '{{.Names}}' | grep -c "^r02b-$RUN" || true)"
  run support cleanup --emails "$UA,$UB,$CONTROL"
  api rm -rf "$CDIR"
  log "diretório no nestjs-api presente: $(api test -e "$CDIR" && echo sim || echo não)"
  case "$WINDIR" in
    /mnt/c/*/r02b-"$RUN") rm -rf -- "$WINDIR" ;;
    *) log "WINDIR inesperado, não removido: $WINDIR" ;;
  esac
  log "diretório no Windows presente: $([ -e "$WINDIR" ] && echo sim || echo não)"
  docker compose exec -T db rm -f "/tmp/r02b-$RUN.dbprobe.sh" "/tmp/r02b-$RUN.dbstop"
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

log "=== R-02 comparação A×B — runId $RUN ($(date -u +%H:%M:%SZ))"
log "livre em C: $(df -B1 --output=avail /mnt/c | tail -1)"
log "Node do container: $(api node -v); Node do Windows: $( (cd /mnt/c && node.exe -v) | tr -d '\r')"
support snapshot >"$EVID/snapshot-before.txt"
residue >"$EVID/residue-before.txt"
api sh -c "umask 077 && mkdir -p '$CDIR/js'"
mkdir -p "$WINDIR/js"
for f in preload.js sampler.sh; do api sh -c "cat > '$CDIR/$f'" <"$SCR/$f"; done
run api npx tsc --outDir "$CDIR/js" --module nodenext --moduleResolution nodenext --target ES2023 \
  --esModuleInterop --skipLibCheck --strictNullChecks proofs/phase-03/upload-client.ts
for f in upload-client.js proof-api.js; do api cat "$CDIR/js/$f" >"$WINDIR/js/$f"; done
log "cliente compilado: $(api sha256sum "$CDIR/js/upload-client.js" | cut -c1-16) (container) e $(sha256sum "$WINDIR/js/upload-client.js" | cut -c1-16) (Windows)"
start_api
log "API pela porta publicada, do Windows: $(win -e "require('http').get('http://localhost:3000/',r=>{console.log('HTTP',r.statusCode);r.resume()}).on('error',e=>console.log(e.code))")"
run support account --email "$UA" --credentials "$CDIR/uploadera.json"
run support account --email "$UB" --credentials "$CDIR/uploaderb.json"
run support account --email "$CONTROL" --credentials "$CDIR/control.json"
api cat "$CDIR/uploaderb.json" >"$WINDIR/uploaderb.json"
run support control-video --credentials "$CDIR/control.json" --state "$CDIR/control-state.json" --file-name "r02b-$RUN-control.mp4"
CONTROL_ID=$(api cat "$CDIR/control-state.json" | python3 -c "import json,sys; print(json.load(sys.stdin)['publicId'])")
run api node "$CDIR/js/upload-client.js" generate --file "$CDIR/f.bin" --size 1000000000 --seed "r02b-$RUN-a"
log "$(win js/upload-client.js generate --file f.bin --size 1000000000 --seed "r02b-$RUN-b")"
start_monitors
start_probes
sleep 20
mark R0-repouso inicio; sleep 60; mark R0-repouso fim
upload_a A1; sleep 20
upload_b B1; sleep 20
upload_a A2; sleep 20
upload_b B2; sleep 10
