import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://storage:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'app-access-key',
  S3_SECRET_ACCESS_KEY: 'app-secret-key',
  S3_BUCKET: 'videos',
};

const validationOptions = { allowUnknown: true, abortEarly: false };

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate({ ...requiredEnv, ...env }, validationOptions);

const validateWithout = (key: keyof typeof requiredEnv) =>
  envValidationSchema.validate(
    Object.fromEntries(
      Object.entries(requiredEnv).filter(([name]) => name !== key),
    ),
    validationOptions,
  );

// Joi types the validated value as any; read it as unknown and assert its shape.
const validatedValue = (env: Record<string, string>): unknown => {
  const result = validate(env);
  expect(result.error).toBeUndefined();
  return result.value;
};

const errorMessage = (env: Record<string, string>): string => {
  const { error } = validate(env);
  expect(error).toBeDefined();
  return error!.message;
};

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const result = validate({});
    // Joi types the validated value as any; read it as unknown and assert its shape.
    const value: unknown = result.value;
    expect(result.error).toBeUndefined();
    expect(value).toHaveProperty('SWAGGER_ENABLED', 'false');
  });
});

describe('envValidationSchema — storage', () => {
  it.each([
    'S3_BUCKET',
    'S3_ENDPOINT',
    'S3_PUBLIC_ENDPOINT',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
  ] as const)('should require %s and name it in the error', (key) => {
    const { error } = validateWithout(key);

    expect(error).toBeDefined();
    expect(error!.message).toContain(`"${key}" is required`);
  });

  it.each([
    ['S3_ENDPOINT', 'storage:9000'],
    ['S3_ENDPOINT', 'ftp://storage:9000'],
    ['S3_PUBLIC_ENDPOINT', 'localhost:9000'],
    ['S3_PUBLIC_ENDPOINT', 'ftp://localhost:9000'],
  ])(
    'should reject %s=%s, which is not an http or https URI',
    (key, invalid) => {
      expect(errorMessage({ [key]: invalid })).toContain(`"${key}"`);
    },
  );

  it('should reject S3_FORCE_PATH_STYLE outside true and false', () => {
    expect(errorMessage({ S3_FORCE_PATH_STYLE: 'yes' })).toContain(
      '"S3_FORCE_PATH_STYLE"',
    );
  });

  it('should apply the storage defaults', () => {
    expect(validatedValue({})).toMatchObject({
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: 'true',
    });
  });
});

describe('envValidationSchema — queue', () => {
  it('should apply the queue defaults, with the lock and stall values confirmed by V-11', () => {
    expect(validatedValue({})).toMatchObject({
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      VIDEO_PROCESSING_ATTEMPTS: 3,
      VIDEO_PROCESSING_BACKOFF_MS: 5000,
      VIDEO_PROCESSING_CONCURRENCY: 1,
      VIDEO_PROCESSING_TIMEOUT_MS: 60000,
      QUEUE_LOCK_DURATION_MS: 30000,
      QUEUE_STALLED_INTERVAL_MS: 30000,
      QUEUE_MAX_STALLED_COUNT: 1,
    });
  });

  it.each([
    ['REDIS_PORT', '70000'],
    ['VIDEO_PROCESSING_ATTEMPTS', '0'],
    ['VIDEO_PROCESSING_BACKOFF_MS', '-1'],
    ['VIDEO_PROCESSING_CONCURRENCY', '1.5'],
    ['VIDEO_PROCESSING_TIMEOUT_MS', 'abc'],
    ['QUEUE_LOCK_DURATION_MS', '0'],
    ['QUEUE_STALLED_INTERVAL_MS', '0'],
    ['QUEUE_MAX_STALLED_COUNT', '-1'],
  ])('should reject %s=%s', (key, invalid) => {
    expect(errorMessage({ [key]: invalid })).toContain(`"${key}"`);
  });

  it('should accept QUEUE_MAX_STALLED_COUNT=0', () => {
    expect(validatedValue({ QUEUE_MAX_STALLED_COUNT: '0' })).toHaveProperty(
      'QUEUE_MAX_STALLED_COUNT',
      0,
    );
  });
});

