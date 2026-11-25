#!/usr/bin/env bash
# Roteiro da prova V-07 (SI-03.31; phase-03-videos/TD-15): tempo e disco de um upload real pelo
# fluxo completo, com interrupção por sinal e retomada, para agendar a prova de 10 GB (SI-03.33).
#
# Roda no host, a partir de nestjs-project/. Os scripts TypeScript rodam em containers:
# - upload-client.ts no nestjs-api, falando com a API por `nestjs-api:3000` e com o storage pelas
#   URLs assinadas, conectando em `storage:9000` com o Host assinado (`--storage-connect`);
# - responsiveness-probe.ts num container próprio (`docker compose run`), com IP distinto do
#   cliente; aqui ela é informativa: o cenário e os critérios de latência são da SI-03.33;
# - upload-proof-support.ts no nestjs-api: contas, vídeo de controle, retratos, resumo e limpeza.
# O `du` (total, bucket, multipart, temporários e lixeira) e o `df` do volume do storage são
# amostrados a cada 0,25 s dentro do container `storage`, e o `df` sem pausa em volta do completion.
# A medição só começa com a lixeira do Silo vazia, e a limpeza espera a purga que libera o disco.
#
# Recursos de prova, todos identificados pelo runId e removidos no final (trap EXIT), inclusive em
# caso de erro:
# - os usuários v07-<runId>-uploader e v07-<runId>-control @proofs.streamtube.test, com canais,
#   tokens e e-mails no Mailpit;
# - o vídeo enviado e o vídeo de controle, com sessões, partes, objetos, multiparts e jobs;
# - /tmp/v07-<runId>/ no nestjs-api: arquivo sintético, credenciais (0600), estado e eventos;
# - o container da sonda v07-<runId>-probe e os arquivos /tmp/v07-<runId>.sampler.* no storage.
# As evidências ficam no diretório de saída (log, eventos do cliente, CSV da sonda, amostras de
# disco, retratos das partes e resumo), sem tokens, senhas ou URLs assinadas.
#
# Uso: proofs/phase-03/v07-roteiro.sh [diretório de saída]
# Variáveis: V07_SIZE_BYTES (padrão 1000000000), V07_PROBE_BASELINE_SECONDS (padrão 60),
#   V07_RESUME_GAP_SECONDS (padrão 5).
# Pré-requisitos: `docker compose up -d` com o ambiente saudável e o video-worker no ar, e a API
#   servida no nestjs-api (`docker compose exec nestjs-api npm run start:dev`, em outro terminal).
# Código de saída: 0 só quando todas as etapas e a limpeza passam. Se o roteiro for interrompido
# ou uma etapa falhar, sai com o código dessa falha original, mesmo que a limpeza passe; se só a
# limpeza falhar, sai com o código dela. A limpeza roda sempre.
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
EVID=$OUT_DIR/v07-$RUN_ID
mkdir -p "$EVID"
LOG=$OUT_DIR/v07-$RUN_ID.log
SIZE=${V07_SIZE_BYTES:-1000000000}
BASELINE=${V07_PROBE_BASELINE_SECONDS:-60}
GAP=${V07_RESUME_GAP_SECONDS:-5}

CDIR=/tmp/v07-$RUN_ID
UPLOADER=v07-$RUN_ID-uploader@proofs.streamtube.test
CONTROL=v07-$RUN_ID-control@proofs.streamtube.test
PROBE_NAME=v07-$RUN_ID-probe
SAMPLER=/tmp/v07-$RUN_ID.sampler
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
PROBE_PID=
EVIDENCE_COLLECTED=0
CONTROL_ID=

log() { printf '%s\n' "$*" | tee -a "$LOG"; }
section() { log ""; log "=== $* ($(date -u +%H:%M:%SZ))"; }
api() { docker compose exec -T nestjs-api "$@"; }
support() { api npx ts-node "$SUPPORT" "$@"; }
client() { api npx ts-node "$CLIENT" "$@"; }

