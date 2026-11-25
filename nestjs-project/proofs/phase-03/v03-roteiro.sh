#!/usr/bin/env bash
# V-03 — roteiro da prova das URLs pré-assinadas do AWS SDK contra o Silo (phase-03-videos/TD-07, TD-08).
#
# Roda no host. O `v03-presigned-urls.ts` roda dentro do container `nestjs-api` e gera as URLs com
# a credencial da aplicação. As requisições são feitas com curl:
#   - URLs do endpoint público (S3_PUBLIC_ENDPOINT, o caminho do navegador): curl no host, pela porta
#     publicada, com `--noproxy '*'` e o header Origin da origem permitida;
#   - URLs do endpoint interno (S3_ENDPOINT, rede do Compose): curl dentro do `nestjs-api`.
# Tudo fica sob o prefixo temporário `proofs/v03-<runId>/` do bucket principal, removido no final,
# inclusive em caso de erro. O bucket é comparado antes e depois.
#
# Uso: proofs/phase-03/v03-roteiro.sh [diretório de saída]
# Pré-requisito: `docker compose up -d` com `storage` saudável e `nestjs-api` no ar.
# Código de saída: 0 só quando todas as etapas e a limpeza passam. Se o roteiro for interrompido
# ou uma etapa falhar, sai com o código dessa falha original, mesmo que a limpeza passe; se só a
# limpeza falhar, sai com o código dela. A limpeza roda sempre, inclusive depois de erro.
set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "$0")/../.." && pwd)
cd "$PROJECT_DIR"

OUT_DIR=${1:-$(mktemp -d)}
mkdir -p "$OUT_DIR"
RUN_ID=$(date -u +%Y%m%d%H%M%S)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
LOG=$OUT_DIR/v03-$RUN_ID.log
WORK=$(mktemp -d)
CONTAINER_WORK=/tmp/v03-$RUN_ID
BODY_BYTES=1048576
EXPIRES_IN=60
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

V03_TS=(npx ts-node proofs/phase-03/v03-presigned-urls.ts)

