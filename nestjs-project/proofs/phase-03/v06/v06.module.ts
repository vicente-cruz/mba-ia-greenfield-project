// V-06 — módulo Nest mínimo: BullModule.forRootAsync com o Redis do .env (nome de serviço do
// Compose), registerQueue e o processor WorkerHost. Prefixo exclusivo da prova.
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { V06Processor, V06_QUEUE } from './v06.processor';

export const V06_PREFIX = `proofs-v06-${process.pid}`;

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: Number(config.getOrThrow<string>('REDIS_PORT')),
        },
        prefix: V06_PREFIX,
      }),
    }),
    BullModule.registerQueue({ name: V06_QUEUE }),
  ],
  providers: [V06Processor],
})
export class V06Module {}
