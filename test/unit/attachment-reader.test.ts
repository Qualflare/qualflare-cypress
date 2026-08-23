import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AttachmentBudget, resolveAttachments, type AttachmentReaderConfig } from '../../src/plugin/attachment-reader.js';
import type { Attachment } from '../../src/shared/types.js';

const ENDPOINT = 'https://qualflare.test';

const BASE_CONFIG: AttachmentReaderConfig = {
  attachScreenshots: true,
  maxAttachmentBytes: 1_000_000,
  maxTotalAttachmentBytes: 5_000_000,
  uploadVideos: true,
  maxVideoBytes: 50_000_000,
  httpOptions: {
    endpoint: ENDPOINT,
    token: 'test-token',
    timeoutMs: 2000,
    retry: { max: 0, baseDelayMs: 1, maxDelayMs: 5 }, // single attempt so a mocked failure resolves fast
    userAgent: 'qualflare-cypress-test',
    debug: false,
  },
};

let tmpDir: string;
let mockAgent: MockAgent;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qualflare-cypress-test-'));
  // Video-routed attachments make a real HTTP call (requestUploadUrl) —
  // disableNetConnect with no interceptors registered makes an unmocked
  // attempt fail immediately (not hang/timeout), which uploadVideo then
  // turns into a logged skip, same as any other upload failure.
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await mockAgent.close();
  vi.restoreAllMocks();
});

function writeTempFile(name: string, bytes: number): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 'a'));
  return filePath;
}

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
    const filePath = path.join(tmpDir, 'shot.png');
    fs.writeFileSync(filePath, original);
    const attachments: Attachment[] = [{ name: 'shot', path: filePath, mimeType: 'image/png' }];

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
    const a = writeTempFile('a.png', 300);
    const b = writeTempFile('b.png', 300);
    const c = writeTempFile('c.png', 300);
    const attachments: Attachment[] = [
      { name: 'a', path: a, mimeType: 'image/png' },
      { name: 'b', path: b, mimeType: 'image/png' },
      { name: 'c', path: c, mimeType: 'image/png' },
    ];
    const budget = new AttachmentBudget(700); // fits a+b (600) but not +c (900)

    const result = await resolveAttachments(attachments, BASE_CONFIG, budget);

    expect(result).toHaveLength(2);
    expect(result!.map((r) => r.name)).toEqual(['a', 'b']);
    expect(budget.usedBytes).toBe(600);
  });

  it('a budget shared across multiple resolveAttachments calls (multiple tests in one run) enforces the total, not per-call', async () => {
    const first = writeTempFile('first.png', 400);
    const second = writeTempFile('second.png', 400);
    const budget = new AttachmentBudget(600);

    const firstResult = await resolveAttachments([{ name: 'first', path: first }], BASE_CONFIG, budget);
    const secondResult = await resolveAttachments([{ name: 'second', path: second }], BASE_CONFIG, budget);

    expect(firstResult).toHaveLength(1);
    expect(secondResult).toBeUndefined();
  });

  it('skips a nonexistent file gracefully rather than throwing', async () => {
    const attachments: Attachment[] = [{ name: 'missing', path: path.join(tmpDir, 'does-not-exist.png') }];
    await expect(resolveAttachments(attachments, BASE_CONFIG, new AttachmentBudget(1_000_000))).resolves.not.toThrow();
    expect(await resolveAttachments(attachments, BASE_CONFIG, new AttachmentBudget(1_000_000))).toBeUndefined();
  });

  it('a video-mimeType attachment is routed to the upload flow, and skipped (not inlined) when the upload fails', async () => {
    const filePath = writeTempFile('clip.webm', 100);
    const attachments: Attachment[] = [{ name: 'clip', path: filePath, mimeType: 'video/webm' }];
    // No interceptor registered -> requestUploadUrl's request throws -> uploadVideo logs and returns undefined.
    expect(await resolveAttachments(attachments, BASE_CONFIG, new AttachmentBudget(1_000_000))).toBeUndefined();
  });

  it('a video-extension path (even with an incorrectly-labeled image mimeType) is routed to the upload flow, not inlined', async () => {
    const filePath = writeTempFile('clip.mp4', 100);
    const attachments: Attachment[] = [{ name: 'clip', path: filePath, mimeType: 'image/png' }];
    expect(await resolveAttachments(attachments, BASE_CONFIG, new AttachmentBudget(1_000_000))).toBeUndefined();
  });

  it('does not attempt a video upload when uploadVideos is disabled', async () => {
    const filePath = writeTempFile('clip.mp4', 100);
    const attachments: Attachment[] = [{ name: 'clip', path: filePath, mimeType: 'video/mp4' }];
    const result = await resolveAttachments(attachments, { ...BASE_CONFIG, uploadVideos: false }, new AttachmentBudget(1_000_000));
    expect(result).toBeUndefined();
    // No interceptor was registered and disableNetConnect() would throw synchronously
    // inside the request call if one were attempted — reaching this point at all
    // (rather than the promise rejecting) already proves no network call was made.
  });

  it('uploads a video attachment end-to-end (presign + PUT) and attaches storageKey/fileSize instead of content', async () => {
    const original = Buffer.from('fake video bytes');
    const filePath = path.join(tmpDir, 'clip.mp4');
    fs.writeFileSync(filePath, original);
    const attachments: Attachment[] = [{ name: 'clip', path: filePath }];

    const pool = mockAgent.get(ENDPOINT);
    pool
      .intercept({ path: '/api/v1/attachments/upload-url', method: 'POST' })
      .reply(200, JSON.stringify({ storageKey: 'case-run-attachments/proj/123.mp4', uploadUrl: `${ENDPOINT}/put-here` }), {
        headers: { 'content-type': 'application/json' },
      });
    pool.intercept({ path: '/put-here', method: 'PUT' }).reply(200, '');

    const result = await resolveAttachments(attachments, BASE_CONFIG, new AttachmentBudget(1_000_000));

    expect(result).toHaveLength(1);
    expect(result![0]!.content).toBeUndefined();
    expect(result![0]!.storageKey).toBe('case-run-attachments/proj/123.mp4');
    expect(result![0]!.fileSize).toBe(original.length);
    expect(result![0]!.mimeType).toBe('video/mp4');
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
