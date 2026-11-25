#!/usr/bin/env bash
# V-01 — roteiro da prova de configuração do Silo (phase-03-videos/TD-02, TD-07, TD-08).
#
# Roda no host. Os comandos Node rodam dentro do container `nestjs-api` (script
# `v01-storage-config.ts`), e o `mc` roda na imagem `pgsty/mc` fixada no Compose.
#
# Instância principal (serviço `storage`): só leitura. Configuração por `mc admin config get`,
# CORS por preflight e GET assinado de chave inexistente, e retrato do bucket antes e depois.
# Instância isolada (`v01-silo-<runId>`): mesma imagem e mesmas variáveis `MINIO_*`, com
# expiração de multipart curta, volume temporário e credencial gerada na hora. É removida no
# final, inclusive em caso de erro.
#
# Uso: proofs/phase-03/v01-roteiro.sh [diretório de saída]
# Opcionais: V01_EXPIRY_SECONDS (padrão 60) e V01_INTERVAL_SECONDS (padrão 10).
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
LOG=$OUT_DIR/v01-$RUN_ID.log
EXPIRY=${V01_EXPIRY_SECONDS:-60}
INTERVAL=${V01_INTERVAL_SECONDS:-10}
ISO_NAME=v01-silo-$RUN_ID
ISO_BUCKET=v01-proof
ISO_USER=v01admin
SECRETS_DIR=$(mktemp -d)
chmod 700 "$SECRETS_DIR"
STATUS=()
# Código da primeira etapa obrigatória que falhou (0 enquanto nenhuma falhou).
FIRST_FAILURE=0

log() { printf '%s\n' "$*" | tee -a "$LOG"; }
section() { log ""; log "=== $* ($(date -u +%H:%M:%SZ))"; }
# Registra o comando (sem valores secretos: as credenciais vão por arquivo ou por nome de variável).
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

# Confere se um recurso do Docker ainda existe. Saída: 0 ausente, 1 presente, 2 sem como conferir.
docker_leftover() {
  local kind=$1 name=$2 names
  if [ "$kind" = container ]; then
    names=$(docker ps -a --format '{{.Names}}') || return 2
  else
    names=$(docker volume ls --format '{{.Name}}') || return 2
  fi
  if grep -Fxq -- "$name" <<<"$names"; then return 1; fi
  return 0
}

# Sempre roda no fim (trap EXIT), inclusive depois de erro. Tenta todos os passos da limpeza,
# confere o resultado e define o código final: a falha original (interrupção do roteiro ou
# primeira etapa com falha) prevalece; sem ela, uma falha da limpeza também dá código diferente de zero.
cleanup() {
  local rc=$? cleanup_rc=0 check=0 final kind
  set +e
  section "Limpeza dos recursos temporários"
  docker rm -f "$ISO_NAME" >/dev/null 2>&1 && log "container $ISO_NAME removido"
  docker volume rm "$ISO_NAME" >/dev/null 2>&1 && log "volume $ISO_NAME removido"
  rm -rf "$SECRETS_DIR"
  for kind in container volume; do
    docker_leftover "$kind" "$ISO_NAME"
    check=$?
    case $check in
      0) log "$kind $ISO_NAME: ausente" ;;
      1) log "$kind $ISO_NAME: ainda existe"; cleanup_rc=1 ;;
      *) log "$kind $ISO_NAME: não foi possível conferir"; cleanup_rc=1 ;;
    esac
  done
  if [ -e "$SECRETS_DIR" ]; then
    log "arquivos de credencial temporários: ainda presentes"
    cleanup_rc=1
  else
    log "arquivos de credencial temporários: removidos"
  fi
  STATUS+=("Limpeza dos recursos temporários: código $cleanup_rc")
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

SILO_IMAGE=$(docker compose config --images | grep '^pgsty/silo')
MC_IMAGE=$(docker compose config --images | grep '^pgsty/mc')
NETWORK=$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' \
  "$(docker compose ps -q storage)" | awk '{print $1}')
# Lista de origens do CORS (a mesma da instância principal) e a primeira delas, a do frontend,
# usada nas verificações.
ALLOWED_ORIGINS=$(grep '^MINIO_API_CORS_ALLOW_ORIGIN=' .env | cut -d= -f2-)
ALLOWED_ORIGIN=${ALLOWED_ORIGINS%%,*}

V01_TS=(npx ts-node proofs/phase-03/v01-storage-config.ts)

# mc na instância principal, pelo serviço de execução única `storage-init` (credencial de root do `.env`).
mc_main() {
  docker compose run --rm --no-deps -T --entrypoint sh storage-init -c \
    "mc alias set storage http://storage:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null && $1"
}
# mc na instância isolada, com a credencial temporária passada por arquivo.
mc_iso() {
  docker run --rm --network "$NETWORK" --env-file "$SECRETS_DIR/mc.env" --entrypoint sh "$MC_IMAGE" -c "$1"
}

section "V-01 — runId $RUN_ID"
log "expiração de prova ${EXPIRY}s; intervalo de limpeza ${INTERVAL}s; origem permitida $ALLOWED_ORIGIN"
log "imagem do storage: $SILO_IMAGE"
log "imagem do mc: $MC_IMAGE"
log "rede do Compose: $NETWORK"