# Sempre roda no fim (trap EXIT), inclusive depois de erro. Tenta todos os passos da limpeza,
# confere o resultado e define o código final: a falha original (interrupção do roteiro ou
# primeira etapa com falha) prevalece; sem ela, uma falha da limpeza também dá código diferente de zero.
cleanup() {
  local rc=$? cleanup_rc=0 prefix_rc=0 dirs_rc=0 present final
  set +e
  section "Limpeza dos recursos temporários"
  run docker compose exec -T nestjs-api "${V03_TS[@]}" cleanup "$RUN_ID"
  prefix_rc=$?
  STATUS+=("Limpeza do prefixo temporário: código $prefix_rc")
  docker compose exec -T nestjs-api rm -rf "$CONTAINER_WORK"
  present=$(docker compose exec -T nestjs-api sh -c "[ -e '$CONTAINER_WORK' ] && echo sim || echo não")
  log "pasta temporária no container presente: ${present:-sem resposta}"
  [ "$present" = não ] || dirs_rc=1
  rm -rf "$WORK"
  if [ -e "$WORK" ]; then
    log "pasta temporária no host presente: sim"
    dirs_rc=1
  else
    log "pasta temporária no host presente: não"
  fi
  STATUS+=("Limpeza das pastas temporárias: código $dirs_rc")
  if [ "$prefix_rc" -ne 0 ]; then cleanup_rc=$prefix_rc; else cleanup_rc=$dirs_rc; fi
  step "Bucket principal depois (só leitura)" docker compose exec -T nestjs-api "${V03_TS[@]}" snapshot
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

# A variável é uma lista separada por vírgula; a primeira origem é a do frontend.
ORIGINS=$(grep '^MINIO_API_CORS_ALLOW_ORIGIN=' .env | cut -d= -f2-)
ORIGIN=${ORIGINS%%,*}

# Faz uma requisição com curl e imprime uma linha TSV "result"; cabeçalhos (e corpo de erro) vão
# para o stderr. Roda igual no host e no container.
# shellcheck disable=SC2016
CURL_SNIPPET='
id=$1; method=$2; url=$3; body=$4; origin=$5
tmp=$(mktemp -d)
if [ -n "$body" ]; then
  status=$(curl -sS --noproxy "*" -o "$tmp/out" -D "$tmp/hdr" -w "%{http_code}" -X "$method" -H "Origin: $origin" -T "$body" "$url")
else
  status=$(curl -sS --noproxy "*" -o "$tmp/out" -D "$tmp/hdr" -w "%{http_code}" -X "$method" -H "Origin: $origin" "$url")
fi
h() { grep -i "^$1:" "$tmp/hdr" | tail -n 1 | cut -d: -f2- | tr -d "\r\"" | sed "s/^ *//"; }
code=$(sed -n "s:.*<Code>\([^<]*\)</Code>.*:\1:p" "$tmp/out" | head -n 1)
message=$(sed -n "s:.*<Message>\([^<]*\)</Message>.*:\1:p" "$tmp/out" | head -n 1)
sha=$(sha256sum "$tmp/out" | cut -d" " -f1)
printf "result\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$id" "$status" "$(h etag)" "$(h access-control-allow-origin)" "$(h access-control-expose-headers)" "$sha" "$code" "$message"
{
  echo "--- $id: $method $(echo "$url" | cut -d"?" -f1)"
  tr -d "\r" <"$tmp/hdr"
  if [ "$status" -ge 300 ]; then cat "$tmp/out"; echo; fi
} >&2
rm -rf "$tmp"
'
curl_host() { sh -c "$CURL_SNIPPET" sh "$@"; }
curl_container() { docker compose exec -T nestjs-api sh -c "$CURL_SNIPPET" sh "$@"; }
url_of() { awk -F '\t' -v id="$1" '$1 == "url" && $2 == id { print $4 }' "$WORK/urls.tsv"; }
# request <host|container> <id do resultado> <método> <id da URL> [corpo]
request() {
  local where=$1 id=$2 method=$3 url_id=$4 body=${5:-}
  log "> $where: $method $url_id ($id)"
  "curl_$where" "$id" "$method" "$(url_of "$url_id")" "$body" "$ORIGIN" 2>>"$LOG" | tee -a "$WORK/results.tsv" "$LOG"
}

section "V-03 — runId $RUN_ID"
log "prefixo temporário: proofs/v03-$RUN_ID/; origem enviada no header Origin: $ORIGIN; validade das URLs: ${EXPIRES_IN}s"
step "Estado do ambiente" docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'
step "Versões" sh -c "docker image inspect --format '{{.Id}} {{json .RepoDigests}}' \"\$(docker compose config --images | grep '^pgsty/silo')\" && \
  docker compose exec -T nestjs-api node -v && \
  docker compose exec -T nestjs-api node -p \"['@aws-sdk/client-s3','@aws-sdk/s3-request-presigner','@smithy/signature-v4','@aws-sdk/checksums'].map(p => p + ' ' + require(p + '/package.json').version).join(', ')\" && \
  curl --version | head -n 1 && docker compose exec -T nestjs-api curl --version | head -n 1"
step "Bucket principal antes (só leitura)" docker compose exec -T nestjs-api "${V03_TS[@]}" snapshot

section "Geração das URLs (credencial da aplicação)"
docker compose exec -T nestjs-api "${V03_TS[@]}" presign "$RUN_ID" >"$WORK/urls.tsv" 2>>"$LOG"
tee -a "$LOG" <"$WORK/urls.tsv"
GENERATED_AT_MS=$(awk -F '\t' '$1 == "meta" && $2 == "generatedAt" { print $3 }' "$WORK/urls.tsv")

section "Corpos enviados"
head -c "$BODY_BYTES" /dev/urandom >"$WORK/body.bin"
docker compose exec -T nestjs-api sh -c "mkdir -p '$CONTAINER_WORK' && head -c $BODY_BYTES /dev/urandom >'$CONTAINER_WORK/body.bin'"
{
  printf 'body\tpublic\t%s\t%s\n' "$(sha256sum "$WORK/body.bin" | cut -d' ' -f1)" "$(stat -c %s "$WORK/body.bin")"
  printf 'body\tinternal\t%s\t%s\n' \
    "$(docker compose exec -T nestjs-api sha256sum "$CONTAINER_WORK/body.bin" | cut -d' ' -f1)" \
    "$(docker compose exec -T nestjs-api stat -c %s "$CONTAINER_WORK/body.bin")"
  printf 'origin\t%s\n' "$ORIGIN"
} | tee -a "$LOG" >"$WORK/bodies.tsv"

section "Requisições com curl"
: >"$WORK/results.tsv"
request host public-put PUT public-put "$WORK/body.bin"
request host public-part PUT public-part "$WORK/body.bin"
request host public-get GET public-get
request container internal-put PUT internal-put "$CONTAINER_WORK/body.bin"
request container internal-part PUT internal-part "$CONTAINER_WORK/body.bin"
request container internal-get GET internal-get
request host control-put PUT control-put "$WORK/body.bin"

section "URL expirada"
NOW_MS=$(($(date +%s%N) / 1000000))
WAIT_S=$(((GENERATED_AT_MS + EXPIRES_IN * 1000 - NOW_MS) / 1000 + 3))
if [ "$WAIT_S" -gt 0 ]; then
  log "aguardando ${WAIT_S}s até a URL de GET vencer"
  sleep "$WAIT_S"
fi
request host public-get-expired GET public-get

step "Conferência (query, respostas e estado do storage)" sh -c \
  "cat '$WORK/urls.tsv' '$WORK/bodies.tsv' '$WORK/results.tsv' | docker compose exec -T nestjs-api ${V03_TS[*]} verify '$RUN_ID'"
