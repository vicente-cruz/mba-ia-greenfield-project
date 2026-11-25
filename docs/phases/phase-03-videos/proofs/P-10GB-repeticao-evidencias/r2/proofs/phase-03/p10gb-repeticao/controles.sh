#!/usr/bin/env bash
# Controles da revisão r2 do registro prévio da repetição da P-10GB (R-02), sem upload.
#
# Uso (no host, a partir de nestjs-project/):
#   proofs/phase-03/p10gb-repeticao/controles.sh veredito <saída>
#       casos sintéticos do latency-verdict com a incerteza do relógio (controles-veredito.py): intervalo
#       menor que a incerteza, amostra lenta na borda, contagem perto de 300, reprovação robusta,
#       incerteza zero e base dentro da incerteza.
#   proofs/phase-03/p10gb-repeticao/controles.sh reprocessa <pasta de uma pré-checagem> <saída>
#       conversão nominal dos eventos do cliente e veredito com a incerteza registrada à parte, sobre as
#       evidências arquivadas. Não altera a pasta de origem.
#   proofs/phase-03/p10gb-repeticao/controles.sh falhas <saída> [roteiro] [modos]
#       roda o roteiro com uma falha injetada por vez (modos: build, tsc, copia-container,
#       copia-windows; padrão: todos) por shims de docker e cp no PATH. Um shim de node.exe é a
#       sentinela: se a geração do arquivo de prova for alcançada, ele a bloqueia (código 99) e o
#       controle reprova. Usa P10GB_SIZE_BYTES=1000000. O controle passa quando o roteiro sai com
#       código diferente de zero, a etapa do build registra a falha, a etapa de geração não começa e
#       a limpeza deixa os retratos iguais.
# Recursos: só /tmp/p10gbr-controles no nestjs-api (removido no final) e os do próprio roteiro, que
# ele mesmo remove. Nenhum arquivo de prova é gerado.
set -euo pipefail

HELP=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$HELP/../../.." && pwd)
cd "$PROJECT_DIR"
SUPPORT=proofs/phase-03/upload-proof-support.ts

api() { docker compose exec -T nestjs-api "$@"; }
container_tmp_reset() {
  api rm -rf /tmp/p10gbr-controles
  api mkdir -p /tmp/p10gbr-controles
}
container_tmp_remove() { api rm -rf /tmp/p10gbr-controles; }

