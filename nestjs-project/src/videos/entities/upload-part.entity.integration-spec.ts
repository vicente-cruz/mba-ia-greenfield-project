import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { captureQueryError } from '../../test/query-error';
import {
  buildUploadPart,
  buildUploadSession,
  buildVideo,
  saveTestChannel,
} from '../../test/video-entity-fixtures';
import { User } from '../../users/entities/user.entity';
import { UploadPart } from './upload-part.entity';
import { UploadSession } from './upload-session.entity';
import { Video } from './video.entity';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  UploadPart,
];

describe('UploadPart entity (integration)', () => {
  let dataSource: DataSource;
  let sessionRepository: Repository<UploadSession>;
  let partRepository: Repository<UploadPart>;
  let videoId: string;
  let sessionId: string;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    sessionRepository = dataSource.getRepository(UploadSession);
    partRepository = dataSource.getRepository(UploadPart);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  async function saveSession(): Promise<string> {
    const session = buildUploadSession(videoId);
    await sessionRepository.insert(session);
    return session.id as string;
  }

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const channel = await saveTestChannel(dataSource);
    const { identifiers } = await dataSource
      .getRepository(Video)
      .insert(buildVideo(channel.id));
    videoId = identifiers[0].id as string;
    sessionId = await saveSession();
  });

  it('should reject a second part with the same number in the same session', async () => {
    await partRepository.insert(buildUploadPart(sessionId, { part_number: 3 }));

    await expect(
      captureQueryError(
        partRepository.insert(buildUploadPart(sessionId, { part_number: 3 })),
      ),
    ).resolves.toMatchObject({
      code: '23505',
      constraint: 'UQ_upload_parts_session_part_number',
    });
  });

  it('should accept the same part number in another session', async () => {
    const otherSessionId = await saveSession();

    await partRepository.insert([
      buildUploadPart(sessionId, { part_number: 1 }),
      buildUploadPart(otherSessionId, { part_number: 1 }),
    ]);

    await expect(partRepository.countBy({ part_number: 1 })).resolves.toBe(2);
  });

  it.each([0, -1])('should reject part_number = %i', async (partNumber) => {
    await expect(
      captureQueryError(
        partRepository.insert(
          buildUploadPart(sessionId, { part_number: partNumber }),
        ),
      ),
    ).resolves.toMatchObject({
      code: '23514',
      constraint: 'CHK_upload_parts_part_number_min',
    });
  });

  it('should delete the parts of a deleted session (CASCADE)', async () => {
    const otherSessionId = await saveSession();
    await partRepository.insert([
      buildUploadPart(sessionId, { part_number: 1 }),
      buildUploadPart(sessionId, { part_number: 2 }),
      buildUploadPart(otherSessionId, { part_number: 1 }),
    ]);

    await sessionRepository.delete({ id: sessionId });

    await expect(
      partRepository.countBy({ upload_session_id: sessionId }),
    ).resolves.toBe(0);
    await expect(
      partRepository.countBy({ upload_session_id: otherSessionId }),
    ).resolves.toBe(1);
  });

  it('should keep the declared checksum when save() changes it, while the ETag is updated', async () => {
    const declared = 'B'.repeat(43) + '=';
    const part = await partRepository.save(
      partRepository.create(
        buildUploadPart(sessionId, { checksum_sha256: declared }),
      ),
    );

    part.checksum_sha256 = 'C'.repeat(43) + '=';
    part.etag = '"etag-1"';
    await partRepository.save(part);

    const stored = await partRepository.findOneByOrFail({ id: part.id });
    expect(stored.checksum_sha256).toBe(declared);
    expect(stored.etag).toBe('"etag-1"');
  });
});