step "Estado do ambiente" docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'
step "Versões" sh -c "docker image inspect --format '{{.Id}} {{json .RepoDigests}}' '$SILO_IMAGE' '$MC_IMAGE' && \
  docker compose exec -T nestjs-api node -v && \
  docker compose exec -T nestjs-api node -p \"['@aws-sdk/client-s3','@aws-sdk/s3-request-presigner'].map(p => p + ' ' + require(p + '/package.json').version).join(', ')\""
step "Bucket principal antes (só leitura)" docker compose exec -T nestjs-api "${V01_TS[@]}" snapshot

step "Principal: mc e variáveis MINIO_* (só leitura)" mc_main \
  'mc --version && mc admin info storage && mc admin config get storage api'
step "Principal: CORS (só leitura)" docker compose exec -T nestjs-api "${V01_TS[@]}" cors-main "$RUN_ID"

section "Instância isolada: criação"
ISO_PASS=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
{
  printf 'MINIO_ROOT_USER=%s\n' "$ISO_USER"
  printf 'MINIO_ROOT_PASSWORD=%s\n' "$ISO_PASS"
  printf 'MINIO_API_CORS_ALLOW_ORIGIN=%s\n' "$ALLOWED_ORIGINS"
  printf 'MINIO_API_STALE_UPLOADS_EXPIRY=%ss\n' "$EXPIRY"
  printf 'MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL=%ss\n' "$INTERVAL"
} >"$SECRETS_DIR/silo.env"
printf 'MC_HOST_iso=http://%s:%s@%s:9000\n' "$ISO_USER" "$ISO_PASS" "$ISO_NAME" >"$SECRETS_DIR/mc.env"
log "variáveis da instância isolada (senha omitida): MINIO_ROOT_USER=$ISO_USER, MINIO_API_CORS_ALLOW_ORIGIN=$ALLOWED_ORIGINS, MINIO_API_STALE_UPLOADS_EXPIRY=${EXPIRY}s, MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL=${INTERVAL}s"
run docker volume create --label streamtube.proof=v01 "$ISO_NAME"
run docker run -d --name "$ISO_NAME" --label streamtube.proof=v01 --network "$NETWORK" \
  --env-file "$SECRETS_DIR/silo.env" -v "$ISO_NAME:/data" "$SILO_IMAGE" server /data
ready=no
for _ in $(seq 1 60); do
  if docker exec "$ISO_NAME" curl -fsS http://localhost:9000/minio/health/ready >/dev/null 2>&1; then
    ready=yes
    break
  fi
  sleep 1
done
log "instância isolada pronta: $ready"
[ "$ready" = yes ] || exit 1
step "Isolada: log de inicialização" docker logs "$ISO_NAME"

step "Isolada: mc e variáveis MINIO_*" mc_iso "mc --version && mc admin info iso && mc admin config get iso api && \
  mc mb iso/$ISO_BUCKET && echo 'v01 mc $RUN_ID' >/tmp/mc-check.txt && \
  mc cp /tmp/mc-check.txt iso/$ISO_BUCKET/mc-check.txt && mc stat iso/$ISO_BUCKET/mc-check.txt && \
  mc cat iso/$ISO_BUCKET/mc-check.txt && mc ls iso/$ISO_BUCKET && mc rm iso/$ISO_BUCKET/mc-check.txt && \
  mc ls iso/$ISO_BUCKET"

export V01_ISO_ENDPOINT=http://$ISO_NAME:9000 V01_ISO_ACCESS_KEY=$ISO_USER V01_ISO_SECRET_KEY=$ISO_PASS \
  V01_ISO_BUCKET=$ISO_BUCKET V01_ALLOWED_ORIGIN=$ALLOWED_ORIGIN \
  V01_EXPIRY_SECONDS=$EXPIRY V01_INTERVAL_SECONDS=$INTERVAL
ISO_ENV=(-e V01_ISO_ENDPOINT -e V01_ISO_ACCESS_KEY -e V01_ISO_SECRET_KEY -e V01_ISO_BUCKET
  -e V01_ALLOWED_ORIGIN -e V01_EXPIRY_SECONDS -e V01_INTERVAL_SECONDS)
step "Isolada: CORS" docker compose exec -T "${ISO_ENV[@]}" nestjs-api "${V01_TS[@]}" cors-iso "$RUN_ID"
step "Isolada: idade do multipart incompleto" docker compose exec -T "${ISO_ENV[@]}" nestjs-api \
  "${V01_TS[@]}" stale "$RUN_ID"
step "Isolada: erros e avisos no log do servidor" sh -c \
  "docker logs '$ISO_NAME' 2>&1 | grep -inE 'error|warn|fail|unknown|invalid' || echo 'nenhuma linha com error, warn, fail, unknown ou invalid'"

step "Bucket principal depois (só leitura)" docker compose exec -T nestjs-api "${V01_TS[@]}" snapshot
step "Principal: serviço e volume preservados" sh -c \
  "docker compose ps storage --format '{{.Service}} {{.State}} {{.Health}}' && docker volume ls -q --filter name=storage-data"
