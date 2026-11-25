import { S3Client } from '@aws-sdk/client-s3';
import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { createStorageClient } from './storage.clients';
import {
  STORAGE_INTERNAL_CLIENT,
  STORAGE_PUBLIC_CLIENT,
} from './storage.constants';
import { StorageService } from './storage.service';

@Module({
  providers: [
    {
      provide: STORAGE_INTERNAL_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        createStorageClient(config, config.endpoint),
    },
    {
      provide: STORAGE_PUBLIC_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        createStorageClient(config, config.publicEndpoint),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule implements OnModuleDestroy {
  constructor(
    @Inject(STORAGE_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(STORAGE_PUBLIC_CLIENT) private readonly publicClient: S3Client,
  ) {}

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }
}
