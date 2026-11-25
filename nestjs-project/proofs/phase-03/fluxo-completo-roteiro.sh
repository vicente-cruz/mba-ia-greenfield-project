#!/usr/bin/env bash
# Roteiro da prova do fluxo completo com vídeo válido até ready (SI-03.32; phase-03-videos/TD-15,
# AMB-1 e AMB-2): gera um MP4 H.264/AAC de alguns minutos com o FFmpeg da imagem, envia pelo
# cliente de prova até o 202, acompanha até ready e confere metadados, thumbnail, Range e download.
#
# Roda no host, a partir de nestjs-project/. Os scripts TypeScript rodam no nestjs-api:
# - upload-client.ts envia o vídeo pela API real (`nestjs-api:3000`) e pelas URLs assinadas,
#   conectando em `storage:9000` com o Host assinado (`--storage-connect`), e faz o polling;
# - upload-proof-support.ts cria a conta de prova, confere o fluxo (`flow-check`), tira os retratos
#   e faz a limpeza.
# O FFmpeg e o ffprobe são os da imagem do nestjs-api, a mesma do video-worker.
#
# Recursos de prova, identificados pelo runId e removidos no final (trap EXIT), inclusive em caso
# de erro:
# - o usuário fluxo-<runId>-uploader@proofs.streamtube.test, com canal, tokens e e-mails no Mailpit;
# - o vídeo enviado, com sessão, partes, original, thumbnail e job de processamento;
# - /tmp/fluxo-<runId>/ no nestjs-api: o MP4, credenciais (0600), estado, eventos e a thumbnail.
# Os temporários que o Silo já guardava em .minio.sys/tmp, de provas anteriores, só são listados,
# antes e depois, e nunca removidos.
# As evidências ficam no diretório de saída, sem tokens, senhas ou URLs assinadas.
#
# Uso: proofs/phase-03/fluxo-completo-roteiro.sh [diretório de saída]
# Variáveis: FLUXO_DURATION_SECONDS (padrão 180), FLUXO_VIDEO_BITRATE (padrão 4M).
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
EVID=$OUT_DIR/fluxo-$RUN_ID
mkdir -p "$EVID"
LOG=$OUT_DIR/fluxo-$RUN_ID.log
DURATION=${FLUXO_DURATION_SECONDS:-180}
BITRATE=${FLUXO_VIDEO_BITRATE:-4M}

CDIR=/tmp/fluxo-$RUN_ID
UPLOADER=fluxo-$RUN_ID-uploader@proofs.streamtube.test
FILE_NAME=fluxo-$RUN_ID.mp4
CLIENT=proofs/phase-03/upload-client.ts
SUPPORT=proofs/phase-03/upload-proof-support.ts
STORAGE_CONNECT=localhost:9000=storage:9000
CLIENT_OPTS=(
  --credentials "$CDIR/uploader.json"
  --state "$CDIR/state.json"
  --events "$CDIR/events.jsonl"
  --progress "$CDIR/progress.json"
  --storage-connect "$STORAGE_CONNECT"
)

STATUS=()
FIRST_FAILURE=0
EVIDENCE_COLLECTED=0

log() { printf '%s\n' "$*" | tee -a "$LOG"; }
section() { log ""; log "=== $* ($(date -u +%H:%M:%SZ))"; }
api() { docker compose exec -T nestjs-api "$@"; }
support() { api npx ts-node "$SUPPORT" "$@"; }
client() { api npx ts-node "$CLIENT" "$@"; }

# Etapa: roda no shell atual, com a saída no log. Devolve o código da etapa; com `set -e`, uma
# etapa obrigatória que falha encerra o roteiro e a limpeza roda pelo trap.
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

versions() {
  docker image inspect --format '{{.Id}} {{json .RepoDigests}}' "$(docker compose config --images | grep '^pgsty/silo')"
  docker version --format 'Docker Engine {{.Server.Version}} (cliente {{.Client.Version}})'
  docker info --format '{{.OperatingSystem}}; kernel {{.KernelVersion}}; {{.NCPU}} CPUs; {{.MemTotal}} bytes de memória'
  docker image inspect --format 'imagem do nestjs-api e do video-worker: {{.Id}} criada {{.Created}}' streamtube-nestjs-dev
  api node -v
  # Lido do package.json instalado: o `exports` do typeorm não expõe `typeorm/package.json`.
  api node -p "['@aws-sdk/client-s3','@aws-sdk/s3-request-presigner','bullmq','typeorm','ts-node','typescript'].map(p => p + ' ' + JSON.parse(require('fs').readFileSync('node_modules/' + p + '/package.json', 'utf8')).version).join(', ')"
  api sh -c 'ffmpeg -hide_banner -version | head -1; ffprobe -hide_banner -version | head -1'
  api dpkg-query -W -f '${Package} ${Version}\n' ffmpeg libavcodec59 libavformat59 libx264-164
  docker compose exec -T video-worker sh -c 'ffmpeg -hide_banner -version | head -1' | sed 's/^/video-worker: /'
}

