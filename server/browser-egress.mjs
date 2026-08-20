import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { parseConnectAuthority, resolveBrowserEgress } from './native/browser-egress-policy.mjs';

const HOST = process.env.Z_AGENT_BROWSER_EGRESS_HOST || '0.0.0.0';
const PORT = Math.min(Math.max(Number(process.env.Z_AGENT_BROWSER_EGRESS_PORT) || 8080, 1), 65535);
const MAX_HEADER_BYTES = 64 * 1024;

function denySocket(socket, status = 403, message = 'Forbidden') {
  try { socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { try { socket.destroy(); } catch {} }
}

function publicError(res, status = 403) {
  const body = Buffer.from(status === 403 ? 'Forbidden' : 'Bad Gateway');
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(body.length), connection: 'close' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(req.method === 'HEAD' ? '' : JSON.stringify({ ok: true, policyProxy: true }));
  }
  try {
    const raw = String(req.url || '');
    if (raw.length > 16 * 1024) return publicError(res, 400);
    const target = await resolveBrowserEgress(raw);
    const url = target.url;
    const transport = url.protocol === 'https:' ? https : http;
    const headers = { ...req.headers, host: url.host, connection: 'close' };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const upstream = transport.request({
      protocol: url.protocol,
      host: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: req.method,
      headers,
      servername: url.protocol === 'https:' && !net.isIP(url.hostname) ? url.hostname : undefined,
      lookup: (_host, options, callback) => options?.all
        ? callback(null, [{ address: target.address, family: target.family }])
        : callback(null, target.address, target.family),
    }, (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers };
      delete responseHeaders['proxy-authenticate'];
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
    });
    upstream.setTimeout(30_000, () => upstream.destroy(new Error('browser egress timeout')));
    upstream.on('error', () => { if (!res.headersSent) publicError(res, 502); else res.destroy(); });
    req.pipe(upstream);
  } catch (error) {
    publicError(res, Number(error?.statusCode) === 400 ? 400 : 403);
  }
});

server.on('connect', async (req, clientSocket, head) => {
  clientSocket.setTimeout(35_000, () => clientSocket.destroy());
  try {
    const { hostname, port } = parseConnectAuthority(req.url);
    const target = await resolveBrowserEgress(`https://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}/`);
    const upstream = net.connect({ host: target.address, port, family: target.family });
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: z-agent-browser-egress\r\n\r\n');
      if (head?.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.once('error', () => denySocket(clientSocket, 502, 'Bad Gateway'));
    clientSocket.once('error', () => upstream.destroy());
    clientSocket.once('close', () => upstream.destroy());
  } catch (error) {
    denySocket(clientSocket, Number(error?.statusCode) === 400 ? 400 : 403, Number(error?.statusCode) === 400 ? 'Bad Request' : 'Forbidden');
  }
});

server.maxHeadersCount = 100;
server.on('clientError', (error, socket) => {
  if (Number(error?.bytesParsed) > MAX_HEADER_BYTES) return denySocket(socket, 431, 'Request Header Fields Too Large');
  denySocket(socket, 400, 'Bad Request');
});

server.listen(PORT, HOST, () => {
  console.log(`[browser-egress] listening on ${HOST}:${PORT}; policy=${process.env.Z_AGENT_NETWORK_POLICY || 'off'}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref?.();
});
