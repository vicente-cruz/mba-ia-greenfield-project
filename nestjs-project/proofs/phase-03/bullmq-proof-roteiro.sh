#!/usr/bin/env bash
# Roteiro das provas da SI-03.7 contra o Redis real do Compose:
#   v06 — spec do Jest 30 em CommonJS com Nest, @nestjs/bullmq e BullMQ (proofs/phase-03/v06/,
#         phase-03-videos/TD-09);
#   v11 — comportamento do BullMQ 6.7.7 (v11-bullmq-behavior.ts; TD-10, TD-12 e AMB-6): núcleo
#         (grupos 1 e 2) e manutenção (grupo 3), com `docker compose stop redis` e `start` no
#         meio da manutenção.
#
# Roda no host, a partir de nestjs-project/; os scripts rodam dentro do container `nestjs-api`.
# Cada prova usa um prefixo exclusivo no Redis (`proofs-v06-<pid>` ou `proofs-v11-<runId>`),
# apagado no final, inclusive em caso de erro. O Redis é comparado antes e depois (chaves e
# tipos, política de memória e clientes conectados), e o serviço `redis` sempre volta a ficar
# saudável. Na V-11, depois de uma limpeza bem-sucedida, um `SAVE` regrava o dump.rdb com o
# conjunto de dados já restaurado: o `stop` da manutenção grava um dump que ainda tem as chaves
# da prova.
#
# Uso: proofs/phase-03/bullmq-proof-roteiro.sh <v06|v11> [diretório de saída]
# Pré-requisito: `docker compose up -d` com `redis` saudável e `nestjs-api` no ar.
# Código de saída: 0 só quando todas as etapas e a limpeza passam. Se o roteiro for interrompido
# ou uma etapa falhar, sai com o código dessa falha original, mesmo que a limpeza passe; se só a
# limpeza falhar, sai com o código dela. A limpeza roda sempre, inclusive depois de erro.
set -euo pipefail

PROOF=${1:-}
case "$PROOF" in
  v06 | v11) ;;
  *)
    echo "uso: $0 <v06|v11> [diretório de saída]" >&2
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
TS=(npx ts-node proofs/phase-03/v11-bullmq-behavior.ts)
if [ "$PROOF" = v06 ]; then
  PREFIX=proofs-v06-
else
  PREFIX=proofs-v11-$RUN_ID
fi
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

redis_health() { docker compose ps --format '{{.Health}}' redis 2>/dev/null || true; }
wait_redis_healthy() {
  local limit=$1 waited=0
  until [ "$(redis_health)" = healthy ]; do
    if [ "$waited" -ge "$limit" ]; then
      echo "redis não ficou saudável em ${limit} s (estado: $(redis_health))"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "redis saudável depois de ${waited} s"
}
# Garante o serviço `redis` no ar e saudável (restaura um `stop` interrompido pelo meio).
ensure_redis_running() {
  if [ "$(redis_health)" = healthy ]; then
    echo "redis já estava saudável"
    return 0
  fi
  echo "redis fora do ar ou não saudável ($(redis_health)); executando docker compose start redis"
  docker compose start redis
  wait_redis_healthy 60
}

snapshot_into() {
  local rc=0
  docker compose exec -T nestjs-api "${TS[@]}" snapshot >"$1" || rc=$?
  cat "$1"
  return "$rc"
}
# Política de memória e clientes conectados (o próprio redis-cli conta como 1).
redis_info_into() {
  docker compose exec -T redis sh -c \
    'printf "maxmemory-policy=%s %s\n" "$(redis-cli CONFIG GET maxmemory-policy | tail -n 1)" "$(redis-cli INFO clients | grep ^connected_clients | tr -d "\r")"' \
    >"$1"
  cat "$1"
  docker compose exec -T redis sh -c 'ls -l /data/dump.rdb; redis-cli INFO persistence | grep -E "^(rdb_changes_since_last_save|rdb_last_bgsave_status)" | tr -d "\r"'
}
compare_snapshots() {
  local ok=0
  for kind in snapshot info; do
    if [ -s "$WORK/$kind-before.txt" ] && cmp -s "$WORK/$kind-before.txt" "$WORK/$kind-after.txt"; then
      echo "$kind igual: $(cat "$WORK/$kind-after.txt")"
    else
      echo "$kind diferente ou ausente"
      diff "$WORK/$kind-before.txt" "$WORK/$kind-after.txt" || true
      ok=1
    fi
  done
  return "$ok"
}

