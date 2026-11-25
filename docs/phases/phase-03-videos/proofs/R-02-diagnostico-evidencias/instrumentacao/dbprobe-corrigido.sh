#!/bin/sh
# Sonda TEMPORÁRIA do PostgreSQL no diagnóstico R-02, dentro do container db, a cada 1 s, até
# existir $2. Uma sessão psql única executa uma consulta equivalente à do GET /videos/:publicId
# (vídeo, canal e sessão atual) e mede o tempo com \timing. O instante vem do próprio Postgres.
# Uso: sh dbprobe.sh <publicId> <arquivo de parada>
ID=$1
STOP=$2
{
  # printf com %s não interpreta a barra invertida; o echo do dash transformava \t em tabulação.
  printf '%s\n' '\timing on'
  while [ ! -e "$STOP" ]; do
    echo "select 't', (extract(epoch from clock_timestamp()) * 1000)::bigint;"
    echo "select 'q', v.status, s.status from videos v join channels c on c.id = v.channel_id left join upload_sessions s on s.id = v.current_upload_session_id where v.public_id = '$ID';"
    sleep 1
  done
} | psql -U streamtube -d streamtube -At
