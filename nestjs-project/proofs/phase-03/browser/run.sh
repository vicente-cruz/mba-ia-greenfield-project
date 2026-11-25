#!/bin/sh
# Roda dentro do serviço `proof-browser` (imagem oficial do Playwright), chamado por
# `browser-proof-roteiro.sh`. Instala o `playwright-core` do package-lock.json fora do diretório
# montado (que é somente leitura), gera o arquivo aleatório de 1 GiB da medição de SHA-256 (V-09)
# e executa o roteiro dos navegadores. Os temporários ficam em /tmp do container, que é removido
# ao final (`docker compose run --rm`); o trap os apaga antes, inclusive em caso de erro.
# Saída: a linha `RESULT <json>` no stdout; logs no stderr. Código de saída: o do roteiro Node.
set -eu

DEPS=/tmp/proof-deps
HASH_FILE=/tmp/v09-hash-input.bin
cleanup() {
  rm -rf "$DEPS" "$HASH_FILE"
}
trap cleanup EXIT

mkdir -p "$DEPS"
cp /proof/package.json /proof/package-lock.json "$DEPS/"
(cd "$DEPS" && npm ci --no-audit --no-fund --loglevel=error) >&2
head -c "$HASH_TOTAL_BYTES" /dev/urandom >"$HASH_FILE"
echo "arquivo da medição: $(stat -c %s "$HASH_FILE") bytes" >&2

PROOF_DEPS=$DEPS HASH_FILE=$HASH_FILE node /proof/run-browser.cjs
