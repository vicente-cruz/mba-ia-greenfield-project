import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideosAndUploadSessions1795372377927 implements MigrationInterface {
  name = 'CreateVideosAndUploadSessions1795372377927';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "upload_parts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "upload_session_id" uuid NOT NULL, "part_number" integer NOT NULL, "expected_size" integer NOT NULL, "checksum_sha256" character(44) NOT NULL, "etag" character varying(255), "etag_registered_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_upload_parts_session_part_number" UNIQUE ("upload_session_id", "part_number"), CONSTRAINT "CHK_upload_parts_part_number_min" CHECK ("part_number" >= 1), CONSTRAINT "PK_c30e5bea8d9b5f4805eac5b104a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."upload_sessions_status_enum" AS ENUM('initiating', 'active', 'completing', 'completed', 'aborting', 'aborted')`,
    );
    await queryRunner.query(
      `CREATE TABLE "upload_sessions" ("id" uuid NOT NULL, "video_id" uuid NOT NULL, "object_key" character varying(255) NOT NULL, "upload_id" text, "status" "public"."upload_sessions_status_enum" NOT NULL DEFAULT 'initiating', "size_bytes" bigint NOT NULL, "part_size" integer NOT NULL, "part_count" integer NOT NULL, "checksum_algorithm" character varying(16) NOT NULL DEFAULT 'SHA256', "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "claim_token" uuid, "claim_expires_at" TIMESTAMP WITH TIME ZONE, "file_mismatch_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_7c9ec3c51813238ec19daa0b294" UNIQUE ("object_key"), CONSTRAINT "PK_4b6ca30b8bb2baa0de9c6bf8fea" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_upload_sessions_video_id_active" ON "upload_sessions" ("video_id") WHERE "status" = 'active'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_upload_sessions_status_claim_expires_at" ON "upload_sessions" ("status", "claim_expires_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_upload_sessions_status_expires_at" ON "upload_sessions" ("status", "expires_at") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'error')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."videos_pending_job_action_enum" AS ENUM('publish', 'republish')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "public_id" character varying(11) NOT NULL, "channel_id" uuid NOT NULL, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "original_filename" character varying(255) NOT NULL, "content_type" character varying(32) NOT NULL, "size_bytes" bigint NOT NULL, "current_upload_session_id" uuid, "original_key" character varying(255), "processing_run" integer NOT NULL DEFAULT '0', "processing_started_at" TIMESTAMP WITH TIME ZONE, "processing_dispatch" integer NOT NULL DEFAULT '0', "current_attempt_id" uuid, "attempt_fence_dispatch" integer, "attempt_fence_seq" integer, "processing_recoveries" integer NOT NULL DEFAULT '0', "pending_job_action" "public"."videos_pending_job_action_enum", "pending_job_dispatch" integer, "pending_job_token" uuid, "pending_job_expires_at" TIMESTAMP WITH TIME ZONE, "thumbnail_key" character varying(255), "duration_seconds" numeric(12,3), "width" integer, "height" integer, "media_format" character varying(100), "video_codec" character varying(32), "audio_codec" character varying(32), "error_code" character varying(64), "error_message" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_39a1f0fe7991162aace659078ec" UNIQUE ("public_id"), CONSTRAINT "CHK_videos_size_bytes_positive" CHECK ("size_bytes" > 0), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_channel_id" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_pending_job_expires_at" ON "videos" ("pending_job_expires_at") WHERE "pending_job_action" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_status_processing_started_at" ON "videos" ("status", "processing_started_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "upload_parts" ADD CONSTRAINT "FK_9a386252bd218fe8a5e09462ff1" FOREIGN KEY ("upload_session_id") REFERENCES "upload_sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "upload_sessions" ADD CONSTRAINT "FK_a0c9961c327fca4a5cfea37c5fb" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_91d54536ab7324c60db98664dd0" FOREIGN KEY ("current_upload_session_id") REFERENCES "upload_sessions"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_91d54536ab7324c60db98664dd0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `ALTER TABLE "upload_sessions" DROP CONSTRAINT "FK_a0c9961c327fca4a5cfea37c5fb"`,
    );
    await queryRunner.query(
      `ALTER TABLE "upload_parts" DROP CONSTRAINT "FK_9a386252bd218fe8a5e09462ff1"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_videos_status_processing_started_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_videos_pending_job_expires_at"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_videos_channel_id"`);
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(
      `DROP TYPE "public"."videos_pending_job_action_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_upload_sessions_status_expires_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_upload_sessions_status_claim_expires_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_upload_sessions_video_id_active"`,
    );
    await queryRunner.query(`DROP TABLE "upload_sessions"`);
    await queryRunner.query(`DROP TYPE "public"."upload_sessions_status_enum"`);
    await queryRunner.query(`DROP TABLE "upload_parts"`);
  }
}
