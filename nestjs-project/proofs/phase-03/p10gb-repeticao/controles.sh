#!/usr/bin/env bash
# Controles das revisões r2 e r3 do registro prévio da repetição da P-10GB (R-02), sem upload.
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
#       roda o roteiro inteiro com uma falha injetada por vez (shims de docker e cp no PATH) e confere:
#       código de saída diferente de zero, a etapa com a falha registrada, a etapa seguinte não
#       iniciada e a limpeza completa (containers, pastas, API e retratos iguais). Modos (padrão: todos):
#         prepare-pasta, prepare-auxiliar-container, prepare-auxiliar-windows   (etapa "Pastas de prova")
#         build, tsc, copia-container, copia-windows                         (etapa do build, r2)
#         accounts-credenciais, accounts-control-id                          (etapa das contas, r3)
#         monitores-sonda-db                                                 (etapa dos monitores, r3)
#       Sentinelas: um shim de node.exe bloqueia a geração do arquivo de prova nos modos anteriores a
#       ela (código 99); nos demais, a geração é de P10GB_SIZE_BYTES=1000000 (1 MB). Um shim de
#       powershell.exe bloqueia qualquer início de upload (iniciar-windows.ps1 ou ctrl-c.ps1). Se uma
#       sentinela for acionada, o controle reprova.
#   proofs/phase-03/p10gb-repeticao/controles.sh funcoes <saída> <pré-checagem 4> <casos sintéticos>
#       carrega só as funções do roteiro (sem o fluxo principal) num ambiente isolado e confere, com
#       falhas injetadas, que as etapas auditadas na r3 retornam erro; e, sem falha, que o resumo e o
#       veredito do roteiro reproduzem o reprocessamento da pré-checagem 4.
# Recursos: /tmp/p10gbr-controles e /tmp/p10gbr-controles-funcoes no nestjs-api (removidos no final) e
# os do próprio roteiro, que ele mesmo remove. Nenhum arquivo de prova maior que 1 MB é gerado.
set -euo pipefail

HELP=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$HELP/../../.." && pwd)
cd "$PROJECT_DIR"
SUPPORT=proofs/phase-03/upload-proof-support.ts
ROTEIRO=proofs/phase-03/p10gb-repeticao-roteiro.sh

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

# Modos anteriores à geração do arquivo de prova: nestes, a geração aciona a sentinela.
PRE_GERACAO="prepare-pasta prepare-auxiliar-container prepare-auxiliar-windows build tsc copia-container copia-windows"

write_shims() {
  local dir=$1 real_docker real_cp real_node real_ps real_df
  real_docker=$(command -v docker)
  real_cp=$(command -v cp)
  real_node=$(command -v node.exe)
  real_ps=$(command -v powershell.exe)
  real_df=$(command -v df)
  mkdir -p "$dir"
  cat >"$dir/docker" <<EOF
#!/usr/bin/env bash
# Shim de controle: falha só o comando escolhido em P10GB_CONTROLE_FALHA; o resto vai ao docker real.
case "\${P10GB_CONTROLE_FALHA:-}:\$*" in
  build:*"exec -T nestjs-api npm run build"*) echo "CONTROLE | falha injetada: npm run build" >&2; exit 2 ;;
  tsc:*"exec -T nestjs-api npx tsc --outDir"*) echo "CONTROLE | falha injetada: tsc do cliente e da sonda" >&2; exit 2 ;;
  copia-container:*"exec -T nestjs-api cat /tmp/p10gbr-"*"/js/upload-client.js") echo "CONTROLE | falha injetada: cópia do JS do container" >&2; exit 2 ;;
  prepare-pasta:*"exec -T nestjs-api sh -c umask 077 && mkdir -p"*) echo "CONTROLE | falha injetada: criação da pasta no nestjs-api" >&2; exit 2 ;;
  prepare-auxiliar-container:*"exec -T nestjs-api sh -c cat > '/tmp/p10gbr-"*"/monitor-api.cjs'") echo "CONTROLE | falha injetada: cópia de monitor-api.cjs para o nestjs-api" >&2; exit 2 ;;
  accounts-credenciais:*"exec -T nestjs-api cat /tmp/p10gbr-"*"/uploader.json") echo "CONTROLE | falha injetada: cópia das credenciais" >&2; exit 2 ;;
  accounts-control-id:*"exec -T nestjs-api cat /tmp/p10gbr-"*"/control-state.json") echo "CONTROLE | falha injetada: leitura do estado do vídeo de controle" >&2; exit 2 ;;
  monitores-sonda-db:*"exec -T db sh -c cat > /tmp/p10gbr-"*".sonda-db.sh") echo "CONTROLE | falha injetada: cópia da sonda do banco" >&2; exit 2 ;;
  api-ps:*"exec -T nestjs-api ps -eo args") echo "CONTROLE | falha injetada: ps no nestjs-api" >&2; exit 2 ;;
  versoes:*"image inspect --format imagem do nestjs-api"*) echo "CONTROLE | falha injetada: imagem do nestjs-api" >&2; exit 2 ;;
  residuos:*"exec -T storage sh -c cd /data/.minio.sys/tmp"*) echo "CONTROLE | falha injetada: temporários do Silo" >&2; exit 2 ;;
  uso-storage:*"exec -T storage sh -c t="*) echo "CONTROLE | falha injetada: uso do storage" >&2; exit 2 ;;
  copia-eventos:*"exec -T nestjs-api sh -c cat > '/tmp/p10gbr-controles-funcoes/events.jsonl'") echo "CONTROLE | falha injetada: cópia dos eventos do cliente" >&2; exit 2 ;;
  copia-sonda:*"exec -T nestjs-api sh -c cat > '/tmp/p10gbr-controles-funcoes/probe-3.csv'") echo "CONTROLE | falha injetada: cópia da sonda 3" >&2; exit 2 ;;
  copia-veredito:*"exec -T nestjs-api cat /tmp/p10gbr-controles-funcoes/latency-verdict.json") echo "CONTROLE | falha injetada: cópia do veredito" >&2; exit 2 ;;
