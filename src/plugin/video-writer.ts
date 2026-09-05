import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { logger } from '../shared/logger.js';

/** Extension -> MIME type for the video formats the server accepts (see
 * `launch.AllowedAttachmentUploadMimeTypes` server-side). Cypress itself
 * always records `.mp4` today, but `.webm`/`.mov` are listed for parity with
 * the server's own allowlist and in case that ever changes. An extension not
 * in this map (a user could point `qualflare.attachmentFromFile()` at an
 * arbitrary file) is skipped — see `copyVideoAttachment`'s doc comment. */
const VIDEO_MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

export interface VideoCopyResult {
  /** Filename relative to the `outputDir` this was copied into — never an
   * absolute path, since the whole directory travels together as one CI
   * artifact bundle (see the design spec's "Why no backend changes"
   * section). */
  localVideoPath: string;
  fileSize: number;
  mimeType: string;
}

/**
 * Copies one video file into `outputDir` under a unique filename (Allure's
 * `FileSystemWriter.writeAttachmentFromPath` pattern: `fs.copyFileSync`,
 * never read into memory) and returns enough to build that `Attachment`
 * entry's `localVideoPath`. `qualflare-cli` is what actually uploads this
 * file later, once it has a real auth token — see the design spec.
 *
 * Best-effort, like the rest of this reporter's attachment handling
 * (`attachment-reader.ts`'s oversized/unreadable-file skip): any failure —
 * oversized file, unsupported extension, an unreadable source file — is
 * logged as a warning and resolves to `undefined` rather than throwing, so a
 * video problem never fails the whole run.
 */
export function copyVideoAttachment(
  filePath: string,
  outputDir: string,
  maxVideoBytes: number,
): VideoCopyResult | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = VIDEO_MIME_TYPES_BY_EXTENSION[ext];
  if (!mimeType) {
    logger.warn(`skipping video attachment "${filePath}": unsupported video format.`);
    return undefined;
  }

  let fileSize: number;
  try {
    // Stat BEFORE copying — an oversized file must never be copied just to
    // discover it should be skipped.
    fileSize = fs.statSync(filePath).size;
  } catch (err) {
    logger.warn(`skipping video attachment "${filePath}": could not stat file: ${(err as Error).message}`);
    return undefined;
  }
  if (fileSize > maxVideoBytes) {
    logger.warn(
      `skipping video attachment "${filePath}": ${fileSize} bytes exceeds the configured ` +
        `maxVideoBytes cap of ${maxVideoBytes} bytes.`,
    );
    return undefined;
  }

  const localVideoPath = `${randomUUID()}${ext}`;
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.copyFileSync(filePath, path.join(outputDir, localVideoPath));
  } catch (err) {
    logger.warn(`skipping video attachment "${filePath}": could not copy file: ${(err as Error).message}`);
    return undefined;
  }

  return { localVideoPath, fileSize, mimeType };
}

/** Extension -> MIME for the image formats the upload endpoint accepts. Anything
 * else (`.bmp`, `.svg`) has nowhere to go out of band and stays on the inline
 * path, which is still bounded by `maxAttachmentBytes` and the run budget. */
const IMAGE_MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

export interface ImageCopyResult {
  /** Filename relative to `outputDir`, same rule as `localVideoPath`. */
  localImagePath: string;
  fileSize: number;
  mimeType: string;
}

/**
 * Copies one screenshot into `outputDir` and returns enough to build that
 * `Attachment` entry's `localImagePath`, so a screenshot travels the same way a
 * video already does instead of being base64-inlined into the report and from
 * there into the `/collect` body.
 *
 * The MIME type comes from the EXTENSION rather than any declared type: the
 * upload endpoint cross-checks the two, so a declared type that disagrees with
 * the file on disk earns a 400 per screenshot.
 *
 * Unlike `copyVideoAttachment`, an unsupported extension is NOT warned about.
 * Every non-image attachment reaches this function on its way to the inline
 * path, so warning here would fire on ordinary logs and JSON. Returning
 * undefined is the normal case, not a fault.
 *
 * Requires `@qualflare/cli` v0.1.24+, which reads `localImagePath`. An older CLI
 * ignores it, leaving an attachment with neither content nor storageKey — a row
 * the server persists from its name alone, showing as an undownloadable
 * placeholder.
 */
export function copyImageAttachment(
  filePath: string,
  outputDir: string,
  maxImageBytes: number,
): ImageCopyResult | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES_BY_EXTENSION[ext];
  if (!mimeType) {
    return undefined;
  }

  let fileSize: number;
  try {
    // Stat BEFORE copying — an oversized file must never be copied just to
    // discover it should be skipped.
    fileSize = fs.statSync(filePath).size;
  } catch (err) {
    logger.warn(`skipping image attachment "${filePath}": could not stat file: ${(err as Error).message}`);
    return undefined;
  }
  if (fileSize > maxImageBytes) {
    logger.warn(
      `skipping image attachment "${filePath}": ${fileSize} bytes exceeds the configured ` +
        `maxAttachmentBytes cap of ${maxImageBytes} bytes.`,
    );
    return undefined;
  }

  const localImagePath = `${randomUUID()}${ext}`;
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.copyFileSync(filePath, path.join(outputDir, localImagePath));
  } catch (err) {
    logger.warn(`skipping image attachment "${filePath}": could not copy file: ${(err as Error).message}`);
    return undefined;
  }

  return { localImagePath, fileSize, mimeType };
}
