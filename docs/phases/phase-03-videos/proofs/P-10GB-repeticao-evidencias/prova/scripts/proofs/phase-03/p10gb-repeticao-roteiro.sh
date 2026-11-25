#!/usr/bin/env bash
# Roteiro da repetição formal da P-10GB (SI-03.33, pendência do R-02), com o registro prévio em
# docs/phases/phase-03-videos/proofs/P-10GB-repeticao.md. A execução reprovada (p10gb-roteiro.sh) fica
# preservada; este roteiro é separado.
#
# Modo de execução (o do ensaio compilado do diagnóstico R-02, seção 12):
# - API sem watch, pelo build do projeto: `npm run build` e `npm run start:prod` (node dist/main), com
#   os monitores de p10gb-repeticao/monitor-api.cjs (sem perfil de CPU);
# - N sondas compiladas uma vez para JS (tsc) e executadas com `node`, cada uma num container próprio
#   (docker compose run, JS montado só para leitura com -v), as mesmas na base e na carga, a cada 2 s,
#   com timeout de 5 s, lançadas com espaçamento de 2000/N ms;
# - cliente de upload compilado, no Node nativo do Windows, com 4 PUTs simultâneos, interrompido por um
#   Ctrl+C real (CTRL_C_EVENT ao console do cliente, p10gb-repeticao/ctrl-c.ps1), pedido pelo vigia que
#   roda no Windows (p10gb-repeticao/vigia-interrupcao.cjs), que aciona o handler de SIGINT do cliente
#   (saída 130), e retomado pelo GET da sessão e file-verifications;
# - worker, banco, storage, Redis e Mailpit como estão.
# Relógios: as sondas, a API e as amostras usam o relógio da VM do Docker; o cliente, o do Windows. A
# diferença é medida antes da base e depois da carga (p10gb-repeticao/relogio.cjs). Os eventos do
# cliente são levados ao relógio da VM pela conversão nominal (p10gb-repeticao/eventos-relogio-vm.py),
# sem encolher nem descartar intervalos; a incerteza fica registrada à parte (relogio.json) e vai ao
# latency-verdict (--clock-uncertainty-ms), que analisa as amostras de borda (registro prévio r2).
#
# Recursos, identificados pelo runId e removidos no final (trap EXIT), inclusive em caso de erro:
# - usuários p10gbr-<runId>-uploader e p10gbr-<runId>-control @proofs.streamtube.test, com canais,
#   tokens, vídeos, sessões, partes, objetos, multiparts, jobs e e-mails;
# - /tmp/p10gbr-<runId>/ no nestjs-api; a pasta p10gbr-<runId> no temporário do Windows (arquivo de
#   prova, cliente compilado, credenciais, logs); o JS compilado no diretório de saída;
# - os containers p10gbr-<runId>-probe-<i>; arquivos /tmp/p10gbr-<runId>.* no storage e no db.
# Os temporários do Silo em .minio.sys/tmp só são listados, antes e depois; nenhum é removido.
#
# Uso: proofs/phase-03/p10gb-repeticao-roteiro.sh <diretório de saída>
# Variáveis (os padrões são os do registro prévio):
#   P10GB_SIZE_BYTES (10000000000); acima de 1.000.000.000 exige P10GB_CONFIRMA_10GB=sim
#   P10GB_PROBES (13); P10GB_PROBE_STAGGER_MS (2000/N); P10GB_BASELINE_SECONDS (600)
#   P10GB_INTERRUPT_FRACTION (0.5); P10GB_RESUME_GAP_SECONDS (5); P10GB_MIN_FREE_BYTES (29500000000)
#   P10GB_ROTULO (prova); a pré-checagem usa pre-checagem
# Pré-requisitos: `docker compose up -d` com o ambiente saudável e o video-worker no ar; a API PARADA
#   (o roteiro faz o build e a sobe); Windows com node.exe, powershell.exe e docker.exe no PATH.
# Código de saída: 0 só quando todas as etapas, os vereditos e a limpeza passam; 64 com uso inválido.
set -euo pipefail

case "${1:-}" in
  '' | -h | --help)
    echo "uso: $0 <diretório de saída>" >&2
    exit 64
    ;;
esac

SIZE=${P10GB_SIZE_BYTES:-10000000000}
if [ "$SIZE" -gt 1000000000 ] && [ "${P10GB_CONFIRMA_10GB:-}" != "sim" ]; then
  echo "recusado: $SIZE bytes exige P10GB_CONFIRMA_10GB=sim (a pré-checagem usa até 1.000.000.000)" >&2
  exit 64
fi
PROBES=${P10GB_PROBES:-13}
STAGGER_MS=${P10GB_PROBE_STAGGER_MS:-$(((2000 + PROBES / 2) / PROBES))}
BASELINE=${P10GB_BASELINE_SECONDS:-600}
FRACTION=${P10GB_INTERRUPT_FRACTION:-0.5}
GAP=${P10GB_RESUME_GAP_SECONDS:-5}
MIN_FREE=${P10GB_MIN_FREE_BYTES:-29500000000}
ROTULO=${P10GB_ROTULO:-prova}

PROJECT_DIR=$(cd "$(dirname "$0")/../.." && pwd)
HELP=$PROJECT_DIR/proofs/phase-03/p10gb-repeticao
cd "$PROJECT_DIR"
OUT_DIR=$1
mkdir -p "$OUT_DIR"
RUN_ID=$(date -u +%Y%m%d%H%M%S)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
EVID=$OUT_DIR/p10gbr-$RUN_ID
mkdir -p "$EVID"
LOG=$OUT_DIR/p10gbr-$RUN_ID.log
CDIR=/tmp/p10gbr-$RUN_ID
HOSTJS=$OUT_DIR/js-$RUN_ID
WINTEMP=$(wslpath -u "$(powershell.exe -NoProfile -Command '[IO.Path]::GetTempPath()' | tr -d '\r')")
WINDIR=${WINTEMP%/}/p10gbr-$RUN_ID
UPLOADER=p10gbr-$RUN_ID-uploader@proofs.streamtube.test
CONTROL=p10gbr-$RUN_ID-control@proofs.streamtube.test
PROBE_PREFIX=p10gbr-$RUN_ID-probe
SAMPLER=/tmp/p10gbr-$RUN_ID.sampler
SUPPORT=proofs/phase-03/upload-proof-support.ts
CLIENT_PARAMS="--concurrency 4 --sign-batch 10 --register-every 4 --part-urls-interval-ms 1100"