esac
exec "$real_docker" "\$@"
EOF
  cat >"$dir/cp" <<EOF
#!/usr/bin/env bash
case "\${P10GB_CONTROLE_FALHA:-}:\$*" in
  copia-windows:*"/js/upload-client.js") echo "CONTROLE | falha injetada: cópia do JS para o Windows" >&2; exit 2 ;;
  prepare-auxiliar-windows:*"vigia-interrupcao.cjs "*) echo "CONTROLE | falha injetada: cópia de vigia-interrupcao.cjs para o Windows" >&2; exit 2 ;;
esac
exec "$real_cp" "\$@"
EOF
  cat >"$dir/df" <<EOF
#!/usr/bin/env bash
case "\${P10GB_CONTROLE_FALHA:-}:\$*" in
  disco-host:*"--output=size,used,avail,target /mnt/c") echo "CONTROLE | falha injetada: df da unidade C:" >&2; exit 2 ;;
esac
exec "$real_df" "\$@"
EOF
  cat >"$dir/node.exe" <<EOF
#!/usr/bin/env bash
# Sentinela da geração: nos modos anteriores a ela, a geração nunca roda.
case " $PRE_GERACAO " in
  *" \${P10GB_CONTROLE_FALHA:-nenhum} "*)
    case " \$* " in
      *" generate "*)
        echo "CONTROLE | SENTINELA: a geração do arquivo de prova foi alcançada e bloqueada" >&2
        echo geracao >>"\${P10GB_CONTROLE_SENTINELA:?}"
        exit 99 ;;
    esac ;;
esac
case "\${P10GB_CONTROLE_FALHA:-}:\$*" in
  relogio:*"relogio.cjs"*) echo "CONTROLE | falha injetada: medida do relógio" >&2; exit 1 ;;
esac
exec "$real_node" "\$@"
EOF
  cat >"$dir/powershell.exe" <<EOF
#!/usr/bin/env bash
# Sentinela do upload: nenhum controle inicia o cliente de upload nem arma o Ctrl+C.
case " \$* " in
  *"iniciar-windows.ps1"* | *"ctrl-c.ps1"*)
    echo "CONTROLE | SENTINELA: o início do upload foi alcançado e bloqueado" >&2
    echo upload >>"\${P10GB_CONTROLE_SENTINELA:?}"
    exit 99 ;;
esac
exec "$real_ps" "\$@"
EOF
  chmod +x "$dir/docker" "$dir/cp" "$dir/df" "$dir/node.exe" "$dir/powershell.exe"
}

