import * as fs from 'node:fs';
import * as path from 'node:path';

import { logger } from '../shared/logger.js';
import type { Attachment } from '../shared/types.js';
import { copyImageAttachment, copyVideoAttachment } from './video-writer.js';

/** Extensions/mime-prefixes routed through the video-copy flow instead of
 * the inline-base64 path below. Broader than the server's own MIME
 * allowlist (`.avi`/`.mkv` included) so this still correctly IDENTIFIES a
 * video attachment even in a format the server can't accept —
 * `copyVideoAttachment` is what actually enforces the narrower allowlist and
 * warns/skips a format outside it. Nothing in this codebase currently
 * produces `.avi`/`.mkv` (`events.ts`'s `after:screenshot` handler always
 * hardcodes `image/png`, and Cypress itself only ever records `.mp4`), but a
 * `qualflare.attachmentFromFile()` call can point at any local file. */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv']);

export interface AttachmentReaderConfig {
  attachScreenshots: boolean;
  maxAttachmentBytes: number;
  maxTotalAttachmentBytes: number;
  maxVideoBytes: number;
  outputDir: string;
}

/**
 * Running total of ENCODED inline attachment bytes for this process, so a single
 * pathological run can't push a launch past the server's body limit.
 *
 * Encoded, not raw, because base64 is what actually travels and what the limit is
 * measured against. Counting raw bytes made the cap mean 4/3 more than it said: a
 * fully-used 10,000,000-byte budget is 13,333,336 bytes of `content`, which is
 * 1.27x `/collect`'s BodyLimit(10<<20) = 10,485,760. See `base64Length`.
 */
/**
 * Length of `Buffer.toString("base64")` without producing it.
 *
 * base64 emits 4 characters per 3 input bytes, padded up. Computed arithmetically
 * so the budget can be checked BEFORE a large buffer is encoded, rather than
 * allocating the string only to discard it.
 */
export function base64Length(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

export class AttachmentBudget {
  private used = 0;

  constructor(private readonly maxTotalBytes: number) {}

  /** Atomically checks-and-reserves `bytes` against the remaining budget.
   * Returns false (reserving nothing) if it would exceed the total. */
  tryReserve(bytes: number): boolean {
    if (this.used + bytes > this.maxTotalBytes) {
      return false;
    }
    this.used += bytes;
    return true;
  }

  get usedBytes(): number {
    return this.used;
  }
}

type ReadResult = { skipped: false; content: string } | { skipped: true; reason: string };

function isVideoLike(attachment: Attachment): boolean {
  if (attachment.mimeType?.toLowerCase().startsWith('video/')) {
    return true;
  }
  if (attachment.path && VIDEO_EXTENSIONS.has(path.extname(attachment.path).toLowerCase())) {
    return true;
  }
  return false;
}

function readAttachmentFile(filePath: string, maxAttachmentBytes: number, budget: AttachmentBudget): ReadResult {
  let size: number;
  try {
    // Stat BEFORE reading — an oversized file must never be loaded into
    // memory just to discover it should be skipped.
    size = fs.statSync(filePath).size;
  } catch (err) {
    return { skipped: true, reason: `could not stat file: ${(err as Error).message}` };
  }
  if (size > maxAttachmentBytes) {
    return {
      skipped: true,
      reason: `${size} bytes exceeds the configured per-attachment cap of ${maxAttachmentBytes} bytes`,
    };
  }
  const encoded = base64Length(size);
  if (!budget.tryReserve(encoded)) {
    return {
      skipped: true,
      reason: `would exceed this run's total attachment budget (${budget.usedBytes} encoded bytes already used; this one needs ${encoded})`,
    };
  }
  try {
    const content = fs.readFileSync(filePath).toString('base64');
    return { skipped: false, content };
  } catch (err) {
    return { skipped: true, reason: `could not read file: ${(err as Error).message}` };
  }
}

/**
 * Resolves a Case's attachment references into either inline base64
 * `content` (small files) or a `localVideoPath` pointing at a copy made
 * alongside the report output (video — see `video-writer.ts`'s
 * `copyVideoAttachment`), or drops them. Attachment references arrive with
 * only a `path` (never bytes — screenshots are captured entirely Node-side
 * via the `after:screenshot` plugin event in `events.ts`, and an author's
 * `qualflare.attachmentFromFile()` call carries only the path it was given
 * too), so all file I/O and size-guarding happens here, at the point a
 * finished Case is received from `cy.task(TASK_REPORT_CASE, ...)` — see
 * `tasks.ts`.
 *
 * Per the plan's resolved decision, an oversized or over-budget INLINE
 * attachment is skipped ENTIRELY (not degraded to a contentless path-only
 * entry): the server's `path` field is explicitly informational/never-fetched,
 * so a contentless entry has little value and this keeps the behavior
 * simple and predictable. A video attachment that fails to copy (oversized
 * per `maxVideoBytes`, unsupported format, or an unreadable source file) is
 * skipped the same way — `copyVideoAttachment` already logs why.
 */
export function resolveAttachments(
  attachments: Attachment[] | undefined,
  config: AttachmentReaderConfig,
  budget: AttachmentBudget,
): Attachment[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  if (!config.attachScreenshots) {
    return undefined;
  }

  const resolved: Attachment[] = [];
  for (const attachment of attachments) {
    if (isVideoLike(attachment)) {
      if (!attachment.path) {
        logger.warn(`skipping video attachment "${attachment.name}": no local file path to copy.`);
        continue;
      }
      const copied = copyVideoAttachment(attachment.path, config.outputDir, config.maxVideoBytes);
      if (!copied) {
        // copyVideoAttachment already logged the specific reason.
        continue;
      }
      resolved.push({
        ...attachment,
        mimeType: copied.mimeType,
        localVideoPath: copied.localVideoPath,
        fileSize: copied.fileSize,
      });
      continue;
    }
    // Screenshots go out of band like video, rather than base64 into the
    // report. Placed BEFORE the inline branch so a screenshot never reaches it,
    // and after the video branch so a misnamed artifact cannot be captured
    // here. A non-image (a log, a JSON blob) returns undefined and falls
    // straight through to the inline path below, unchanged.
    if (attachment.content === undefined && attachment.path) {
      const copied = copyImageAttachment(attachment.path, config.outputDir, config.maxAttachmentBytes);
      if (copied) {
        resolved.push({
          ...attachment,
          mimeType: copied.mimeType,
          localImagePath: copied.localImagePath,
          fileSize: copied.fileSize,
        });
        continue;
      }
    }

    if (attachment.content !== undefined || !attachment.path) {
      // Already has inline content (e.g. from a future metadata-API call
      // that provides content directly), or nothing to read — pass through
      // unchanged.
      resolved.push(attachment);
      continue;
    }
    const result = readAttachmentFile(attachment.path, config.maxAttachmentBytes, budget);
    if (result.skipped) {
      logger.warn(`skipping attachment "${attachment.name}" (${attachment.path}): ${result.reason}`);
      continue;
    }
    resolved.push({ ...attachment, content: result.content });
  }
  return resolved.length > 0 ? resolved : undefined;
}
