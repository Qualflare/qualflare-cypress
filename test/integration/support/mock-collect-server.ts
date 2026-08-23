import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** One captured `/api/v1/collect` request. `body` is the parsed JSON (or the
 * raw string if it didn't parse — should never happen for a well-behaved
 * client, but surfaced rather than swallowed if it does). */
export interface CapturedRequest {
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface MockCollectServer {
  url: string;
  requests: CapturedRequest[];
  /** Queues a specific HTTP status to return for the NEXT request only; once
   * the queue is empty, subsequent requests get 201 with an incrementing
   * `{seq}`. Lets a test exercise the client's retry path end-to-end
   * (queue a 503, then the client's own retry naturally lands on 201). */
  queueStatus(status: number): void;
  close(): Promise<void>;
}

/** A real local HTTP server, not a mocked/patched client — deliberately, to
 * sidestep any uncertainty about whether a mocking library actually
 * intercepts `undici` traffic (see `test/unit/http-client.test.ts`'s
 * `undici.MockAgent` usage for the parallel reasoning at the unit-test
 * layer: `nock` only patches Node's legacy `http`/`https` modules, which
 * `undici.request()` doesn't go through). This is the real-process
 * equivalent for the integration layer. */
export function startMockCollectServer(): Promise<MockCollectServer> {
  const requests: CapturedRequest[] = [];
  const statusQueue: number[] = [];
  let seqCounter = 1;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // Leave `body` as the raw string — a client sending unparseable
        // JSON is itself a bug worth surfacing to whatever asserts on this,
        // not something to hide.
      }
      requests.push({ headers: req.headers, body });

      const status = statusQueue.shift() ?? 201;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      if (status >= 200 && status < 300) {
        res.end(JSON.stringify({ seq: seqCounter }));
        seqCounter += 1;
      } else {
        res.end(
          JSON.stringify({
            code: 'test.forced_error',
            message: `mock-collect-server: forced ${status} response for retry-path testing`,
          }),
        );
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        queueStatus(status: number) {
          statusQueue.push(status);
        },
        close() {
          return new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
  });
}
