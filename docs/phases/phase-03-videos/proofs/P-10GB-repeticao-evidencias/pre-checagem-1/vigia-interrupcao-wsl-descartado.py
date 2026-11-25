"""Vigia da interrupção na repetição da P-10GB (R-02), no WSL.

Lê a cada 50 ms o progresso que o cliente grava no Windows e, quando a fração pedida das partes do
plano já teve o PUT concluído (o mesmo limite do `interrupt-when`: ceil(partCount × fração)), envia
um Ctrl+C real ao console do cliente com ctrl-c.ps1. O cliente trata o SIGINT, aborta os PUTs em
andamento e sai com 130. Não encerra o processo à força.

Uso: python3 -I vigia-interrupcao.py <progresso.json> <fração> <pid do console> <ctrl-c.ps1 (Windows)>
                                     <log do ctrl-c (Windows)> <pid do iniciador no WSL>
"""
import json
import math
import os
import subprocess
import sys
import time

progress_path, fraction, console_pid, ctrl_c, ctrl_log, launcher_pid = sys.argv[1:7]
fraction = float(fraction)
deadline = time.time() + 30 * 60


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


while True:
    progress = None
    try:
        with open(progress_path, encoding='utf-8') as f:
            progress = json.load(f)
    except (OSError, ValueError):
        pass
    if progress and progress.get('partCount'):
        threshold = math.ceil(progress['partCount'] * fraction)
        if progress['phase'] in ('done', 'failed') or not alive(launcher_pid):
            print(f"VIGIA | o cliente terminou ({progress['phase']}) com {len(progress['putDone'])} de {progress['partCount']} partes antes do limite de {threshold}")
            sys.exit(1)
        if len(progress['putDone']) >= threshold:
            sent = int(time.time() * 1000)
            rc = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ctrl_c,
                                 '-TargetPid', console_pid, '-Log', ctrl_log]).returncode
            print(f"VIGIA | Ctrl+C real (CTRL_C_EVENT) pedido em {sent} (relógio do WSL) ao console {console_pid}, com {len(progress['putDone'])} de {progress['partCount']} partes com PUT concluído (limite: {threshold}); ctrl-c.ps1 saiu com {rc} | PUT concluído: {progress['putDone']} | registradas: {progress['registered']} | em andamento: {progress['inFlight']}")
            sys.exit(0 if rc == 0 else 1)
    elif not alive(launcher_pid):
        print('VIGIA | o cliente terminou antes de gravar o progresso')
        sys.exit(1)
    if time.time() > deadline:
        print('VIGIA | o limite não foi atingido em 30 min')
        sys.exit(1)
    time.sleep(0.05)
