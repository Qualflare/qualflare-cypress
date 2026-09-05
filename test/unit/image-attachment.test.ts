import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { copyImageAttachment } from '../../src/plugin/video-writer.js';

let dir: string;
let out: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-cy-image-'));
  out = path.join(dir, 'results');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeFile(name: string, bytes: Buffer = PNG): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

describe('copyImageAttachment', () => {
  it('copies a screenshot into outputDir under a unique relative name', () => {
    const r = copyImageAttachment(makeFile('shot.png'), out, 1_000_000)!;
    expect(r.mimeType).toBe('image/png');
    expect(r.localImagePath).toMatch(/\.png$/);
    // Relative, never absolute — the whole directory travels together as one
    // CI artifact bundle.
    expect(path.isAbsolute(r.localImagePath)).toBe(false);
    expect(fs.readFileSync(path.join(out, r.localImagePath)).equals(PNG)).toBe(true);
    expect(r.fileSize).toBe(PNG.length);
  });

  it('derives the MIME type from the extension, not from any declared type', () => {
    // The upload endpoint cross-checks extension against MIME, so a declared
    // type that disagrees with the file would earn a 400 per screenshot.
    expect(copyImageAttachment(makeFile('a.jpg'), out, 1_000_000)!.mimeType).toBe('image/jpeg');
    expect(copyImageAttachment(makeFile('b.jpeg'), out, 1_000_000)!.mimeType).toBe('image/jpeg');
    expect(copyImageAttachment(makeFile('c.gif'), out, 1_000_000)!.mimeType).toBe('image/gif');
  });

  it('declines formats the upload endpoint does not accept, leaving them to the inline path', () => {
    for (const name of ['d.bmp', 'e.svg', 'f.txt', 'g.json']) {
      expect(copyImageAttachment(makeFile(name), out, 1_000_000)).toBeUndefined();
    }
  });

  it('skips an oversized image without copying it first', () => {
    expect(copyImageAttachment(makeFile('big.png', Buffer.alloc(4096)), out, 1024)).toBeUndefined();
    // Stat happens BEFORE the copy, so nothing is written just to be rejected.
    expect(fs.existsSync(out) ? fs.readdirSync(out) : []).toHaveLength(0);
  });

  it('skips an unreadable file instead of throwing', () => {
    expect(() => copyImageAttachment(path.join(dir, 'nope.png'), out, 1_000_000)).not.toThrow();
    expect(copyImageAttachment(path.join(dir, 'nope.png'), out, 1_000_000)).toBeUndefined();
  });

  it('gives each screenshot its own filename, so two never collide', () => {
    const a = copyImageAttachment(makeFile('one.png'), out, 1_000_000)!;
    const b = copyImageAttachment(makeFile('two.png'), out, 1_000_000)!;
    expect(a.localImagePath).not.toBe(b.localImagePath);
    expect(fs.readdirSync(out)).toHaveLength(2);
  });
});