# Etapa que falha e etapa seguinte, por modo.
mode_step() {
  case "$1" in
    prepare-*) echo "Pastas de prova|Build da API e JS do cliente e da sonda" ;;
    build | tsc | copia-*) echo "Build da API e JS do cliente e da sonda|Arquivo de prova no Windows, preparado antes da medição" ;;
    accounts-*) echo "Contas de prova e vídeo de controle|Relógio antes da base" ;;
    monitores-*) echo "Monitores (VM, PostgreSQL, docker stats e Windows)|Sondas compiladas em containers próprios" ;;
    *) return 1 ;;
  esac
}

falhas() {
  local out=$1 roteiro=${2:-$ROTEIRO}
  local modos=${3:-prepare-pasta prepare-auxiliar-container prepare-auxiliar-windows build tsc copia-container copia-windows accounts-credenciais accounts-control-id monitores-sonda-db}
  local modo rc log step next step_line started sentinel checks ok failures=0 total=0
  mkdir -p "$out"
  write_shims "$out/shim"
  for modo in $modos; do
    total=$((total + 1))
    IFS='|' read -r step next < <(mode_step "$modo")
    rc=0
    rm -f "$out/$modo.sentinela"
    PATH="$out/shim:$PATH" P10GB_CONTROLE_FALHA=$modo P10GB_CONTROLE_SENTINELA="$out/$modo.sentinela" \
      P10GB_SIZE_BYTES=1000000 P10GB_ROTULO="controle-$modo" "$roteiro" "$out/$modo" >"$out/$modo.stdout" 2>&1 || rc=$?
    log=$(ls "$out/$modo"/p10gbr-*.log | head -1)
    step_line=$(grep -F -- "- $step: código" "$log" || echo "etapa \"$step\" sem registro")
    started=$(grep -cF "=== $next (" "$log" || true)
    sentinel=$([ -e "$out/$modo.sentinela" ] && tr '\n' ' ' <"$out/$modo.sentinela" || echo não)
    checks=(
      "roteiro com código diferente de zero:$([ "$rc" -ne 0 ] && echo sim || echo não)"
      "etapa com falha registrada:$(grep -q 'código 0$' <<<"$step_line" && echo não || echo sim)"
      "etapa seguinte não iniciada:$([ "$started" -eq 0 ] && echo sim || echo não)"
      "sentinelas não acionadas:$([ "$sentinel" = não ] && echo sim || echo não)"
      "containers removidos:$(grep -q '^containers de prova restantes: 0$' "$log" && echo sim || echo não)"
      "pasta no nestjs-api removida:$(grep -q '^diretório no nestjs-api presente: não$' "$log" && echo sim || echo não)"
      "pasta no Windows removida:$(grep -q '^pasta no Windows presente: não$' "$log" && echo sim || echo não)"
      "JS compilado removido:$(grep -q '^JS compilado presente: não$' "$log" && echo sim || echo não)"
      "API parada:$(grep -q '^processos da API restantes: 0$' "$log" && echo sim || echo não)"
      "usuários e recursos de prova removidos:$(grep -q '^- Usuários, vídeos, objetos, multiparts, jobs e e-mails de prova: código 0$' "$log" && echo sim || echo não)"
      "retratos iguais:$(grep -q '^retratos iguais' "$log" && echo sim || echo não)"
    )
    ok=sim
    for c in "${checks[@]}"; do [ "${c##*:}" = sim ] || ok=não; done
    [ "$ok" = sim ] || failures=$((failures + 1))
    echo "CONTROLE | $modo | roteiro saiu com $rc | ${step_line#- } | etapa seguinte iniciada: $([ "$started" -eq 0 ] && echo não || echo sim) | sentinela: $sentinel | $([ "$ok" = sim ] && echo passou || echo 'NÃO PASSOU')"
    for c in "${checks[@]}"; do [ "${c##*:}" = sim ] || echo "  verificação reprovada: ${c%:*}"; done
    grep -hE '^FALHA \||^CONTROLE \|' "$log" "$out/$modo.stdout" 2>/dev/null | sort -u | sed 's/^/  /'
  done
  echo "CONTROLES | $((total - failures)) de $total passaram"
  return "$failures"
}

# ---------------------------------------------------------------- funções isoladas do roteiro (r3)

