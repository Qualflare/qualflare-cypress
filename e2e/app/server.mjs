import * as http from 'node:http';

/**
 * A one-file app for the dogfood suite to drive.
 *
 * Cypress needs a real http origin -- `cy.visit()` does not accept `data:`
 * URLs, which is what the Playwright suite uses. So this serves one HTML string
 * for every request: no filesystem, no MIME map, no path-traversal surface.
 *
 * Port 0 so a busy runner can never collide, and `unref()` so the server can
 * never keep the Cypress node process alive. `unref` rather than closing it in
 * an `after:run` hook is deliberate: the plugin already registers `after:run`,
 * `after:spec` and `after:screenshot`, and Cypress permits only ONE handler per
 * lifecycle event -- registering a second would break the reporter.
 */
const HTML = `<!doctype html>
<meta charset="utf-8">
<title>Dogfood Shop</title>
<h1 id="title">Dogfood Shop</h1>
<form id="login">
  <input id="user" name="user" autocomplete="off">
  <button id="submit" type="submit">Sign in</button>
</form>
<p id="greeting" hidden></p>
<script>
  document.getElementById('login').addEventListener('submit', function (e) {
    e.preventDefault();
    var g = document.getElementById('greeting');
    g.textContent = 'Welcome, ' + document.getElementById('user').value;
    g.hidden = false;
  });
</script>`;

export function startAppServer() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
    });
    server.unref();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ origin: `http://127.0.0.1:${port}` });
    });
  });
}
