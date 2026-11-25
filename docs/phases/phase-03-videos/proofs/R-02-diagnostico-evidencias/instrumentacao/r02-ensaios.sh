#!/usr/bin/env bash
# Ensaios TEMPORÁRIOS do diagnóstico R-02 (não fazem parte do repositório). Roda no host, a partir
# de nestjs-project/, com a API parada no início. Arquivos de até 1 GB; uma variável por fase.
# - API com a instrumentação temporária (preload.js via NODE_OPTIONS, só no processo dist/main);
# - 4 sondas em containers próprios, como na P-10GB, durante todos os ensaios;
# - amostrador da VM e dos processos no nestjs-api, sonda do PostgreSQL no db e docker stats;
# - fases com marcadores pelo relógio dos containers:
#   modo watch (npm run start:dev): repouso, SHA-256 em cache, SHA-256 frio, SHA-256 frio em outro
#   container, upload de 1 GB; modo sem watch (node dist/main): repouso, SHA-256 frio, upload de 1 GB.
# Recursos: usuários r02-<runId>-uploader e r02-<runId>-control, /tmp/r02-<runId>/ no nestjs-api,
# containers r02-<runId>-*, os vídeos de 1 GB e /tmp/r02-<runId>.* no db. Todos removidos no final.
set -euo pipefail
SCR=$(cd "$(dirname "$0")" && pwd)
cd <repositório>/nestjs-project
OUT=$1
RUN=$(date -u +%Y%m%d%H%M%S)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
EVID=$OUT/r02-$RUN
mkdir -p "$EVID"
LOG=$OUT/r02-$RUN.log
CDIR=/tmp/r02-$RUN
UPLOADER=r02-$RUN-uploader@proofs.streamtube.test
CONTROL=r02-$RUN-control@proofs.streamtube.test
PROBES=4
PHASE_SECONDS=${R02_PHASE_SECONDS:-60}
PROBE_PIDS=()
BG_PIDS=()
API_PID=
CONTROL_ID=

log() { printf '%s\n' "$*" | tee -a "$LOG"; }
api() { docker compose exec -T nestjs-api "$@"; }
support() { api npx ts-node proofs/phase-03/upload-proof-support.ts "$@"; }
client() { api npx ts-node proofs/phase-03/upload-client.ts "$@"; }
now() { api date +%s%3N; }
mark() { local t; t=$(now); echo "$1 $2 $t" >>"$EVID/phases.txt"; log "MARCA | $1 | $2 | $t"; }
run() { log "\$ $*"; "$@" > >(tee -a "$LOG") 2>&1; }

