import { describe, expect, it } from 'vitest';

import {
  MAX_ATTACHMENTS_PER_CASE,
  MAX_LABELS_PER_CASE,
  MAX_LINKS_PER_CASE,
  MAX_PARAMETERS_PER_STEP,
  MAX_TAGS_PER_CASE,
  MAX_TAG_LENGTH,
} from '../../src/shared/constants.js';
import { TestMetadataBuffer } from '../../src/browser/test-metadata-buffer.js';

describe('TestMetadataBuffer', () => {
  describe('inactive (outside any test) behavior', () => {
    it('every public call is a silent no-op before reset() has ever been called', () => {
      const buffer = new TestMetadataBuffer();
      expect(buffer.isActive()).toBe(false);

      buffer.label('epic', 'Checkout');
      buffer.link('https://example.com/issue/1');
      buffer.tag('smoke');
      buffer.description('should not be recorded');
      buffer.priority('high');
      buffer.parameter('userId', '123');
      buffer.attachment('note.txt', 'hello', { encoding: 'utf8' });
      buffer.attachmentFromFile('log.txt', '/tmp/log.txt');
      const idx = buffer.beginStep('a step');

      expect(idx).toBeUndefined();
      expect(buffer.drain()).toStrictEqual({
        labels: undefined,
        links: undefined,
        tags: undefined,
        description: undefined,
        priority: undefined,
        properties: undefined,
        attachments: undefined,
        manualSteps: undefined,
      });
    });

    it('is inactive again immediately after drain(), until the next reset()', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      expect(buffer.isActive()).toBe(true);
      buffer.drain();
      expect(buffer.isActive()).toBe(false);
      buffer.label('x', 'y'); // no-op — not active
      expect(buffer.drain().labels).toBeUndefined();
    });
  });

  describe('label / link / tag / description / priority / properties', () => {
    it('accumulates labels, links (defaulting type to custom), and tags', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      buffer.label('epic', 'Checkout');
      buffer.label('severity', 'critical');
      buffer.link('https://issues.example.com/ISSUE-1');
      buffer.link('https://tms.example.com/T-2', { type: 'tms', name: 'Test case' });
      buffer.tag('smoke', 'regression');
      buffer.tag('nightly');

      const snapshot = buffer.drain();
      expect(snapshot.labels).toStrictEqual([
        { name: 'epic', value: 'Checkout' },
        { name: 'severity', value: 'critical' },
      ]);
      expect(snapshot.links).toStrictEqual([
        { type: 'custom', url: 'https://issues.example.com/ISSUE-1' },
        { type: 'tms', name: 'Test case', url: 'https://tms.example.com/T-2' },
      ]);
      expect(snapshot.tags).toStrictEqual(['smoke', 'regression', 'nightly']);
    });

    it('description is last-write-wins across multiple calls in one test', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      buffer.description('first');
      buffer.description('second');
      buffer.description('third');
      expect(buffer.drain().description).toBe('third');
    });

    it('priority is last-write-wins across multiple calls in one test', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      buffer.priority('low');
      buffer.priority('critical');
      expect(buffer.drain().priority).toBe('critical');
    });

    it('priority is undefined when never called', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      buffer.label('epic', 'Checkout'); // some unrelated activity
      expect(buffer.drain().priority).toBeUndefined();
    });

    it('enforces the label/link caps by dropping (and warning once for) excess calls', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      for (let i = 0; i < MAX_LABELS_PER_CASE + 5; i += 1) {
        buffer.label(`label-${i}`, 'v');
      }
      for (let i = 0; i < MAX_LINKS_PER_CASE + 5; i += 1) {
        buffer.link(`https://example.com/${i}`);
      }
      const snapshot = buffer.drain();
      expect(snapshot.labels).toHaveLength(MAX_LABELS_PER_CASE);
      expect(snapshot.links).toHaveLength(MAX_LINKS_PER_CASE);
    });

    it('enforces the tag count cap (server REJECTS, not truncates, over 64 tags/case)', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      const many = Array.from({ length: MAX_TAGS_PER_CASE + 10 }, (_, i) => `tag-${i}`);
      buffer.tag(...many);
      expect(buffer.drain().tags).toHaveLength(MAX_TAGS_PER_CASE);
    });

    it('truncates (does not drop) an individual tag longer than the server-mirrored length cap', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      const longTag = 'x'.repeat(MAX_TAG_LENGTH + 50);
      buffer.tag(longTag);
      const tags = buffer.drain().tags;
      expect(tags).toHaveLength(1);
      expect(tags![0]).toHaveLength(MAX_TAG_LENGTH);
      expect(tags![0]).toBe('x'.repeat(MAX_TAG_LENGTH));
    });
  });

  describe('parameter() placement', () => {
    it('a call outside any open step becomes a Case.properties entry', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      buffer.parameter('userId', '123');
      buffer.parameter('flagged'); // value omitted -> stored as ''
      const snapshot = buffer.drain();
      expect(snapshot.properties).toStrictEqual({ userId: '123', flagged: '' });
      expect(snapshot.manualSteps).toBeUndefined();
    });

    it('a call inside an open qualflare.step() attaches to that step\'s parameters[], not properties', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      const idx = buffer.beginStep('do the thing');
      buffer.parameter('retries', '2', { masked: false });
      buffer.parameter('secret', 'hunter2', { masked: true });
      buffer.endStep(idx, 'passed');
      const snapshot = buffer.drain();
      expect(snapshot.properties).toBeUndefined();
      expect(snapshot.manualSteps).toHaveLength(1);
      expect(snapshot.manualSteps?.[0]?.parameters).toStrictEqual([
        { name: 'retries', value: '2' },
        { name: 'secret', value: 'hunter2', masked: true },
      ]);
    });

    it('caps a single step\'s parameters at MAX_PARAMETERS_PER_STEP', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      const idx = buffer.beginStep('loop');
      for (let i = 0; i < MAX_PARAMETERS_PER_STEP + 3; i += 1) {
        buffer.parameter(`p${i}`, String(i));
      }
      buffer.endStep(idx, 'passed');
      expect(buffer.drain().manualSteps?.[0]?.parameters).toHaveLength(MAX_PARAMETERS_PER_STEP);
    });
  });

  describe('attachment() / attachmentFromFile()', () => {
    it('utf8 encoding (the default) base64-encodes content; base64 passes through unchanged', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      buffer.attachment('greeting.txt', 'hello world', { mimeType: 'text/plain' });
      buffer.attachment('already-encoded.bin', 'aGVsbG8=', { encoding: 'base64' });
      const snapshot = buffer.drain();
      expect(snapshot.attachments).toStrictEqual([
        { name: 'greeting.txt', content: Buffer.from('hello world', 'utf8').toString('base64'), mimeType: 'text/plain' },
        { name: 'already-encoded.bin', content: 'aGVsbG8=' },
      ]);
      // Cross-check the encoding against a known string/base64 pair, not just
      // against Buffer's own encoder (which would make this test tautological
      // if TestMetadataBuffer used the same broken logic Buffer also used).
      expect(snapshot.attachments?.[0]?.content).toBe('aGVsbG8gd29ybGQ=');
    });

    it('attachmentFromFile queues a path-only reference (no content) for Node-side resolution', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      buffer.attachmentFromFile('report.pdf', '/tmp/report.pdf', { mimeType: 'application/pdf' });
      expect(buffer.drain().attachments).toStrictEqual([
        { name: 'report.pdf', path: '/tmp/report.pdf', mimeType: 'application/pdf' },
      ]);
    });

    it('caps attachments at MAX_ATTACHMENTS_PER_CASE, mixing both attachment()/attachmentFromFile()', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      for (let i = 0; i < MAX_ATTACHMENTS_PER_CASE; i += 1) {
        buffer.attachment(`a${i}.txt`, 'x');
      }
      buffer.attachmentFromFile('overflow.png', '/tmp/overflow.png');
      expect(buffer.drain().attachments).toHaveLength(MAX_ATTACHMENTS_PER_CASE);
    });
  });

  describe('beginStep() / endStep() nesting', () => {
    it('a single top-level step has no parentIndex and records its real duration', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      const idx = buffer.beginStep('log in', 1000);
      buffer.endStep(idx, 'passed', undefined, 1250);
      const steps = buffer.drain().manualSteps;
      expect(steps).toStrictEqual([{ name: 'log in', status: 'passed', startedAt: 1000, durationMs: 250 }]);
    });

    it('nests a step opened while another is still open, and un-nests correctly on close', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      const outer = buffer.beginStep('checkout flow', 0);
      const inner = buffer.beginStep('fill address', 10);
      buffer.endStep(inner, 'passed', undefined, 40);
      const inner2 = buffer.beginStep('fill payment', 40);
      buffer.endStep(inner2, 'failed', 'card declined', 90);
      buffer.endStep(outer, 'failed', 'card declined', 90);

      const steps = buffer.drain().manualSteps;
      expect(steps).toHaveLength(3);
      expect(steps?.[0]?.name).toBe('checkout flow');
      expect(steps?.[0]?.parentIndex).toBeUndefined();
      expect(steps?.[1]).toMatchObject({ name: 'fill address', parentIndex: 0 });
      expect(steps?.[2]).toMatchObject({ name: 'fill payment', parentIndex: 0, status: 'failed', error: 'card declined' });
    });

    it('supports arbitrary nesting depth (unlike Cypress\'s own flat parent/child signal)', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      const a = buffer.beginStep('a');
      const b = buffer.beginStep('b');
      const c = buffer.beginStep('c');
      buffer.endStep(c, 'passed');
      buffer.endStep(b, 'passed');
      buffer.endStep(a, 'passed');
      const steps = buffer.drain().manualSteps;
      expect(steps?.map((s) => s.parentIndex)).toStrictEqual([undefined, 0, 1]);
    });

    it('endStep(undefined, ...) — the documented signal from a capped/inactive beginStep() — is a safe no-op', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      expect(() => buffer.endStep(undefined, 'passed')).not.toThrow();
      expect(buffer.drain().manualSteps).toBeUndefined();
    });

    it('a step whose wrapped commands fail before endStep() runs stays pending, with no duration — honest, not guessed', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      buffer.beginStep('never finishes');
      const steps = buffer.drain().manualSteps;
      expect(steps).toStrictEqual([{ name: 'never finishes', startedAt: expect.any(Number), status: 'pending' }]);
    });
  });

  describe('attempt lifecycle (reset/drain)', () => {
    it('reset() clears everything a prior attempt accumulated', () => {
      const buffer = new TestMetadataBuffer();
      buffer.reset();
      buffer.label('x', 'y');
      buffer.tag('t');
      buffer.attachment('a.txt', 'x');
      buffer.beginStep('s');
      buffer.reset(); // start of a NEW attempt — old data must not survive
      const snapshot = buffer.drain();
      expect(snapshot).toStrictEqual({
        labels: undefined,
        links: undefined,
        tags: undefined,
        description: undefined,
        priority: undefined,
        properties: undefined,
        attachments: undefined,
        manualSteps: undefined,
      });
    });
  });
});