STATUS=()
FIRST_FAILURE=0
SAMPLER_PID=
BG_PIDS=()
PROBE_PIDS=()
WINMON_PID=
HELPER_PID=
API_PID=
CONTROL_ID=
BASELINE_START=
BASELINE_END=
OFFSET=
UNC=
API_CONTAINER=
WWIN=
EVIDENCE_COLLECTED=0

log() { printf '%s\n' "$*" | tee -a "$LOG"; }
section() { log ""; log "=== $* ($(date -u +%H:%M:%SZ))"; }
api() { docker compose exec -T nestjs-api "$@"; }
support() { api npx ts-node "$SUPPORT" "$@"; }
container_now() { api date +%s%3N; }
win_node() { (cd "$WINDIR" && node.exe "$@") 2>&1 | tr -d '\r'; }
json_field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

# As etapas rodam dentro de step ("$@" || rc=$?), onde o set -e não vale: um comando intermediário que
# falhe não interrompe a função. Por isso cada comando obrigatório verifica o próprio código com
# `|| { falha $? "descrição"; return; }`: a falha aparece no resultado da etapa e, antes do upload,
# interrompe o roteiro, que segue para a limpeza (registro prévio r3).
falha() {
  local rc=$1
  shift
  echo "FALHA | $* (código $rc)"
  [ "$rc" -ne 0 ] || rc=1
  return "$rc"
}

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

# ---------------------------------------------------------------- ambiente, versões e disco

api_stopped() {
  local n procs
  procs=$(api ps -eo args) || { falha $? "lista de processos do nestjs-api"; return; }
  n=$(grep -cE '[d]ist/main|[s]tart:dev|[s]tart:prod|[n]est start' <<<"$procs" || true)
  echo "processos da API no nestjs-api antes do roteiro: $n (o roteiro exige 0: ele faz o build e sobe a API)"
  [ "$n" -eq 0 ]
}

versions() {
  local silo node_c node_w tsc_v nest_v docker_w
  silo=$(docker compose config --images | grep '^pgsty/silo') || { falha $? "imagem do storage no Compose"; return; }
  docker image inspect --format '{{.Id}} {{json .RepoDigests}}' "$silo" || { falha $? "imagem do storage"; return; }
  docker version --format 'Docker Engine {{.Server.Version}} (cliente {{.Client.Version}})' || { falha $? "versão do Docker"; return; }
  docker info --format '{{.OperatingSystem}}; kernel {{.KernelVersion}}; {{.NCPU}} CPUs; {{.MemTotal}} bytes de memória na VM' ||
    { falha $? "informações da VM do Docker"; return; }
  docker image inspect --format 'imagem do nestjs-api e do video-worker: {{.Id}} criada {{.Created}}' streamtube-nestjs-dev ||
    { falha $? "imagem do nestjs-api"; return; }
  node_c=$(api node -v) || { falha $? "Node do container"; return; }
  node_w=$( (cd /mnt/c && node.exe -v) | tr -d '\r') || { falha $? "Node do Windows"; return; }
  tsc_v=$(api npx tsc -v | tr -d '\r') || { falha $? "tsc do container"; return; }
  nest_v=$(api npx nest --version | tr -d '\r') || { falha $? "Nest CLI do container"; return; }
  echo "Node do container: $node_c; Node do Windows: $node_w; tsc: $tsc_v; Nest CLI: $nest_v"
  docker_w=$( (cd /mnt/c && cmd.exe /c 'docker.exe --version') 2>/dev/null | tr -d '\r') || { falha $? "docker.exe no Windows"; return; }
  echo "docker.exe no Windows: $docker_w"
}

