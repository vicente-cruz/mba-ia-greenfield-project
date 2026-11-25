import { createTestDataSource } from './create-test-data-source';

// Regressão da D-08: o auxiliar lê o nome do banco de DB_NAME, a chave do projeto
// (database.config.ts e env.validation.ts), e não de DB_DATABASE. O DataSource é só
// construído; nenhuma conexão é aberta com os bancos fictícios abaixo.
describe('createTestDataSource', () => {
  const keys = ['DB_NAME', 'DB_DATABASE'] as const;
  const original: Partial<Record<(typeof keys)[number], string>> = {};

  beforeEach(() => {
    for (const key of keys) {
      original[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  });

  it('should configure the database name from DB_NAME, not DB_DATABASE', () => {
    process.env.DB_NAME = 'd08_name_from_db_name';
    process.env.DB_DATABASE = 'd08_name_from_db_database';

    const dataSource = createTestDataSource([]);

    expect(dataSource.options).toMatchObject({
      type: 'postgres',
      database: 'd08_name_from_db_name',
    });
    expect(dataSource.isInitialized).toBe(false);
  });

  it('should keep the streamtube default when DB_NAME is unset, ignoring DB_DATABASE', () => {
    delete process.env.DB_NAME;
    process.env.DB_DATABASE = 'd08_name_from_db_database';

    const dataSource = createTestDataSource([]);

    expect(dataSource.options).toMatchObject({ database: 'streamtube' });
    expect(dataSource.isInitialized).toBe(false);
  });
});
