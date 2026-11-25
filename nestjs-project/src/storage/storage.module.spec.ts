import type { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import {
  STORAGE_INTERNAL_CLIENT,
  STORAGE_PUBLIC_CLIENT,
} from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const TEST_ENV = {
  S3_ENDPOINT: 'http://storage-internal.test:9000',
  S3_PUBLIC_ENDPOINT: 'http://storage-public.test:9443',
  S3_REGION: 'eu-test-1',
  S3_ACCESS_KEY_ID: 'module-access-key',
  S3_SECRET_ACCESS_KEY: 'module-secret-key',
  S3_BUCKET: 'module-bucket',
  S3_FORCE_PATH_STYLE: 'true',
} as const;

type Key = keyof typeof TEST_ENV;

describe('StorageModule', () => {
  const original: Partial<Record<Key, string>> = {};
  let module: TestingModule;

  beforeEach(async () => {
    for (const key of Object.keys(TEST_ENV) as Key[]) {
      original[key] = process.env[key];
      process.env[key] = TEST_ENV[key];
    }
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [storageConfig],
        }),
        StorageModule,
      ],
    }).compile();
  });

  afterEach(async () => {
    await module.close();
    for (const key of Object.keys(TEST_ENV) as Key[]) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  });

  it('should compile and provide StorageService', () => {
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
  });

  it('should sign browser URLs on S3_PUBLIC_ENDPOINT and internal URLs on S3_ENDPOINT', async () => {
    const storage = module.get(StorageService);
    const input = { key: 'originals/v/s', expiresInSeconds: 60 };

    const browser = await storage.presignGet({ ...input, audience: 'browser' });
    const internal = await storage.presignGet({
      ...input,
      audience: 'internal',
    });

    expect(new URL(browser.url).origin).toBe('http://storage-public.test:9443');
    expect(new URL(internal.url).origin).toBe(
      'http://storage-internal.test:9000',
    );
    expect(new URL(browser.url).pathname).toBe('/module-bucket/originals/v/s');
  });

  it.each([
    ['internal', STORAGE_INTERNAL_CLIENT],
    ['public', STORAGE_PUBLIC_CLIENT],
  ])(
    'should configure the %s client with path style, the region and WHEN_REQUIRED checksums',
    async (_name, token) => {
      const client = module.get<S3Client>(token);

      expect(client.config.forcePathStyle).toBe(true);
      expect(await client.config.region()).toBe('eu-test-1');
      expect(await client.config.requestChecksumCalculation()).toBe(
        'WHEN_REQUIRED',
      );
      expect(await client.config.responseChecksumValidation()).toBe(
        'WHEN_REQUIRED',
      );
    },
  );
});
