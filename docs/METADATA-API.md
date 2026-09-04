# Author-facing metadata API

```ts
import { qualflare } from '@qualflare/cypress';
```

Everything on `qualflare` is safe to call from anywhere inside a running test (`it(...)` body,
including nested `describe`s and hooks that run while a test is active). Calling any of these
outside a running test (e.g. at spec-file module-load time) logs a warning and no-ops — it never
throws or aborts the run.

## `qualflare.label(name, value)`

Attaches an Allure-style arbitrary label. `epic`/`feature`/`story`/`owner`/`severity` are just
conventional names — any string works.

```ts
it('logs in with valid credentials', () => {
  qualflare.label('epic', 'Authentication');
  qualflare.label('owner', 'platform-team');
  // ...
});
```

Capped at 100 labels per test; further calls beyond the cap are dropped with a one-time warning.

## `qualflare.link(url, opts?)`

Attaches a typed external link.

```ts
qualflare.link('https://github.com/org/repo/issues/42', { type: 'issue', name: 'Known flaky login' });
qualflare.link('https://your-tms.example.com/cases/TC-123', { type: 'tms' });
qualflare.link('https://internal-wiki.example.com/runbook'); // type defaults to 'custom'
```

`opts.type` is one of `'issue' | 'tms' | 'custom'`, defaulting to `'custom'`. Capped at 20 links per test.

## `qualflare.tag(...tags)`

```ts
qualflare.tag('smoke', 'critical-path');
```

Variadic — pass one or several tags in one call. Capped at 64 tags per test (further calls beyond
the cap are dropped with a one-time warning); an individual tag longer than 255 characters is
truncated, not dropped.

## `qualflare.description(text)`

Sets the test's description. Last call wins if invoked more than once in the same test.

```ts
qualflare.description('Verifies the standard email/password login flow against a seeded test account.');
```

## `qualflare.priority(value)`

Sets the test's priority. Last call wins if invoked more than once in the same test.

```ts
qualflare.priority('critical');
```

`value` is one of `'low' | 'medium' | 'high' | 'critical'`. Not runtime-validated on the client —
an unrecognized value is normalized or dropped server-side rather than rejecting the upload.

## `qualflare.parameter(name, value?, opts?)`

```ts
qualflare.parameter('userId', '12345');
qualflare.parameter('apiKey', secretValue, { masked: true });
```

**Placement depends on context**: called while a `qualflare.step()` is currently open, the parameter
attaches to that step's `parameters[]` (masking respected there). Called outside any open step, it
becomes a `Case.properties` entry instead — the wire contract has no test-level `Parameter[]`, only
`Step.parameters` — and `masked` has no effect in that case (see
[`docs/LIMITATIONS.md`](./LIMITATIONS.md)).

```ts
it('processes a payment', () => {
  qualflare.parameter('environment', 'sandbox'); // -> Case.properties.environment

  qualflare.step('submit payment form', () => {
    qualflare.parameter('cardLast4', '4242'); // -> this step's parameters[]
    cy.get('#card-number').type('4242424242424242');
    cy.get('#submit').click();
  });
});
```

`masked` **redacts the value before the report is written.** The secret never leaves this process:
it is not stored server-side and cannot be read back through the API. Inside a step the parameter
travels as `{ name, masked: true }` with no value and the UI renders `••••••` from the flag; outside
one it lands in `Case.properties`, a flat map with nowhere for the flag, so the value itself becomes
`••••••`.

A masked value is therefore **unrecoverable** — that is the point, but it is not a display toggle you
can undo later.

Requires v0.6.0 or newer of this package. Before that, `masked` was a display hint only: the real value
was sent, stored in plaintext and readable through the API, while only the UI drew dots over it.

## `qualflare.attachment(name, content, opts?)`

Attaches text/JSON/binary content you already have in memory.

```ts
qualflare.attachment('response.json', JSON.stringify(responseBody), { mimeType: 'application/json' });
qualflare.attachment('logo.png', base64PngString, { encoding: 'base64', mimeType: 'image/png' });
```

`opts.encoding` defaults to `'utf8'` (the string is base64-encoded for you before upload); pass
`'base64'` if `content` is already base64 text. Capped at 50 attachments per case (shared with
`attachmentFromFile()` and screenshots captured in the same test — see
[`docs/LIMITATIONS.md`](./LIMITATIONS.md) for how the caps interact), and subject to the same
per-file/per-run size budgets (`maxAttachmentBytes`/`maxTotalAttachmentBytes`, see
[`docs/CONFIGURATION.md`](./CONFIGURATION.md)) as screenshots.

## `qualflare.attachmentFromFile(name, path, opts?)`

Attaches a file already on disk (e.g. a file your test downloaded or generated) by path — the bytes
are read Node-side at upload time, size-guarded the same way screenshots are.

```ts
qualflare.attachmentFromFile('exported-report.pdf', '/tmp/report.pdf', { mimeType: 'application/pdf' });
```

## `qualflare.step(name, fn)`

Wraps a block of `cy.*()` commands as a named, reportable step — composes with the rest of a Cypress
chain since it returns a `Cypress.Chainable`.

```ts
it('completes checkout', () => {
  qualflare.step('add item to cart', () => {
    cy.get('[data-testid=add-to-cart]').click();
  });

  qualflare.step('fill shipping details', () => {
    cy.get('#name').type('Jane Doe');
    cy.get('#address').type('123 Main St');
  }).then(() => {
    // chains normally — step() returns a real Cypress.Chainable
  });
});
```

**Nesting**: calling `qualflare.step()` while another `qualflare.step()` is already open nests it
under the outer one, to arbitrary depth — this uses its own independent nesting stack, separate from
Cypress's own command-log-derived `parent`/`child` steps (which are limited to one level — see
[`docs/LIMITATIONS.md`](./LIMITATIONS.md)).

```ts
qualflare.step('checkout flow', () => {
  qualflare.step('enter payment details', () => {
    cy.get('#card').type('4242424242424242');
  });
  qualflare.step('confirm order', () => {
    cy.get('#confirm').click();
  });
});
```

A step's start time is captured when `qualflare.step()` is called (a documented approximation, not
the exact moment its wrapped commands begin executing in Cypress's command queue — see
[`docs/LIMITATIONS.md`](./LIMITATIONS.md)); its end time and duration reflect the real completion of
its wrapped commands. If a step's wrapped commands fail before completing, the step is left without a
recorded duration (defaults to 0) rather than reporting a guessed value.
