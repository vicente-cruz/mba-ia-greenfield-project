import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Loads the `.env` of the working directory into `env`, as `ConfigModule.forRoot` does: a
 * variable already set by the environment (Compose, shell) is never overridden.
 *
 * The worker needs it before any import: the options of a BullMQ worker are given to the
 * `@Processor` decorator, which runs when the processor module is evaluated, before
 * `ConfigModule.forRoot` loads the file. `parseEnv` is the parser of Node, with the same results
 * as the `dotenv` of `ConfigModule` for the `.env` and `.env.example` of the project (SI-03.22).
 */
export function loadEnvFile(
  path = resolve(process.cwd(), '.env'),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!existsSync(path)) {
    return false;
  }
  for (const [key, value] of Object.entries(
    parseEnv(readFileSync(path, 'utf8')),
  )) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
  return true;
}
