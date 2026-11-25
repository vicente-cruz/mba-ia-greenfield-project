"""Análise TEMPORÁRIA da comparação A×B do diagnóstico R-02 (só leitura dos arquivos coletados).

Uso: python3 -I analisa-comparacao.py <diretório de evidências>
Janela de cada upload, pelo relógio do servidor (o mesmo da sonda e das amostras da VM): da chegada
do primeiro POST …/part-urls ao fim do POST …/completion, no log de requisições da API. A mesma
definição vale para A e B, independentemente do relógio do cliente.
"""
import csv
import glob
import json
import math
import os
import re
import sys
from collections import defaultdict

D = sys.argv[1]


def jl(name):
    path = os.path.join(D, name)
    return [json.loads(l) for l in open(path) if l.strip()] if os.path.exists(path) else []


def pct(v, p):
    v = sorted(v)
    return v[max(1, math.ceil(p / 100 * len(v))) - 1] if v else float('nan')


def f(x, nd=1):
    return 'n/a' if x is None or (isinstance(x, float) and math.isnan(x)) else f'{x:.{nd}f}'


marks = defaultdict(dict)
for line in open(os.path.join(D, 'phases.txt')):
    n, k, t = line.split()
    marks[n][k] = int(t)
req = jl('api-requests.jsonl')
loop = jl('api-loop.jsonl')
db = jl('api-db.jsonl')
probe = []
for p in sorted(glob.glob(os.path.join(D, 'probe-*.csv'))):
    for r in csv.DictReader(open(p)):
        probe.append((int(r['epoch_ms']), float(r['latency_ms']), r['outcome']))
vm = []
for line in open(os.path.join(D, 'sampler.txt')):
    if line.startswith('V '):
        h, c = line.split('|', 1)
        p = h.split()
        r = {'t': int(p[1])}
        for kv in p[2:]:
            k, v = kv.split('=')
            r[k] = int(v)
        cc = [int(x) for x in c.split()[1:]]
        r['tot'], r['idle'], r['iow'] = sum(cc[:8]), cc[3], cc[4]
        vm.append(r)
dbq, dbt = [], []
cur, times = None, 0
for line in open(os.path.join(D, 'dbprobe.txt')):
    line = line.strip()
    if line.startswith('t|'):
        cur, times = int(line.split('|')[1]), 0
        dbt.append(cur)
    elif line.startswith('Time:') and cur is not None:
        times += 1
        if times == 2:
            dbq.append((cur, float(line.split()[1])))
stats = defaultdict(list)
for line in open(os.path.join(D, 'docker-stats.txt')):
    m = re.match(r'(\d+) (\S+) cpu ([\d.]+)%', line)
    if m:
        short = 'sondas' if '-probe-' in m.group(2) else m.group(2).replace('nestjs-project-', '').rsplit('-', 1)[0]
        stats[short].append((int(m.group(1)), float(m.group(3))))

windows = []
for name, m in sorted(marks.items(), key=lambda x: x[1].get('inicio', 0)):
    a, b = m.get('inicio'), m.get('fim')
    if a is None or b is None:
        continue
    if name.startswith('R0'):
        windows.append((name, a, b, None))
        continue
    inside = [r for r in req if a <= r['t'] <= b]
    pu = [r for r in inside if r['path'].endswith('/part-urls')]
    co = [r for r in inside if r['path'].endswith('/completion')]
    if pu and co:
        windows.append((name, min(r['t'] for r in pu), max(r['t'] + r['ms'] for r in co), name))

print('# Comparação A (cliente no container) × B (cliente no Windows), upload de 1 GB\n')
print('| Janela | Duração | Sonda: amostras, p95 / máx (>250 ms) | Servidor GET: p95 / máx | Event loop: máx (s >100 ms) | Amostrador: maior intervalo (>1 s) | Sonda do db: consulta p95 / máx; maior intervalo | PSI io some / full | PSI mem some | PSI cpu some | iowait | swap out | faltas maiores | CPU nestjs-api / storage (mediana; máx) | Cliente: PUT MiB/s; checksum MiB/s; completion |')
print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for name, a, b, ev in windows:
    secs = (b - a) / 1000
    lat = [l for t, l, o in probe if a <= t <= b]
    slow = sum(1 for l in lat if l > 250)
    sv = [r['ms'] for r in req if a <= r['t'] <= b and r['method'] == 'GET' and r['path'].count('/') == 2]
    el = [r['elMaxMs'] for r in loop if a <= r['t'] <= b + 1000]
    vs = [r for r in vm if a <= r['t'] <= b]
    gaps = [y['t'] - x['t'] for x, y in zip(vs, vs[1:])]
    q = [ms for t, ms in dbq if a <= t <= b]
    dts = [t for t in dbt if a - 1500 <= t <= b + 1500]
    dgaps = [y - x for x, y in zip(dts, dts[1:])]

    def dl(k):
        return (vs[-1][k] - vs[0][k]) if len(vs) >= 2 and k in vs[0] else None

    span = (vs[-1]['t'] - vs[0]['t']) if len(vs) >= 2 else None
    pctk = lambda k: (100 * dl(k) / 1000 / span) if span and dl(k) is not None else None
    tot, idle, iow = dl('tot'), dl('idle'), dl('iow')
    cpus = []
    for c in ('nestjs-api', 'storage'):
        v = [x for t, x in stats.get(c, []) if a <= t <= b]
        cpus.append(f'{pct(v, 50):.0f}%; {max(v):.0f}%' if v else 'n/a')
    client = '—'
    if ev:
        events = jl(f'events-{ev}.jsonl')
        puts = [e for e in events if e['ev'] == 'put' and e.get('outcome') == 'ok']
        put_bytes = sum(e['bytes'] for e in puts)
        intervals = sorted((e['t'] - e['ms'], e['t']) for e in events if e['ev'] == 'put')
        merged, active = [], 0
        for s0, e0 in intervals:
            if merged and s0 <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], e0)
            else:
                merged.append([s0, e0])
        active = sum(e0 - s0 for s0, e0 in merged)
        cks = [e for e in events if e['ev'] == 'checksum']
        ck_bytes, ck_ms = sum(e['bytes'] for e in cks), sum(e['ms'] for e in cks)
        comp = next((e for e in events if e['ev'] == 'completion'), {})
        final = next((e for e in events if e['ev'] == 'final'), {})
        client = f"{put_bytes / 1048576 / (active / 1000):.1f}; {ck_bytes / 1048576 / (ck_ms / 1000):.1f}; {comp.get('status')} em {comp.get('ms')} ms → {final.get('status')} {final.get('errorCode') or ''}"
    print(f"| {name} | {secs:.1f} s | {len(lat)}, {f(pct(lat, 95))} / {f(max(lat) if lat else None)} ms ({slow}) | {f(pct(sv, 95), 2)} / {f(max(sv) if sv else None, 2)} ms | {f(max(el) if el else None)} ms ({sum(1 for x in el if x > 100)}) | {max(gaps) if gaps else 'n/a'} ms ({sum(1 for g in gaps if g > 1000)}) | {f(pct(q, 95), 2)} / {f(max(q) if q else None, 2)} ms; {max(dgaps) if dgaps else 'n/a'} ms | {f(pctk('io_some'))}% / {f(pctk('io_full'))}% | {f(pctk('memory_some'))}% | {f(pctk('cpu_some'))}% | {f(100 * iow / tot if tot else None)}% | {dl('pswpout')} pág | {dl('pgmajfault')} | {cpus[0]} / {cpus[1]} | {client} |")
