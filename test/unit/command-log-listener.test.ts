import { describe, expect, it } from 'vitest';

import { CommandLogBuffer } from '../../src/browser/command-log-listener.js';
import { MAX_STEPS_PER_TEST_ATTEMPT } from '../../src/shared/constants.js';

describe('CommandLogBuffer', () => {
  it('converts a simple log:added entry into a root Step', () => {
    const buffer = new CommandLogBuffer();
    buffer.handleAdded({ id: '1', name: 'get', state: 'passed' }, 1000);
    const steps = buffer.drain();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ name: 'get', status: 'passed' });
    expect(steps[0]).not.toHaveProperty('parentIndex');
  });

  it('ignores a log entry with no name', () => {
    const buffer = new CommandLogBuffer();
    buffer.handleAdded({ id: '1', state: 'passed' }, 1000);
    expect(buffer.drain()).toHaveLength(0);
  });

  it('sets displayName as keyword only when it differs from name', () => {
    const buffer = new CommandLogBuffer();
    buffer.handleAdded({ id: '1', name: 'get', displayName: 'get', state: 'passed' }, 1000);
    buffer.handleAdded({ id: '2', name: 'assert', displayName: 'expect', state: 'passed' }, 1000);
    const steps = buffer.drain();
    expect(steps[0]!.keyword).toBeUndefined();
    expect(steps[1]!.keyword).toBe('expect');
  });

  it('a failed log entry always maps to failed status, never silently to passed', () => {
    const buffer = new CommandLogBuffer();
    buffer.handleAdded({ id: '1', name: 'click', state: 'failed', err: { message: 'element not found' } }, 1000);
    const steps = buffer.drain();
    expect(steps[0]!.status).toBe('failed');
    expect(steps[0]!.error).toBe('element not found');
  });

  it('an entry with no/unrecognized state reports pending, not passed (never guesses green)', () => {
    const buffer = new CommandLogBuffer();
    buffer.handleAdded({ id: '1', name: 'get' }, 1000); // no state at all
    buffer.handleAdded({ id: '2', name: 'click', state: 'something-unexpected' }, 1000);
    const steps = buffer.drain();
    expect(steps[0]!.status).toBe('pending');
    expect(steps[1]!.status).toBe('pending');
  });

  it('log:changed updates an existing step in place by id, not append a new one', () => {
    const buffer = new CommandLogBuffer();
    buffer.handleAdded({ id: '1', name: 'get', state: 'pending' }, 1000);
    buffer.handleChanged({ id: '1', state: 'passed' }, 1050);
    const steps = buffer.drain();
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe('passed');
  });

  it('log:changed for an unknown id is a no-op, not a crash or a phantom step', () => {
    const buffer = new CommandLogBuffer();
    buffer.handleAdded({ id: '1', name: 'get', state: 'passed' }, 1000);
    buffer.handleChanged({ id: 'never-added', state: 'failed' }, 1050);
    expect(buffer.drain()).toHaveLength(1);
  });

  it('duration is the elapsed time between log:added and the last log:changed, in nanoseconds', () => {
    const buffer = new CommandLogBuffer();
    buffer.handleAdded({ id: '1', name: 'get', state: 'pending' }, 1000);
    buffer.handleChanged({ id: '1', state: 'passed' }, 1250); // 250ms later
    const steps = buffer.drain();
    expect(steps[0]!.duration).toBe(250 * 1_000_000);
  });

  describe('parentIndex nesting via the real `type: parent|child` field', () => {
    it('a child entry gets parentIndex pointing at the most recent parent', () => {
      const buffer = new CommandLogBuffer();
      buffer.handleAdded({ id: '1', name: 'get', type: 'parent', state: 'passed' }, 1000);
      buffer.handleAdded({ id: '2', name: 'should', type: 'child', state: 'passed' }, 1010);
      const steps = buffer.drain();
      expect(steps[0]!.parentIndex).toBeUndefined();
      expect(steps[1]!.parentIndex).toBe(0);
    });

    it('a child entry before any parent has been seen falls back to root (safe default)', () => {
      const buffer = new CommandLogBuffer();
      buffer.handleAdded({ id: '1', name: 'should', type: 'child', state: 'passed' }, 1000);
      const steps = buffer.drain();
      expect(steps[0]!.parentIndex).toBeUndefined();
    });

    it('a second parent resets which parent subsequent children attach to', () => {
      const buffer = new CommandLogBuffer();
      buffer.handleAdded({ id: '1', name: 'get', type: 'parent', state: 'passed' }, 1000);
      buffer.handleAdded({ id: '2', name: 'should-a', type: 'child', state: 'passed' }, 1010);
      buffer.handleAdded({ id: '3', name: 'click', type: 'parent', state: 'passed' }, 1020);
      buffer.handleAdded({ id: '4', name: 'should-b', type: 'child', state: 'passed' }, 1030);
      const steps = buffer.drain();
      expect(steps[1]!.parentIndex).toBe(0); // should-a -> get
      expect(steps[3]!.parentIndex).toBe(2); // should-b -> click
    });
  });

  describe('message enrichment (the step name, not just consoleProps)', () => {
    it('appends a string message to the bare command name', () => {
      const buffer = new CommandLogBuffer();
      buffer.handleAdded({ id: '1', name: 'visit', state: 'passed', message: 'http://localhost:3000/login' }, 1000);
      expect(buffer.drain()[0]!.name).toBe('visit http://localhost:3000/login');
    });

    it('leaves the name as the bare command when there is no message', () => {
      const buffer = new CommandLogBuffer();
      buffer.handleAdded({ id: '1', name: 'click', state: 'passed' }, 1000);
      expect(buffer.drain()[0]!.name).toBe('click');
    });

    it('ignores an empty or whitespace-only message', () => {
      const buffer = new CommandLogBuffer();
      buffer.handleAdded({ id: '1', name: 'get', state: 'passed', message: '   ' }, 1000);
      expect(buffer.drain()[0]!.name).toBe('get');
    });

    it('ignores a non-string message (Cypress types it `any`) rather than stringifying it into the name', () => {
      const buffer = new CommandLogBuffer();
      buffer.handleAdded({ id: '1', name: 'wait', state: 'passed', message: { some: 'object' } }, 1000);
      expect(buffer.drain()[0]!.name).toBe('wait');
    });

    it('trims surrounding whitespace from the message before appending', () => {
      const buffer = new CommandLogBuffer();
      buffer.handleAdded({ id: '1', name: 'contains', state: 'passed', message: '  Reset your password  ' }, 1000);
      expect(buffer.drain()[0]!.name).toBe('contains Reset your password');
    });

    it('truncates a very long message rather than bloating the step name indefinitely', () => {
      const buffer = new CommandLogBuffer();
      buffer.handleAdded({ id: '1', name: 'type', state: 'passed', message: 'x'.repeat(500) }, 1000);
      const name = buffer.drain()[0]!.name;
      expect(name.length).toBeLessThan(230); // "type " + 200 chars + ellipsis
      expect(name.endsWith('…')).toBe(true);
    });
  });

  it('consoleProps captured on the entry is flattened into parameters at drain time', () => {
    const buffer = new CommandLogBuffer();
    buffer.handleAdded(
      { id: '1', name: 'get', state: 'passed', consoleProps: { Selector: '#foo', Yielded: 'bar' } },
      1000,
    );
    const steps = buffer.drain();
    expect(steps[0]!.parameters).toEqual([
      { name: 'Selector', value: '#foo' },
      { name: 'Yielded', value: 'bar' },
    ]);
  });

  it('a later log:changed consoleProps update overrides the log:added value', () => {
    const buffer = new CommandLogBuffer();
    buffer.handleAdded({ id: '1', name: 'get', state: 'pending', consoleProps: { partial: true } }, 1000);
    buffer.handleChanged({ id: '1', state: 'passed', consoleProps: { Yielded: 'final' } }, 1050);
    const steps = buffer.drain();
    expect(steps[0]!.parameters).toEqual([{ name: 'Yielded', value: 'final' }]);
  });

  it('enforces the client-side soft cap, dropping entries beyond it rather than growing unbounded', () => {
    const buffer = new CommandLogBuffer();
    for (let i = 0; i < MAX_STEPS_PER_TEST_ATTEMPT + 25; i += 1) {
      buffer.handleAdded({ id: String(i), name: `cmd-${i}`, state: 'passed' }, 1000);
    }
    expect(buffer.drain()).toHaveLength(MAX_STEPS_PER_TEST_ATTEMPT);
  });

  it('drain() clears the buffer — a subsequent drain() with no new entries is empty', () => {
    const buffer = new CommandLogBuffer();
    buffer.handleAdded({ id: '1', name: 'get', state: 'passed' }, 1000);
    expect(buffer.drain()).toHaveLength(1);
    expect(buffer.drain()).toHaveLength(0);
  });

  it('reset() discards any buffered entries without returning them (abandoned-attempt semantics)', () => {
    const buffer = new CommandLogBuffer();
    buffer.handleAdded({ id: '1', name: 'get', state: 'failed' }, 1000);
    buffer.reset();
    expect(buffer.drain()).toHaveLength(0);
  });

  it('reset() clears nesting state — a parent recorded before reset does not apply after it', () => {
    const buffer = new CommandLogBuffer();
    buffer.handleAdded({ id: '1', name: 'get', type: 'parent', state: 'passed' }, 1000);
    buffer.reset();
    buffer.handleAdded({ id: '2', name: 'should', type: 'child', state: 'passed' }, 1010);
    const steps = buffer.drain();
    expect(steps[0]!.parentIndex).toBeUndefined();
  });
});
