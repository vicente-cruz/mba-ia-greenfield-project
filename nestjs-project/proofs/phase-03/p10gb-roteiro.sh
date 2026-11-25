#!/usr/bin/env bash
# Roteiro da prova P-10GB (SI-03.33; phase-03-videos/TD-15, R-02 e R-03): upload real de
# 10.000.000.000 bytes, com interrupção por sinal e retomada, medindo a responsividade da API com
# os critérios fixados no relatório antes da execução.
#
# Roda no host, a partir de nestjs-project/, com o mesmo arranjo da V-07:
# - upload-client.ts no nestjs-api, falando com a API por `nestjs-api:3000` e com o storage pelas
#   URLs assinadas, conectando em `storage:9000` com o Host assinado (`--storage-connect`);
# - N instâncias de responsiveness-probe.ts, cada uma num container próprio (`docker compose run`),
#   com IP distinto do cliente, as mesmas na base e na carga, a cada 2 s e com timeout de 5 s;
# - upload-proof-support.ts no nestjs-api: contas, vídeo de controle, vigia da interrupção,
#   retratos das partes, resumo, vereditos de latência e limpeza.
# A base começa quando todas as instâncias estão amostrando e termina no lançamento do cliente; os
# instantes vêm do relógio dos containers. A carga são só os intervalos de upload ativo do cliente.
# O `du` do volume do storage é amostrado a cada 0,25 s, com um `df` sem pausa em volta do
# completion. A medição só começa com a lixeira do Silo vazia, e a limpeza espera a purga.
#
# Recursos de prova, todos identificados pelo runId e removidos no final (trap EXIT), inclusive em
# caso de erro:
# - os usuários p10gb-<runId>-uploader e p10gb-<runId>-control @proofs.streamtube.test, com canais,
#   tokens e e-mails no Mailpit;
# - o vídeo enviado e o vídeo de controle, com sessões, partes, objetos, multiparts e jobs;
# - /tmp/p10gb-<runId>/ no nestjs-api: arquivo sintético, credenciais (0600), estado e eventos;
# - os containers das sondas p10gb-<runId>-probe-<i> e os arquivos /tmp/p10gb-<runId>.sampler.* no
#   storage.
# Os temporários que o Silo guarda em .minio.sys/tmp só são listados, antes e depois; a comparação
# separa os anteriores à prova dos novos. Nenhum é removido.
# As evidências ficam no diretório de saída, sem tokens, senhas ou URLs assinadas.
#
# Uso: proofs/phase-03/p10gb-roteiro.sh [diretório de saída]
# Variáveis: P10GB_SIZE_BYTES (padrão 10000000000), P10GB_PROBES (padrão 4),
#   P10GB_BASELINE_SECONDS (padrão 600), P10GB_RESUME_GAP_SECONDS (padrão 5),
#   P10GB_MIN_FREE_BYTES (padrão 29500000000, livre exigido na unidade C: pela V-07).
# Pré-requisitos: `docker compose up -d` com o ambiente saudável e o video-worker no ar, a API
#   servida no nestjs-api (`docker compose exec nestjs-api npm run start:dev`, em outro terminal) e
#   a janela de 40 min com o ambiente exclusivo.
# Código de saída: 0 só quando todas as etapas, os vereditos e a limpeza passam. Se o roteiro for
# interrompido ou uma etapa falhar, sai com o código dessa falha original, mesmo que a limpeza
# passe; se só a limpeza falhar, sai com o código dela. A limpeza roda sempre.
set -euo pipefail

case "${1:-}" in
  -h | --help)
    echo "uso: $0 [diretório de saída]" >&2
    exit 64
    ;;
esac

PROJECT_DIR=$(cd "$(dirname "$0")/../.." && pwd)
cd "$PROJECT_DIR"

