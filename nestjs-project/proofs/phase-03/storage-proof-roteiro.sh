#!/usr/bin/env bash
# Roteiro das provas de servidor da SI-03.4 contra o storage real:
#   v02 — content-length assinado (v02-content-length.ts, phase-03-videos/TD-03);
#   v09 — checksum SHA-256 assinado, parte de servidor (v09-checksum-server.ts, TD-02 e TD-07);
#   v10 — repetição do Complete e guardas opcionais (v10-complete-retry.ts, TD-02);
#   v04 — ffprobe/ffmpeg sobre URL assinada, formatos e timeouts (v04-ffmpeg-signed-url.ts, TD-11, TD-13).
#
# Roda no host; os scripts rodam dentro do container `nestjs-api`, com a credencial da aplicação.
# Tudo fica sob o prefixo temporário `proofs/<prova>-<runId>/` do bucket principal, removido no
# final, inclusive em caso de erro. O bucket é comparado antes e depois.
#
# Uso: proofs/phase-03/storage-proof-roteiro.sh <v02|v09|v10|v04> [diretório de saída]
# Pré-requisito: `docker compose up -d` com `storage` saudável e `nestjs-api` no ar.
# Código de saída: 0 só quando todas as etapas e a limpeza passam. Se o roteiro for interrompido
# ou uma etapa falhar, sai com o código dessa falha original, mesmo que a limpeza passe; se só a
# limpeza falhar, sai com o código dela. A limpeza roda sempre, inclusive depois de erro.
set -euo pipefail

PROOF=${1:-}
case "$PROOF" in
  v02) SCRIPT=proofs/phase-03/v02-content-length.ts ;;
  v09) SCRIPT=proofs/phase-03/v09-checksum-server.ts ;;
  v10) SCRIPT=proofs/phase-03/v10-complete-retry.ts ;;
  v04) SCRIPT=proofs/phase-03/v04-ffmpeg-signed-url.ts ;;
  *)
    echo "uso: $0 <v02|v09|v10|v04> [diretório de saída]" >&2
    exit 64
    ;;
esac

PROJECT_DIR=$(cd "$(dirname "$0")/../.." && pwd)
cd "$PROJECT_DIR"

OUT_DIR=${2:-$(mktemp -d)}
mkdir -p "$OUT_DIR"
RUN_ID=$(date -u +%Y%m%d%H%M%S)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
LOG=$OUT_DIR/$PROOF-$RUN_ID.log
WORK=$(mktemp -d)
TS=(npx ts-node "$SCRIPT")
STATUS=()
# Código da primeira etapa obrigatória que falhou (0 enquanto nenhuma falhou).
FIRST_FAILURE=0

log() { printf '%s\n' "$*" | tee -a "$LOG"; }
section() { log ""; log "=== $* ($(date -u +%H:%M:%SZ))"; }
run() {
  log "\$ $*"
  "$@" 2>&1 | tee -a "$LOG"
  return "${PIPESTATUS[0]}"
}
# Etapa obrigatória: registra o código e segue para as próximas, para coletar todas as evidências.
# A falha não se perde: o código final do roteiro é diferente de zero (ver cleanup).
step() {
  local name=$1 rc=0
  shift
  section "$name"
  run "$@" || rc=$?
  STATUS+=("$name: código $rc")
  if [ "$rc" -ne 0 ] && [ "$FIRST_FAILURE" -eq 0 ]; then
    FIRST_FAILURE=$rc
  fi
}

snapshot_into() {
  local rc=0
  docker compose exec -T nestjs-api "${TS[@]}" snapshot >"$1" || rc=$?
  cat "$1"
  return "$rc"
}
compare_snapshots() {
  if [ -s "$WORK/snapshot-before.txt" ] && cmp -s "$WORK/snapshot-before.txt" "$WORK/snapshot-after.txt"; then
    echo "retratos iguais: $(cat "$WORK/snapshot-after.txt")"
    return 0
  fi
  echo "retratos diferentes ou ausentes"
  diff "$WORK/snapshot-before.txt" "$WORK/snapshot-after.txt" || true
  return 1
}

# Sempre roda no fim (trap EXIT), inclusive depois de erro. Tenta todos os passos da limpeza,
# confere o resultado e define o código final: a falha original (interrupção do roteiro ou
# primeira etapa com falha) prevalece; sem ela, uma falha da limpeza também dá código diferente de zero.
cleanup() {
  local rc=$? cleanup_rc=0 prefix_rc=0 final
  set +e
  section "Limpeza dos recursos temporários"
  run docker compose exec -T nestjs-api "${TS[@]}" cleanup "$RUN_ID"
  prefix_rc=$?
  STATUS+=("Limpeza do prefixo temporário: código $prefix_rc")
  cleanup_rc=$prefix_rc
  step "Bucket principal depois (só leitura)" snapshot_into "$WORK/snapshot-after.txt"
  step "Bucket principal preservado (antes = depois)" compare_snapshots
  rm -rf "$WORK"
  if [ -e "$WORK" ]; then
    log "pasta temporária no host presente: sim"
    [ "$cleanup_rc" -ne 0 ] || cleanup_rc=1
  else
    log "pasta temporária no host presente: não"
  fi
  section "Situação dos passos"
  for entry in "${STATUS[@]}"; do log "- $entry"; done
  if [ "$rc" -ne 0 ]; then
    final=$rc
  elif [ "$FIRST_FAILURE" -ne 0 ]; then
    final=$FIRST_FAILURE
  else
    final=$cleanup_rc
  fi
  log "código final: $final (interrupção: $rc; primeira etapa com falha: $FIRST_FAILURE; limpeza: $cleanup_rc)"
  log "log completo: $LOG"
  exit "$final"
}
trap cleanup EXIT

section "${PROOF^^} — runId $RUN_ID"
log "script: $SCRIPT; prefixo temporário: proofs/$PROOF-$RUN_ID/"
step "Estado do ambiente" docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'
step "Versões" sh -c "docker image inspect --format '{{.Id}} {{json .RepoDigests}}' \"\$(docker compose config --images | grep '^pgsty/silo')\" && \
  docker compose exec -T nestjs-api node -v && \
  docker compose exec -T nestjs-api node -p \"['@aws-sdk/client-s3','@aws-sdk/s3-request-presigner','@smithy/signature-v4','@aws-sdk/checksums'].map(p => p + ' ' + require(p + '/package.json').version).join(', ')\""
step "Bucket principal antes (só leitura)" snapshot_into "$WORK/snapshot-before.txt"
step "Prova ${PROOF^^}" docker compose exec -T nestjs-api "${TS[@]}" run "$RUN_ID"