# Manutenção da V-11: roda o subcomando em segundo plano, espera o marcador, para e religa o
# Redis e espera o fim do subcomando, propagando o código dele.
maintenance_with_outage() {
  local mlog=$WORK/maintenance.log rc=0 pid waited=0 shown
  : >"$mlog"
  docker compose exec -T nestjs-api "${TS[@]}" maintenance "$RUN_ID" >"$mlog" 2>&1 &
  pid=$!
  echo "$pid" >"$WORK/maintenance.pid"
  until grep -q '^V11_AGUARDANDO_PARADA_DO_REDIS' "$mlog"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" || rc=$?
      cat "$mlog"
      echo "a manutenção terminou antes do marcador (código $rc); o Redis não foi parado"
      [ "$rc" -ne 0 ] || rc=1
      return "$rc"
    fi
    if [ "$waited" -ge 240 ]; then
      cat "$mlog"
      echo "marcador não apareceu em 240 s; o Redis não foi parado"
      kill "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  shown=$(wc -l <"$mlog")
  head -n "$shown" "$mlog"
  echo "\$ docker compose stop redis ($(date -u +%H:%M:%S.%3NZ))"
  docker compose stop redis
  echo "redis parado ($(date -u +%H:%M:%S.%3NZ)); estado: $(docker compose ps -a --format '{{.State}}' redis)"
  sleep 5
  echo "\$ docker compose start redis ($(date -u +%H:%M:%S.%3NZ))"
  docker compose start redis
  wait_redis_healthy 60 || rc=$?
  echo "redis de volta ($(date -u +%H:%M:%S.%3NZ))"
  local script_rc=0
  wait "$pid" || script_rc=$?
  tail -n +"$((shown + 1))" "$mlog"
  rm -f "$WORK/maintenance.pid"
  echo "código da manutenção: $script_rc; código do retorno do Redis: $rc"
  [ "$script_rc" -eq 0 ] || return "$script_rc"
  return "$rc"
}

# Sempre roda no fim (trap EXIT), inclusive depois de erro. Tenta todos os passos da limpeza,
# confere o resultado e define o código final: a falha original (interrupção do roteiro ou
# primeira etapa com falha) prevalece; sem ela, uma falha da limpeza também dá código diferente de zero.
cleanup() {
  local rc=$? cleanup_rc=0 step_rc=0 final
  set +e
  section "Limpeza e restauração"
  if [ -s "$WORK/maintenance.pid" ]; then
    kill "$(cat "$WORK/maintenance.pid")" 2>/dev/null
  fi
  run ensure_redis_running
  step_rc=$?
  STATUS+=("Redis no ar e saudável: código $step_rc")
  cleanup_rc=$step_rc
  run docker compose exec -T nestjs-api "${TS[@]}" cleanup "$PREFIX"
  step_rc=$?
  STATUS+=("Limpeza do prefixo $PREFIX e dos processos da prova: código $step_rc")
  [ "$cleanup_rc" -ne 0 ] || cleanup_rc=$step_rc
  if [ "$PROOF" = v11 ] && [ "$step_rc" -eq 0 ]; then
    run docker compose exec -T redis redis-cli SAVE
    step_rc=$?
    STATUS+=("SAVE do conjunto restaurado: código $step_rc")
    [ "$cleanup_rc" -ne 0 ] || cleanup_rc=$step_rc
  fi
  step "Redis depois (só leitura)" snapshot_into "$WORK/snapshot-after.txt"
  step "Serviço redis depois" redis_info_into "$WORK/info-after.txt"
  step "Redis preservado (antes = depois)" compare_snapshots
  step "Estado do ambiente depois" docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'
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
log "prefixo no Redis: $PREFIX"
step "Estado do ambiente" docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'
step "Versões" sh -c "docker image inspect --format '{{.Id}} {{json .RepoDigests}}' \"\$(docker compose config --images | grep '^redis:')\" && \
  docker compose exec -T redis redis-server --version && \
  docker compose exec -T nestjs-api node -v && \
  docker compose exec -T nestjs-api node -p \"['bullmq','@nestjs/bullmq','ioredis','@nestjs/core','@nestjs/testing','jest','ts-jest','typescript'].map(p => p + ' ' + require(p + '/package.json').version).join(', ')\""
step "Redis antes (só leitura)" snapshot_into "$WORK/snapshot-before.txt"
step "Serviço redis antes" redis_info_into "$WORK/info-before.txt"

if [ "$PROOF" = v06 ]; then
  step "Sistema de módulos (CommonJS)" docker compose exec -T nestjs-api node -p \
    "['bullmq','@nestjs/bullmq','ioredis'].map(p => p + ': ' + require.resolve(p) + ' (type ' + (require(p + '/package.json').type ?? 'ausente = commonjs') + ')').join('\n') + '\nprojeto: type ' + (require('./package.json').type ?? 'ausente = commonjs') + '; NODE_OPTIONS=' + (process.env.NODE_OPTIONS ?? '')"
  step "V-06 — spec do Jest 30 em CommonJS contra o Redis real" timeout 300 \
    docker compose exec -T nestjs-api npx jest --rootDir . --roots '<rootDir>/proofs/phase-03/v06' \
    --runInBand --verbose --detectOpenHandles
else
  step "V-11 — núcleo (grupos 1 e 2)" timeout 900 \
    docker compose exec -T nestjs-api "${TS[@]}" core "$RUN_ID"
  step "V-11 — manutenção (grupo 3), com docker compose stop/start redis" maintenance_with_outage
fi