host_disk() {
  df -B1 --output=size,used,avail,target /mnt/c | sed 's/^/host: /' || { falha $? "espaço da unidade C:"; return; }
  local vhdx
  for vhdx in /mnt/c/Users/*/AppData/Local/Docker/wsl/disk/docker_data.vhdx; do
    [ -f "$vhdx" ] && echo "host: docker_data.vhdx do Docker Desktop: $(stat -c %s "$vhdx") bytes"
  done
  docker compose exec -T storage df -B1 -P /data | sed 's/^/disco de dados do Docker: /' ||
    { falha $? "espaço do disco de dados do Docker"; return; }
}

check_free_space() {
  local avail
  avail=$(df -B1 --output=avail /mnt/c | tail -1 | tr -d ' ') || { falha $? "espaço livre da unidade C:"; return; }
  [ -n "$avail" ] || { falha 1 "espaço livre da unidade C: não lido"; return; }
  echo "livre na unidade C:: $avail bytes; exigido: $MIN_FREE bytes"
  [ "$avail" -ge "$MIN_FREE" ]
}

# ---------------------------------------------------------------- storage: uso, lixeira e resíduos

STORAGE_DU="t=\$(date +%s%3N); \
a=\$(du -sk /data | cut -f1); b=\$(du -sk /data/streamtube | cut -f1); \
m=\$(du -sk /data/.minio.sys/multipart | cut -f1); x=\$(du -sk /data/.minio.sys/tmp | cut -f1); \
r=\$(du -sk /data/.minio.sys/tmp/.trash 2>/dev/null | cut -f1); \
d=\$(df -kP /data | tail -1 | tr -s ' ' | cut -d' ' -f3,4); \
echo \"\$t \$a \$b \$m \$x \${r:-0} \$d\""

storage_usage() { docker compose exec -T storage sh -c "$STORAGE_DU"; }

wait_trash_empty() {
  local limit=${1:-600} waited=0 line trash
  while :; do
    line=$(storage_usage) || { falha $? "uso do storage"; return; }
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

residue_into() {
  docker compose exec -T storage sh -c \
    'cd /data/.minio.sys/tmp || exit 1; for d in *; do [ -d "$d" ] && echo "$(du -sk "$d" | cut -f1) KiB $d"; done; true' >"$1" ||
    { falha $? "lista dos temporários do Silo"; return; }
  echo "temporários do Silo em .minio.sys/tmp: $(wc -l <"$1") diretórios, $(awk '{s += $1} END {print s + 0}' "$1") KiB"
  cat "$1"
}

compare_residue() {
  local kept missing new
  if [ ! -e "$EVID/residue-before.txt" ]; then
    echo "a lista de antes não foi registrada; nada a comparar"
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
  [ "$new" -gt 0 ] && echo "liberação do disco incompleta: restam temporários novos no volume storage-data"
  [ "$missing" -eq 0 ] && [ "$new" -eq 0 ]
}

start_storage_sampler() {
  docker compose exec -T storage sh -c "echo \$\$ > $SAMPLER.pid; while [ ! -e $SAMPLER.stop ]; do $STORAGE_DU; sleep 0.25; done" \
    >"$EVID/disk-samples.txt" 2>"$EVID/disk-sampler.err" &
  SAMPLER_PID=$!
  sleep 2
  echo "amostrador do storage: $(wc -l <"$EVID/disk-samples.txt") amostras em 2 s"
  [ -s "$EVID/disk-samples.txt" ]
}

stop_storage_sampler() {
  [ -n "$SAMPLER_PID" ] || return 0
  docker compose exec -T storage touch "$SAMPLER.stop" || true
  wait "$SAMPLER_PID" 2>/dev/null || true
  SAMPLER_PID=
  docker compose exec -T storage rm -f "$SAMPLER.stop" "$SAMPLER.pid"
  echo "amostrador do storage parado: $(wc -l <"$EVID/disk-samples.txt") amostras"
}

# ---------------------------------------------------------------- preparo: build, JS e arquivos

prepare() {
  local f
  api sh -c "umask 077 && mkdir -p '$CDIR/api'" || { falha $? "pasta $CDIR no nestjs-api"; return; }
  mkdir -p "$WINDIR/js" "$HOSTJS" || { falha $? "pasta no temporário do Windows e pasta do JS compilado"; return; }
  WWIN=$(wslpath -w "$WINDIR") || { falha $? "caminho da pasta no Windows"; return; }
  api sh -c "cat > '$CDIR/monitor-api.cjs'" <"$HELP/monitor-api.cjs" || { falha $? "cópia de monitor-api.cjs para o nestjs-api"; return; }
  api sh -c "cat > '$CDIR/amostrador-vm.sh'" <"$HELP/amostrador-vm.sh" || { falha $? "cópia de amostrador-vm.sh para o nestjs-api"; return; }
  for f in iniciar-windows.ps1 ctrl-c.ps1 relogio.cjs monitor-windows.ps1 vigia-interrupcao.cjs; do
    cp "$HELP/$f" "$WINDIR/" || { falha $? "cópia de $f para o Windows"; return; }
  done
  API_CONTAINER=$(docker compose ps --format '{{.Name}}' nestjs-api) || { falha $? "nome do container nestjs-api"; return; }
  [ -n "$API_CONTAINER" ] || { falha 1 "nome do container nestjs-api vazio"; return; }
  echo "pastas: $CDIR (nestjs-api), pasta p10gbr-$RUN_ID no temporário do Windows, $HOSTJS"
}

# Chamada por step, num contexto em que o set -e não vale dentro da função ("$@" || rc=$?): cada
# comando que pode falhar retorna explicitamente, para que uma falha no build, no tsc ou na cópia
# dos artefatos encerre o roteiro antes da geração do arquivo de prova.
build_and_compile() {
  local f rc=0
  echo "--- build da API (npm run build = nest build; dist/ fora do Git)"
  api npm run build || { rc=$?; echo "FALHA | build da API: código $rc"; return "$rc"; }
  echo "--- cliente e sonda compilados para JS (tsc), uma vez"
  api npx tsc --outDir "$CDIR/js" --module nodenext --moduleResolution nodenext --target ES2023 \
    --esModuleInterop --skipLibCheck --strictNullChecks proofs/phase-03/upload-client.ts proofs/phase-03/responsiveness-probe.ts ||
    { rc=$?; echo "FALHA | tsc do cliente e da sonda: código $rc"; return "$rc"; }
  for f in upload-client.js responsiveness-probe.js proof-api.js; do
    api cat "$CDIR/js/$f" >"$HOSTJS/$f" || { rc=$?; echo "FALHA | cópia de $f do container: código $rc"; return "$rc"; }
    [ -s "$HOSTJS/$f" ] || { echo "FALHA | $f copiado vazio"; return 1; }
  done
  for f in upload-client.js proof-api.js; do
    cp "$HOSTJS/$f" "$WINDIR/js/$f" || { rc=$?; echo "FALHA | cópia de $f para o Windows: código $rc"; return "$rc"; }
  done
  echo "JS: $(cd "$HOSTJS" && sha256sum ./*.js | cut -c1-16 | tr '\n' ' ')"
  docker compose run --rm --no-deps -T -v "$HOSTJS:/r02js:ro" nestjs-api node /r02js/responsiveness-probe.js </dev/null >/dev/null 2>&1 || rc=$?
  echo "pré-checagem da sonda compilada montada (uso inválido, esperado 64): $rc"
  [ "$rc" -eq 64 ]
}

generate_file() {
  win_node js/upload-client.js generate --file source.bin --size "$SIZE" --seed "p10gbr-$RUN_ID" --events events.jsonl
}

start_api() {
  docker compose exec -T -e NODE_OPTIONS="--require=$CDIR/monitor-api.cjs" -e R02_OUT="$CDIR/api" \
    nestjs-api npm run start:prod >"$EVID/api.log" 2>&1 &
  API_PID=$!
  local i
  for i in $(seq 1 120); do
    if curl --noproxy '*' -s -o /dev/null -w '%{http_code}' http://localhost:3000 | grep -q 200; then
      echo "API pronta em ${i} s; processos: $(api ps -eo args | grep -E '[s]tart:prod|[d]ist/main' | tr '\n' ';')"
      echo "API pela porta publicada, do Windows: $(win_node -e "require('http').get('http://localhost:3000/',r=>{console.log('HTTP',r.statusCode);r.resume()}).on('error',e=>console.log(e.code))")"
      return 0
    fi
    sleep 1
  done
  echo "API sem resposta em 120 s"
  return 1
}

stop_api() {
  local pids
  pids=$(api ps -eo pid,args | awk '/npm run start:prod|dist\/main/ {print $1}' | tr '\n' ' ')
  # shellcheck disable=SC2086
  [ -n "${pids// /}" ] && api kill -TERM $pids || true
  [ -n "$API_PID" ] && { wait "$API_PID" 2>/dev/null || true; API_PID=; }
  sleep 2
  echo "processos da API restantes: $(api ps -eo args | grep -cE '[d]ist/main|[s]tart:prod' || true)"
}

accounts() {
  support account --email "$UPLOADER" --credentials "$CDIR/uploader.json" || return $?
  support account --email "$CONTROL" --credentials "$CDIR/control.json" || return $?
  api cat "$CDIR/uploader.json" >"$WINDIR/uploader.json" || { falha $? "cópia das credenciais do usuário de upload para o Windows"; return; }
  [ -s "$WINDIR/uploader.json" ] || { falha 1 "credenciais do usuário de upload vazias no Windows"; return; }
  support control-video --credentials "$CDIR/control.json" --state "$CDIR/control-state.json" \
    --file-name "p10gbr-$RUN_ID-control.mp4" || return $?
  CONTROL_ID=$(api cat "$CDIR/control-state.json" | json_field "['publicId']") || { falha $? "leitura do publicId do vídeo de controle"; return; }
  [ -n "$CONTROL_ID" ] || { falha 1 "publicId do vídeo de controle vazio"; return; }
  echo "vídeo de controle: $CONTROL_ID (dono: $CONTROL; upload: $UPLOADER)"
}

# ---------------------------------------------------------------- relógios

clock() {
  local name=$1
  win_node relogio.cjs "$API_CONTAINER" 15 >"$EVID/relogio-$name.json" || { falha $? "medida do relógio ($name)"; return; }
  python3 - "$EVID/relogio-$name.json" "$name" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print(f"relógio ({sys.argv[2]}): VM − Windows = {d['offsetMs']} ms, incerteza ± {d['uncertaintyMs']} ms (menor ida e volta entre {len(d['samples'])} medidas)")
PY
}

# ---------------------------------------------------------------- monitores e sondas

start_monitors() {
  local pid
  # Preparação da sonda do banco antes de iniciar qualquer monitor.
  docker compose exec -T db sh -c "cat > /tmp/p10gbr-$RUN_ID.sonda-db.sh" <"$HELP/sonda-db.sh" ||
    { falha $? "cópia da sonda do banco para o db"; return; }
  docker compose exec -T db test -s "/tmp/p10gbr-$RUN_ID.sonda-db.sh" || { falha $? "sonda do banco ausente no db"; return; }
  api sh "$CDIR/amostrador-vm.sh" "$CDIR" >"$EVID/amostrador-vm.txt" 2>"$EVID/amostrador-vm.err" &
  BG_PIDS+=($!)
  docker compose exec -T db sh "/tmp/p10gbr-$RUN_ID.sonda-db.sh" "$CONTROL_ID" "/tmp/p10gbr-$RUN_ID.dbstop" >"$EVID/sonda-db.txt" 2>&1 &
  BG_PIDS+=($!)
  (while [ ! -e "$EVID/stats.stop" ]; do
    docker stats --no-stream --format "$(date +%s%3N) {{.Name}} cpu {{.CPUPerc}} mem {{.MemUsage}}" \
      $(docker compose ps -q nestjs-api db storage video-worker) $(docker ps --format '{{.Names}}' | grep "^$PROBE_PREFIX") 2>/dev/null || true
    sleep 3
  done) >"$EVID/docker-stats.txt" &
  BG_PIDS+=($!)
  (cd "$WINDIR" && powershell.exe -NoProfile -ExecutionPolicy Bypass -File monitor-windows.ps1 windows.csv parar-monitor) >"$EVID/monitor-windows.err" 2>&1 &
  WINMON_PID=$!
  sleep 3
  for pid in "${BG_PIDS[@]}" "$WINMON_PID"; do
    kill -0 "$pid" 2>/dev/null || { falha 1 "um monitor terminou logo depois de iniciado (processo $pid)"; return; }
  done
  echo "monitores iniciados: amostrador da VM, sonda do PostgreSQL, docker stats e monitor do Windows"
}

stop_monitors() {
  api touch "$CDIR/stop" || true
  docker compose exec -T db touch "/tmp/p10gbr-$RUN_ID.dbstop" || true
  touch "$EVID/stats.stop"
  [ -d "$WINDIR" ] && touch "$WINDIR/parar-monitor"
  for pid in "${BG_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  [ -n "$WINMON_PID" ] && { wait "$WINMON_PID" 2>/dev/null || true; WINMON_PID=; }
  BG_PIDS=()
  [ -e "$WINDIR/windows.csv" ] && tr -d '\r' <"$WINDIR/windows.csv" >"$EVID/windows.csv"
  rm -f "$EVID/stats.stop"
  echo "monitores parados"
}

csv_lines() { wc -l <"$1" 2>/dev/null || echo 0; }

# As N instâncias, cada uma num container próprio, lançadas com espaçamento de STAGGER_MS para que os
# disparos não coincidam. A base começa quando todas já têm uma amostra.
start_probes() {
  local i waited=0 ready
  for i in $(seq 1 "$PROBES"); do
    (api cat "$CDIR/control.json" |
      docker compose run --rm --no-deps -T -v "$HOSTJS:/r02js:ro" --name "$PROBE_PREFIX-$i" nestjs-api \
        node /r02js/responsiveness-probe.js --public-id "$CONTROL_ID" --instance "$i" \
        >"$EVID/probe-$i.csv" 2>"$EVID/probe-$i.log") &
    PROBE_PIDS+=($!)
    sleep "$(awk -v ms="$STAGGER_MS" 'BEGIN {printf "%.3f", ms / 1000}')"
  done
  while :; do
    ready=0
    for i in $(seq 1 "$PROBES"); do
      [ "$(csv_lines "$EVID/probe-$i.csv")" -ge 2 ] && ready=$((ready + 1))
    done
    [ "$ready" -eq "$PROBES" ] && break
    sleep 1
    waited=$((waited + 1))
    [ "$waited" -lt 240 ] || { echo "sondas sem amostra em 240 s ($ready de $PROBES prontas)"; return 1; }
  done
  BASELINE_START=$(container_now) || { falha $? "instante de início da base"; return; }
  for i in $(seq 1 "$PROBES"); do
    echo "instância $i: processo 1 = $(docker exec "$PROBE_PREFIX-$i" cat /proc/1/cmdline | tr '\0' ' ' | cut -c1-60); fase do disparo (epoch_ms mod 2000) = $(sed -n 2p "$EVID/probe-$i.csv" | cut -d, -f4 | awk '{print $1 % 2000}') ms"
  done
  echo "base: início em $BASELINE_START ms (relógio dos containers), com $PROBES instâncias"
}

stop_probes() {
  [ "${#PROBE_PIDS[@]}" -gt 0 ] || return 0
  local i
  for i in $(seq 1 "$PROBES"); do docker kill --signal SIGTERM "$PROBE_PREFIX-$i" >/dev/null 2>&1 || true; done
  for pid in "${PROBE_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  PROBE_PIDS=()
  for i in $(seq 1 "$PROBES"); do tail -1 "$EVID/probe-$i.log"; done
}

# Memória com todas as sondas em execução: Windows (referência informativa de 4 GiB), containers e VM.
memory_snapshot() {
  local t0 waited=0 running
  running=$(docker ps --format '{{.Names}}' | grep -c "^$PROBE_PREFIX-" || true)
  echo "sondas em execução na medição: $running de $PROBES"
  [ "$running" -eq "$PROBES" ] || { echo "FALHA | a medição de memória exige todas as $PROBES sondas em execução"; return 1; }
  t0=$(container_now)
  until [ "$(awk -v a="$t0" -F, 'NR > 1 && $1 >= a' "$WINDIR/windows.csv" 2>/dev/null | wc -l)" -ge 10 ]; do
    sleep 2; waited=$((waited + 2)); [ "$waited" -lt 120 ] || break
  done
  docker stats --no-stream --format '{{.Name}} cpu {{.CPUPerc}} mem {{.MemUsage}}' $(docker compose ps -q) \
    $(docker ps --format '{{.Names}}' | grep "^$PROBE_PREFIX") | tee "$EVID/memoria-containers.txt" ||
    { falha $? "memória dos containers"; return; }
  api sh -c 'grep -E "^(MemTotal|MemAvailable|SwapTotal|SwapFree):" /proc/meminfo' | tee "$EVID/memoria-vm.txt" ||
    { falha $? "memória da VM"; return; }
  python3 - "$WINDIR/windows.csv" "$t0" <<'PY'
import csv,sys
rows=[r for r in csv.DictReader(l.replace('\r','') for l in open(sys.argv[1])) if int(r['epoch_ms'])>=int(sys.argv[2])]
av=sorted(int(r['available_mb']) for r in rows)
print(f"Windows ({len(rows)} amostras): disponível mín {av[0]} MB, mediana {av[len(av)//2]} MB ({'acima' if av[0]>=4096 else 'abaixo'} da referência informativa de 4.096 MiB); commit máx {max(int(r['committed_bytes']) for r in rows)/1e9:.2f} de {int(rows[-1]['commit_limit'])/1e9:.2f} GB; arquivo de paginação {rows[-1]['pagefile_pct']}%; vmmem {int(rows[-1]['vmmem_ws_bytes'])/1e9:.2f} GB")
PY
}

baseline() {
  echo "fase de base: $BASELINE s sem upload, com as mesmas $PROBES instâncias"
  sleep "$BASELINE"
  local total=0 i
  for i in $(seq 1 "$PROBES"); do total=$((total + $(csv_lines "$EVID/probe-$i.csv") - 1)); done
  echo "amostras até aqui, com o aquecimento: $total"
}

# ---------------------------------------------------------------- cliente no Windows

# Inicia o cliente no Windows num console próprio (iniciar-windows.ps1) e devolve o código de saída.
win_client() {
  local name=$1
  shift
  (cd "$WINDIR" && powershell.exe -NoProfile -ExecutionPolicy Bypass -File iniciar-windows.ps1 -Dir "$WWIN" \
    -PidFile "$name.pid" -Command "node.exe js\\upload-client.js $* > $name.log 2>&1")
}

wait_file() {
  local f=$1 limit=$2 waited=0
  until [ -e "$f" ]; do
    sleep 0.5; waited=$((waited + 1)); [ "$waited" -lt $((limit * 2)) ] || return 1
  done
}

upload_with_interruption() {
  local lpid rc=0 watch_rc=0 helper_rc=0 cpid waited=0
  rm -f "$WINDIR/ctrl-c.trigger" "$WINDIR/ctrl-c.log" "$WINDIR/client-start.pid"
  # A base termina antes de armar o envio do Ctrl+C: a partida do PowerShell não entra na base (ela
  # elevaria o p95 da base e afrouxaria o critério (a)). Do armar ao lançamento do cliente, as amostras
  # ficam fora da base e da carga e só contam no critério (c).
  BASELINE_END=$(container_now) || { falha $? "instante de fim da base"; return; }
  echo "base: fim em $BASELINE_END ms (antes de armar o envio do Ctrl+C e de lançar o cliente de upload)"
  # O envio do Ctrl+C é armado antes do cliente: a partida do PowerShell e o Add-Type levam ~3 s, o que
  # atrasou a interrupção na 2ª pré-checagem. O PID do console é lido só no gatilho.
  (cd "$WINDIR" && powershell.exe -NoProfile -ExecutionPolicy Bypass -File ctrl-c.ps1 -PidFile client-start.pid \
    -Log ctrl-c.log -TriggerFile ctrl-c.trigger) >/dev/null 2>&1 &
  HELPER_PID=$!
  until grep -q armado "$WINDIR/ctrl-c.log" 2>/dev/null; do
    sleep 0.2; waited=$((waited + 1)); [ "$waited" -lt 300 ] || { echo "o envio do Ctrl+C não armou em 60 s"; return 1; }
  done
  echo "envio do Ctrl+C armado: $(tr -d '\r' <"$WINDIR/ctrl-c.log" | head -1)"
  echo "lançamento do cliente de upload em $(container_now) ms (relógio dos containers)"
  win_client client-start start --file source.bin --file-name "p10gbr-$RUN_ID-synthetic.mp4" --credentials uploader.json \
    --state state.json --events events.jsonl --progress progress.json --api http://localhost:3000 --no-complete $CLIENT_PARAMS &
  lpid=$!
  wait_file "$WINDIR/client-start.pid" 60 || { echo "o iniciador não gravou o PID do console"; return 1; }
  cpid=$(tr -d '\r\n ' <"$WINDIR/client-start.pid")
  echo "cliente iniciado no Windows; console $cpid"
  # O vigia roda no Windows (Node do Windows): lido pelo WSL, o progresso fica aberto sem
  # compartilhamento de exclusão, e a troca atômica do arquivo pelo cliente falha com EPERM.
  (cd "$WINDIR" && node.exe vigia-interrupcao.cjs progress.json "$FRACTION" "$cpid" ctrl-c.trigger) > >(tr -d '\r') 2>&1 || watch_rc=$?
  if [ "$watch_rc" -ne 0 ]; then
    kill "$HELPER_PID" 2>/dev/null || true
  fi
  wait "$HELPER_PID" || helper_rc=$?
  HELPER_PID=
  wait "$lpid" || rc=$?
  tr -d '\r' <"$WINDIR/client-start.log"
  [ -e "$WINDIR/ctrl-c.log" ] && tr -d '\r' <"$WINDIR/ctrl-c.log" | sed 's/^/ctrl-c.ps1: /'
  echo "código do vigia: $watch_rc; código do envio do Ctrl+C: $helper_rc; código do cliente: $rc (esperado: 130, SIGINT tratado pelo cliente)"
  [ "$watch_rc" -eq 0 ] && [ "$helper_rc" -eq 0 ] && [ "$rc" -eq 130 ]
}

# Estado e eventos do cliente no nestjs-api, para o retrato e a comparação das partes. Um arquivo
# ausente ou uma cópia com falha é falha obrigatória: a comparação nunca usa eventos antigos.
copy_client_files() {
  local f
  for f in state.json events.jsonl; do
    [ -s "$WINDIR/$f" ] || { falha 1 "$f do cliente ausente ou vazio"; return; }
    api sh -c "cat > '$CDIR/$f'" < <(tr -d '\r' <"$WINDIR/$f") || { falha $? "cópia de $f do cliente para o nestjs-api"; return; }
  done
}

parts_snapshot() {
  copy_client_files || return $?
  support parts-snapshot --state "$CDIR/state.json" --out "$CDIR/$1.json"
}

resume_and_complete() {
  local lpid rc=0 compare_rc=0 fast_pid
  sleep "$GAP"
  win_client client-resume resume --credentials uploader.json --state state.json --events events.jsonl \
    --progress progress.json --api http://localhost:3000 --hold-before-completion hold $CLIENT_PARAMS &
  lpid=$!
  local waited=0
  until [ -e "$WINDIR/hold.ready" ]; do
    if ! kill -0 "$lpid" 2>/dev/null; then
      wait "$lpid" || rc=$?
      tr -d '\r' <"$WINDIR/client-resume.log"
      echo "o cliente terminou antes do completion (código $rc)"
      return 1
    fi
    sleep 0.5
    waited=$((waited + 1))
    [ "$waited" -lt 3600 ] || { echo "o cliente não chegou ao completion em 30 min"; return 1; }
  done
  echo "--- retrato das partes antes do completion"
  parts_snapshot parts-before-completion || compare_rc=$?
  echo "--- comparação com o retrato depois da interrupção"
  support compare-parts --before "$CDIR/parts-after-interruption.json" \
    --after "$CDIR/parts-before-completion.json" --events "$CDIR/events.jsonl" || compare_rc=$?
  docker compose exec -T storage sh -c 'end=$(($(date +%s) + 6)); while [ "$(date +%s)" -lt "$end" ]; do \
echo "$(date +%s%3N) $(df -kP /data | tail -1 | tr -s " " | cut -d" " -f3)"; done' >"$EVID/disk-completion-fast.txt" &
  fast_pid=$!
  sleep 1
  touch "$WINDIR/hold"
  wait "$fast_pid" || true
  wait "$lpid" || rc=$?
  tr -d '\r' <"$WINDIR/client-resume.log"
  echo "código do cliente: $rc; código da comparação: $compare_rc"
  [ "$rc" -eq 0 ] && [ "$compare_rc" -eq 0 ]
}

# ---------------------------------------------------------------- evidências, resumo e vereditos

collect_evidence() {
  [ "$EVIDENCE_COLLECTED" -eq 0 ] || return 0
  EVIDENCE_COLLECTED=1
  local f k rc=0
  for f in events.jsonl state.json progress.json client-start.log client-resume.log ctrl-c.log; do
    if [ -e "$WINDIR/$f" ]; then
      tr -d '\r' <"$WINDIR/$f" >"$EVID/client-$f" || { falha $? "cópia de $f do cliente"; rc=1; }
    fi
  done
  for f in parts-after-interruption.json parts-before-completion.json; do
    if api test -e "$CDIR/$f"; then
      api cat "$CDIR/$f" >"$EVID/$f" || { falha $? "cópia de $f"; rc=1; }
    fi
  done
  for k in requests loop gc db; do
    if api test -e "$CDIR/api/$k.jsonl"; then
      api cat "$CDIR/api/$k.jsonl" >"$EVID/api-$k.jsonl" || { falha $? "cópia de api-$k.jsonl"; rc=1; }
    fi
  done
  (cd "$EVID" && wc -c -- *)
  return "$rc"
}

# Eventos do cliente no relógio da VM: diferença média das duas medidas (conversão nominal, todos os
# intervalos preservados); incerteza = a maior das duas + metade da variação entre elas, registrada à
# parte em relogio.json e passada ao latency-verdict.
events_to_vm() {
  [ -e "$EVID/relogio-antes.json" ] && [ -e "$EVID/relogio-depois.json" ] || { echo "faltam as medidas de relógio"; return 1; }
  read -r OFFSET UNC < <(python3 - "$EVID/relogio-antes.json" "$EVID/relogio-depois.json" <<'PY'
import json,sys,math
a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2]))
o=(a['offsetMs']+b['offsetMs'])/2
u=max(a['uncertaintyMs'],b['uncertaintyMs'])+abs(a['offsetMs']-b['offsetMs'])/2
print(round(o), math.ceil(u))
PY
  )
  [ -n "$OFFSET" ] && [ -n "$UNC" ] || { echo "FALHA | diferença ou incerteza do relógio não calculada"; return 1; }
  printf '{"offsetMs": %s, "uncertaintyMs": %s}\n' "$OFFSET" "$UNC" >"$EVID/relogio.json"
  echo "eventos do cliente levados ao relógio da VM (conversão nominal): + $OFFSET ms; incerteza registrada à parte: ± $UNC ms"
  python3 -I "$HELP/eventos-relogio-vm.py" "$EVID/client-events.jsonl" "$EVID/events-vm.jsonl" "$OFFSET" || return $?
  api sh -c "cat > '$CDIR/events-vm.jsonl'" <"$EVID/events-vm.jsonl"
}

# As N sondas no nestjs-api para o resumo e os vereditos. Uma sonda sem CSV ou uma cópia com falha é
# falha obrigatória: nenhuma instância é omitida em silêncio.
PROBE_ARGS=()
copy_probes() {
  local i
  PROBE_ARGS=()
  for i in $(seq 1 "$PROBES"); do
    [ -s "$EVID/probe-$i.csv" ] || { falha 1 "sonda $i sem CSV de amostras"; return; }
    api sh -c "cat > '$CDIR/probe-$i.csv'" <"$EVID/probe-$i.csv" || { falha $? "cópia da sonda $i para o nestjs-api"; return; }
    PROBE_ARGS+=(--probe "$CDIR/probe-$i.csv")
  done
}

# A coleta segue mesmo com uma cópia de evidência falha (o resumo e os vereditos ainda são calculados),
# mas a etapa termina com o código da falha.
summarize() {
  local collect_rc=0
  collect_evidence || collect_rc=$?
  events_to_vm || return $?
  local args=(--events "$CDIR/events-vm.jsonl" --out "$CDIR/summary.json")
  if [ -s "$EVID/disk-samples.txt" ]; then
    api sh -c "cat > '$CDIR/disk-samples.txt'" <"$EVID/disk-samples.txt" || { falha $? "cópia das amostras de disco"; return; }
    args+=(--disk "$CDIR/disk-samples.txt")
  fi
  if [ -s "$EVID/disk-completion-fast.txt" ]; then
    api sh -c "cat > '$CDIR/disk-completion-fast.txt'" <"$EVID/disk-completion-fast.txt" ||
      { falha $? "cópia das amostras de disco do completion"; return; }
    args+=(--disk-fast "$CDIR/disk-completion-fast.txt")
  fi
  copy_probes || return $?
  args+=("${PROBE_ARGS[@]}")
  support summarize "${args[@]}" || return $?
  api cat "$CDIR/summary.json" >"$EVID/summary.json" || { falha $? "cópia do resumo"; return; }
  return "$collect_rc"
}

latency_verdict() {
  if [ -z "$BASELINE_START" ] || [ -z "$BASELINE_END" ]; then
    echo "a base não foi delimitada; os vereditos de latência não podem ser calculados"
    return 1
  fi
  if [ -z "$UNC" ]; then
    echo "a incerteza do relógio não foi calculada; os vereditos de latência não podem ser calculados"
    return 1
  fi
  local args=(--events "$CDIR/events-vm.jsonl" --baseline-start "$BASELINE_START" --baseline-end "$BASELINE_END"
    --clock-uncertainty-ms "$UNC" --out "$CDIR/latency-verdict.json") rc=0
  copy_probes || return $?
  args+=("${PROBE_ARGS[@]}")
  support latency-verdict "${args[@]}" || rc=$?
  api cat "$CDIR/latency-verdict.json" >"$EVID/latency-verdict.json" || {
    falha $? "cópia do veredito de latência"
    [ "$rc" -ne 0 ] || rc=1
  }
  return "$rc"
}

snapshot_into() { local rc=0; support snapshot >"$1" || rc=$?; cat "$1"; return "$rc"; }

compare_snapshots() {
  if [ -s "$EVID/snapshot-before.txt" ] && cmp -s "$EVID/snapshot-before.txt" "$EVID/snapshot-after.txt"; then
    echo "retratos iguais: $(cat "$EVID/snapshot-after.txt")"
    return 0
  fi
  echo "retratos diferentes ou ausentes"
  diff "$EVID/snapshot-before.txt" "$EVID/snapshot-after.txt" || true
  return 1
}

# ---------------------------------------------------------------- limpeza

# Se o cliente ainda estiver rodando (roteiro interrompido), recebe o mesmo Ctrl+C real; se não sair
# em 20 s, é encerrado, e o log registra que foi encerramento de limpeza, fora da medição.
stop_windows_client() {
  local f cpid alive
  for f in client-start client-resume; do
    [ -e "$WINDIR/$f.pid" ] || continue
    cpid=$(tr -d '\r\n ' <"$WINDIR/$f.pid")
    alive=$(powershell.exe -NoProfile -Command "if (Get-Process -Id $cpid -ErrorAction SilentlyContinue) { 'sim' } else { 'nao' }" | tr -d '\r')
    if [ "$alive" = "sim" ]; then
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$WWIN\\ctrl-c.ps1" -TargetPid "$cpid" -Log "$WWIN\\ctrl-c-limpeza.log" >/dev/null 2>&1 || true
      sleep 20
      powershell.exe -NoProfile -Command "Get-Process -Id $cpid -ErrorAction SilentlyContinue | Stop-Process -Force" >/dev/null 2>&1 || true
      echo "cliente $f ainda rodava na limpeza: Ctrl+C enviado e, se preciso, encerrado (fora da medição)"
    fi
  done
}

measure_release() {
  local started=$SECONDS rc=0
  echo "uso logo depois da limpeza (ms total bucket multipart tmp lixeira usado livre, em KiB): $(storage_usage)"
  wait_trash_empty 1800 || rc=$?
  echo "purga da lixeira observada em $((SECONDS - started)) s depois da limpeza"
  return "$rc"
}

cleanup_local() {
  local i
  stop_probes
  stop_monitors
  stop_storage_sampler
  [ -n "$HELPER_PID" ] && { kill "$HELPER_PID" 2>/dev/null || true; echo "envio do Ctrl+C armado e não disparado: encerrado (só o PowerShell auxiliar)"; }
  [ -n "$WWIN" ] && stop_windows_client
  collect_evidence >/dev/null 2>&1
  stop_api
  for i in $(seq 1 "$PROBES"); do docker rm -f "$PROBE_PREFIX-$i" >/dev/null 2>&1 || true; done
  echo "containers de prova restantes: $(docker ps -a --format '{{.Names}}' | grep -c "^p10gbr-$RUN_ID" || true)"
  api rm -rf "$CDIR"
  echo "diretório no nestjs-api presente: $(api test -e "$CDIR" && echo sim || echo não)"
  case "$WINDIR" in
    /mnt/c/*/p10gbr-"$RUN_ID") rm -rf -- "$WINDIR" ;;
  esac
  echo "pasta no Windows presente: $([ -e "$WINDIR" ] && echo sim || echo não)"
  case "$HOSTJS" in
    */js-"$RUN_ID") rm -rf -- "$HOSTJS" ;;
  esac
  echo "JS compilado presente: $([ -e "$HOSTJS" ] && echo sim || echo não)"
  docker compose exec -T db rm -f "/tmp/p10gbr-$RUN_ID.sonda-db.sh" "/tmp/p10gbr-$RUN_ID.dbstop"
  docker compose exec -T storage sh -c "rm -f $SAMPLER.stop $SAMPLER.pid"
  [ "$(docker ps -a --format '{{.Names}}' | grep -c "^p10gbr-$RUN_ID" || true)" -eq 0 ]
}

