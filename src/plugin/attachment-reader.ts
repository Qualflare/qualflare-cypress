import * as fs from 'node:fs';
import * as path from 'node:path';

import { logger } from '../shared/logger.js';
import type { Attachment } from '../shared/types.js';

/** Extensions/mime-prefixes this reporter must never attach — qualflare-cypress
 * has no video/blob-attachment support yet (a separate, unbuilt backend
 * feature). Nothing in this codebase should ever produce one of these (only
 * `events.ts`'s `after:screenshot` handler enqueues a pending attachment,
 * and it always hardcodes `image/png`), but this is enforced here too,
 * defensively, as a belt-and-suspenders guard rather than relying purely on
 * that convention. */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv']);

export interface AttachmentReaderConfig {
  attachScreenshots: boolean;
  maxAttachmentBytes: number;
  maxTotalAttachmentBytes: number;
}

/**
 * Tracks cumulative attached bytes across the whole `cypress run` process
 * (one instance per `qualflareCypress()` call, threaded through every
 * `TASK_REPORT_CASE` resolution), so the final POST doesn't silently exceed
 * the request body limit. `maxTotalAttachmentBytes` defaults well under the
 * documented 10MB specifically because production currently has a known,
 * confirmed effective ~1MB body-limit bug (see the plan's CRIT-01
 * reference) — don't raise the default until that's confirmed fixed
 * server-side.
 */
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
  if (!budget.tryReserve(size)) {
    return {
      skipped: true,
      reason: `would exceed this run's total attachment budget (${budget.usedBytes} bytes already used)`,
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
 * Resolves a Case's attachment references into inline base64 `content`, or
 * drops them. Attachment references arrive with only a `path` (never
 * bytes — screenshots are captured entirely Node-side via the
 * `after:screenshot` plugin event in `events.ts`, so there is no browser
 * context involved in producing them at all), so all file I/O and
 * size-guarding happens here, at the point a finished Case is received from
 * `cy.task(TASK_REPORT_CASE, ...)` — see `tasks.ts`.
 *
 * Per the plan's resolved decision, an oversized or over-budget attachment
 * is skipped ENTIRELY (not degraded to a contentless path-only entry): the
 * server's `path` field is explicitly informational/never-fetched, so a
 * contentless entry has little value and this keeps the behavior simple
 * and predictable.
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
      logger.warn(
        `refusing to attach "${attachment.name}": video attachments are not supported yet ` +
          `(${attachment.path ?? attachment.mimeType ?? 'unknown'}).`,
      );
      continue;
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
