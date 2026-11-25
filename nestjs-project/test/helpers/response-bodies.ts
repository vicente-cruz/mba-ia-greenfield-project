import type { Response } from 'supertest';
import type { JwtPayload } from '../../src/auth/auth.types';
import type { ApiErrorEnvelope } from '../../src/common/openapi/api-error-envelope.dto';

/**
 * supertest types `res.body` as `any`. These accessors give each response
 * the type of the HTTP contract the endpoint declares, at a single boundary.
 */

/** Body of `POST /auth/register` (201). */
export interface RegisteredUserBody {
  id: string;
  email: string;
}

/** Body of `POST /auth/login` and `POST /auth/refresh` (200). */
export interface AuthTokensBody {
  access_token: string;
  refresh_token: string;
}

export function registeredUserBody(res: Response): RegisteredUserBody {
  return res.body as RegisteredUserBody;
}

export function authTokensBody(res: Response): AuthTokensBody {
  return res.body as AuthTokensBody;
}

/** Body of `GET /auth/me` (200). */
export function currentUserBody(res: Response): JwtPayload {
  return res.body as JwtPayload;
}

/** Error envelope produced by the global exception filters. */
export function errorBody(res: Response): ApiErrorEnvelope {
  return res.body as ApiErrorEnvelope;
}

/** Body of `POST /videos` (201), with the date as it arrives in JSON. */
export interface VideoUploadSessionBody {
  publicId: string;
  status: string;
  uploadSession: {
    id: string;
    status: string;
    partSize: number;
    partCount: number;
    checksumAlgorithm: string;
    expiresAt: string;
  };
}

export function videoUploadSessionBody(res: Response): VideoUploadSessionBody {
  return res.body as VideoUploadSessionBody;
}

/** Body of `POST /videos/:publicId/upload-sessions/:sessionId/part-urls` (200). */
export interface PartUrlsBody {
  parts: {
    partNumber: number;
    url: string;
    method: string;
    expectedSize: number;
    headers: Record<string, string>;
    expiresAt: string;
  }[];
  registeredParts: number[];
}

export function partUrlsBody(res: Response): PartUrlsBody {
  return res.body as PartUrlsBody;
}

/** Body of `GET /videos/:publicId/upload-sessions/:sessionId` (200). */
export interface UploadSessionBody {
  id: string;
  status: string;
  expired: boolean;
  fileMismatch: boolean;
  partSize: number;
  partCount: number;
  checksumAlgorithm: string;
  expiresAt: string;
  parts: {
    partNumber: number;
    state: string;
    checksumSha256: string | null;
    etag: string | null;
  }[];
}

export function uploadSessionBody(res: Response): UploadSessionBody {
  return res.body as UploadSessionBody;
}
