import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { UploadSession } from '../videos/entities/upload-session.entity';
import { UploadPart } from '../videos/entities/upload-part.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideosAndUploadSessions1795372377927 } from './migrations/1795372377927-CreateVideosAndUploadSessions';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
  'upload_sessions',
  'upload_parts',
];

const PHASE_03_TABLES = ['upload_parts', 'upload_sessions', 'videos'];

const PHASE_03_ENUMS = [
  'upload_sessions_status_enum',
  'videos_pending_job_action_enum',
  'videos_status_enum',
];

// Os enums são objetos separados das tabelas.
const MANAGED_ENUMS = ['verification_tokens_type_enum', ...PHASE_03_ENUMS];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  async function existingTables(tables: string[]): Promise<string[]> {
    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [tables],
    );
    return result.map((r) => r.table_name);
  }

  async function existingEnums(enums: string[]): Promise<string[]> {
    const result = await dataSource.query<{ typname: string }[]>(
      `SELECT t.typname FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public'
         AND t.typname = ANY($1::text[])
       ORDER BY t.typname`,
      [enums],
    );
    return result.map((r) => r.typname);
  }

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [
        User,
        Channel,
        RefreshToken,
        VerificationToken,
        Video,
        UploadSession,
        UploadPart,
      ],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideosAndUploadSessions1795372377927,
        ],
      },
    );

    await dataSource.initialize();

    // Remove as tabelas em sequência.
    for (const table of MANAGED_TABLES) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    await dataSource.query('DROP TABLE IF EXISTS "migrations"');

    for (const enumName of MANAGED_ENUMS) {
      await dataSource.query(`DROP TYPE IF EXISTS "public"."${enumName}"`);
    }
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) {
      return;
    }

    try {
      // Restaura as migrations para as próximas suítes e remove os dados semeados aqui.
      await dataSource.runMigrations();
      await cleanAllTables(dataSource);
    } finally {
      // Fecha a conexão mesmo se a restauração falhar.
      await dataSource.destroy();
    }
  });

  it('should apply all migrations and create all managed tables and enums', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);
    await expect(existingTables(MANAGED_TABLES)).resolves.toEqual([
      'channels',
      'refresh_tokens',
      'upload_parts',
      'upload_sessions',
      'users',
      'verification_tokens',
      'videos',
    ]);
    await expect(existingEnums(MANAGED_ENUMS)).resolves.toEqual([
      'upload_sessions_status_enum',
      'verification_tokens_type_enum',
      'videos_pending_job_action_enum',
      'videos_status_enum',
    ]);
  });

  it('should create the circular foreign keys and the partial indexes of the phase', async () => {
    const foreignKeys = await dataSource.query<
      {
        table_name: string;
        column_name: string;
        target: string;
        rule: string;
      }[]
    >(
      `SELECT tc.table_name, kcu.column_name, ccu.table_name AS target, rc.delete_rule AS rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_name = ANY($1::text[])
       ORDER BY tc.table_name, kcu.column_name`,
      [PHASE_03_TABLES],
    );
    expect(foreignKeys).toEqual([
      {
        table_name: 'upload_parts',
        column_name: 'upload_session_id',
        target: 'upload_sessions',
        rule: 'CASCADE',
      },
      {
        table_name: 'upload_sessions',
        column_name: 'video_id',
        target: 'videos',
        rule: 'CASCADE',
      },
      {
        table_name: 'videos',
        column_name: 'channel_id',
        target: 'channels',
        rule: 'RESTRICT',
      },
      {
        table_name: 'videos',
        column_name: 'current_upload_session_id',
        target: 'upload_sessions',
        rule: 'SET NULL',
      },
    ]);

    const partialIndexes = await dataSource.query<
      { indexname: string; indexdef: string }[]
    >(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = ANY($1::text[])
         AND indexdef LIKE '% WHERE %'
       ORDER BY indexname`,
      [PHASE_03_TABLES],
    );
    expect(partialIndexes.map((index) => index.indexname)).toEqual([
      'IDX_videos_pending_job_expires_at',
      'UQ_upload_sessions_video_id_active',
    ]);
    expect(partialIndexes[0].indexdef).toMatch(
      /^CREATE INDEX .* ON public\.videos USING btree \(pending_job_expires_at\) WHERE \(pending_job_action IS NOT NULL\)$/,
    );
    expect(partialIndexes[1].indexdef).toMatch(
      /^CREATE UNIQUE INDEX .* ON public\.upload_sessions USING btree \(video_id\) WHERE \(status = 'active'::upload_sessions_status_enum\)$/,
    );
  });

  it('should revert the phase 03 migration and keep the earlier tables and their rows', async () => {
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'migration_keep@example.com', password: 'hashed' });
    await dataSource.getRepository(Channel).save({
      name: 'Kept',
      nickname: 'migration_keep',
      user_id: user.id,
    });

    await dataSource.undoLastMigration();

    await expect(existingTables(MANAGED_TABLES)).resolves.toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
    ]);
    await expect(existingEnums(MANAGED_ENUMS)).resolves.toEqual([
      'verification_tokens_type_enum',
    ]);
    await expect(
      dataSource.query<{ nickname: string }[]>(
        'SELECT c.nickname FROM channels c JOIN users u ON u.id = c.user_id WHERE u.email = $1',
        ['migration_keep@example.com'],
      ),
    ).resolves.toEqual([{ nickname: 'migration_keep' }]);
  });

  it('should reapply the phase 03 migration after the revert', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations.map((m) => m.name)).toEqual([
      'CreateVideosAndUploadSessions1795372377927',
    ]);
    await expect(existingTables(PHASE_03_TABLES)).resolves.toEqual([
      'upload_parts',
      'upload_sessions',
      'videos',
    ]);
    await expect(existingEnums(PHASE_03_ENUMS)).resolves.toEqual(
      PHASE_03_ENUMS,
    );
  });

  it('should revert down to the first migration and remove the token tables', async () => {
    await dataSource.undoLastMigration();
    await dataSource.undoLastMigration();

    await expect(
      existingTables(['refresh_tokens', 'verification_tokens']),
    ).resolves.toEqual([]);
    await expect(existingTables(['users', 'channels'])).resolves.toEqual([
      'channels',
      'users',
    ]);
  });
});
