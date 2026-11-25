import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import videoConfig from './video.config';

const KEYS = [
  'VIDEO_MAX_SIZE_BYTES',
  'UPLOAD_PART_SIZE_BYTES',
  'UPLOAD_SESSION_TTL',
  'PROCESSING_MAX_RECOVERIES',
  'MAINTENANCE_BATCH_SIZE',
] as const;

type Key = (typeof KEYS)[number];

const loadConfig = async (
  env: Partial<Record<Key, string>> = {},
): Promise<ConfigType<typeof videoConfig>> => {
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
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [videoConfig] }),
    ],
  }).compile();

  const config = module.get<ConfigType<typeof videoConfig>>(videoConfig.KEY);
  await module.close();
  return config;
};

describe('videoConfig', () => {
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

  it('should apply the phase defaults when the keys are unset', async () => {
    const config = await loadConfig();

    expect(config).toMatchObject({
      maxSizeBytes: 10000000000,
      uploadPartSizeBytes: 67108864,
      uploadSessionTtlSeconds: 86400,
      processingMaxRecoveries: 2,
      maintenance: { batchSize: 100 },
    });
  });

  it.each([
    ['24h', 86400],
    ['90m', 5400],
    ['3600s', 3600],
    ['1d', 86400],
  ])(
    'should convert UPLOAD_SESSION_TTL=%s to %i seconds',
    async (ttl, seconds) => {
      const config = await loadConfig({ UPLOAD_SESSION_TTL: ttl });

      expect(config.uploadSessionTtlSeconds).toBe(seconds);
    },
  );

  it('should read integer keys from the environment, including zero', async () => {
    const config = await loadConfig({
      VIDEO_MAX_SIZE_BYTES: '1000000',
      PROCESSING_MAX_RECOVERIES: '0',
    });

    expect(config.maxSizeBytes).toBe(1000000);
    expect(config.processingMaxRecoveries).toBe(0);
  });
});