cleanup() {
  local rc=$? cleanup_rc=0 final step_rc
  set +e
  section "Limpeza dos recursos de prova"
  step "Sondas, monitores, cliente, API, containers e pastas temporárias" cleanup_local
  step_rc=$?
  [ "$step_rc" -eq 0 ] || cleanup_rc=$step_rc
  step "Usuários, vídeos, objetos, multiparts, jobs e e-mails de prova" support cleanup --emails "$UPLOADER,$CONTROL"
  step_rc=$?
  [ "$step_rc" -eq 0 ] || [ "$cleanup_rc" -ne 0 ] || cleanup_rc=$step_rc
  step "Purga da lixeira do storage depois da limpeza" measure_release
  step "Uso do storage depois da limpeza e da purga" storage_usage
  step "Retrato depois (só leitura)" snapshot_into "$EVID/snapshot-after.txt"
  step "Retrato preservado (antes = depois)" compare_snapshots
  step_rc=$?
  [ "$step_rc" -eq 0 ] || [ "$cleanup_rc" -ne 0 ] || cleanup_rc=$step_rc
  step "Temporários do Silo: anteriores preservados e novos (só leitura)" compare_residue
  step "Espaço livre depois da limpeza" host_disk
  section "Situação dos passos"
  for entry in "${STATUS[@]}"; do log "- $entry"; done
  if [ "$rc" -ne 0 ]; then final=$rc; elif [ "$FIRST_FAILURE" -ne 0 ]; then final=$FIRST_FAILURE; else final=$cleanup_rc; fi
  log "código final: $final (interrupção ou etapa obrigatória: $rc; primeira etapa com falha: $FIRST_FAILURE; limpeza: $cleanup_rc)"
  log "log completo: $LOG"
  log "evidências: $EVID"
  exit "$final"
}
trap cleanup EXIT

