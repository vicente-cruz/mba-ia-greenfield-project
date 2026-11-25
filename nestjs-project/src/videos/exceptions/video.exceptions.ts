import { DomainException } from '../../common/exceptions/domain.exception';

/*
 * One subclass per HTTP code of the plan's "Error Catalog", mapped by the DomainExceptionFilter to
 * the inherited envelope (phase-02-auth/TD-07). STORAGE_UNAVAILABLE (503) is the
 * StorageUnavailableException of the storage module, reused here and not redefined.
 */

// ---- 404 ----

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'The user has no channel');
  }
}

/** Also for a malformed publicId or a video of another channel, without revealing which. */
export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

/** Also for a malformed sessionId or a session of another video. */
export class UploadSessionNotFoundException extends DomainException {
  constructor() {
    super('UPLOAD_SESSION_NOT_FOUND', 404, 'Upload session not found');
  }
}

// ---- 413 and 415 (domain rules, applied after the structural validation) ----

export class VideoTooLargeException extends DomainException {
  constructor(maxSizeBytes: number) {
    super(
      'VIDEO_TOO_LARGE',
      413,
      `Video size exceeds the limit of ${maxSizeBytes} bytes`,
    );
  }
}

export class UnsupportedVideoTypeException extends DomainException {
  constructor() {
    super(
      'UNSUPPORTED_VIDEO_TYPE',
      415,
      'Video type is not supported; use video/mp4 or video/webm',
    );
  }
}

// ---- 409 ----

export class VideoInvalidStateException extends DomainException {
  constructor() {
    super(
      'VIDEO_INVALID_STATE',
      409,
      'Video is not in a state that accepts this operation',
    );
  }
}

export class UploadSessionNotActiveException extends DomainException {
  constructor() {
    super(
      'UPLOAD_SESSION_NOT_ACTIVE',
      409,
      'Upload session is not the active session of the video',
    );
  }
}

export class UploadSessionCompletingException extends DomainException {
  constructor() {
    super(
      'UPLOAD_SESSION_COMPLETING',
      409,
      'Upload session completion is in progress',
    );
  }
}

export class UploadSessionInitiatingException extends DomainException {
  constructor() {
    super(
      'UPLOAD_SESSION_INITIATING',
      409,
      'Upload session creation is in progress',
    );
  }
}

export class UploadCompletionInterruptedException extends DomainException {
  constructor() {
    super(
      'UPLOAD_COMPLETION_INTERRUPTED',
      409,
      'Upload completion was interrupted; the session is active again',
    );
  }
}

export class UploadFileMismatchException extends DomainException {
  constructor() {
    super(
      'UPLOAD_FILE_MISMATCH',
      409,
      'The file does not match the parts registered for this upload session',
    );
  }
}

export class UploadPartNotSignedException extends DomainException {
  constructor() {
    super(
      'UPLOAD_PART_NOT_SIGNED',
      409,
      'An ETag was reported for a part without a registered checksum',
    );
  }
}

export class UploadIncompleteException extends DomainException {
  constructor() {
    super(
      'UPLOAD_INCOMPLETE',
      409,
      'Some parts of the upload are missing or have no registered ETag',
    );
  }
}

export class UploadPartMismatchException extends DomainException {
  constructor() {
    super(
      'UPLOAD_PART_MISMATCH',
      409,
      'The parts in storage do not match the registered parts',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready');
  }
}

// ---- 410 ----

export class UploadSessionExpiredException extends DomainException {
  constructor() {
    super('UPLOAD_SESSION_EXPIRED', 410, 'Upload session has expired');
  }
}

// ---- 400 (domain rules that depend on the session) ----

export class InvalidPartNumberException extends DomainException {
  constructor() {
    super(
      'INVALID_PART_NUMBER',
      400,
      'Part number is out of range, repeated or has no registered checksum',
    );
  }
}

export class UploadVerificationIncompleteException extends DomainException {
  constructor() {
    super(
      'UPLOAD_VERIFICATION_INCOMPLETE',
      400,
      'Every part must be confirmed or unregistered',
    );
  }
}

/**
 * Codes persisted in `videos.error_code` ("Error Catalog → Códigos persistidos"). They are not
 * HTTP responses; they appear in `GET /videos/:publicId`.
 */
export const VIDEO_ERROR_CODES = {
  MEDIA_INVALID: 'MEDIA_INVALID',
  MEDIA_CONTAINER_MISMATCH: 'MEDIA_CONTAINER_MISMATCH',
  MEDIA_UNSUPPORTED_CODEC: 'MEDIA_UNSUPPORTED_CODEC',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
  PROCESSING_STALLED: 'PROCESSING_STALLED',
  PROCESSING_INCONSISTENT: 'PROCESSING_INCONSISTENT',
} as const;

export type VideoErrorCode =
  (typeof VIDEO_ERROR_CODES)[keyof typeof VIDEO_ERROR_CODES];