describe('envValidationSchema — video', () => {
  it('should apply the upload, delivery, processing and maintenance defaults', () => {
    expect(validatedValue({})).toMatchObject({
      VIDEO_MAX_SIZE_BYTES: 10000000000,
      UPLOAD_PART_SIZE_BYTES: 67108864,
      UPLOAD_SESSION_TTL: '24h',
      UPLOAD_SESSION_CLAIM_TTL_SECONDS: 300,
      UPLOAD_PART_URL_TTL_SECONDS: 900,
      PLAYBACK_URL_TTL_SECONDS: 3600,
      DOWNLOAD_URL_TTL_SECONDS: 300,
      PROCESSING_JOB_ACTION_TTL_SECONDS: 120,
      PROCESSING_MAX_RECOVERIES: 2,
      PROCESSING_STUCK_ALERT_MS: 600000,
      PROCESSING_RECONCILE_GRACE_MS: 300000,
      STORAGE_CLEANUP_GRACE_MS: 3600000,
      MAINTENANCE_SWEEP_INTERVAL_MS: 60000,
      MAINTENANCE_RECONCILE_INTERVAL_MS: 60000,
      MAINTENANCE_CLEANUP_INTERVAL_MS: 3600000,
      MAINTENANCE_BATCH_SIZE: 100,
    });
  });

  it.each(['-1', '1.5', 'abc'])(
    'should reject PROCESSING_MAX_RECOVERIES=%s',
    (invalid) => {
      expect(errorMessage({ PROCESSING_MAX_RECOVERIES: invalid })).toContain(
        '"PROCESSING_MAX_RECOVERIES"',
      );
    },
  );

  it('should accept PROCESSING_MAX_RECOVERIES=0', () => {
    expect(validatedValue({ PROCESSING_MAX_RECOVERIES: '0' })).toHaveProperty(
      'PROCESSING_MAX_RECOVERIES',
      0,
    );
  });

  it.each([
    ['VIDEO_MAX_SIZE_BYTES', '0'],
    ['VIDEO_MAX_SIZE_BYTES', '5497558138881'],
    ['UPLOAD_PART_SIZE_BYTES', '5242879'],
    ['UPLOAD_PART_SIZE_BYTES', '5368709121'],
    ['UPLOAD_SESSION_CLAIM_TTL_SECONDS', '0'],
    ['UPLOAD_PART_URL_TTL_SECONDS', '0'],
    ['UPLOAD_PART_URL_TTL_SECONDS', '604801'],
    ['PLAYBACK_URL_TTL_SECONDS', '604801'],
    ['DOWNLOAD_URL_TTL_SECONDS', '604801'],
    ['PROCESSING_JOB_ACTION_TTL_SECONDS', '0'],
    ['PROCESSING_STUCK_ALERT_MS', '0'],
    ['PROCESSING_RECONCILE_GRACE_MS', '-1'],
    ['STORAGE_CLEANUP_GRACE_MS', '-1'],
    ['MAINTENANCE_SWEEP_INTERVAL_MS', '0'],
    ['MAINTENANCE_RECONCILE_INTERVAL_MS', '0'],
    ['MAINTENANCE_CLEANUP_INTERVAL_MS', '0'],
    ['MAINTENANCE_BATCH_SIZE', '0'],
  ])('should reject %s=%s', (key, invalid) => {
    expect(errorMessage({ [key]: invalid })).toContain(`"${key}"`);
  });

  it('should accept zero graces, which are only an additional margin', () => {
    expect(
      validatedValue({
        PROCESSING_RECONCILE_GRACE_MS: '0',
        STORAGE_CLEANUP_GRACE_MS: '0',
      }),
    ).toMatchObject({
      PROCESSING_RECONCILE_GRACE_MS: 0,
      STORAGE_CLEANUP_GRACE_MS: 0,
    });
  });

  it('should reject a part size that splits VIDEO_MAX_SIZE_BYTES into more than 10000 parts', () => {
    const message = errorMessage({
      VIDEO_MAX_SIZE_BYTES: '52428800001',
      UPLOAD_PART_SIZE_BYTES: '5242880',
    });

    expect(message).toContain('"UPLOAD_PART_SIZE_BYTES"');
    expect(message).toContain('10000 parts');
  });

  it('should accept exactly 10000 parts', () => {
    expect(
      validatedValue({
        VIDEO_MAX_SIZE_BYTES: '52428800000',
        UPLOAD_PART_SIZE_BYTES: '5242880',
      }),
    ).toHaveProperty('VIDEO_MAX_SIZE_BYTES', 52428800000);
  });

  it.each(['24', '24 h', '0h', '1.5h', '24H', 'abc'])(
    'should reject UPLOAD_SESSION_TTL=%s',
    (invalid) => {
      expect(errorMessage({ UPLOAD_SESSION_TTL: invalid })).toContain(
        '"UPLOAD_SESSION_TTL"',
      );
    },
  );

  it.each(['90m', '3600s', '1d'])(
    'should accept UPLOAD_SESSION_TTL=%s',
    (ttl) => {
      expect(validatedValue({ UPLOAD_SESSION_TTL: ttl })).toHaveProperty(
        'UPLOAD_SESSION_TTL',
        ttl,
      );
    },
  );

  it.each([
    ['48h', '300'],
    ['47h', '3600'],
  ])(
    'should reject UPLOAD_SESSION_TTL=%s with a %s s claim, which reaches the 48h storage expiry',
    (ttl, claimTtl) => {
      const message = errorMessage({
        UPLOAD_SESSION_TTL: ttl,
        UPLOAD_SESSION_CLAIM_TTL_SECONDS: claimTtl,
      });

      expect(message).toContain('"UPLOAD_SESSION_TTL"');
      expect(message).toContain('"UPLOAD_SESSION_CLAIM_TTL_SECONDS"');
    },
  );

  it('should accept a session TTL and claim that stay below the 48h storage expiry', () => {
    expect(
      validatedValue({
        UPLOAD_SESSION_TTL: '47h',
        UPLOAD_SESSION_CLAIM_TTL_SECONDS: '3599',
      }),
    ).toHaveProperty('UPLOAD_SESSION_TTL', '47h');
  });
});
