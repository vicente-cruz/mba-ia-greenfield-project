import { S3Client } from '@aws-sdk/client-s3';
import type { ConfigType } from '@nestjs/config';
import type storageConfig from '../config/storage.config';
import { STORAGE_HTTP_TIMEOUTS } from './storage.constants';

export interface StorageHttpTimeouts {
  connectionMs: number;
  socketIdleMs: number;
}

const DEFAULT_TIMEOUTS: StorageHttpTimeouts = {
  connectionMs: STORAGE_HTTP_TIMEOUTS.CONNECTION_MS,
  socketIdleMs: STORAGE_HTTP_TIMEOUTS.SOCKET_IDLE_MS,
};

/**
 * Both clients share the configuration of TD-07: path-style addressing and checksums only when
 * an operation requires them (WHEN_REQUIRED), so presigned URLs carry no automatic checksum
 * parameters (V-03, V-09). Only the endpoint differs.
 */
export function createStorageClient(
  config: ConfigType<typeof storageConfig>,
  endpoint: string,
  timeouts: StorageHttpTimeouts = DEFAULT_TIMEOUTS,
): S3Client {
  return new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: {
      connectionTimeout: timeouts.connectionMs,
      socketTimeout: timeouts.socketIdleMs,
    },
  });
}
