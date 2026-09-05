import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AttachmentBudget, resolveAttachments, type AttachmentReaderConfig } from '../../src/plugin/attachment-reader.js';
import type { Attachment } from '../../src/shared/types.js';

// None of the tests using BASE_CONFIG unmodified exercise the video-copy
// branch, so outputDir here is a placeholder, never actually written to —
// tests that do need a real, per-test output directory build their own
// config from `outputDir` below instead of spreading BASE_CONFIG.
const BASE_CONFIG: AttachmentReaderConfig = {
  attachScreenshots: true,
  maxAttachmentBytes: 1_000_000,
  maxTotalAttachmentBytes: 5_000_000,
  maxVideoBytes: 50_000_000,
  outputDir: os.tmpdir(),
};

let tmpDir: string;
let outputDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qualflare-cypress-test-'));
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qualflare-cypress-test-out-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(outputDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeTempFile(name: string, bytes: number): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 'a'));
  return filePath;
}

// These use text/plain deliberately. Images no longer reach the inline path at
// all -- they are copied into outputDir and referenced by localImagePath -- so
// asserting the base64/budget behaviour with a .png would be asserting a route
// screenshots no longer take. Text attachments still inline, and the budget
// still bounds them, which is what these cover.
describe('resolveAttachments', () => {
  it('returns undefined for an empty/absent attachment list', async () => {
    expect(await resolveAttachments(undefined, BASE_CONFIG, new AttachmentBudget(1_000_000))).toBeUndefined();
    expect(await resolveAttachments([], BASE_CONFIG, new AttachmentBudget(1_000_000))).toBeUndefined();
  });

  it('drops everything when attachScreenshots is disabled', async () => {
    const filePath = writeTempFile('shot.png', 100);
    const attachments: Attachment[] = [{ name: 'shot', path: filePath, mimeType: 'image/png' }];
    const result = await resolveAttachments(
      attachments,
      { ...BASE_CONFIG, attachScreenshots: false },
      new AttachmentBudget(1_000_000),
    );
    expect(result).toBeUndefined();
  });

  it('reads a within-budget file and base64-encodes its exact bytes', async () => {
    const original = Buffer.from('hello qualflare screenshot bytes');
    const filePath = path.join(tmpDir, 'shot.txt');
    fs.writeFileSync(filePath, original);
    const attachments: Attachment[] = [{ name: 'shot', path: filePath, mimeType: 'text/plain' }];

    const result = await resolveAttachments(attachments, BASE_CONFIG, new AttachmentBudget(1_000_000));

    expect(result).toHaveLength(1);
    expect(result![0]!.content).toBe(original.toString('base64'));
    expect(Buffer.from(result![0]!.content!, 'base64').equals(original)).toBe(true);
  });

  it('skips a single file exceeding maxAttachmentBytes entirely — no contentless entry', async () => {
    const filePath = writeTempFile('big.png', 2000);
    const attachments: Attachment[] = [{ name: 'big', path: filePath, mimeType: 'image/png' }];

    const result = await resolveAttachments(
      attachments,
      { ...BASE_CONFIG, maxAttachmentBytes: 1000 },
      new AttachmentBudget(1_000_000),
    );

    expect(result).toBeUndefined();
  });

  it('stops attaching once the cumulative run budget would be exceeded, keeping earlier ones', async () => {
    const a = writeTempFile('a.txt', 300);
    const b = writeTempFile('b.txt', 300);
    const c = writeTempFile('c.txt', 300);
    const attachments: Attachment[] = [
      { name: 'a', path: a, mimeType: 'text/plain' },
      { name: 'b', path: b, mimeType: 'text/plain' },
      { name: 'c', path: c, mimeType: 'text/plain' },
    ];
    const budget = new AttachmentBudget(700); // fits a+b (600) but not +c (900)

    const result = await resolveAttachments(attachments, BASE_CONFIG, budget);

    expect(result).toHaveLength(2);
    expect(result!.map((r) => r.name)).toEqual(['a', 'b']);
    expect(budget.usedBytes).toBe(600);
  });

  it('a budget shared across multiple resolveAttachments calls (multiple tests in one run) enforces the total, not per-call', async () => {
    const first = writeTempFile('first.txt', 400);
    const second = writeTempFile('second.txt', 400);
    const budget = new AttachmentBudget(600);

    const firstResult = await resolveAttachments([{ name: 'first', path: first }], BASE_CONFIG, budget);
    const secondResult = await resolveAttachments([{ name: 'second', path: second }], BASE_CONFIG, budget);

    expect(firstResult).toHaveLength(1);
    expect(secondResult).toBeUndefined();
  });

  it('skips a nonexistent file gracefully rather than throwing', () => {
    const attachments: Attachment[] = [{ name: 'missing', path: path.join(tmpDir, 'does-not-exist.png') }];
    expect(() => resolveAttachments(attachments, BASE_CONFIG, new AttachmentBudget(1_000_000))).not.toThrow();
    expect(resolveAttachments(attachments, BASE_CONFIG, new AttachmentBudget(1_000_000))).toBeUndefined();
  });

  it('routes a video-like attachment through copyVideoAttachment and sets localVideoPath', async () => {
    const src = path.join(tmpDir, 'clip.mp4');
    fs.writeFileSync(src, 'video-bytes');

    const resolved = await resolveAttachments(
      [{ name: 'video', path: src, mimeType: 'video/mp4' }],
      { attachScreenshots: true, maxAttachmentBytes: 1_000_000, maxTotalAttachmentBytes: 1_000_000, maxVideoBytes: 1_000_000, outputDir },
      new AttachmentBudget(1_000_000),
    );

    expect(resolved).toHaveLength(1);
    expect(resolved![0].localVideoPath).toBeDefined();
    expect(resolved![0].content).toBeUndefined();
  });

  it('drops a video attachment with no local path to copy', async () => {
    const resolved = await resolveAttachments(
      [{ name: 'video', mimeType: 'video/mp4' }],
      { attachScreenshots: true, maxAttachmentBytes: 1_000_000, maxTotalAttachmentBytes: 1_000_000, maxVideoBytes: 1_000_000, outputDir },
      new AttachmentBudget(1_000_000),
    );

    expect(resolved).toBeUndefined();
  });

  it('passes through an attachment that already has inline content, untouched', async () => {
    const attachments: Attachment[] = [{ name: 'inline', content: 'YWJj', mimeType: 'text/plain' }];
    const result = await resolveAttachments(attachments, BASE_CONFIG, new AttachmentBudget(1_000_000));
    expect(result).toEqual(attachments);
  });
});

describe('AttachmentBudget', () => {
  it('reserves bytes cumulatively and rejects once the cap would be exceeded', () => {
    const budget = new AttachmentBudget(1000);
    expect(budget.tryReserve(400)).toBe(true);
    expect(budget.tryReserve(400)).toBe(true);
    expect(budget.tryReserve(300)).toBe(false); // 800 + 300 > 1000
    expect(budget.usedBytes).toBe(800);
    expect(budget.tryReserve(200)).toBe(true); // 800 + 200 == 1000, exactly at the cap
    expect(budget.usedBytes).toBe(1000);
  });
});