veredito() {
  local out=$1 dir name bs be u rc failures=0
  mkdir -p "$out"
  python3 -I "$HELP/controles-veredito.py" gerar "$out"
  container_tmp_reset
  for dir in "$out"/*/; do
    name=$(basename "$dir")
    docker compose cp "$dir" "nestjs-api:/tmp/p10gbr-controles/$name" >/dev/null 2>&1
    read -r bs be u < <(python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1])); print(c["baselineStart"], c["baselineEnd"], c["uncertaintyMs"])' "$dir/caso.json")
    rc=0
    api npx ts-node "$SUPPORT" latency-verdict --events "/tmp/p10gbr-controles/$name/events.jsonl" \
      --probe "/tmp/p10gbr-controles/$name/probe.csv" --baseline-start "$bs" --baseline-end "$be" \
      --clock-uncertainty-ms "$u" --out "/tmp/p10gbr-controles/$name/verdict.json" >"$dir/veredito.txt" 2>&1 || rc=$?
    echo "$rc" >"$dir/codigo.txt"
    if api test -e "/tmp/p10gbr-controles/$name/verdict.json"; then
      api cat "/tmp/p10gbr-controles/$name/verdict.json" >"$dir/verdict.json"
    fi
  done
  container_tmp_remove
  python3 -I "$HELP/controles-veredito.py" conferir "$out" || failures=$?
  return "$failures"
}

reprocessa() {
  local evid=$1 out=$2 log bs be o u f rc=0 args=()
  mkdir -p "$out"
  log=$(ls "$evid"/p10gbr-*.log | head -1)
  bs=$(grep -oP 'base: início em \K[0-9]+' "$log")
  be=$(grep -oP 'base: fim em \K[0-9]+' "$log")
  read -r o u < <(python3 -I - "$evid/relogio-antes.json" "$evid/relogio-depois.json" <<'PY'
import json,sys,math
a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2]))
o=(a['offsetMs']+b['offsetMs'])/2
u=max(a['uncertaintyMs'],b['uncertaintyMs'])+abs(a['offsetMs']-b['offsetMs'])/2
print(round(o), math.ceil(u))
PY
  )
  [ -n "$bs" ] && [ -n "$be" ] && [ -n "$o" ] && [ -n "$u" ] || { echo "FALHA | base ou relógio ausente nas evidências"; return 1; }
  printf '{"offsetMs": %s, "uncertaintyMs": %s, "baselineStart": %s, "baselineEnd": %s}\n' "$o" "$u" "$bs" "$be" >"$out/relogio.json"
  echo "REPROCESSAMENTO | $(basename "$log") | base de $bs a $be | conversão nominal + $o ms | incerteza à parte ± $u ms"
  python3 -I "$HELP/eventos-relogio-vm.py" "$evid/client-events.jsonl" "$out/events-vm.jsonl" "$o" | tee "$out/eventos-relogio.txt"
  container_tmp_reset
  docker compose cp "$out/events-vm.jsonl" nestjs-api:/tmp/p10gbr-controles/events.jsonl >/dev/null 2>&1
  for f in "$evid"/probe-*.csv; do
    docker compose cp "$f" "nestjs-api:/tmp/p10gbr-controles/$(basename "$f")" >/dev/null 2>&1
    args+=(--probe "/tmp/p10gbr-controles/$(basename "$f")")
  done
  api npx ts-node "$SUPPORT" latency-verdict --events /tmp/p10gbr-controles/events.jsonl "${args[@]}" \
    --baseline-start "$bs" --baseline-end "$be" --clock-uncertainty-ms "$u" \
    --out /tmp/p10gbr-controles/latency-verdict.json 2>&1 | tee "$out/latency-verdict.txt" || rc=$?
  api cat /tmp/p10gbr-controles/latency-verdict.json >"$out/latency-verdict.json" || true
  container_tmp_remove
  echo "código do latency-verdict: $rc (1 = não aprovado)"
  return 0
}

write_shims() {
  local dir=$1 real_docker real_cp real_node
  real_docker=$(command -v docker)
  real_cp=$(command -v cp)
  real_node=$(command -v node.exe)
  mkdir -p "$dir"
  cat >"$dir/docker" <<EOF
#!/usr/bin/env bash
# Shim de controle: falha só o comando escolhido em P10GB_CONTROLE_FALHA; o resto vai ao docker real.
case "\${P10GB_CONTROLE_FALHA:-}:\$*" in
  build:*"exec -T nestjs-api npm run build"*) echo "CONTROLE | falha injetada: npm run build" >&2; exit 2 ;;
  tsc:*"exec -T nestjs-api npx tsc --outDir"*) echo "CONTROLE | falha injetada: tsc do cliente e da sonda" >&2; exit 2 ;;
  copia-container:*"exec -T nestjs-api cat /tmp/p10gbr-"*"/js/upload-client.js") echo "CONTROLE | falha injetada: cópia do JS do container" >&2; exit 2 ;;
esac
exec "$real_docker" "\$@"
EOF
  cat >"$dir/cp" <<EOF
#!/usr/bin/env bash
case "\${P10GB_CONTROLE_FALHA:-}:\$*" in
  copia-windows:*"/js/upload-client.js") echo "CONTROLE | falha injetada: cópia do JS para o Windows" >&2; exit 2 ;;
esac
exec "$real_cp" "\$@"
EOF
  cat >"$dir/node.exe" <<EOF
#!/usr/bin/env bash
# Sentinela: a geração do arquivo de prova nunca roda num controle de falha.
case " \$* " in
  *" generate "*)
    echo "CONTROLE | SENTINELA: a geração do arquivo de prova foi alcançada e bloqueada" >&2
    echo alcancada >"\${P10GB_CONTROLE_SENTINELA:?}"
    exit 99 ;;
esac
exec "$real_node" "\$@"
EOF
  chmod +x "$dir/docker" "$dir/cp" "$dir/node.exe"
}

falhas() {
  local out=$1 roteiro=${2:-proofs/phase-03/p10gb-repeticao-roteiro.sh} modos=${3:-build tsc copia-container copia-windows}
  local modo rc log build_line reached sentinel equal failures=0
  mkdir -p "$out"
  write_shims "$out/shim"
  for modo in $modos; do
    rc=0
    rm -f "$out/$modo.sentinela"
    PATH="$out/shim:$PATH" P10GB_CONTROLE_FALHA=$modo P10GB_CONTROLE_SENTINELA="$out/$modo.sentinela" \
      P10GB_SIZE_BYTES=1000000 P10GB_ROTULO="controle-$modo" "$roteiro" "$out/$modo" >"$out/$modo.stdout" 2>&1 || rc=$?
    log=$(ls "$out/$modo"/p10gbr-*.log | head -1)
    build_line=$(grep -E '^- Build da API e JS do cliente e da sonda: código' "$log" || echo "etapa do build sem registro")
    reached=$(grep -c '^=== Arquivo de prova no Windows' "$log" || true)
    sentinel=$([ -e "$out/$modo.sentinela" ] && echo sim || echo não)
    equal=$(grep -c '^retratos iguais' "$log" || true)
    if [ "$rc" -ne 0 ] && ! grep -q 'código 0$' <<<"$build_line" && [ "$reached" -eq 0 ] && [ "$sentinel" = não ] && [ "$equal" -eq 1 ]; then
      echo "CONTROLE | $modo | roteiro saiu com $rc | ${build_line#- } | geração iniciada: não | sentinela: $sentinel | retratos iguais | passou"
    else
      failures=$((failures + 1))
      echo "CONTROLE | $modo | roteiro saiu com $rc | ${build_line#- } | geração iniciada: $([ "$reached" -eq 0 ] && echo não || echo sim) | sentinela: $sentinel | retratos iguais: $equal | NÃO PASSOU"
    fi
    grep -E '^FALHA \||^CONTROLE \|' "$log" "$out/$modo.stdout" 2>/dev/null | sed 's/^[^:]*://' | sort -u | sed 's/^/  /'
  done
  return "$failures"
}

case "${1:-}" in
  veredito) veredito "${2:?saída}" ;;
  reprocessa) reprocessa "${2:?pasta da pré-checagem}" "${3:?saída}" ;;
  falhas) falhas "${2:?saída}" "${3:-}" "${4:-}" ;;
  *) echo "uso: $0 veredito <saída> | reprocessa <pré-checagem> <saída> | falhas <saída> [roteiro] [modos]" >&2; exit 64 ;;
esac
