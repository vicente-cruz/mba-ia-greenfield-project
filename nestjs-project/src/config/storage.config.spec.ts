import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from './storage.config';

const KEYS = [
  'S3_ENDPOINT',
  'S3_PUBLIC_ENDPOINT',
  'S3_REGION',
  'S3_FORCE_PATH_STYLE',
] as const;

type Key = (typeof KEYS)[number];

const loadConfig = async (
  env: Partial<Record<Key, string>> = {},
): Promise<ConfigType<typeof storageConfig>> => {
  for (const key of KEYS) {
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [storageConfig] }),
    ],
  }).compile();

  const config = module.get<ConfigType<typeof storageConfig>>(
    storageConfig.KEY,
  );
  await module.close();
  return config;
};

describe('storageConfig', () => {
  const original: Partial<Record<Key, string>> = {};

  beforeAll(() => {
    for (const key of KEYS) {
      original[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  });

  it('should keep the internal and public endpoints separate', async () => {
    const config = await loadConfig({
      S3_ENDPOINT: 'http://storage:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
    });

    expect(config.endpoint).toBe('http://storage:9000');
    expect(config.publicEndpoint).toBe('http://localhost:9000');
  });

  it('should default to path-style addressing and us-east-1 when unset', async () => {
    const config = await loadConfig();

    expect(config.forcePathStyle).toBe(true);
    expect(config.region).toBe('us-east-1');
  });

  it('should disable path-style addressing when S3_FORCE_PATH_STYLE=false', async () => {
    const config = await loadConfig({ S3_FORCE_PATH_STYLE: 'false' });

    expect(config.forcePathStyle).toBe(false);
  });
});