OUT_DIR=${1:-$(mktemp -d)}
mkdir -p "$OUT_DIR"
RUN_ID=$(date -u +%Y%m%d%H%M%S)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
EVID=$OUT_DIR/p10gb-$RUN_ID
mkdir -p "$EVID"
LOG=$OUT_DIR/p10gb-$RUN_ID.log
SIZE=${P10GB_SIZE_BYTES:-10000000000}
PROBES=${P10GB_PROBES:-4}
BASELINE=${P10GB_BASELINE_SECONDS:-600}
GAP=${P10GB_RESUME_GAP_SECONDS:-5}
MIN_FREE=${P10GB_MIN_FREE_BYTES:-29500000000}

CDIR=/tmp/p10gb-$RUN_ID
UPLOADER=p10gb-$RUN_ID-uploader@proofs.streamtube.test
CONTROL=p10gb-$RUN_ID-control@proofs.streamtube.test
PROBE_PREFIX=p10gb-$RUN_ID-probe
SAMPLER=/tmp/p10gb-$RUN_ID.sampler
CLIENT=proofs/phase-03/upload-client.ts
SUPPORT=proofs/phase-03/upload-proof-support.ts
PROBE=proofs/phase-03/responsiveness-probe.ts
CLIENT_OPTS=(
  --credentials "$CDIR/uploader.json"
  --state "$CDIR/state.json"
  --events "$CDIR/events.jsonl"
  --progress "$CDIR/progress.json"
  --storage-connect localhost:9000=storage:9000
)

STATUS=()
FIRST_FAILURE=0
SAMPLER_PID=
PROBE_PIDS=()
EVIDENCE_COLLECTED=0
CONTROL_ID=
BASELINE_START=
BASELINE_END=

log() { printf '%s\n' "$*" | tee -a "$LOG"; }
section() { log ""; log "=== $* ($(date -u +%H:%M:%SZ))"; }
api() { docker compose exec -T nestjs-api "$@"; }
support() { api npx ts-node "$SUPPORT" "$@"; }
client() { api npx ts-node "$CLIENT" "$@"; }
# Instante em ms pelo relógio dos containers, o mesmo da sonda e dos eventos do cliente.
container_now() { api date +%s%3N; }

# Etapa: roda no shell atual (os PIDs e ids definidos nela ficam disponíveis), com a saída no log.
step() {
  local name=$1 rc=0
  shift
  section "$name"
  log "\$ $*"
  "$@" > >(tee -a "$LOG") 2>&1 || rc=$?
  STATUS+=("$name: código $rc")
  if [ "$rc" -ne 0 ] && [ "$FIRST_FAILURE" -eq 0 ]; then
    FIRST_FAILURE=$rc
  fi
  return "$rc"
}

json_field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

versions() {
  docker image inspect --format '{{.Id}} {{json .RepoDigests}}' "$(docker compose config --images | grep '^pgsty/silo')"
  docker image inspect --format '{{.Id}} {{json .RepoDigests}}' "$(docker compose config --images | grep '^redis')"
  docker version --format 'Docker Engine {{.Server.Version}} (cliente {{.Client.Version}})'
  docker info --format '{{.OperatingSystem}}; kernel {{.KernelVersion}}; {{.NCPU}} CPUs; {{.MemTotal}} bytes de memória'
  docker image inspect --format 'imagem do nestjs-api e do video-worker: {{.Id}} criada {{.Created}}' streamtube-nestjs-dev
  api node -v
  # Lido do package.json instalado: o `exports` do typeorm não expõe `typeorm/package.json`.
  api node -p "['@aws-sdk/client-s3','@nestjs/core','@nestjs/throttler','bullmq','ioredis','typeorm','ts-node','typescript'].map(p => p + ' ' + JSON.parse(require('fs').readFileSync('node_modules/' + p + '/package.json', 'utf8')).version).join(', ')"
  docker compose exec -T video-worker sh -c 'ffprobe -hide_banner -version | head -1' | sed 's/^/video-worker: /'
}

