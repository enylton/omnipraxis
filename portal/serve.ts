import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const root = resolve('build/portal/browser');
const types: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};
createServer(async (request, response) => {
  try {
    const path = resolve(
      root,
      '.' + decodeURIComponent(new URL(request.url!, 'http://localhost').pathname),
    );
    if (path !== root && !path.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    let file = path;
    let info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      if (extname(path)) {
        response.writeHead(404).end();
        return;
      }
      file = resolve(root, 'index.html');
      info = await stat(file);
    }
    response.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Accept-Ranges', 'bytes');
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    if (request.headers.range && !range) {
      response.writeHead(416).end();
      return;
    }
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
      return;
    }
    response.setHeader('Content-Length', end - start + 1);
    if (range) {
      response.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
      response.statusCode = 206;
    }
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = createReadStream(file, { start, end });
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch {
    response.writeHead(500).end();
  }
}).listen(4200, '127.0.0.1', () => console.log('Portal preview: http://127.0.0.1:4200'));
