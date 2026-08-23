import { describe, expect, it } from 'vitest';

import { buildParametersFromConsoleProps, safeStringify } from '../../src/browser/console-props.js';

describe('safeStringify', () => {
  it('renders primitives directly', () => {
    expect(safeStringify('hello')).toBe('hello');
    expect(safeStringify(42)).toBe('42');
    expect(safeStringify(true)).toBe('true');
    expect(safeStringify(null)).toBe('null');
    expect(safeStringify(undefined)).toBe('undefined');
  });

  it('renders a function as a placeholder, never its source', () => {
    expect(safeStringify(() => 'should not appear')).toBe('[function]');
  });

  it('renders a plain object as flattened key: value pairs', () => {
    expect(safeStringify({ a: 1, b: 'two' })).toBe('{a: 1, b: two}');
  });

  it('renders an array', () => {
    expect(safeStringify([1, 'two', 3])).toBe('[1, two, 3]');
  });

  it('never throws on a circular reference — breaks the cycle instead', () => {
    const obj: Record<string, unknown> = { name: 'circular' };
    obj.self = obj;
    expect(() => safeStringify(obj)).not.toThrow();
    expect(safeStringify(obj)).toContain('[circular]');
  });

  it('never throws on a value whose property getter throws', () => {
    const hostile = {
      get boom(): string {
        throw new Error('nope');
      },
    };
    expect(() => safeStringify(hostile)).not.toThrow();
  });

  it('never throws on a value whose tagName getter throws (the DOM-element duck-type check itself)', () => {
    // Regression test: isDomElementLike's `.tagName` read used to happen
    // BEFORE the try/catch even started, so a hostile tagName getter (or a
    // Proxy with a throwing `get` trap, simulated here the same way) threw
    // straight out of safeStringify — found via deep adversarial self-review.
    const hostile = {
      get tagName(): string {
        throw new Error('proxy trap style failure');
      },
    };
    expect(() => safeStringify(hostile)).not.toThrow();
    expect(safeStringify(hostile)).toBe('[unserializable]');
  });

  it('never throws when a DOM-element-like object\'s id/className getters throw', () => {
    const hostile = {
      tagName: 'DIV',
      get id(): string {
        throw new Error('id boom');
      },
    };
    expect(() => safeStringify(hostile)).not.toThrow();
  });

  it('truncates a very large BigInt value, matching the string-truncation cap', () => {
    const huge = 10n ** 1000n;
    const result = safeStringify(huge);
    expect(result.length).toBeLessThanOrEqual(501); // MAX_VALUE_CHARS (500) + the ellipsis char
    expect(result.endsWith('…')).toBe(true);
  });

  it('renders a DOM-element-like object by tag name, not full serialization', () => {
    const fakeEl = { tagName: 'BUTTON', id: 'submit', className: 'btn primary' };
    expect(safeStringify(fakeEl)).toBe('<button#submit.btn.primary>');
  });

  it('truncates very long strings', () => {
    const long = 'x'.repeat(1000);
    const result = safeStringify(long);
    expect(result.length).toBeLessThan(600);
    expect(result.endsWith('…')).toBe(true);
  });

  it('caps recursion depth on deeply nested objects rather than recursing forever', () => {
    let deep: unknown = 'bottom';
    for (let i = 0; i < 20; i += 1) {
      deep = { nested: deep };
    }
    expect(() => safeStringify(deep)).not.toThrow();
  });
});

describe('buildParametersFromConsoleProps', () => {
  it('flattens a plain consoleProps object into Parameter[]', () => {
    const result = buildParametersFromConsoleProps({ Command: 'get', Selector: '#foo' });
    expect(result).toEqual([
      { name: 'Command', value: 'get' },
      { name: 'Selector', value: '#foo' },
    ]);
  });

  it('calls consoleProps if it is a function (the LogConfig-typed shape)', () => {
    const result = buildParametersFromConsoleProps(() => ({ Yielded: 'ok' }));
    expect(result).toEqual([{ name: 'Yielded', value: 'ok' }]);
  });

  it('returns an empty array, not a throw, if the function throws', () => {
    const result = buildParametersFromConsoleProps(() => {
      throw new Error('boom');
    });
    expect(result).toEqual([]);
  });

  it('returns an empty array for undefined/null/non-object input', () => {
    expect(buildParametersFromConsoleProps(undefined)).toEqual([]);
    expect(buildParametersFromConsoleProps(null)).toEqual([]);
    expect(buildParametersFromConsoleProps('a string')).toEqual([]);
  });

  it('skips function-valued top-level properties', () => {
    const result = buildParametersFromConsoleProps({ Command: 'get', Snapshot: () => {} });
    expect(result).toEqual([{ name: 'Command', value: 'get' }]);
  });

  it('flattens the NESTED `props` object (Cypress\'s real {name, type, props} shape) rather than the outer bookkeeping keys', () => {
    // The exact shape observed in real captured command-log output for a
    // cy.visit() — see command-log-listener.ts's buildParametersFromConsoleProps
    // doc comment.
    const result = buildParametersFromConsoleProps({
      name: 'visit',
      type: 'command',
      props: { 'Resolved Url': 'http://localhost:3000/login', Redirects: [], 'Cookies Set': [] },
    });
    expect(result).toEqual([
      { name: 'Resolved Url', value: 'http://localhost:3000/login' },
      { name: 'Redirects', value: '[]' },
      { name: 'Cookies Set', value: '[]' },
    ]);
  });

  it('falls back to flattening the outer object when there is no nested `props`', () => {
    const result = buildParametersFromConsoleProps({ name: 'get', type: 'command' });
    expect(result).toEqual([
      { name: 'name', value: 'get' },
      { name: 'type', value: 'command' },
    ]);
  });

  it('falls back to the outer object when `props` is not a plain object (e.g. an array or primitive)', () => {
    expect(buildParametersFromConsoleProps({ name: 'x', props: [1, 2, 3] })).toEqual([
      { name: 'name', value: 'x' },
      { name: 'props', value: '[1, 2, 3]' },
    ])
    expect(buildParametersFromConsoleProps({ name: 'x', props: 'a string' })).toEqual([
      { name: 'name', value: 'x' },
      { name: 'props', value: 'a string' },
    ])
  });

  it('an empty nested `props` object yields zero parameters, not the outer bookkeeping keys', () => {
    // Real observed shape for a bare cy.get() with nothing interesting to
    // report: {name: 'get', type: 'command', props: {}}.
    const result = buildParametersFromConsoleProps({ name: 'get', type: 'command', props: {} });
    expect(result).toEqual([]);
  });

  it('caps at the server-mirrored MAX_PARAMETERS_PER_STEP limit (50)', () => {
    const huge: Record<string, string> = {};
    for (let i = 0; i < 80; i += 1) {
      huge[`key${i}`] = `value${i}`;
    }
    const result = buildParametersFromConsoleProps(huge);
    expect(result).toHaveLength(50);
  });
});