# Espaço livre: o disco do WSL, a unidade C: (onde ficam os VHDX do WSL e do Docker Desktop) e o
# disco de dados do Docker visto de dentro dos containers. O caminho do VHDX não é impresso.
host_disk() {
  df -B1 --output=size,used,avail,target / | sed 's/^/host: /'
  if [ -d /mnt/c ]; then
    df -B1 --output=size,used,avail,target /mnt/c | sed 's/^/host: /'
  fi
  local vhdx
  for vhdx in /mnt/c/Users/*/AppData/Local/Docker/wsl/disk/docker_data.vhdx; do
    [ -f "$vhdx" ] && echo "host: docker_data.vhdx do Docker Desktop: $(stat -c %s "$vhdx") bytes"
  done
  docker compose exec -T storage df -B1 -P /data | sed 's/^/storage: /'
  api df -B1 -P /tmp | sed 's/^/nestjs-api: /'
}

# Espaço exigido pela V-07 na unidade C:, que guarda o docker_data.vhdx.
check_free_space() {
  local avail
  if [ ! -d /mnt/c ]; then
    echo "unidade C: não montada em /mnt/c; o espaço exigido não pode ser conferido"
    return 1
  fi
  avail=$(df -B1 --output=avail /mnt/c | tail -1 | tr -d ' ')
  echo "livre na unidade C:: $avail bytes; exigido: $MIN_FREE bytes"
  [ "$avail" -ge "$MIN_FREE" ]
}

prepare_workdir() {
  api sh -c "umask 077 && mkdir -p '$CDIR' && ls -ld '$CDIR'"
}

create_control_video() {
  support control-video --credentials "$CDIR/control.json" --state "$CDIR/control-state.json" \
    --file-name "p10gb-$RUN_ID-control.mp4" || return $?
  CONTROL_ID=$(api cat "$CDIR/control-state.json" | json_field "['publicId']")
  echo "vídeo de controle: $CONTROL_ID (dono: $CONTROL; upload: $UPLOADER)"
}

# Uso do volume do storage em KiB: total, bucket, multipart, temporários (com a lixeira) e lixeira
# (um `du` por diretório, para não haver dupla contagem), mais o usado e o livre do disco (`df`).
STORAGE_DU="t=\$(date +%s%3N); \
a=\$(du -sk /data | cut -f1); b=\$(du -sk /data/streamtube | cut -f1); \
m=\$(du -sk /data/.minio.sys/multipart | cut -f1); x=\$(du -sk /data/.minio.sys/tmp | cut -f1); \
r=\$(du -sk /data/.minio.sys/tmp/.trash 2>/dev/null | cut -f1); \
d=\$(df -kP /data | tail -1 | tr -s ' ' | cut -d' ' -f3,4); \
echo \"\$t \$a \$b \$m \$x \${r:-0} \$d\""

storage_usage() {
  docker compose exec -T storage sh -c "$STORAGE_DU"
}

wait_trash_empty() {
  local limit=${1:-600} waited=0 line trash
  while :; do
    line=$(storage_usage)
    trash=$(echo "$line" | cut -d' ' -f6)
    if [ "$trash" -le 10240 ]; then
      echo "lixeira do storage com $trash KiB depois de $waited s; uso (ms total bucket multipart tmp lixeira usado livre, em KiB): $line"
      return 0
    fi
    if [ "$waited" -ge "$limit" ]; then
      echo "lixeira do storage ainda com $trash KiB depois de $waited s: $line"
      return 1
    fi
    [ $((waited % 60)) -eq 0 ] && echo "aguardando a purga da lixeira do storage: $line"
    sleep 10
    waited=$((waited + 10))
  done
}

# Temporários que o Silo guarda em .minio.sys/tmp (um diretório por PUT abortado), com o tamanho.
# Só leitura: a lixeira (.trash, oculta) e os arquivos internos do Silo ficam de fora.
residue_into() {
  docker compose exec -T storage sh -c \
    'cd /data/.minio.sys/tmp && for d in *; do [ -d "$d" ] && echo "$(du -sk "$d" | cut -f1) KiB $d"; done; true' >"$1"
  echo "temporários do Silo em .minio.sys/tmp: $(wc -l <"$1") diretórios, $(awk '{s += $1} END {print s + 0}' "$1") KiB"
  cat "$1"
}

# Separa os temporários anteriores à prova (preservados ou não) dos novos, deixados pela prova.
compare_residue() {
  local kept missing new
  if [ ! -e "$EVID/residue-before.txt" ]; then
    echo "a lista de antes não foi registrada (o roteiro parou antes); nada a comparar"
    return 1
  fi
  residue_into "$EVID/residue-after.txt"
  kept=$(awk 'NR == FNR {before[$0] = 1; next} ($0 in before)' "$EVID/residue-before.txt" "$EVID/residue-after.txt" | wc -l)
  missing=$(awk 'NR == FNR {after[$0] = 1; next} !($0 in after)' "$EVID/residue-after.txt" "$EVID/residue-before.txt" | wc -l)
  echo "anteriores preservados (mesmo nome e tamanho): $kept de $(wc -l <"$EVID/residue-before.txt"); anteriores ausentes ou alterados: $missing"
  awk 'NR == FNR {before[$3] = 1; next} !($3 in before)' "$EVID/residue-before.txt" "$EVID/residue-after.txt" >"$EVID/residue-new.txt"
  new=$(wc -l <"$EVID/residue-new.txt")
  echo "novos, deixados durante a prova: $new diretórios, $(awk '{s += $1} END {print s + 0}' "$EVID/residue-new.txt") KiB"
  cat "$EVID/residue-new.txt"
  if [ "$new" -gt 0 ]; then
    echo "liberação do disco incompleta: restam temporários novos no volume storage-data"
  fi
  [ "$missing" -eq 0 ] && [ "$new" -eq 0 ]
}

start_sampler() {
  docker compose exec -T storage sh -c "echo \$\$ > $SAMPLER.pid; while [ ! -e $SAMPLER.stop ]; do $STORAGE_DU; sleep 0.25; done" \
    >"$EVID/disk-samples.txt" 2>"$EVID/disk-sampler.err" &
  SAMPLER_PID=$!
  sleep 2
  echo "amostrador no storage: $(wc -l <"$EVID/disk-samples.txt") amostras em 2 s; primeira (ms total bucket multipart tmp lixeira usado livre, em KiB): $(head -1 "$EVID/disk-samples.txt")"
  [ -s "$EVID/disk-samples.txt" ]
}

stop_sampler() {
  [ -n "$SAMPLER_PID" ] || return 0
  docker compose exec -T storage touch "$SAMPLER.stop" || true
  wait "$SAMPLER_PID" 2>/dev/null || true
  SAMPLER_PID=
  docker compose exec -T storage rm -f "$SAMPLER.stop" "$SAMPLER.pid"
  echo "amostrador parado: $(wc -l <"$EVID/disk-samples.txt") amostras"
}

container_ip() {
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$1"
}

csv_lines() { wc -l <"$1" 2>/dev/null || echo 0; }

# As N instâncias da sonda, cada uma num container próprio. A base começa quando todas já têm uma
# amostra e dura BASELINE segundos, sem upload.
start_probes() {
  local i waited=0 ready
  for i in $(seq 1 "$PROBES"); do
    (api cat "$CDIR/control.json" |
      docker compose run --rm --no-deps -T --name "$PROBE_PREFIX-$i" nestjs-api \
        node -r ts-node/register "$PROBE" --public-id "$CONTROL_ID" --instance "$i" \
        >"$EVID/probe-$i.csv" 2>"$EVID/probe-$i.log") &
    PROBE_PIDS+=($!)
  done
  while :; do
    ready=0
    for i in $(seq 1 "$PROBES"); do
      [ "$(csv_lines "$EVID/probe-$i.csv")" -ge 2 ] && ready=$((ready + 1))
      if ! kill -0 "${PROBE_PIDS[$((i - 1))]}" 2>/dev/null; then
        cat "$EVID/probe-$i.log"
        echo "a instância $i da sonda terminou antes da primeira amostra"
        return 1
      fi
    done
    [ "$ready" -eq "$PROBES" ] && break
    sleep 1
    waited=$((waited + 1))
    [ "$waited" -lt 180 ] || { echo "sondas sem amostra em 180 s ($ready de $PROBES prontas)"; return 1; }
  done
  BASELINE_START=$(container_now)
  for i in $(seq 1 "$PROBES"); do
    cat "$EVID/probe-$i.log"
    echo "IP do container da instância $i: $(container_ip "$PROBE_PREFIX-$i")"
  done
  echo "IP do nestjs-api (API e cliente de upload): $(container_ip "$(docker compose ps -q nestjs-api)")"
  echo "base: início em $BASELINE_START ms (relógio dos containers), $BASELINE s sem upload, com $PROBES instâncias"
  sleep "$BASELINE"
  local total=0
  for i in $(seq 1 "$PROBES"); do
    total=$((total + $(csv_lines "$EVID/probe-$i.csv") - 1))
  done
  echo "amostras até aqui, com o aquecimento: $total"
}

stop_probes() {
  [ "${#PROBE_PIDS[@]}" -gt 0 ] || return 0
  local i
  for i in $(seq 1 "$PROBES"); do
    docker kill --signal SIGTERM "$PROBE_PREFIX-$i" >/dev/null 2>&1 || true
  done
  for pid in "${PROBE_PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  PROBE_PIDS=()
  for i in $(seq 1 "$PROBES"); do
    cat "$EVID/probe-$i.log"
    echo "linhas no CSV da instância $i (com o cabeçalho): $(csv_lines "$EVID/probe-$i.csv")"
  done
}

generate_file() {
  client generate --file "$CDIR/source.bin" --size "$SIZE" --seed "p10gb-$RUN_ID" --events "$CDIR/events.jsonl"
}

# Uso de CPU e memória dos containers a cada 3 s enquanto o cliente roda (informativo).
sample_docker_stats() {
  local pid=$1 label=$2 api_id storage_id names=() i
  api_id=$(docker compose ps -q nestjs-api)
  storage_id=$(docker compose ps -q storage)
  for i in $(seq 1 "$PROBES"); do names+=("$PROBE_PREFIX-$i"); done
  while kill -0 "$pid" 2>/dev/null; do
    docker stats --no-stream --format "$label $(date -u +%H:%M:%SZ) {{.Name}} cpu {{.CPUPerc}} mem {{.MemUsage}}" \
      "$api_id" "$storage_id" "${names[@]}" >>"$EVID/docker-stats.txt" 2>&1 || true
    sleep 3
  done
}

# Envio interrompido por SIGINT quando metade das partes do plano já teve o PUT concluído, pelo
# vigia `interrupt-when` no mesmo container. A base termina no lançamento do cliente.
upload_with_interruption() {
  local client_pid rc=0 watch_rc=0 stats_pid
  BASELINE_END=$(container_now)
  echo "base: fim em $BASELINE_END ms (lançamento do cliente de upload)"
  client start --file "$CDIR/source.bin" --file-name "p10gb-$RUN_ID-synthetic.mp4" "${CLIENT_OPTS[@]}" \
    --no-complete >"$EVID/client-start.log" 2>&1 &
  client_pid=$!
  sample_docker_stats "$client_pid" start &
  stats_pid=$!
  support interrupt-when --progress "$CDIR/progress.json" --fraction 0.5 --signal SIGINT || watch_rc=$?
  wait "$client_pid" || rc=$?
  wait "$stats_pid" || true
  cat "$EVID/client-start.log"
  echo "código do vigia: $watch_rc; código do cliente: $rc (esperado: 130, interrompido por SIGINT)"
  [ "$watch_rc" -eq 0 ] && [ "$rc" -eq 130 ]
}

parts_snapshot() {
  support parts-snapshot --state "$CDIR/state.json" --out "$CDIR/$1.json"
}

# Retomada até o ponto anterior ao completion, retrato das partes, comparação e liberação do completion.
resume_and_complete() {
  local client_pid rc=0 waited=0 compare_rc=0 stats_pid fast_pid
  sleep "$GAP"
  client resume "${CLIENT_OPTS[@]}" --hold-before-completion "$CDIR/hold" >"$EVID/client-resume.log" 2>&1 &
  client_pid=$!
  sample_docker_stats "$client_pid" resume &
  stats_pid=$!
  until api test -e "$CDIR/hold.ready"; do
    if ! kill -0 "$client_pid" 2>/dev/null; then
      wait "$client_pid" || rc=$?
      cat "$EVID/client-resume.log"
      echo "o cliente terminou antes do completion (código $rc)"
      return 1
    fi
    sleep 0.5
    waited=$((waited + 1))
    if [ "$waited" -ge 3600 ]; then
      echo "o cliente não chegou ao completion em 30 min"
      return 1
    fi
  done
  echo "--- retrato das partes antes do completion"
  parts_snapshot parts-before-completion || compare_rc=$?
  echo "--- comparação com o retrato depois da interrupção"
  support compare-parts --before "$CDIR/parts-after-interruption.json" \
    --after "$CDIR/parts-before-completion.json" --events "$CDIR/events.jsonl" || compare_rc=$?
  # `df` contínuo, sem pausa, por 6 s em volta do completion de 150 partes.
  docker compose exec -T storage sh -c 'end=$(($(date +%s) + 6)); while [ "$(date +%s)" -lt "$end" ]; do \
echo "$(date +%s%3N) $(df -kP /data | tail -1 | tr -s " " | cut -d" " -f3)"; done' >"$EVID/disk-completion-fast.txt" &
  fast_pid=$!
  sleep 1
  api touch "$CDIR/hold"
  wait "$fast_pid" || true
  echo "amostras rápidas do df em volta do completion: $(wc -l <"$EVID/disk-completion-fast.txt")"
  wait "$client_pid" || rc=$?
  wait "$stats_pid" || true
  cat "$EVID/client-resume.log"
  grep '^resume' "$EVID/docker-stats.txt" | tail -12 | sed 's/^/docker stats: /' || true
  echo "código do cliente: $rc; código da comparação: $compare_rc"
  [ "$rc" -eq 0 ] && [ "$compare_rc" -eq 0 ]
}

collect_evidence() {
  [ "$EVIDENCE_COLLECTED" -eq 0 ] || return 0
  EVIDENCE_COLLECTED=1
  local file i
  for file in events.jsonl parts-after-interruption.json parts-before-completion.json; do
    if api test -e "$CDIR/$file"; then
      api cat "$CDIR/$file" >"$EVID/$file"
    fi
  done
  [ -s "$EVID/disk-samples.txt" ] && api sh -c "cat > '$CDIR/disk-samples.txt'" <"$EVID/disk-samples.txt"
  [ -s "$EVID/disk-completion-fast.txt" ] && api sh -c "cat > '$CDIR/disk-completion-fast.txt'" <"$EVID/disk-completion-fast.txt"
  for i in $(seq 1 "$PROBES"); do
    [ -s "$EVID/probe-$i.csv" ] && api sh -c "cat > '$CDIR/probe-$i.csv'" <"$EVID/probe-$i.csv"
  done
  (cd "$EVID" && wc -c -- *)
}

probe_args() {
  local i
  for i in $(seq 1 "$PROBES"); do
    if api test -e "$CDIR/probe-$i.csv"; then
      printf '%s\n' --probe "$CDIR/probe-$i.csv"
    fi
  done
}

summarize() {
  collect_evidence
  local args=(--events "$CDIR/events.jsonl" --out "$CDIR/summary.json")
  api test -e "$CDIR/disk-samples.txt" && args+=(--disk "$CDIR/disk-samples.txt")
  api test -e "$CDIR/disk-completion-fast.txt" && args+=(--disk-fast "$CDIR/disk-completion-fast.txt")
  mapfile -t -O "${#args[@]}" args < <(probe_args)
  support summarize "${args[@]}" || return $?
  api cat "$CDIR/summary.json" >"$EVID/summary.json"
}

latency_verdict() {
  collect_evidence
  if [ -z "$BASELINE_START" ] || [ -z "$BASELINE_END" ]; then
    echo "a base não foi delimitada; os vereditos de latência não podem ser calculados"
    return 1
  fi
  local args=(--events "$CDIR/events.jsonl" --baseline-start "$BASELINE_START" --baseline-end "$BASELINE_END"
    --out "$CDIR/latency-verdict.json") rc=0
  mapfile -t -O "${#args[@]}" args < <(probe_args)
  support latency-verdict "${args[@]}" || rc=$?
  api cat "$CDIR/latency-verdict.json" >"$EVID/latency-verdict.json" || true
  return "$rc"
}

compare_snapshots() {
  if [ -s "$EVID/snapshot-before.txt" ] && cmp -s "$EVID/snapshot-before.txt" "$EVID/snapshot-after.txt"; then
    echo "retratos iguais: $(cat "$EVID/snapshot-after.txt")"
    return 0
  fi
  echo "retratos diferentes ou ausentes"
  diff "$EVID/snapshot-before.txt" "$EVID/snapshot-after.txt" || true
  return 1
}

snapshot_into() {
  local rc=0
  support snapshot >"$1" || rc=$?
  cat "$1"
  return "$rc"
}

cleanup_workdir() {
  local pid
  pid=$(api sh -c "cat '$CDIR/progress.json' 2>/dev/null" | json_field "['pid']" 2>/dev/null || true)
  if [ -n "$pid" ] && api sh -c "kill -0 $pid" 2>/dev/null; then
    api sh -c "kill -TERM $pid" || true
    sleep 2
  fi
  api rm -rf "$CDIR"
  if api test -e "$CDIR"; then
    echo "diretório de prova no nestjs-api presente: sim"
    return 1
  fi
  echo "diretório de prova no nestjs-api presente: não"
}

cleanup_containers() {
  stop_probes
  stop_sampler
  local i left
  for i in $(seq 1 "$PROBES"); do
    if docker ps -a --format '{{.Names}}' | grep -qx "$PROBE_PREFIX-$i"; then
      docker rm -f "$PROBE_PREFIX-$i" >/dev/null
    fi
  done
  left=$(docker ps -a --format '{{.Names}}' | grep -c "^p10gb-$RUN_ID" || true)
  echo "containers de prova restantes: $left"
  docker compose exec -T storage sh -c "ls $SAMPLER.* 2>/dev/null | wc -l" | sed 's/^/arquivos do amostrador restantes no storage: /'
  [ "$left" -eq 0 ]
}

# Depois da remoção dos objetos, o disco só é liberado quando o Silo purga a lixeira.
measure_release() {
  local started=$SECONDS rc=0
  echo "uso logo depois da limpeza (ms total bucket multipart tmp lixeira usado livre, em KiB): $(storage_usage)"
  wait_trash_empty 1800 || rc=$?
  echo "purga da lixeira observada em $((SECONDS - started)) s depois da limpeza"
  return "$rc"
}

cleanup() {
  local rc=$? cleanup_rc=0 final step_rc
  set +e
  section "Limpeza dos recursos de prova"
  step "Sondas e amostrador parados e removidos" cleanup_containers
  step_rc=$?
  [ "$step_rc" -eq 0 ] || cleanup_rc=$step_rc
  collect_evidence >/dev/null 2>&1
  step "Usuários, vídeos, objetos, multiparts, jobs e e-mails de prova" support cleanup --emails "$UPLOADER,$CONTROL"
  step_rc=$?
  [ "$step_rc" -eq 0 ] || [ "$cleanup_rc" -ne 0 ] || cleanup_rc=$step_rc
  step "Diretório de prova no nestjs-api" cleanup_workdir
  step_rc=$?
  [ "$step_rc" -eq 0 ] || [ "$cleanup_rc" -ne 0 ] || cleanup_rc=$step_rc
  step "Purga da lixeira do storage depois da limpeza" measure_release
  step "Uso do storage depois da limpeza e da purga" storage_usage
  step "Retrato depois (só leitura)" snapshot_into "$EVID/snapshot-after.txt"
  step "Retrato preservado (antes = depois)" compare_snapshots
  step_rc=$?
  [ "$step_rc" -eq 0 ] || [ "$cleanup_rc" -ne 0 ] || cleanup_rc=$step_rc
  # Os temporários novos do Silo não são removidos: a etapa registra a liberação incompleta.
  step "Temporários do Silo: anteriores preservados e novos (só leitura)" compare_residue
  step "Espaço livre depois da limpeza" host_disk
  section "Situação dos passos"
  for entry in "${STATUS[@]}"; do log "- $entry"; done
  if [ "$rc" -ne 0 ]; then
    final=$rc
  elif [ "$FIRST_FAILURE" -ne 0 ]; then
    final=$FIRST_FAILURE
  else
    final=$cleanup_rc
  fi
  log "código final: $final (interrupção ou etapa obrigatória: $rc; primeira etapa com falha: $FIRST_FAILURE; limpeza: $cleanup_rc)"
  log "log completo: $LOG"
  log "evidências: $EVID"
  exit "$final"
}
trap cleanup EXIT

section "P-10GB — runId $RUN_ID"
log "arquivo sintético de $SIZE bytes; $PROBES instâncias da sonda; base de $BASELINE s; intervalo antes da retomada: $GAP s"
log "usuários de prova: $UPLOADER (upload) e $CONTROL (dono do vídeo de controle)"
step "Estado do ambiente" docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'
step "Espaço livre exigido pela V-07 na unidade C:" check_free_space
step "Versões" versions
step "API no ar" support api-check
step "Espaço livre antes da prova" host_disk
step "Retrato antes (só leitura)" snapshot_into "$EVID/snapshot-before.txt"
step "Temporários do Silo antes da prova (só leitura)" residue_into "$EVID/residue-before.txt"
step "Diretório de prova no nestjs-api" prepare_workdir
step "Conta de prova do upload" support account --email "$UPLOADER" --credentials "$CDIR/uploader.json"
step "Conta de prova do vídeo de controle" support account --email "$CONTROL" --credentials "$CDIR/control.json"
step "Vídeo de controle em draft" create_control_video
step "Arquivo sintético" generate_file
step "Espaço livre com o arquivo sintético" host_disk
step "Lixeira do storage vazia antes da medição" wait_trash_empty 900
step "Amostrador de disco do storage" start_sampler
step "Sondas em containers próprios e fase de base" start_probes
# Daqui em diante uma falha não encerra o roteiro: as evidências, o resumo e os vereditos são
# sempre coletados, e a primeira falha define o código final.
step "Upload interrompido por SIGINT por volta de 50%" upload_with_interruption || true
step "Retrato das partes depois da interrupção" parts_snapshot parts-after-interruption || true
step "Retomada, conferência das partes recebidas, completion e polling" resume_and_complete || true
step "Fim das sondas" stop_probes || true
step "Fim do amostrador" stop_sampler || true
step "Espaço livre antes da limpeza" host_disk || true
step "Resumo das medidas" summarize || true
step "Vereditos de latência (critérios fixados antes da execução)" latency_verdict || true