funcoes() {
  local out=$1 pre4=$2 sint=$3 roteiro=${4:-$ROTEIRO}
  mkdir -p "$out"
  write_shims "$out/shim"
  (
    set -euo pipefail
    export PATH="$out/shim:$PATH"
    export P10GB_CONTROLE_SENTINELA="$out/sentinela"
    # Os nomes globais do roteiro, com pastas próprias dos controles.
    SIZE=1000000 PROBES=12 STAGGER_MS=167 BASELINE=60 FRACTION=0.5 GAP=5 MIN_FREE=29500000000 ROTULO=controle-funcoes
    HELP=$PROJECT_DIR/proofs/phase-03/p10gb-repeticao
    OUT_DIR=$out/roteiro RUN_ID=controles-funcoes
    EVID=$OUT_DIR/evid LOG=$OUT_DIR/funcoes.log CDIR=/tmp/p10gbr-controles-funcoes HOSTJS=$OUT_DIR/js WINDIR=$OUT_DIR/windows
    UPLOADER=p10gbr-$RUN_ID-uploader@proofs.streamtube.test CONTROL=p10gbr-$RUN_ID-control@proofs.streamtube.test
    PROBE_PREFIX=p10gbr-$RUN_ID-probe SAMPLER=/tmp/p10gbr-$RUN_ID.sampler SUPPORT=proofs/phase-03/upload-proof-support.ts
    CLIENT_PARAMS="--concurrency 4 --sign-batch 10 --register-every 4 --part-urls-interval-ms 1100"
    STATUS=() FIRST_FAILURE=0 SAMPLER_PID= BG_PIDS=() PROBE_PIDS=() WINMON_PID= HELPER_PID= API_PID= CONTROL_ID=
    BASELINE_START= BASELINE_END= OFFSET= UNC= API_CONTAINER= WWIN= EVIDENCE_COLLECTED=0
    mkdir -p "$EVID" "$WINDIR"
    # shellcheck source=/dev/null
    source <(sed -n '/^log() {/,/^trap cleanup EXIT/p' "$roteiro" | sed '$d')
    API_CONTAINER=$(docker compose ps --format '{{.Name}}' nestjs-api)
    trap 'docker compose exec -T nestjs-api rm -rf /tmp/p10gbr-controles-funcoes' EXIT
    api rm -rf "/tmp/p10gbr-controles-funcoes"
    api mkdir -p "/tmp/p10gbr-controles-funcoes"
    total=0 failures=0
    caso() {
      local name=$1 mode=$2 expect=$3 rc=0 got
      shift 3
      total=$((total + 1))
      export P10GB_CONTROLE_FALHA=$mode
      "$@" >"$out/$name.txt" 2>&1 || rc=$?
      export P10GB_CONTROLE_FALHA=
      case "$expect" in
        zero) [ "$rc" -eq 0 ] && got=passou || got="NÃO PASSOU (código $rc, esperado 0)" ;;
        um) [ "$rc" -eq 1 ] && got=passou || got="NÃO PASSOU (código $rc, esperado 1)" ;;
        erro) [ "$rc" -ne 0 ] && got=passou || got="NÃO PASSOU (código 0, esperado erro)" ;;
      esac
      [ "$got" = passou ] || failures=$((failures + 1))
      echo "CONTROLE | $name | falha injetada: ${mode:-nenhuma} | $* → código $rc | $got"
      grep -hE '^FALHA \|' "$out/$name.txt" | sed 's/^/  /' || true
    }
    # Etapas antes do upload (auditoria da r3).
    caso api-parada-sem-falha "" zero api_stopped
    caso api-parada-ps-falha api-ps erro api_stopped
    caso versoes-falha versoes erro versions
    caso disco-host-falha disco-host erro host_disk
    caso residuos-falha residuos erro residue_into "$EVID/residue-controle.txt"
    caso lixeira-uso-falha uso-storage erro wait_trash_empty 30
    caso relogio-falha relogio erro clock controle
    PROBES=13
    caso memoria-sem-as-13-sondas "" erro memory_snapshot
    # Etapas depois do upload, com os arquivos reais da pré-checagem 4.
    for f in events.jsonl state.json progress.json client-start.log client-resume.log ctrl-c.log; do
      if [ -e "$pre4/client-$f" ]; then cp "$pre4/client-$f" "$WINDIR/$f"; fi
    done
    caso eventos-do-cliente-sem-falha "" zero copy_client_files
    mv "$WINDIR/events.jsonl" "$WINDIR/events.jsonl.retirado"
    caso eventos-do-cliente-ausentes "" erro copy_client_files
    mv "$WINDIR/events.jsonl.retirado" "$WINDIR/events.jsonl"
    caso eventos-do-cliente-copia-falha copia-eventos erro copy_client_files
    for f in relogio-antes.json relogio-depois.json disk-samples.txt disk-completion-fast.txt; do cp "$pre4/$f" "$EVID/$f"; done
    cp "$pre4"/probe-*.csv "$EVID/"
    PROBES=13
    caso sondas-uma-ausente "" erro copy_probes
    PROBES=12
    caso sondas-copia-falha copia-sonda erro copy_probes
    caso sondas-sem-falha "" zero copy_probes
    echo "  argumentos das sondas: $((${#PROBE_ARGS[@]} / 2)) instâncias"
    log=$(ls "$pre4"/p10gbr-*.log | head -1)
    BASELINE_START=$(grep -oP 'base: início em \K[0-9]+' "$log")
    BASELINE_END=$(grep -oP 'base: fim em \K[0-9]+' "$log")
    caso resumo-pre-checagem-4 "" zero summarize
    caso veredito-pre-checagem-4 "" um latency_verdict
    # O veredito do roteiro r3 deve ser o mesmo do reprocessamento da r2 (mesmas entradas). A ordem
    # das sondas difere (glob × ordem numérica), então a comparação é do conteúdo, sem a ordem.
    if [ -n "${P10GB_CONTROLE_REFERENCIA:-}" ]; then
      total=$((total + 1))
      if python3 -I - "$EVID/latency-verdict.json" "$P10GB_CONTROLE_REFERENCIA" <<'PY'
