import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from './load-env-file';

describe('loadEnvFile', () => {
  const preset = `LOAD_ENV_FILE_PRESET_${process.pid}`;
  const fromFile = `LOAD_ENV_FILE_ONLY_${process.pid}`;
  const file = join(tmpdir(), `load-env-file-${randomUUID()}.env`);

  afterEach(() => {
    rmSync(file, { force: true });
  });

  it('should load the file without overriding the variables of the environment', () => {
    const env: NodeJS.ProcessEnv = { [preset]: 'from-environment' };
    writeFileSync(file, `${preset}=from-file\n${fromFile}="quoted value"\n`);

    expect(loadEnvFile(file, env)).toBe(true);

    expect(env).toEqual({
      [preset]: 'from-environment',
      [fromFile]: 'quoted value',
    });
  });

  it('should do nothing when there is no file, as in an environment configured only by variables', () => {
    const env: NodeJS.ProcessEnv = {};

    expect(loadEnvFile(file, env)).toBe(false);
    expect(env).toEqual({});
  });
});