# Etapa: roda no shell atual (os PIDs e ids definidos nela ficam disponíveis), com a saída no log.
# Devolve o código da etapa; com `set -e`, uma etapa obrigatória que falha encerra o roteiro e a
# limpeza roda pelo trap.
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
  docker version --format 'Docker Engine {{.Server.Version}} (cliente {{.Client.Version}})'
  docker info --format '{{.OperatingSystem}}; kernel {{.KernelVersion}}; {{.NCPU}} CPUs; {{.MemTotal}} bytes de memória'
  api node -v
  # Lido do package.json instalado: o `exports` do typeorm não expõe `typeorm/package.json`.
  api node -p "['@aws-sdk/client-s3','bullmq','ioredis','typeorm','ts-node','typescript'].map(p => p + ' ' + JSON.parse(require('fs').readFileSync('node_modules/' + p + '/package.json', 'utf8')).version).join(', ')"
  docker image inspect --format 'imagem do nestjs-api: {{.Id}} criada {{.Created}}' streamtube-nestjs-dev
}

# Espaço livre: o disco do WSL, a unidade C: (onde ficam os VHDX do WSL e do Docker Desktop) e o
# disco de dados do Docker visto de dentro dos containers. O caminho do VHDX não é impresso.
host_disk() {
  df -B1 --output=source,size,used,avail,target / | sed 's/^/host: /'
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

prepare_workdir() {
  api sh -c "umask 077 && mkdir -p '$CDIR' && ls -ld '$CDIR'"
}

create_control_video() {
  support control-video --credentials "$CDIR/control.json" --state "$CDIR/control-state.json" \
    --file-name "v07-$RUN_ID-control.mp4" || return $?
  CONTROL_ID=$(api cat "$CDIR/control-state.json" | json_field "['publicId']")
  echo "vídeo de controle: $CONTROL_ID"
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

# A lixeira do Silo (.minio.sys/tmp/.trash) guarda o que foi apagado até a purga periódica, que
# libera o disco minutos depois. Medir com a lixeira cheia mistura a purga com o upload.
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

start_probe() {
  (api cat "$CDIR/control.json" |
    docker compose run --rm --no-deps -T --name "$PROBE_NAME" nestjs-api \
      node -r ts-node/register "$PROBE" --public-id "$CONTROL_ID" --instance 1 \
      >"$EVID/probe-1.csv" 2>"$EVID/probe-1.log") &
  PROBE_PID=$!
  local waited=0
  while [ "$(wc -l <"$EVID/probe-1.csv" 2>/dev/null || echo 0)" -lt 2 ]; do
    if ! kill -0 "$PROBE_PID" 2>/dev/null; then
      cat "$EVID/probe-1.log"
      echo "a sonda terminou antes da primeira amostra"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
    [ "$waited" -lt 120 ] || { echo "sonda sem amostra em 120 s"; return 1; }
  done
  cat "$EVID/probe-1.log"
  echo "IP do container da sonda: $(container_ip "$PROBE_NAME"); IP do nestjs-api (cliente de upload): $(container_ip "$(docker compose ps -q nestjs-api)")"
  echo "fase de base informativa: $BASELINE s sem upload"
  sleep "$BASELINE"
  echo "amostras até aqui: $(($(wc -l <"$EVID/probe-1.csv") - 1))"
}

stop_probe() {
  [ -n "$PROBE_PID" ] || return 0
  docker kill --signal SIGTERM "$PROBE_NAME" >/dev/null 2>&1 || true
  wait "$PROBE_PID" 2>/dev/null || true
  PROBE_PID=
  cat "$EVID/probe-1.log"
  echo "linhas no CSV da sonda (com o cabeçalho): $(wc -l <"$EVID/probe-1.csv")"
}

generate_file() {
  client generate --file "$CDIR/source.bin" --size "$SIZE" --seed "v07-$RUN_ID" --events "$CDIR/events.jsonl"
}

# Uso de CPU e memória dos containers a cada 3 s enquanto o cliente roda (informativo).
sample_docker_stats() {
  local pid=$1 label=$2 api_id storage_id
  api_id=$(docker compose ps -q nestjs-api)
  storage_id=$(docker compose ps -q storage)
  while kill -0 "$pid" 2>/dev/null; do
    docker stats --no-stream --format "$label $(date -u +%H:%M:%SZ) {{.Name}} cpu {{.CPUPerc}} mem {{.MemUsage}}" \
      "$api_id" "$storage_id" "$PROBE_NAME" >>"$EVID/docker-stats.txt" 2>&1 || true
    sleep 3
  done
}

# Envio interrompido por SIGINT quando metade das partes do plano já teve o PUT concluído. O sinal
# vem de um vigia externo ao cliente (`interrupt-when`), no mesmo container, que lê o progresso a
# cada 50 ms.
upload_with_interruption() {
  local client_pid rc=0 watch_rc=0 stats_pid
  client start --file "$CDIR/source.bin" --file-name "v07-$RUN_ID-synthetic.mp4" "${CLIENT_OPTS[@]}" \
    --no-complete >"$EVID/client-start.log" 2>&1 &
  client_pid=$!
  sample_docker_stats "$client_pid" start &
  stats_pid=$!
  support interrupt-when --progress "$CDIR/progress.json" --fraction 0.5 --signal SIGINT || watch_rc=$?
  wait "$client_pid" || rc=$?
  wait "$stats_pid" || true
  cat "$EVID/client-start.log"
  echo "código do vigia: $watch_rc; código do cliente: $rc (esperado: 130, interrompido por SIGINT)"
  grep '^start' "$EVID/docker-stats.txt" | sed 's/^/docker stats: /' || true
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
  # `df` contínuo, sem pausa, por 4 s em volta do completion, que dura dezenas de ms.
  docker compose exec -T storage sh -c 'end=$(($(date +%s) + 4)); while [ "$(date +%s)" -lt "$end" ]; do \
echo "$(date +%s%3N) $(df -kP /data | tail -1 | tr -s " " | cut -d" " -f3)"; done' >"$EVID/disk-completion-fast.txt" &
  fast_pid=$!
  sleep 1
  api touch "$CDIR/hold"
  wait "$fast_pid" || true
  echo "amostras rápidas do df em volta do completion: $(wc -l <"$EVID/disk-completion-fast.txt")"
  wait "$client_pid" || rc=$?
  wait "$stats_pid" || true
  cat "$EVID/client-resume.log"
  grep '^resume' "$EVID/docker-stats.txt" | sed 's/^/docker stats: /' || true
  echo "código do cliente: $rc; código da comparação: $compare_rc"
  [ "$rc" -eq 0 ] && [ "$compare_rc" -eq 0 ]
}

collect_evidence() {
  [ "$EVIDENCE_COLLECTED" -eq 0 ] || return 0
  EVIDENCE_COLLECTED=1
  local file
  for file in events.jsonl parts-after-interruption.json parts-before-completion.json; do
    api test -e "$CDIR/$file" && api cat "$CDIR/$file" >"$EVID/$file"
  done
  [ -s "$EVID/disk-samples.txt" ] && api sh -c "cat > '$CDIR/disk-samples.txt'" <"$EVID/disk-samples.txt"
  [ -s "$EVID/disk-completion-fast.txt" ] && api sh -c "cat > '$CDIR/disk-completion-fast.txt'" <"$EVID/disk-completion-fast.txt"
  [ -s "$EVID/probe-1.csv" ] && api sh -c "cat > '$CDIR/probe-1.csv'" <"$EVID/probe-1.csv"
  (cd "$EVID" && wc -c -- *)
}

summarize() {
  collect_evidence
  local args=(--events "$CDIR/events.jsonl" --out "$CDIR/summary.json")
  api test -e "$CDIR/disk-samples.txt" && args+=(--disk "$CDIR/disk-samples.txt")
  api test -e "$CDIR/disk-completion-fast.txt" && args+=(--disk-fast "$CDIR/disk-completion-fast.txt")
  api test -e "$CDIR/probe-1.csv" && args+=(--probe "$CDIR/probe-1.csv")
  support summarize "${args[@]}" || return $?
  api cat "$CDIR/summary.json" >"$EVID/summary.json"
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
  stop_probe
  stop_sampler
  if docker ps -a --format '{{.Names}}' | grep -qx "$PROBE_NAME"; then
    docker rm -f "$PROBE_NAME" >/dev/null
  fi
  local left
  left=$(docker ps -a --format '{{.Names}}' | grep -c "^v07-$RUN_ID" || true)
  echo "containers de prova restantes: $left"
  docker compose exec -T storage sh -c "ls $SAMPLER.* 2>/dev/null | wc -l" | sed 's/^/arquivos do amostrador restantes no storage: /'
  [ "$left" -eq 0 ]
}

# Depois da remoção dos objetos, o disco só é liberado quando o Silo purga a lixeira.
measure_release() {
  local started=$SECONDS rc=0
  echo "uso logo depois da limpeza (ms total bucket multipart tmp lixeira usado livre, em KiB): $(storage_usage)"
  wait_trash_empty 900 || rc=$?
  echo "liberação observada em $((SECONDS - started)) s depois da limpeza"
  return "$rc"
}

cleanup() {
  local rc=$? cleanup_rc=0 final step_rc
  set +e
  section "Limpeza dos recursos de prova"
  step "Sonda e amostrador parados e removidos" cleanup_containers
  step_rc=$?
  [ "$step_rc" -eq 0 ] || cleanup_rc=$step_rc
  collect_evidence >/dev/null 2>&1
  step "Usuários, vídeos, objetos, multiparts, jobs e e-mails de prova" support cleanup --emails "$UPLOADER,$CONTROL"
  step_rc=$?
  [ "$step_rc" -eq 0 ] || [ "$cleanup_rc" -ne 0 ] || cleanup_rc=$step_rc
  step "Diretório de prova no nestjs-api" cleanup_workdir
  step_rc=$?
  [ "$step_rc" -eq 0 ] || [ "$cleanup_rc" -ne 0 ] || cleanup_rc=$step_rc
  step "Liberação do disco do storage (purga da lixeira depois da limpeza)" measure_release
  step "Retrato depois (só leitura)" snapshot_into "$EVID/snapshot-after.txt"
  step "Retrato preservado (antes = depois)" compare_snapshots
  step_rc=$?
  [ "$step_rc" -eq 0 ] || [ "$cleanup_rc" -ne 0 ] || cleanup_rc=$step_rc
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

section "V-07 — runId $RUN_ID"
log "arquivo sintético de $SIZE bytes; fase de base informativa da sonda: $BASELINE s; intervalo antes da retomada: $GAP s"
log "usuários de prova: $UPLOADER (upload) e $CONTROL (dono do vídeo de controle)"
step "Estado do ambiente" docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'
step "Versões" versions
step "API no ar" support api-check
step "Espaço livre antes da prova" host_disk
step "Retrato antes (só leitura)" snapshot_into "$EVID/snapshot-before.txt"
step "Diretório de prova no nestjs-api" prepare_workdir
step "Conta de prova do upload" support account --email "$UPLOADER" --credentials "$CDIR/uploader.json"
step "Conta de prova do vídeo de controle" support account --email "$CONTROL" --credentials "$CDIR/control.json"
step "Vídeo de controle em draft" create_control_video
step "Arquivo sintético" generate_file
step "Espaço livre com o arquivo sintético" host_disk
step "Lixeira do storage vazia antes da medição" wait_trash_empty 900
step "Amostrador de disco do storage" start_sampler
step "Sonda em container próprio e fase de base informativa" start_probe
# Daqui em diante uma falha não encerra o roteiro: as evidências e o resumo são sempre coletados, e
# a primeira falha define o código final.
step "Upload interrompido por SIGINT por volta de 50%" upload_with_interruption || true
step "Retrato das partes depois da interrupção" parts_snapshot parts-after-interruption || true
step "Retomada, conferência das partes confirmed, completion e polling" resume_and_complete || true
step "Fim da sonda" stop_probe || true
step "Fim do amostrador" stop_sampler || true
step "Espaço livre antes da limpeza" host_disk || true
step "Resumo das medidas e projeção" summarize || true