section "P-10GB repetição ($ROTULO) — runId $RUN_ID"
log "arquivo de $SIZE bytes; $PROBES instâncias da sonda com espaçamento de $STAGGER_MS ms; base de $BASELINE s; interrupção a $FRACTION; intervalo antes da retomada: $GAP s"
log "usuários de prova: $UPLOADER (upload) e $CONTROL (dono do vídeo de controle)"
step "Estado do ambiente" docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'
step "API parada antes do roteiro" api_stopped
step "Espaço livre exigido na unidade C:" check_free_space
step "Versões" versions
step "Espaço livre e VHDX antes da prova" host_disk
step "Retrato antes (só leitura)" snapshot_into "$EVID/snapshot-before.txt"
step "Temporários do Silo antes da prova (só leitura)" residue_into "$EVID/residue-before.txt"
step "Pastas de prova" prepare
step "Build da API e JS do cliente e da sonda" build_and_compile
step "Arquivo de prova no Windows, preparado antes da medição" generate_file
step "Espaço livre com o arquivo de prova" host_disk
step "API sem watch (npm run start:prod) com os monitores" start_api
step "Contas de prova e vídeo de controle" accounts
step "Relógio antes da base" clock antes
step "Lixeira do storage vazia antes da medição" wait_trash_empty 900
step "Amostrador de disco do storage" start_storage_sampler
step "Monitores (VM, PostgreSQL, docker stats e Windows)" start_monitors
step "Sondas compiladas em containers próprios" start_probes
step "Memória com todas as sondas em execução (referência informativa de 4 GiB)" memory_snapshot
step "Fase de base" baseline
# Daqui em diante uma falha não encerra o roteiro: as evidências, o resumo e os vereditos são sempre
# coletados, e a primeira falha define o código final.
step "Upload no Windows interrompido por Ctrl+C real por volta de $FRACTION" upload_with_interruption || true
step "Retrato das partes depois da interrupção" parts_snapshot parts-after-interruption || true
step "Retomada no Windows, conferência das partes recebidas, completion e polling" resume_and_complete || true
step "Relógio depois da carga" clock depois || true
step "Fim das sondas" stop_probes || true
step "Fim dos monitores" stop_monitors || true
step "Fim do amostrador do storage" stop_storage_sampler || true
step "Espaço livre antes da limpeza" host_disk || true
step "Resumo das medidas" summarize || true
step "Vereditos de latência (critérios do registro prévio)" latency_verdict || true
