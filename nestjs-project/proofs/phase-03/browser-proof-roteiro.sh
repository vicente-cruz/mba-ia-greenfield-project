#!/usr/bin/env bash
# Roteiro da prova de navegador da SI-03.5: V-08 (PUT em navegador real) e V-09, parte de navegador
# (preflight com o header de checksum e custo do SHA-256), em Chromium e Firefox.
# (phase-03-videos/TD-01, TD-02, TD-03, TD-07)
#
# Roda no host:
#   1. `v08-browser-urls.ts presign` (no `nestjs-api`) abre um multipart por navegador e assina as
#      URLs como a SI-03.9: content-length assinado, checksum em unhoistableHeaders e WHEN_REQUIRED;
#   2. o serviço `proof-browser` (perfil `proofs`) executa `browser/run.sh`, que serve a página de
#      prova em http://localhost:4173, roda os casos nos dois navegadores e mede o SHA-256;
#   3. `v08-browser-urls.ts verify` confere as observações do navegador e o ListParts.
# Tudo fica sob o prefixo temporário `proofs/v08-<runId>/` do bucket principal, removido no final,
# inclusive em caso de erro; o bucket é comparado antes e depois. O container do navegador é
# removido (`--rm`) e, se sobrar, a limpeza o remove.
#
# Uso: proofs/phase-03/browser-proof-roteiro.sh [diretório de saída]
# Pré-requisito: `docker compose up -d` com `storage` saudável e `nestjs-api` no ar, e a origem
# http://localhost:4173 em MINIO_API_CORS_ALLOW_ORIGIN.
# Código de saída: 0 só quando todas as etapas e a limpeza passam. Se o roteiro for interrompido
# ou uma etapa falhar, sai com o código dessa falha original, mesmo que a limpeza passe; se só a
# limpeza falhar, sai com o código dela. A limpeza roda sempre, inclusive depois de erro.
set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "$0")/../.." && pwd)
cd "$PROJECT_DIR"

OUT_DIR=${1:-$(mktemp -d)}
mkdir -p "$OUT_DIR"
RUN_ID=$(date -u +%Y%m%d%H%M%S)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
LOG=$OUT_DIR/v08-$RUN_ID.log
WORK=$(mktemp -d)
TS=(npx ts-node proofs/phase-03/v08-browser-urls.ts)
HASH_TOTAL_BYTES=1073741824
BROWSER_TIMEOUT_SECONDS=900
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
presign_into() {
  docker compose exec -T nestjs-api "${TS[@]}" presign "$RUN_ID" >"$WORK/manifest.json"
  echo "manifesto: $(wc -c <"$WORK/manifest.json") bytes (URLs válidas por 30 min)"
}
run_browsers() {
  local rc=0
  V08_MANIFEST_B64=$(base64 -w0 "$WORK/manifest.json") \
    timeout "$BROWSER_TIMEOUT_SECONDS" docker compose --profile proofs run --rm --no-deps -T \
    -e V08_MANIFEST_B64 -e HASH_TOTAL_BYTES="$HASH_TOTAL_BYTES" proof-browser sh /proof/run.sh \
    >"$WORK/browser.out" || rc=$?
  grep -v '^RESULT ' "$WORK/browser.out" || true
  if ! grep -q '^RESULT ' "$WORK/browser.out"; then
    echo "sem a linha RESULT do navegador"
    [ "$rc" -ne 0 ] || rc=1
  fi
  return "$rc"
}
verify_results() {
  { printf 'MANIFEST '; cat "$WORK/manifest.json"; printf '\n'; grep '^RESULT ' "$WORK/browser.out"; } |
    docker compose exec -T nestjs-api "${TS[@]}" verify "$RUN_ID"
}
proof_browser_containers() {
  docker ps -a -q --filter label=com.docker.compose.project=nestjs-project \
    --filter label=com.docker.compose.service=proof-browser
}

# Sempre roda no fim (trap EXIT), inclusive depois de erro. Tenta todos os passos da limpeza,
# confere o resultado e define o código final: a falha original (interrupção do roteiro ou
# primeira etapa com falha) prevalece; sem ela, uma falha da limpeza também dá código diferente de zero.
cleanup() {
  local rc=$? cleanup_rc=0 prefix_rc=0 left final
  set +e
  section "Limpeza dos recursos temporários"
  run docker compose exec -T nestjs-api "${TS[@]}" cleanup "$RUN_ID"
  prefix_rc=$?
  STATUS+=("Limpeza do prefixo temporário: código $prefix_rc")
  cleanup_rc=$prefix_rc
  left=$(proof_browser_containers)
  if [ -n "$left" ]; then
    log "containers do proof-browser restantes: $(echo "$left" | wc -l); removendo"
    docker rm -f $left >/dev/null 2>&1
  fi
  if left=$(proof_browser_containers) && [ -z "$left" ]; then
    log "containers do proof-browser restantes: 0"
    STATUS+=("Limpeza dos containers do proof-browser: código 0")
  else
    log "containers do proof-browser restantes: não foi possível confirmar zero"
    STATUS+=("Limpeza dos containers do proof-browser: código 1")
    [ "$cleanup_rc" -ne 0 ] || cleanup_rc=1
  fi
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

section "V-08 e V-09 (navegador) — runId $RUN_ID"
log "prefixo temporário: proofs/v08-$RUN_ID/; medição de SHA-256: $HASH_TOTAL_BYTES bytes em partes de 64 MiB"
step "Estado do ambiente" docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'
step "Versões" sh -c "docker image inspect --format '{{.Id}} {{json .RepoDigests}}' \
  \"\$(docker compose --profile proofs config --images | grep '^mcr.microsoft.com/playwright')\" \
  \"\$(docker compose config --images | grep '^pgsty/silo')\" && \
  echo \"@playwright/test em next-frontend/package-lock.json: \$(grep -A2 '\"node_modules/@playwright/test\": {' ../next-frontend/package-lock.json | grep '\"version\"' | tr -d ' ,\"' | cut -d: -f2)\" && \
  echo \"playwright-core em proofs/phase-03/browser/package-lock.json: \$(grep -A2 '\"node_modules/playwright-core\": {' proofs/phase-03/browser/package-lock.json | grep '\"version\"' | tr -d ' ,\"' | cut -d: -f2)\" && \
  docker compose exec -T nestjs-api node -p \"['@aws-sdk/client-s3','@aws-sdk/s3-request-presigner'].map(p => p + ' ' + require(p + '/package.json').version).join(', ')\""
step "Origens no CORS do storage" sh -c "grep '^MINIO_API_CORS_ALLOW_ORIGIN=' .env | grep -q 'http://localhost:4173' && \
  echo \"MINIO_API_CORS_ALLOW_ORIGIN=\$(grep '^MINIO_API_CORS_ALLOW_ORIGIN=' .env | cut -d= -f2-)\""
step "Bucket principal antes (só leitura)" snapshot_into "$WORK/snapshot-before.txt"
step "Assinatura das URLs (credencial da aplicação)" presign_into
step "Navegadores: Chromium e Firefox (proof-browser)" run_browsers
step "Conferência (navegador e ListParts)" verify_results
