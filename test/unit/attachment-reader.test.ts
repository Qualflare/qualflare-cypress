import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AttachmentBudget, resolveAttachments, type AttachmentReaderConfig } from '../../src/plugin/attachment-reader.js';
import type { Attachment } from '../../src/shared/types.js';

const BASE_CONFIG: AttachmentReaderConfig = {
  attachScreenshots: true,
  maxAttachmentBytes: 1_000_000,
  maxTotalAttachmentBytes: 5_000_000,
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qualflare-cypress-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTempFile(name: string, bytes: number): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 'a'));
  return filePath;
}

describe('resolveAttachments', () => {
  it('returns undefined for an empty/absent attachment list', () => {
    expect(resolveAttachments(undefined, BASE_CONFIG, new AttachmentBudget(1_000_000))).toBeUndefined();
    expect(resolveAttachments([], BASE_CONFIG, new AttachmentBudget(1_000_000))).toBeUndefined();
  });

  it('drops everything when attachScreenshots is disabled', () => {
    const filePath = writeTempFile('shot.png', 100);
    const attachments: Attachment[] = [{ name: 'shot', path: filePath, mimeType: 'image/png' }];
    const result = resolveAttachments(attachments, { ...BASE_CONFIG, attachScreenshots: false }, new AttachmentBudget(1_000_000));
    expect(result).toBeUndefined();
  });

  it('reads a within-budget file and base64-encodes its exact bytes', () => {
    const original = Buffer.from('hello qualflare screenshot bytes');
    const filePath = path.join(tmpDir, 'shot.png');
    fs.writeFileSync(filePath, original);
    const attachments: Attachment[] = [{ name: 'shot', path: filePath, mimeType: 'image/png' }];

    const result = resolveAttachments(attachments, BASE_CONFIG, new AttachmentBudget(1_000_000));

    expect(result).toHaveLength(1);
    expect(result![0]!.content).toBe(original.toString('base64'));
    expect(Buffer.from(result![0]!.content!, 'base64').equals(original)).toBe(true);
  });

  it('skips a single file exceeding maxAttachmentBytes entirely — no contentless entry', () => {
    const filePath = writeTempFile('big.png', 2000);
    const attachments: Attachment[] = [{ name: 'big', path: filePath, mimeType: 'image/png' }];

    const result = resolveAttachments(attachments, { ...BASE_CONFIG, maxAttachmentBytes: 1000 }, new AttachmentBudget(1_000_000));

    expect(result).toBeUndefined();
  });

  it('stops attaching once the cumulative run budget would be exceeded, keeping earlier ones', () => {
    const a = writeTempFile('a.png', 300);
    const b = writeTempFile('b.png', 300);
    const c = writeTempFile('c.png', 300);
    const attachments: Attachment[] = [
      { name: 'a', path: a, mimeType: 'image/png' },
      { name: 'b', path: b, mimeType: 'image/png' },
      { name: 'c', path: c, mimeType: 'image/png' },
    ];
    const budget = new AttachmentBudget(700); // fits a+b (600) but not +c (900)

    const result = resolveAttachments(attachments, BASE_CONFIG, budget);

    expect(result).toHaveLength(2);
    expect(result!.map((r) => r.name)).toEqual(['a', 'b']);
    expect(budget.usedBytes).toBe(600);
  });

  it('a budget shared across multiple resolveAttachments calls (multiple tests in one run) enforces the total, not per-call', () => {
    const first = writeTempFile('first.png', 400);
    const second = writeTempFile('second.png', 400);
    const budget = new AttachmentBudget(600);

    const firstResult = resolveAttachments([{ name: 'first', path: first }], BASE_CONFIG, budget);
    const secondResult = resolveAttachments([{ name: 'second', path: second }], BASE_CONFIG, budget);

    expect(firstResult).toHaveLength(1);
    expect(secondResult).toBeUndefined();
  });

  it('skips a nonexistent file gracefully rather than throwing', () => {
    const attachments: Attachment[] = [{ name: 'missing', path: path.join(tmpDir, 'does-not-exist.png') }];
    expect(() => resolveAttachments(attachments, BASE_CONFIG, new AttachmentBudget(1_000_000))).not.toThrow();
    expect(resolveAttachments(attachments, BASE_CONFIG, new AttachmentBudget(1_000_000))).toBeUndefined();
  });

  it('refuses a video-mimeType attachment even if within size budget', () => {
    const filePath = writeTempFile('clip.webm', 100);
    const attachments: Attachment[] = [{ name: 'clip', path: filePath, mimeType: 'video/webm' }];
    expect(resolveAttachments(attachments, BASE_CONFIG, new AttachmentBudget(1_000_000))).toBeUndefined();
  });

  it('refuses a video-extension path even with an (incorrectly-labeled) image mimeType', () => {
    const filePath = writeTempFile('clip.mp4', 100);
    const attachments: Attachment[] = [{ name: 'clip', path: filePath, mimeType: 'image/png' }];
    expect(resolveAttachments(attachments, BASE_CONFIG, new AttachmentBudget(1_000_000))).toBeUndefined();
  });

  it('passes through an attachment that already has inline content, untouched', () => {
    const attachments: Attachment[] = [{ name: 'inline', content: 'YWJj', mimeType: 'text/plain' }];
    const result = resolveAttachments(attachments, BASE_CONFIG, new AttachmentBudget(1_000_000));
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
