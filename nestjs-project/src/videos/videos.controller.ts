import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { DownloadUrlResponseDto } from './dto/download-url-response.dto';
import { PlaybackUrlResponseDto } from './dto/playback-url-response.dto';
import { UploadDeclarationDto } from './dto/upload-declaration.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideoUploadSessionResponseDto } from './dto/video-upload-session-response.dto';
import { UploadSessionsService } from './upload-sessions.service';
import { VideosService } from './videos.service';
import { VIDEOS_THROTTLE } from './videos-throttle';

const ERROR_ENVELOPE = { $ref: getSchemaPath(ApiErrorEnvelope) };

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly uploadSessionsService: UploadSessionsService,
    private readonly videosService: VideosService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle(VIDEOS_THROTTLE.CREATE_VIDEO)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a video draft and its first upload session',
    description:
      "Registers the video as a draft in the user's channel and starts a resumable multipart upload, signed part by part afterwards. The video is addressed only by its publicId.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft video and active upload session',
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
    description: 'The user has no channel (CHANNEL_NOT_FOUND)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 413,
    description:
      'sizeBytes above the maximum video size, informed in the message (VIDEO_TOO_LARGE)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 415,
    description:
      'contentType other than video/mp4 or video/webm (UNSUPPORTED_VIDEO_TYPE)',
    schema: ERROR_ENVELOPE,
  })
  @ApiResponse({
    status: 503,
    description:
      'The storage could not start the upload; no usable session was created (STORAGE_UNAVAILABLE)',
    schema: ERROR_ENVELOPE,
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UploadDeclarationDto,
  ): Promise<VideoUploadSessionResponseDto> {
    return this.uploadSessionsService.createVideoWithSession(user.sub, dto);
  }

  @Get(':publicId')
  @Throttle(VIDEOS_THROTTLE.GET_VIDEO)
  @ApiBearerAuth('access-token')
  @ApiParam({
    name: 'publicId',
    description: 'Public id of the video, 11 base64url characters',
  })
  @ApiOperation({
    summary: 'Get the state and the metadata of a video',
    description:
      'Returns the state of the video, the metadata extracted by the processing and its current upload session, for the owner. It is the route of the polling while the video is processed.',
  })
  @ApiResponse({
    status: 200,
    description: 'State, metadata and current upload session of the video',
    type: VideoResponseDto,
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
  async getOwnVideo(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.getOwnVideo(user.sub, publicId);
  }

  @Get(':publicId/playback-url')
  @Throttle(VIDEOS_THROTTLE.GET_PLAYBACK_URL)
  @ApiBearerAuth('access-token')
  @ApiParam({
    name: 'publicId',
    description: 'Public id of the video, 11 base64url characters',
  })
  @ApiOperation({
    summary: 'Get a short-lived URL to play a ready video',
    description:
      'Issues a presigned GET of the original on the public storage endpoint, valid for PLAYBACK_URL_TTL_SECONDS, for the owner of a ready video. The video is played by progressive download: the storage answers Range requests with 206 Partial Content and Content-Range, and the bytes never pass through the API. Request a new URL when it expires.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned playback URL, its content type and its expiry',
    type: PlaybackUrlResponseDto,
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
    description: 'The video is not ready (VIDEO_NOT_READY)',
    schema: ERROR_ENVELOPE,
  })
  async getPlaybackUrl(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<PlaybackUrlResponseDto> {
    return this.videosService.getPlaybackUrl(user.sub, publicId);
  }

  @Get(':publicId/download-url')
  @Throttle(VIDEOS_THROTTLE.GET_DOWNLOAD_URL)
  @ApiBearerAuth('access-token')
  @ApiParam({
    name: 'publicId',
    description: 'Public id of the video, 11 base64url characters',
  })
  @ApiOperation({
    summary: 'Get a short-lived URL to download the original of a ready video',
    description:
      'Issues a presigned GET of the original on the public storage endpoint, valid for DOWNLOAD_URL_TTL_SECONDS, for the owner of a ready video. The storage answers it as an attachment named after the original file name (filename* in UTF-8, with an ASCII fallback in filename; RFC 6266), and the bytes never pass through the API.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL and its expiry',
    type: DownloadUrlResponseDto,
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
    description: 'The video is not ready (VIDEO_NOT_READY)',
    schema: ERROR_ENVELOPE,
  })
  async getDownloadUrl(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<DownloadUrlResponseDto> {
    return this.videosService.getDownloadUrl(user.sub, publicId);
  }
}