api_ready() {
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

start_api() {
  local mode=$1
  if [ "$mode" = watch ]; then
    docker compose exec -T -e NODE_OPTIONS="--require=$CDIR/preload.js" -e R02_OUT="$CDIR/api-watch" \
      nestjs-api npm run start:dev >"$EVID/api-watch.log" 2>&1 &
  else
    docker compose exec -T -e NODE_OPTIONS="--require=$CDIR/preload.js" -e R02_OUT="$CDIR/api-nowatch" \
      nestjs-api node --enable-source-maps dist/main >"$EVID/api-nowatch.log" 2>&1 &
  fi
  API_PID=$!
  api_ready
}

stop_api() {
  local pids
  pids=$(api ps -eo pid,args | awk '/npm run start:dev|nest start --watch|dist\/main/ && !/awk/ {print $1}' | tr '\n' ' ')
  if [ -n "${pids// /}" ]; then
    # shellcheck disable=SC2086
    api kill -TERM $pids || true
  fi
  [ -n "$API_PID" ] && { wait "$API_PID" 2>/dev/null || true; API_PID=; }
  sleep 2
  log "processos da API restantes: $(api ps -eo args | grep -c '[d]ist/main' || true)"
}

start_monitors() {
  api sh "$CDIR/sampler.sh" "$CDIR" >"$EVID/sampler.txt" 2>"$EVID/sampler.err" &
  BG_PIDS+=($!)
  docker compose exec -T db sh -c "cat > /tmp/r02-$RUN.dbprobe.sh" <"$SCR/dbprobe.sh"
  docker compose exec -T db sh "/tmp/r02-$RUN.dbprobe.sh" "$CONTROL_ID" "/tmp/r02-$RUN.dbstop" >"$EVID/dbprobe.txt" 2>&1 &
  BG_PIDS+=($!)
  (while [ ! -e "$EVID/stats.stop" ]; do
    docker stats --no-stream --format "$(date +%s%3N) {{.Name}} cpu {{.CPUPerc}} mem {{.MemUsage}}" \
      $(docker compose ps -q nestjs-api db storage video-worker) $(docker ps --format '{{.Names}}' | grep "^r02-$RUN-probe") 2>/dev/null || true
    sleep 2
  done) >"$EVID/docker-stats.txt" &
  BG_PIDS+=($!)
}

stop_monitors() {
  api touch "$CDIR/stop" || true
  docker compose exec -T db touch "/tmp/r02-$RUN.dbstop" || true
  touch "$EVID/stats.stop"
  for pid in "${BG_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  BG_PIDS=()
}

start_probes() {
  local i
  for i in $(seq 1 "$PROBES"); do
    (api cat "$CDIR/control.json" |
      docker compose run --rm --no-deps -T --name "r02-$RUN-probe-$i" nestjs-api \
        node -r ts-node/register proofs/phase-03/responsiveness-probe.ts --public-id "$CONTROL_ID" --instance "$i" \
        >"$EVID/probe-$i.csv" 2>"$EVID/probe-$i.log") &
    PROBE_PIDS+=($!)
  done
  for i in $(seq 1 120); do
    local ready=0 j
    for j in $(seq 1 "$PROBES"); do
      [ "$(cat "$EVID/probe-$j.csv" 2>/dev/null | wc -l)" -ge 2 ] && ready=$((ready + 1))
    done
    [ "$ready" -eq "$PROBES" ] && { log "sondas prontas: $ready"; return 0; }
    sleep 1
  done
  log "sondas sem amostra em 120 s"
  return 1
}

stop_probes() {
  local i
  for i in $(seq 1 "$PROBES"); do docker kill --signal SIGTERM "r02-$RUN-probe-$i" >/dev/null 2>&1 || true; done
  for pid in "${PROBE_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  PROBE_PIDS=()
  for i in $(seq 1 "$PROBES"); do tail -1 "$EVID/probe-$i.log" | tee -a "$LOG"; done
}

residue() {
  docker compose exec -T storage sh -c \
    'cd /data/.minio.sys/tmp && for d in *; do [ -d "$d" ] && echo "$(du -sk "$d" | cut -f1) KiB $d"; done; true'
}

phase_hash() {
  local name=$1 mode=$2
  mark "$name" inicio
  run api node "$CDIR/stress.js" "$mode" "$PHASE_SECONDS" "$CDIR/f.bin"
  mark "$name" fim
}

phase_hash_other_container() {
  local name=$1
  log "$name: outro container (r02-$RUN-stress), com o próprio arquivo de 1 GB"
  docker compose run --rm --no-deps -T --name "r02-$RUN-stress" nestjs-api sh -c \
    "cat > /tmp/stress.js && head -c 1000000000 /dev/urandom > /tmp/r02.bin && echo \"INICIO \$(date +%s%3N)\" && node /tmp/stress.js cold $PHASE_SECONDS /tmp/r02.bin && echo \"FIM \$(date +%s%3N)\"; rm -f /tmp/r02.bin /tmp/stress.js" \
    <"$SCR/stress.js" | tee -a "$LOG" >"$EVID/$name-container.txt"
  echo "$name inicio $(awk '/^INICIO/{print $2}' "$EVID/$name-container.txt")" >>"$EVID/phases.txt"
  echo "$name fim $(awk '/^FIM/{print $2}' "$EVID/$name-container.txt")" >>"$EVID/phases.txt"
}

phase_upload() {
  local name=$1
  api dd if="$CDIR/f.bin" iflag=nocache count=0 status=none
  mark "$name" inicio
  run client start --file "$CDIR/f.bin" --file-name "r02-$RUN-$name.mp4" --credentials "$CDIR/uploader.json" \
    --state "$CDIR/state-$name.json" --events "$CDIR/events-$name.jsonl" --progress "$CDIR/progress-$name.json" \
    --storage-connect localhost:9000=storage:9000
  mark "$name" fim
}

cleanup() {
  local rc=$?
  set +e
  log "=== limpeza"
  stop_probes
  stop_monitors
  for d in api-watch api-nowatch; do
    for k in requests loop db; do
      api test -e "$CDIR/$d/$k.jsonl" && api cat "$CDIR/$d/$k.jsonl" >"$EVID/$d-$k.jsonl"
    done
  done
  for n in A4 B4; do api test -e "$CDIR/events-$n.jsonl" && api cat "$CDIR/events-$n.jsonl" >"$EVID/events-$n.jsonl"; done
  stop_api
  docker ps -a --format '{{.Names}}' | grep "^r02-$RUN" | xargs -r docker rm -f >/dev/null
  log "containers r02 restantes: $(docker ps -a --format '{{.Names}}' | grep -c "^r02-$RUN" || true)"
  run support cleanup --emails "$UPLOADER,$CONTROL"
  api rm -rf "$CDIR"
  log "diretório de ensaio presente: $(api test -e "$CDIR" && echo sim || echo não)"
  docker compose exec -T db rm -f "/tmp/r02-$RUN.dbprobe.sh" "/tmp/r02-$RUN.dbstop"
  log "arquivos no db restantes: $(docker compose exec -T db sh -c "ls /tmp/r02-$RUN.* 2>/dev/null | wc -l")"
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
  if cmp -s "$EVID/residue-before.txt" "$EVID/residue-after.txt"; then
    log "temporários do Silo: lista igual antes e depois ($(wc -l <"$EVID/residue-after.txt") diretórios), nenhum novo"
  else
    log "temporários do Silo: listas diferentes"
    diff "$EVID/residue-before.txt" "$EVID/residue-after.txt" | tee -a "$LOG"
  fi
  support snapshot >"$EVID/snapshot-after.txt"
  if cmp -s "$EVID/snapshot-before.txt" "$EVID/snapshot-after.txt"; then log "retratos iguais"; else log "retratos diferentes"; diff "$EVID/snapshot-before.txt" "$EVID/snapshot-after.txt" | tee -a "$LOG"; fi
  log "livre em C: $(df -B1 --output=avail /mnt/c | tail -1)"
  log "código: $rc"
  exit "$rc"
}
trap cleanup EXIT

log "=== R-02 ensaios — runId $RUN ($(date -u +%H:%M:%SZ)); fases de $PHASE_SECONDS s"
log "livre em C: $(df -B1 --output=avail /mnt/c | tail -1)"
support snapshot >"$EVID/snapshot-before.txt"
residue >"$EVID/residue-before.txt"
api sh -c "umask 077 && mkdir -p '$CDIR'"
for f in preload.js stress.js sampler.sh; do api sh -c "cat > '$CDIR/$f'" <"$SCR/$f"; done
start_api watch
run support account --email "$UPLOADER" --credentials "$CDIR/uploader.json"
run support account --email "$CONTROL" --credentials "$CDIR/control.json"
run support control-video --credentials "$CDIR/control.json" --state "$CDIR/control-state.json" --file-name "r02-$RUN-control.mp4"
CONTROL_ID=$(api cat "$CDIR/control-state.json" | python3 -c "import json,sys; print(json.load(sys.stdin)['publicId'])")
sleep 2
log "instrumentação da API: $(api sh -c "wc -l < '$CDIR/api-watch/requests.jsonl'") requisições registradas até aqui"
run client generate --file "$CDIR/f.bin" --size 1000000000 --seed "r02-$RUN"
start_monitors
start_probes
sleep 20
# Modo watch (npm run start:dev), como na P-10GB.
mark A0-repouso inicio; sleep "$PHASE_SECONDS"; mark A0-repouso fim
api sh -c "cat '$CDIR/f.bin' > /dev/null"
phase_hash A1-sha256-cache warm
phase_hash A2-sha256-frio cold
phase_hash_other_container A3-sha256-frio-outro-container
phase_upload A4
# Modo sem watch (node dist/main), a única variável trocada.
mark troca-de-modo inicio
stop_api
start_api nowatch
sleep 20
mark troca-de-modo fim
mark B0-repouso inicio; sleep "$PHASE_SECONDS"; mark B0-repouso fim
phase_hash B2-sha256-frio cold
phase_upload B4
sleep 6
