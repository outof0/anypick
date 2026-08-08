import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const host = '127.0.0.1';
const port = 4178;
const frontend = resolve('src/tray/tauri/frontend');
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const server = createServer(async (request, response) => {
  const requested = request.url === '/' ? 'index.html' : request.url?.split('?')[0].slice(1);
  const relative = normalize(requested || 'index.html');
  const path = join(frontend, relative);
  if (!path.startsWith(`${frontend}/`)) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const file = await stat(path);
    if (!file.isFile()) {
      throw new Error('Not a file');
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentTypes[extname(path)] || 'application/octet-stream',
    });
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

server.listen(port, host, () => {
  process.stdout.write(`AnyPick tray demo: http://${host}:${port}\n`);
  process.stdout.write('Uses in-memory fixture data only. Press Ctrl+C to stop.\n');
});
