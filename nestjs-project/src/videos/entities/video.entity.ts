import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { bigintNumberTransformer } from '../../database/bigint-number.transformer';
import { UploadSession } from './upload-session.entity';

/** Lifecycle of a video (TD-04). Transitions follow P1 to P5 of the plan's Data Model. */
export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  ERROR = 'error',
}

/** Queue action recorded in the database and not yet confirmed (P2, P5). There is no `retry`. */
export enum VideoPendingJobAction {
  PUBLISH = 'publish',
  REPUBLISH = 'republish',
}

@Entity('videos')
@Check('CHK_videos_size_bytes_positive', '"size_bytes" > 0')
@Index('IDX_videos_status_processing_started_at', [
  'status',
  'processing_started_at',
])
@Index('IDX_videos_pending_job_expires_at', ['pending_job_expires_at'], {
  where: '"pending_job_action" IS NOT NULL',
})
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 11, unique: true })
  public_id: string;

  @Index('IDX_videos_channel_id')
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.DRAFT })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 32 })
  content_type: string;

  @Column({ type: 'bigint', transformer: bigintNumberTransformer })
  size_bytes: number;

  @Column({ type: 'uuid', nullable: true })
  current_upload_session_id: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  original_key: string | null;

  @Column({ type: 'integer', default: 0 })
  processing_run: number;

  @Column({ type: 'timestamptz', nullable: true })
  processing_started_at: Date | null;

  @Column({ type: 'integer', default: 0 })
  processing_dispatch: number;

  @Column({ type: 'uuid', nullable: true })
  current_attempt_id: string | null;

  @Column({ type: 'integer', nullable: true })
  attempt_fence_dispatch: number | null;

  @Column({ type: 'integer', nullable: true })
  attempt_fence_seq: number | null;

  @Column({ type: 'integer', default: 0 })
  processing_recoveries: number;

  @Column({ type: 'enum', enum: VideoPendingJobAction, nullable: true })
  pending_job_action: VideoPendingJobAction | null;

  @Column({ type: 'integer', nullable: true })
  pending_job_dispatch: number | null;

  @Column({ type: 'uuid', nullable: true })
  pending_job_token: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  pending_job_expires_at: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_key: string | null;

  /** `numeric` is returned by the driver as a string, kept as is (ffprobe also reports a string). */
  @Column({ type: 'numeric', precision: 12, scale: 3, nullable: true })
  duration_seconds: string | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  media_format: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  video_codec: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  audio_codec: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  error_code: string | null;

  @Column({ type: 'text', nullable: true })
  error_message: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;

  @OneToMany(() => UploadSession, (session) => session.video)
  upload_sessions: UploadSession[];

  /** Current session of the video; it only changes in step T1 of P1. */
  @ManyToOne(() => UploadSession, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'current_upload_session_id' })
  current_upload_session: UploadSession | null;
}
