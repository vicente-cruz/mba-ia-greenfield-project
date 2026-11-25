import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { UploadSession } from './upload-session.entity';

@Entity('upload_parts')
@Unique('UQ_upload_parts_session_part_number', [
  'upload_session_id',
  'part_number',
])
@Check('CHK_upload_parts_part_number_min', '"part_number" >= 1')
export class UploadPart {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  upload_session_id: string;

  /** At most `part_count`, checked in the service. */
  @Column({ type: 'integer' })
  part_number: number;

  /** `min(part_size, size_bytes - (part_number - 1) * part_size)`, always at least 1 byte. */
  @Column({ type: 'integer' })
  expected_size: number;

  /**
   * SHA-256 declared for the part, base64 with padding (the `x-amz-checksum-sha256` format).
   * Immutable once written: `save()` never updates it.
   */
  @Column({ type: 'char', length: 44, update: false })
  checksum_sha256: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  etag: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  etag_registered_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @ManyToOne(() => UploadSession, (session) => session.parts, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'upload_session_id' })
  upload_session: UploadSession;
}