host_disk() {
  df -B1 --output=size,used,avail,target / | sed 's/^/host: /'
  if [ -d /mnt/c ]; then
    df -B1 --output=size,used,avail,target /mnt/c | sed 's/^/host: /'
  fi
  docker compose exec -T storage df -B1 -P /data | sed 's/^/storage: /'
}

# Uso do volume do storage em KiB: total, bucket, multipart, temporários (com a lixeira) e lixeira.
STORAGE_DU="t=\$(date +%s%3N); \
a=\$(du -sk /data | cut -f1); b=\$(du -sk /data/streamtube | cut -f1); \
m=\$(du -sk /data/.minio.sys/multipart | cut -f1); x=\$(du -sk /data/.minio.sys/tmp | cut -f1); \
r=\$(du -sk /data/.minio.sys/tmp/.trash 2>/dev/null | cut -f1); \
echo \"ms \$t | KiB: total \$a bucket \$b multipart \$m temporários \$x lixeira \${r:-0}\""

storage_usage() {
  docker compose exec -T storage sh -c "$STORAGE_DU"
}

# Temporários que o Silo guarda em .minio.sys/tmp (um diretório por PUT abortado), com o tamanho.
# Só leitura: a lixeira (.trash, oculta) e os arquivos internos do Silo ficam de fora.
residue_into() {
  docker compose exec -T storage sh -c \
    'cd /data/.minio.sys/tmp && for d in *; do [ -d "$d" ] && echo "$(du -sk "$d" | cut -f1) KiB $d"; done; true' >"$1"
  echo "temporários do Silo em .minio.sys/tmp: $(wc -l <"$1") diretórios, $(awk '{s += $1} END {print s + 0}' "$1") KiB"
  cat "$1"
}

compare_residue() {
  residue_into "$EVID/residue-after.txt"
  if cmp -s "$EVID/residue-before.txt" "$EVID/residue-after.txt"; then
    echo "resíduos anteriores preservados e nenhum novo: listas iguais antes e depois"
    return 0
  fi
  echo "listas de temporários diferentes"
  diff "$EVID/residue-before.txt" "$EVID/residue-after.txt" || true
  return 1
}

prepare_workdir() {
  api sh -c "umask 077 && mkdir -p '$CDIR' && ls -ld '$CDIR'"
}

# MP4 H.264/AAC de fontes sintéticas do FFmpeg (testsrc2 e sine), codificado a uma taxa comum de
# 720p, sem preenchimento: o tamanho é o que o codificador e o muxer produzem.
generate_video() {
  local cmd="ffmpeg -hide_banner -loglevel error -nostdin -y \
-f lavfi -i testsrc2=size=1280x720:rate=30:duration=$DURATION \
-f lavfi -i sine=frequency=440:beep_factor=4:sample_rate=48000:duration=$DURATION \
-map 0:v -map 1:a -c:v libx264 -preset veryfast -b:v $BITRATE -maxrate $BITRATE -bufsize 8M \
-pix_fmt yuv420p -g 60 -c:a aac -b:a 128k -ac 2 -movflags +faststart $CDIR/fluxo.mp4"
  echo "comando: $cmd"
  api sh -c "s=\$(date +%s%3N) && $cmd && e=\$(date +%s%3N) && echo \"geração: \$((e - s)) ms\""
}

hash_video() {
  api sh -c "cd '$CDIR' && s=\$(date +%s%3N) && sha256sum fluxo.mp4 && e=\$(date +%s%3N) && \
echo \"sha256sum: \$((e - s)) ms\" && echo \"tamanho: \$(stat -c %s fluxo.mp4) bytes\""
}

upload_until_ready() {
  local rc=0
  client start --file "$CDIR/fluxo.mp4" --file-name "$FILE_NAME" --content-type video/mp4 \
    "${CLIENT_OPTS[@]}" >"$EVID/client-start.log" 2>&1 || rc=$?
  cat "$EVID/client-start.log"
  echo "código do cliente: $rc (esperado: 0, com o completion e o polling até o estado final)"
  [ "$rc" -eq 0 ]
}

