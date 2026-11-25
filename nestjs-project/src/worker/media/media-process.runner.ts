import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';

export interface MediaProcessResult {
  /** Exit code, or `null` when the process ended by a signal. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  /** The per-call timeout killed the process. */
  timedOut: boolean;
  durationMs: number;
}

/**
 * Runs ffprobe and ffmpeg as child processes, outside the event loop (TD-10). A call that passes
 * `timeoutMs` is killed with SIGKILL, and the promise only resolves on `close`, after the process
 * has exited and its output streams are closed, so no process is left behind (G-09, V-04).
 */
@Injectable()
export class MediaProcessRunner {
  run(
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<MediaProcessResult> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      let stderr = '';
      let timedOut = false;
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({
          code,
          signal,
          stdout: Buffer.concat(stdout),
          stderr,
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }
}
