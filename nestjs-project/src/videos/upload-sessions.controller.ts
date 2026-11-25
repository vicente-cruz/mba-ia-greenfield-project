import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { FileVerificationsRequestDto } from './dto/file-verifications.dto';
import { FileVerificationsResponseDto } from './dto/file-verifications-response.dto';
import { PartUrlsRequestDto } from './dto/part-urls.dto';
import { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import { UploadCompletionResponseDto } from './dto/upload-completion-response.dto';
import { UploadDeclarationDto } from './dto/upload-declaration.dto';
import { UploadSessionResponseDto } from './dto/upload-session-response.dto';
import { VideoUploadSessionResponseDto } from './dto/video-upload-session-response.dto';
import { UploadCompletionService } from './upload-completion.service';
import { UploadPartsService } from './upload-parts.service';
import { UploadSessionsService } from './upload-sessions.service';
import { VIDEOS_THROTTLE } from './videos-throttle';

const ERROR_ENVELOPE = { $ref: getSchemaPath(ApiErrorEnvelope) };

/** Upload sessions of a video, addressed by the publicId of the video. */
@ApiTags('videos')
@ApiParam({
  name: 'publicId',
  description: 'Public id of the video, 11 base64url characters',
})
@Controller('videos/:publicId/upload-sessions')
export class UploadSessionsController {
  constructor(
    private readonly uploadSessionsService: UploadSessionsService,
    private readonly uploadPartsService: UploadPartsService,
    private readonly uploadCompletionService: UploadCompletionService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle(VIDEOS_THROTTLE.RESTART_UPLOAD_SESSION)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Restart the upload of a draft video',
    description:
      'Creates a new upload session, with a new key for the original, for a draft video, and aborts the previous session. The video declares the new file. The new session starts without the file mismatch block of the previous one.',
  })
  @ApiResponse({
    status: 201,
    description: 'New active session, ready to sign parts',
    type: VideoUploadSessionResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or of another channel (VIDEO_NOT_FOUND)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 409,
    description:
      'The video is not a draft (VIDEO_INVALID_STATE), its current session is completing (UPLOAD_SESSION_COMPLETING) or being created (UPLOAD_SESSION_INITIATING), or the activation lost the new session to another restart (UPLOAD_SESSION_NOT_ACTIVE)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 413,
    description: 'The file is larger than the limit (VIDEO_TOO_LARGE)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 415,
    description: 'Unsupported content type (UNSUPPORTED_VIDEO_TYPE)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 503,
    description:
      'Transient failure of the storage (STORAGE_UNAVAILABLE); the new session ends aborted and the video stays a restartable draft',
    schema: ERROR_ENVELOPE,
  })
  async restartSession(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: UploadDeclarationDto,
  ): Promise<VideoUploadSessionResponseDto> {
    return this.uploadSessionsService.restartSession(user.sub, publicId, dto);
  }

  @Get(':sessionId')
  @Throttle(VIDEOS_THROTTLE.GET_UPLOAD_SESSION)
  @ApiBearerAuth('access-token')
  @ApiParam({
    name: 'sessionId',
    description: 'Id of the upload session (UUID)',
  })
  @ApiOperation({
    summary: 'Get the upload session and the state of its parts',
    description:
      'Returns the state of the session and, for an active session, one entry per part of the plan, classified against the parts listed by the storage. It is the base of the resumption.',
  })
  @ApiResponse({
    status: 200,
    description: 'State of the session and its classified parts',
    type: UploadSessionResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 404,
    description:
      'Video not found or of another channel (VIDEO_NOT_FOUND), or session not found (UPLOAD_SESSION_NOT_FOUND)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 410,
    description:
      'The storage no longer knows the upload of the active session, which is aborted (UPLOAD_SESSION_EXPIRED)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 503,
    description:
      'The storage could not list the parts (STORAGE_UNAVAILABLE); the session is not changed',
    schema: ERROR_ENVELOPE,
  })
  async getSession(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Param('sessionId') sessionId: string,
  ): Promise<UploadSessionResponseDto> {
    return this.uploadSessionsService.getSession(user.sub, publicId, sessionId);
  }

  @Post(':sessionId/part-urls')
  @HttpCode(HttpStatus.OK)
  @Throttle(VIDEOS_THROTTLE.SIGN_PART_URLS)
  @ApiBearerAuth('access-token')
  @ApiParam({
    name: 'sessionId',
    description: 'Id of the upload session (UUID)',
  })
  @ApiOperation({
    summary: 'Sign upload parts and register ETags',
    description:
      'Signs, in one batch, the PUT of each part with its exact size and its SHA-256, and registers the ETags of the parts already sent. The bytes go from the browser straight to the storage.',
  })
  @ApiResponse({
    status: 200,
    description: 'Signed parts and the parts whose ETag was registered',
    type: PartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed, or a part number above partCount or repeated in the batch (INVALID_PART_NUMBER)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 404,
    description:
      'Video not found or of another channel (VIDEO_NOT_FOUND), or session not found (UPLOAD_SESSION_NOT_FOUND)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 409,
    description:
      'Session not current or not active (UPLOAD_SESSION_NOT_ACTIVE), checksum different from the registered one or session blocked (UPLOAD_FILE_MISMATCH), or ETag of a part never signed (UPLOAD_PART_NOT_SIGNED)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 410,
    description: 'The session has expired (UPLOAD_SESSION_EXPIRED)',
    schema: ERROR_ENVELOPE,
  })
  async requestPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: PartUrlsRequestDto,
  ): Promise<PartUrlsResponseDto> {
    return this.uploadPartsService.requestPartUrls(
      user.sub,
      publicId,
      sessionId,
      dto,
    );
  }

  @Post(':sessionId/file-verifications')
  @HttpCode(HttpStatus.OK)
  @Throttle(VIDEOS_THROTTLE.VERIFY_UPLOAD_FILE)
  @ApiBearerAuth('access-token')
  @ApiParam({
    name: 'sessionId',
    description: 'Id of the upload session (UUID)',
  })
  @ApiOperation({
    summary: 'Verify the file selected again on the resumption',
    description:
      'Compares the SHA-256 recalculated for every part already received (confirmed and unregistered) with the registered checksums. A different checksum blocks the session until an explicit restart.',
  })
  @ApiResponse({
    status: 200,
    description: 'The file is the same',
    type: FileVerificationsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed, a part outside the plan or without a registered checksum (INVALID_PART_NUMBER), or a part already received left out (UPLOAD_VERIFICATION_INCOMPLETE)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 404,
    description:
      'Video not found or of another channel (VIDEO_NOT_FOUND), or session not found (UPLOAD_SESSION_NOT_FOUND)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 409,
    description:
      'Session not current or not active (UPLOAD_SESSION_NOT_ACTIVE), or a checksum different from the registered one, which blocks the session, or a session already blocked (UPLOAD_FILE_MISMATCH)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 410,
    description:
      'The session has expired, or the storage no longer knows its upload (UPLOAD_SESSION_EXPIRED)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 503,
    description:
      'The storage could not list the parts (STORAGE_UNAVAILABLE); nothing is recorded',
    schema: ERROR_ENVELOPE,
  })
  async verifyFile(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: FileVerificationsRequestDto,
  ): Promise<FileVerificationsResponseDto> {
    return this.uploadPartsService.verifyFile(
      user.sub,
      publicId,
      sessionId,
      dto.parts,
    );
  }

  @Post(':sessionId/completion')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(VIDEOS_THROTTLE.COMPLETE_UPLOAD)
  @ApiBearerAuth('access-token')
  @ApiParam({
    name: 'sessionId',
    description: 'Id of the upload session (UUID)',
  })
  @ApiOperation({
    summary: 'Complete the upload',
    description:
      'Checks every part against the storage, completes the multipart upload from the registered parts and moves the video to processing, publishing its processing job. Repeating the call after the success returns the current state of the video.',
  })
  @ApiResponse({
    status: 202,
    description:
      'This call completed the upload and moved the video to processing',
    type: UploadCompletionResponseDto,
  })
  @ApiResponse({
    status: 200,
    description:
      'The session was already completed as the current one of the video; current state of the video',
    type: UploadCompletionResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 404,
    description:
      'Video not found or of another channel (VIDEO_NOT_FOUND), or session not found (UPLOAD_SESSION_NOT_FOUND)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 409,
    description:
      'Another completion is in progress (UPLOAD_SESSION_COMPLETING), the completion was reverted by another call (UPLOAD_COMPLETION_INTERRUPTED), a part is missing or has no registered ETag (UPLOAD_INCOMPLETE), the storage differs from the registry (UPLOAD_PART_MISMATCH), the session is blocked (UPLOAD_FILE_MISMATCH), or it is not the current active session (UPLOAD_SESSION_NOT_ACTIVE)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 410,
    description:
      'The session has expired, or the storage no longer has its upload nor the completed object (UPLOAD_SESSION_EXPIRED)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 503,
    description:
      'Transient failure of the storage (STORAGE_UNAVAILABLE); the claim expires and the next call resumes',
    schema: ERROR_ENVELOPE,
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Param('sessionId') sessionId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UploadCompletionResponseDto> {
    const { transitioned, body } =
      await this.uploadCompletionService.completeUpload(
        user.sub,
        publicId,
        sessionId,
      );
    if (!transitioned) {
      res.status(HttpStatus.OK);
    }
    return body;
  }

  @Delete(':sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(VIDEOS_THROTTLE.ABORT_UPLOAD_SESSION)
  @ApiBearerAuth('access-token')
  @ApiParam({
    name: 'sessionId',
    description: 'Id of the upload session (UUID)',
  })
  @ApiOperation({
    summary: 'Abort the upload session',
    description:
      'Claims the session for abort and aborts its multipart upload in the storage until the storage confirms that it is gone. The video stays in draft and can restart the upload. Repeating the call on an aborted session has no new effect.',
  })
  @ApiResponse({
    status: 204,
    description:
      'The session is aborted, or stays aborting while a part in transit prevents the confirmation; the sweep concludes it',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 404,
    description:
      'Video not found or of another channel (VIDEO_NOT_FOUND), or session not found (UPLOAD_SESSION_NOT_FOUND)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 409,
    description:
      'The session is completing (UPLOAD_SESSION_COMPLETING), is being created (UPLOAD_SESSION_INITIATING), or is completed (UPLOAD_SESSION_NOT_ACTIVE)',
    schema: ERROR_ENVELOPE,
  })
  async abortSession(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Param('sessionId') sessionId: string,
  ): Promise<void> {
    await this.uploadSessionsService.abortSession(
      user.sub,
      publicId,
      sessionId,
    );
  }
}
