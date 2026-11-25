import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { UploadPart } from './entities/upload-part.entity';

export interface PartChecksum {
  partNumber: number;
  checksumSha256: string;
  expectedSize: number;
}

export interface PartEtag {
  partNumber: number;
  etag: string;
}

/**
 * Registry of the parts of a session (G-04). The signing and the ETag batch read and write
 * without locking the video (plan's "Leituras sem bloqueio").
 */
@Injectable()
export class UploadPartsRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Registers the declared checksum of each part once: `INSERT … ON CONFLICT DO NOTHING` on the
   * unique (`upload_session_id`, `part_number`), so a row is never overwritten, even by
   * concurrent requests. Returns the checksum stored for each part after the insert, which is
   * the one of whoever registered first.
   */
  async registerChecksums(
    sessionId: string,
    parts: PartChecksum[],
  ): Promise<Map<number, string>> {
    if (parts.length === 0) {
      return new Map();
    }
    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(UploadPart)
      .values(
        parts.map((part) => ({
          upload_session_id: sessionId,
          part_number: part.partNumber,
          expected_size: part.expectedSize,
          checksum_sha256: part.checksumSha256,
        })),
      )
      .orIgnore()
      .execute();

    const stored = await this.dataSource.getRepository(UploadPart).find({
      select: { part_number: true, checksum_sha256: true },
      where: {
        upload_session_id: sessionId,
        part_number: In(parts.map((part) => part.partNumber)),
      },
    });
    return new Map(stored.map((row) => [row.part_number, row.checksum_sha256]));
  }

  /** The registry of the parts of a session, by part number; read without locking. */
  async findBySession(sessionId: string): Promise<UploadPart[]> {
    return this.dataSource.getRepository(UploadPart).find({
      select: {
        part_number: true,
        expected_size: true,
        checksum_sha256: true,
        etag: true,
      },
      where: { upload_session_id: sessionId },
      order: { part_number: 'ASC' },
    });
  }

  /**
   * Records the ETags reported for parts with a registered checksum, all or nothing. Returns
   * `false`, recording nothing, when any of the parts has no checksum registered. A later ETag of
   * the same part replaces the earlier one (re-upload of the part). Registered parts are never
   * removed while their session exists, so checking first and updating after is safe.
   */
  async registerEtags(sessionId: string, parts: PartEtag[]): Promise<boolean> {
    if (parts.length === 0) {
      return true;
    }
    const partNumbers = parts.map((part) => part.partNumber);
    const signed = await this.dataSource.getRepository(UploadPart).count({
      where: { upload_session_id: sessionId, part_number: In(partNumbers) },
    });
    if (signed !== parts.length) {
      return false;
    }
    // One statement for the whole batch. Raw SQL does not get `updated_at` from TypeORM, so it is
    // set here (SI-03.10).
    await this.dataSource.query(
      `UPDATE upload_parts AS part
          SET etag = reported.etag,
              etag_registered_at = now(),
              updated_at = now()
         FROM unnest($2::int[], $3::varchar[]) AS reported(part_number, etag)
        WHERE part.upload_session_id = $1
          AND part.part_number = reported.part_number`,
      [sessionId, partNumbers, parts.map((part) => part.etag)],
    );
    return true;
  }
}