flow_check() {
  support flow-check --credentials "$CDIR/uploader.json" --state "$CDIR/state.json" \
    --events "$CDIR/events.jsonl" --source "$CDIR/fluxo.mp4" --out "$CDIR/flow-check.json" \
    --thumbnail "$CDIR/thumbnail.jpg" --storage-connect "$STORAGE_CONNECT"
}

collect_evidence() {
  [ "$EVIDENCE_COLLECTED" -eq 0 ] || return 0
  EVIDENCE_COLLECTED=1
  local file
  for file in events.jsonl state.json flow-check.json thumbnail.jpg; do
    if api test -e "$CDIR/$file"; then
      api cat "$CDIR/$file" >"$EVID/$file"
    fi
  done
  (cd "$EVID" && wc -c -- *)
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
  pid=$(api sh -c "cat '$CDIR/progress.json' 2>/dev/null" |
    python3 -c "import json,sys; print(json.load(sys.stdin)['pid'])" 2>/dev/null || true)
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

# Depois da remoção dos objetos, o disco só é liberado quando o Silo purga a lixeira (V-07).
measure_release() {
  local started=$SECONDS waited=0 line trash
  echo "uso logo depois da limpeza: $(storage_usage)"
  while :; do
    line=$(storage_usage)
    trash=${line##* lixeira }
    if [ "$trash" -le 10240 ]; then
      echo "lixeira com $trash KiB, $((SECONDS - started)) s depois da limpeza: $line"
      return 0
    fi
    if [ "$waited" -ge 900 ]; then
      echo "lixeira ainda com $trash KiB depois de $waited s: $line"
      return 1
    fi
    [ $((waited % 60)) -eq 0 ] && echo "aguardando a purga da lixeira: $line"
    sleep 10
    waited=$((waited + 10))
  done
}

cleanup() {
  local rc=$? cleanup_rc=0 final step_rc
  set +e
  section "Limpeza dos recursos de prova"
  collect_evidence >/dev/null 2>&1
  step "Usuário, vídeo, objetos, multipart, job e e-mails de prova" support cleanup --emails "$UPLOADER"
  step_rc=$?
  [ "$step_rc" -eq 0 ] || cleanup_rc=$step_rc
  step "Diretório de prova no nestjs-api" cleanup_workdir
  step_rc=$?
  [ "$step_rc" -eq 0 ] || [ "$cleanup_rc" -ne 0 ] || cleanup_rc=$step_rc
  step "Liberação do disco do storage (purga da lixeira depois da limpeza)" measure_release
  step "Retrato depois (só leitura)" snapshot_into "$EVID/snapshot-after.txt"
  step "Retrato preservado (antes = depois)" compare_snapshots
  step_rc=$?
  [ "$step_rc" -eq 0 ] || [ "$cleanup_rc" -ne 0 ] || cleanup_rc=$step_rc
  step "Resíduos anteriores do storage preservados (só leitura)" compare_residue
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

section "Fluxo completo — runId $RUN_ID"
log "vídeo de $DURATION s, 1280x720 a 30 fps, H.264 a $BITRATE e AAC a 128k; usuário de prova: $UPLOADER"
step "Estado do ambiente" docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'
step "Versões" versions
step "API no ar" support api-check
step "Espaço livre antes da prova" host_disk
step "Retrato antes (só leitura)" snapshot_into "$EVID/snapshot-before.txt"
step "Resíduos anteriores do storage (só leitura)" residue_into "$EVID/residue-before.txt"
step "Uso do storage antes da prova" storage_usage
step "Diretório de prova no nestjs-api" prepare_workdir
step "Conta de prova" support account --email "$UPLOADER" --credentials "$CDIR/uploader.json"
step "Vídeo MP4 H.264/AAC gerado com o FFmpeg da imagem" generate_video
step "Tamanho e SHA-256 do vídeo" hash_video
# Daqui em diante uma falha não encerra o roteiro: as evidências são sempre coletadas, e a primeira
# falha define o código final.
step "Upload pelo cliente de prova, completion e polling até o estado final" upload_until_ready || true
step "Conferência do fluxo: metadados, thumbnail, Range e download" flow_check || true
step "Uso do storage com o vídeo" storage_usage || true
step "Evidências" collect_evidence || true
