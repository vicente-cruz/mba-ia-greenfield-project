"""Análise TEMPORÁRIA do perfil de CPU da API no diagnóstico R-02 (só leitura).

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


start_us = prof['startTime']
t_us = start_us
samples = []
for sid, delta in zip(prof['samples'], prof['timeDeltas']):
    t_us += delta
    samples.append((meta['wallStartMs'] + (t_us - start_us) / 1000, sid, delta / 1000))


def jl(name):
    p = os.path.join(D, name)
    return [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []


loop = jl('api-loop.jsonl')
gc = jl('api-gc.jsonl')
prof_a, prof_b = samples[0][0] if samples else 0, samples[-1][0] if samples else 0
windows = [('perfil inteiro', prof_a, prof_b)]
for r in loop:
    if r['elMaxMs'] >= 500 and prof_a <= r['t'] <= prof_b + 2000:
        windows.append((f"episódio: event loop {r['elMaxMs']} ms, intervalo real {r['intervalMs']} ms, CPU usuário {r['cpuUserMs']} ms + sistema {r['cpuSystemMs']} ms", r['t'] - r['intervalMs'], r['t']))

print(f"# Perfil de CPU da API — {NAME}\n")
print(f"- perfil: {len(samples)} amostras, de {meta['wallStartMs']} a {meta.get('wallStopMs')} (ms de parede), intervalo de amostragem pedido de 1 ms")
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
    print(f"- pausas de GC na janela: {len(g)}, somando {sum(x['ms'] for x in g):.1f} ms, maior {max((x['ms'] for x in g), default=0):.1f} ms ({dict(Counter(x['kind'] for x in g))})")
