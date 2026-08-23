import * as fs from 'node:fs';
import * as path from 'node:path';

import { putObject, requestUploadUrl, type SendOptions } from '../http/client.js';
import { logger } from '../shared/logger.js';
import type { ResolvedPluginConfig } from './resolve-config.js';
import { PACKAGE_VERSION } from './version.js';

/** Builds the `SendOptions` shared by every HTTP call this reporter makes
 * (the final `/collect` POST, the video presign request, and — implicitly,
 * via the presigned URL itself — the R2 PUT) from the resolved plugin
 * config. Centralized so the `userAgent` string is constructed exactly once. */
export function buildHttpOptions(config: ResolvedPluginConfig): SendOptions {
  return {
    endpoint: config.apiEndpoint,
    token: config.token,
    timeoutMs: config.timeoutMs,
    retry: config.retry,
    userAgent: `qualflare-cypress/${PACKAGE_VERSION}`,
    debug: config.debug,
  };
}

/** Extension -> MIME type for the video formats the server accepts (see
 * `launch.AllowedAttachmentUploadMimeTypes` server-side). Cypress itself
 * always records `.mp4` today, but `.webm`/`.mov` are listed for parity with
 * the server's own allowlist and in case that ever changes. An extension not
 * in this map (Cypress video is never `.avi`/`.mkv`, but a user could point
 * `uploadVideos` config at an arbitrary file some other way) is skipped —
 * see `uploadVideo`'s doc comment. */
const VIDEO_MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

export interface VideoUploadResult {
  storageKey: string;
  fileSize: number;
  mimeType: string;
}

/**
 * Uploads one video file to R2 via the presigned-upload-URL flow
 * (`POST /api/v1/attachments/upload-url` -> PUT bytes -> return the
 * `storageKey` a later `/collect` payload references — see
 * `Attachment.storageKey`'s doc comment in shared/types.ts) and returns
 * enough to build that `Attachment` entry.
 *
 * Best-effort, like the rest of this reporter's attachment handling
 * (`attachment-reader.ts`'s oversized/unreadable-file skip): any failure —
 * oversized file, unsupported extension, network/API error — is logged as a
 * warning and resolves to `undefined` rather than throwing, so a video
 * upload problem never fails the whole run (independent of
 * `failOnUploadError`, which is scoped to the actual `/collect` POST, not to
 * best-effort attachment resolution).
 */
export async function uploadVideo(
  filePath: string,
  maxVideoBytes: number,
  httpOptions: SendOptions,
): Promise<VideoUploadResult | undefined> {
  const mimeType = VIDEO_MIME_TYPES_BY_EXTENSION[path.extname(filePath).toLowerCase()];
  if (!mimeType) {
    logger.warn(`skipping video upload for "${filePath}": unsupported video format.`);
    return undefined;
  }

  let fileSize: number;
  try {
    // Stat BEFORE reading — an oversized file must never be loaded into
    // memory just to discover it should be skipped (same discipline as
    // attachment-reader.ts's readAttachmentFile).
    fileSize = fs.statSync(filePath).size;
  } catch (err) {
    logger.warn(`skipping video upload for "${filePath}": could not stat file: ${(err as Error).message}`);
    return undefined;
  }
  if (fileSize > maxVideoBytes) {
    logger.warn(
      `skipping video upload for "${filePath}": ${fileSize} bytes exceeds the configured ` +
        `maxVideoBytes cap of ${maxVideoBytes} bytes.`,
    );
    return undefined;
  }

  const filename = path.basename(filePath);

  let uploadUrl: string;
  let storageKey: string;
  try {
    const res = await requestUploadUrl(httpOptions, filename, mimeType, fileSize);
    uploadUrl = res.uploadUrl;
    storageKey = res.storageKey;
  } catch (err) {
    logger.warn(`skipping video upload for "${filePath}": failed to obtain an upload URL: ${(err as Error).message}`);
    return undefined;
  }

  let body: Buffer;
  try {
    body = fs.readFileSync(filePath);
  } catch (err) {
    logger.warn(`skipping video upload for "${filePath}": could not read file: ${(err as Error).message}`);
    return undefined;
  }

  try {
    await putObject(uploadUrl, body, mimeType, httpOptions.timeoutMs);
  } catch (err) {
    logger.warn(`skipping video upload for "${filePath}": upload failed: ${(err as Error).message}`);
    return undefined;
  }

  return { storageKey, fileSize, mimeType };
}
