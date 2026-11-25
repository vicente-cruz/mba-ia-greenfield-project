import { registerAs } from '@nestjs/config';
import { STORAGE_DEFAULTS } from './config.constants';

// Two explicit endpoints (TD-07): `endpoint` is used by the API and the worker over the Compose
// network; `publicEndpoint` only signs the URLs handed to the browser.
export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT!,
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT!,
  region: process.env.S3_REGION || STORAGE_DEFAULTS.S3_REGION,
  accessKeyId: process.env.S3_ACCESS_KEY_ID!,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  bucket: process.env.S3_BUCKET!,
  forcePathStyle:
    (process.env.S3_FORCE_PATH_STYLE ||
      STORAGE_DEFAULTS.S3_FORCE_PATH_STYLE) === 'true',
}));
