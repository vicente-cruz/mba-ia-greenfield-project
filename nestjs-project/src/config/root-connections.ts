import type { BullRootModuleOptions } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import type databaseConfig from './database.config';
import type queueConfig from './queue.config';

/**
 * Connection options shared by the two root modules, the API (`AppModule`) and the worker
 * (`WorkerModule`, SI-03.20), so both processes always reach the database and the Redis the same
 * way. Hosts are Compose service names, never localhost.
 */
export function typeOrmRootOptions(
  dbConfig: ConfigType<typeof databaseConfig>,
): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: dbConfig.host,
    port: dbConfig.port,
    username: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.name,
    autoLoadEntities: true,
    synchronize: false,
  };
}

/** The single BullMQ connection of a process (TD-09); the queues are registered by their modules. */
export function bullRootOptions(
  config: ConfigType<typeof queueConfig>,
): BullRootModuleOptions {
  return {
    connection: { host: config.redis.host, port: config.redis.port },
  };
}
