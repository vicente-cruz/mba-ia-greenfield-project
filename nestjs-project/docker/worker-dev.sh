#!/bin/sh
# Watch mode of the video-worker (`npm run start:worker:dev`, phase-03-videos/TD-10).
#
# The Nest CLI compiles src/ to dist-worker/ and restarts the worker on every change, but it has no
# SIGTERM handler: killed by the signal, it leaves the worker it started behind, and the container
# ends that worker with SIGKILL, without its graceful shutdown. This script is the process that
# npm forwards SIGTERM and SIGINT to. It sends the signal to the worker (the direct child of the
# CLI, started with --no-shell), waits for the worker to exit and only then stops the CLI.
set -u

node_modules/.bin/nest start --watch --no-shell -p tsconfig.worker.json --entryFile worker &
cli=$!

stop() {
  trap '' TERM INT
  workers=$(pgrep -P "$cli" || true)
  if [ -n "$workers" ]; then
    kill -TERM $workers 2>/dev/null || true
    for pid in $workers; do
      while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
    done
  fi
  kill -TERM "$cli" 2>/dev/null || true
  wait "$cli" 2>/dev/null || true
  exit 0
}
trap stop TERM INT

wait "$cli"
