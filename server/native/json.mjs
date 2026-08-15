export function sendJson(res, status, value, headers = {}) {
  if (status === 204) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

export async function readBody(req, maxBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const err = new Error('Request body too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, maxBytes) {
  const buf = await readBody(req, maxBytes);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    const err = new Error('Invalid JSON');
    err.statusCode = 400;
    throw err;
  }
}