import json,sys
def norm(x):
    if isinstance(x, dict):
        return {k: norm(v) for k, v in x.items()}
    if isinstance(x, list):
        return sorted((norm(v) for v in x), key=lambda v: json.dumps(v, sort_keys=True))
    return x
a, b = (norm(json.load(open(p))) for p in sys.argv[1:3])
sys.exit(0 if a == b else 1)
PY
      then
        echo "CONTROLE | veredito-igual-ao-reprocessamento | latency-verdict.json do roteiro r3 igual, em conteúdo, ao do reprocessamento da pré-checagem 4 | passou"
      else
        failures=$((failures + 1))
        echo "CONTROLE | veredito-igual-ao-reprocessamento | latency-verdict.json diferente do reprocessamento | NÃO PASSOU"
      fi
    fi
    # Cópia do veredito com falha, num caso sintético aprovado (sem a falha, código 0).
    EVID=$OUT_DIR/evid-sintetico
    mkdir -p "$EVID"
    cp "$sint/probe.csv" "$EVID/probe-1.csv"
    PROBES=1 UNC=157
    api sh -c "cat > '$CDIR/events-vm.jsonl'" <"$sint/events.jsonl"
    read -r BASELINE_START BASELINE_END < <(python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1])); print(c["baselineStart"], c["baselineEnd"])' "$sint/caso.json")
    caso veredito-aprovado-sem-falha "" zero latency_verdict
    caso veredito-aprovado-copia-falha copia-veredito erro latency_verdict
    api rm -rf "/tmp/p10gbr-controles-funcoes"
    total=$((total + 1))
    if [ -e "$out/sentinela" ]; then
      failures=$((failures + 1))
      echo "CONTROLE | sentinelas | acionadas: $(tr '\n' ' ' <"$out/sentinela") | NÃO PASSOU"
    else
      echo "CONTROLE | sentinelas | não acionadas (nenhuma geração nem upload) | passou"
    fi
    echo "CONTROLES | $((total - failures)) de $total passaram"
    exit "$failures"
  )
}

case "${1:-}" in
  veredito) veredito "${2:?saída}" ;;
  reprocessa) reprocessa "${2:?pasta da pré-checagem}" "${3:?saída}" ;;
  falhas) falhas "${2:?saída}" "${3:-}" "${4:-}" ;;
  funcoes) funcoes "${2:?saída}" "${3:?pasta da pré-checagem 4}" "${4:?pasta de um caso sintético aprovado}" ;;
  *) echo "uso: $0 veredito <saída> | reprocessa <pré-checagem> <saída> | falhas <saída> [roteiro] [modos] | funcoes <saída> <pré-checagem 4> <caso sintético>" >&2; exit 64 ;;
esac
