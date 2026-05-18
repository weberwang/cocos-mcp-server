/**
 * Minimal stdio-to-HTTP MCP adapter (pure proxy).
 *
 * Reads JSON-RPC lines from stdin, forwards them to the extension's
 * HTTP POST /mcp endpoint, and writes responses back to stdout.
 */

import * as http from 'node:http';

const PORT = parseInt(process.env['COCOS_MCP_PORT'] ?? '7788', 10);
const BASE = `http://127.0.0.1:${PORT}`;

function log(msg: string): void {
  process.stderr.write(`[cocos-mcp] ${msg}\n`);
}

function isNotification(line: string): boolean {
  try {
    const message = JSON.parse(line);
    return message?.jsonrpc === '2.0'
      && typeof message?.method === 'string'
      && !Object.prototype.hasOwnProperty.call(message, 'id');
  } catch {
    return false;
  }
}

function forward(line: string): void {
  const notification = isNotification(line);
  const req = http.request(
    `${BASE}/mcp`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    },
    (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (!body.trim()) {
          if (!notification && res.statusCode && res.statusCode >= 400) {
            log(`HTTP ${res.statusCode} with empty response body`);
          }
          return;
        }
        process.stdout.write(body + '\n');
      });
    },
  );

  req.on('error', (err) => {
    log(`HTTP error: ${err.message}`);
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: err.message },
        id: null,
      }) + '\n',
    );
  });

  req.write(line);
  req.end();
}

function main(): void {
  log(`Proxying stdio ↔ ${BASE}/mcp`);

  let buffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) forward(line);
    }
  });

  process.stdin.on('end', () => {
    if (buffer.trim()) forward(buffer.trim());
  });

  process.stdin.resume();
}

main();
