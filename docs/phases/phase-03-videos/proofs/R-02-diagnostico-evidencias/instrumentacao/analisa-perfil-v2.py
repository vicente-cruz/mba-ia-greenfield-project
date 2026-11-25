"""Análise TEMPORÁRIA do perfil de CPU da API no diagnóstico R-02, versão 2 (só leitura).

Correções sobre analisa-perfil.py:
- alinhamento: os carimbos do V8 usam o mesmo relógio monotônico de process.hrtime. Com as âncoras
  de preload-v3.js, cada amostra vai para a parede por hrtime. Nos perfis antigos (só wallStartMs,
  tirado no callback do start, depois do arranque), a âncora passa a ser o fim: wallStopMs contra
  endTime, com erro igual à latência do callback do stop; a diferença para o alinhamento antigo
  (pelo início) é informada;
- GC: os rótulos antigos de gc.jsonl ({1: minor, 2: major, 4: incremental, 8: weakcb}, errado) voltam
  ao valor bruto e recebem o nome pelas constantes de node:perf_hooks (1 minor, 4 major,
  8 incremental, 16 weakcb).

Uso: python3 -I analisa-perfil.py <diretório de evidências> <nome do perfil, ex.: perfil-B1>
- alinha cada amostra do perfil do V8 ao relógio de parede (início registrado no -meta.json);
- janelas de episódio: registros de api-loop.jsonl com atraso do event loop >= 500 ms, cobrindo
  [t - intervalMs, t] (a duração real desde a coleta anterior);
- por janela e no total: tempo próprio por categoria, por pacote e por função; as pilhas mais
  frequentes; a maior lacuna entre amostras consecutivas; as pausas de GC; a CPU de usuário e de
  sistema do processo.
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict

D, NAME = sys.argv[1], sys.argv[2]
prof = json.load(open(os.path.join(D, f'{NAME}.cpuprofile')))
meta = json.load(open(os.path.join(D, f'{NAME}-meta.json')))
nodes = {n['id']: n for n in prof['nodes']}
parent = {}
for n in prof['nodes']:
    for c in n.get('children', []):
        parent[c] = n['id']


def package(url):
    if not url:
        return '(nativo/V8)'
    if url.startswith('node:'):
        return 'node:' + url[5:].split('/')[0]
    m = re.search(r'node_modules/((?:@[^/]+/)?[^/]+)/', url)
    if m:
        return m.group(1)
    m = re.search(r'/app/(dist[^/]*/.*)$', url)
    if m:
        return 'app:' + m.group(1)
    return url[-60:]


def label(node_id):
    cf = nodes[node_id]['callFrame']
    fn = cf['functionName'] or '(anônima)'
    if fn in ('(idle)', '(program)', '(garbage collector)', '(root)'):
        return fn
    return f"{fn} [{package(cf['url'])}:{cf['lineNumber'] + 1}]"


def category(node_id):
    fn = nodes[node_id]['callFrame']['functionName']
    if fn in ('(idle)', '(program)', '(garbage collector)'):
        return fn
    return 'JS/nativo: ' + package(nodes[node_id]['callFrame']['url'])


def stack(node_id, depth=8):
    out = []
    while node_id in nodes and len(out) < depth:
        fn = nodes[node_id]['callFrame']['functionName']
        if fn == '(root)':
            break
        out.append(label(node_id))
        node_id = parent.get(node_id)
    return ' ← '.join(out)


start_us, end_us = prof['startTime'], prof['endTime']
if 'startCallback' in meta:
    anchor = 'hrtime (âncora do callback do start)'
    to_wall = lambda t: meta['startCallback']['wallMs'] + (t - meta['startCallback']['hrtimeUs']) / 1000
else:
    anchor = 'fim (wallStopMs contra endTime; erro = latência do callback do stop)'
    to_wall = lambda t: meta['wallStopMs'] - (end_us - t) / 1000
t_us = start_us
samples = []
for sid, delta in zip(prof['samples'], prof['timeDeltas']):
    t_us += delta
    samples.append((to_wall(t_us), sid, delta / 1000))
last_us = t_us
old_last = meta.get('wallStartMs', 0) + (last_us - start_us) / 1000 if 'wallStartMs' in meta else None


def jl(name):
    p = os.path.join(D, name)
    return [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []


loop = jl('api-loop.jsonl')
gc = jl('api-gc.jsonl')
OLD_RAW = {'minor': 1, 'major': 2, 'incremental': 4, 'weakcb': 8}
NAMES = {1: 'minor', 4: 'major', 8: 'incremental', 16: 'weakcb'}
for x in gc:
    raw = x.get('kindRaw', OLD_RAW.get(x['kind']))
    x['kindCorrected'] = NAMES.get(raw, f'sem constante ({raw})')
prof_a, prof_b = samples[0][0] if samples else 0, samples[-1][0] if samples else 0
windows = [('perfil inteiro', prof_a, prof_b)]
for r in loop:
    if r['elMaxMs'] >= 500 and prof_a <= r['t'] <= prof_b + 2000:
        windows.append((f"episódio: event loop {r['elMaxMs']} ms, intervalo real {r['intervalMs']} ms, CPU usuário {r['cpuUserMs']} ms + sistema {r['cpuSystemMs']} ms", r['t'] - r['intervalMs'], r['t']))

print(f"# Perfil de CPU da API — {NAME}\n")
print(f"- perfil: {len(samples)} amostras; alinhamento por {anchor}; intervalo de amostragem pedido de 1 ms")
if old_last is not None:
    print(f"- alinhamento antigo (pelo início, wallStartMs do callback): a última amostra caía {old_last - meta['wallStopMs']:.0f} ms depois de wallStopMs; é o arranque do perfil entre startTime e o callback, deslocando todas as amostras")
    print(f"- realinhado pelo fim: primeira amostra em {samples[0][0]:.0f}, última em {samples[-1][0]:.0f}; wallStartMs (callback do start) = {meta['wallStartMs']}, ou seja, {meta['wallStartMs'] - to_wall(start_us):.0f} ms depois do startTime realinhado")
for title, a, b in windows:
    inside = [s for s in samples if a <= s[0] <= b]
    print(f"\n## {title}\n- janela: {a:.0f} a {b:.0f} ({(b - a) / 1000:.2f} s); amostras: {len(inside)}")
    if not inside:
        continue
    total = sum(s[2] for s in inside)
    gaps = sorted((s[2] for s in inside), reverse=True)[:3]
    print(f"- tempo coberto pelas amostras: {total:.0f} ms; maiores intervalos entre amostras: {', '.join(f'{g:.1f} ms' for g in gaps)}")
    by_cat, by_fn, by_stack = Counter(), Counter(), Counter()
    for _, sid, dt in inside:
        by_cat[category(sid)] += dt
        by_fn[label(sid)] += dt
        if nodes[sid]['callFrame']['functionName'] not in ('(idle)', '(program)'):
            by_stack[stack(sid)] += dt
    print('- por categoria (tempo próprio):')
    for k, v in by_cat.most_common(8):
        print(f'  - {k}: {v:.0f} ms ({100 * v / total:.1f}%)')
    print('- funções com mais tempo próprio:')
    for k, v in by_fn.most_common(12):
        print(f'  - {v:7.0f} ms  {k}')
    print('- pilhas mais frequentes (fora de idle e program), da função para quem chamou:')
    for k, v in by_stack.most_common(5):
        print(f'  - {v:7.0f} ms  {k}')
    g = [x for x in gc if a <= x['t'] <= b]
    print(f"- pausas de GC na janela: {len(g)}, somando {sum(x['ms'] for x in g):.1f} ms, maior {max((x['ms'] for x in g), default=0):.1f} ms; tipos corrigidos pelas constantes: {dict(Counter(x['kindCorrected'] for x in g))}")
    for x in sorted(g, key=lambda x: -x['ms'])[:3]:
        print(f"  - {x['ms']:.1f} ms em {x['t']}: rótulo gravado '{x['kind']}' → {x['kindCorrected']}")
