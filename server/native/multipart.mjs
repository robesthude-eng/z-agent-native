import fs from 'node:fs';
import path from 'node:path';
import { finished as streamFinished } from 'node:stream/promises';

// Streaming multipart/form-data reader.
//
// The previous implementation buffered the entire request body and then sliced
// a second copy per part, so a single upload could pin twice its size in the
// server heap and a handful of concurrent uploads could exhaust it. Here the
// body is consumed chunk by chunk, bytes are handed to a sink (normally a file
// on disk) as they arrive, and only a delimiter-sized tail is ever retained.

const CR = 13;
const DASH = 45;
const HEADER_END = Buffer.from('\r\n\r\n');
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_DELIMITER_PADDING = 1024;

export const PART_TOO_LARGE = 'file too large';

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

export function boundaryFromContentType(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(contentType || ''));
  const boundary = (match?.[1] || match?.[2] || '').trim();
  return boundary || null;
}

function dispositionOf(headers) {
  return /^content-disposition:[ \t]*(.*)$/im.exec(headers)?.[1]?.trim() || '';
}

// Writes one part to `finalPath` through a sibling temp file, so a failed or
// oversized upload never leaves a truncated file where the agent can read it.
export function fileSink(finalPath, { overwrite = false, mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.upload-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const stream = fs.createWriteStream(tmpPath, { flags: 'wx', mode });
  let failure = null;
  stream.on('error', (err) => { failure = failure || err; });
  return {
    path: finalPath,
    tmpPath,
    async write(chunk) {
      if (failure) throw failure;
      if (stream.write(chunk)) return;
      await new Promise((resolve, reject) => {
        const onDrain = () => { stream.off('error', onError); resolve(); };
        const onError = (err) => { stream.off('drain', onDrain); reject(err); };
        stream.once('drain', onDrain);
        stream.once('error', onError);
      });
    },
    async finish() {
      stream.end();
      try { await streamFinished(stream); } catch (err) { failure = failure || err; }
      if (failure) throw failure;
      if (overwrite) {
        fs.renameSync(tmpPath, finalPath);
        return;
      }
      // linkSync fails with EEXIST instead of clobbering a file that appeared
      // while this upload was streaming.
      try { fs.linkSync(tmpPath, finalPath); } finally { fs.rmSync(tmpPath, { force: true }); }
    },
    async discard() {
      stream.destroy();
      // createWriteStream opens the fd asynchronously, so removing the temp
      // file before the stream is closed can be undone by a late open().
      if (!stream.closed) await new Promise((resolve) => stream.once('close', resolve));
      fs.rmSync(tmpPath, { force: true });
    },
  };
}

/**
 * Consume `req` as multipart/form-data.
 *
 * openPart({ name, filename, headers }) decides what happens to each part:
 *   - a sink object ({ write, finish, discard }) receives the bytes
 *   - null/undefined silently discards the part
 *   - { skip: reason } discards it and records `reason`
 *   - a throw records the error message and keeps parsing the other parts
 */
export async function parseMultipartStream(req, boundary, options = {}) {
  const maxPartBytes = Number(options.maxPartBytes) || 0;
  const maxTotalBytes = Number(options.maxTotalBytes) || 0;
  const maxParts = Number(options.maxParts) || 512;
  const openPart = typeof options.openPart === 'function' ? options.openPart : () => null;

  // Every delimiter in a well formed body is preceded by CRLF; seeding the
  // buffer with one lets a single needle match the first delimiter too.
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const parts = [];
  let buf = Buffer.from('\r\n');
  let state = 'delimiter';
  let current = null;
  let sink = null;
  let done = false;
  let received = 0;

  async function consume(chunk) {
    current.size += chunk.length;
    if (maxPartBytes && current.size > maxPartBytes) {
      if (sink) { await sink.discard(); sink = null; }
      current.skipped = true;
      current.error = current.error || PART_TOO_LARGE;
      return;
    }
    if (sink) await sink.write(chunk);
  }

  async function finishPart() {
    if (sink) {
      try {
        await sink.finish();
        current.path = sink.path;
      } catch (err) {
        current.error = err.message;
        current.skipped = true;
        try { await sink.discard(); } catch { /* best effort */ }
      }
      sink = null;
    }
    current = null;
  }

  async function pump() {
    while (true) {
      if (state === 'delimiter') {
        const idx = buf.indexOf(delimiter);
        if (idx < 0) {
          if (buf.length > delimiter.length) buf = buf.subarray(buf.length - delimiter.length);
          return;
        }
        const after = idx + delimiter.length;
        if (buf.length < after + 2) { buf = buf.subarray(idx); return; }
        if (buf[after] === DASH && buf[after + 1] === DASH) {
          done = true;
          buf = Buffer.alloc(0);
          return;
        }
        let cursor = after;
        while (cursor < buf.length && buf[cursor] !== CR) cursor += 1;
        if (cursor - after > MAX_DELIMITER_PADDING) throw httpError(400, 'malformed multipart delimiter');
        if (cursor + 1 >= buf.length) { buf = buf.subarray(idx); return; }
        buf = buf.subarray(cursor + 2);
        state = 'headers';
        continue;
      }
      if (state === 'headers') {
        const end = buf.indexOf(HEADER_END);
        if (end < 0) {
          if (buf.length > MAX_HEADER_BYTES) throw httpError(400, 'multipart part headers too large');
          return;
        }
        const raw = buf.subarray(0, end).toString('utf8');
        buf = buf.subarray(end + HEADER_END.length);
        if (parts.length >= maxParts) throw httpError(413, 'too many upload parts');
        const disposition = dispositionOf(raw);
        current = {
          name: /name="([^"]*)"/.exec(disposition)?.[1] ?? null,
          filename: /filename="([^"]*)"/.exec(disposition)?.[1] || null,
          size: 0,
          skipped: false,
        };
        parts.push(current);
        let opened = null;
        try {
          opened = await openPart({ name: current.name, filename: current.filename, headers: raw });
        } catch (err) {
          opened = { skip: err.message };
        }
        if (!opened) {
          current.skipped = true;
          sink = null;
        } else if (opened.skip) {
          current.skipped = true;
          current.error = String(opened.skip);
          sink = null;
        } else {
          sink = opened;
        }
        state = 'body';
        continue;
      }
      if (state === 'body') {
        const idx = buf.indexOf(delimiter);
        if (idx < 0) {
          // Hold back only enough bytes to recognise a delimiter split across
          // two chunks; everything else is flushed immediately.
          const keep = Math.min(buf.length, delimiter.length - 1);
          const flushable = buf.length - keep;
          if (flushable > 0) {
            await consume(buf.subarray(0, flushable));
            buf = buf.subarray(flushable);
          }
          return;
        }
        if (idx > 0) await consume(buf.subarray(0, idx));
        buf = buf.subarray(idx);
        await finishPart();
        state = 'delimiter';
        continue;
      }
      return;
    }
  }

  try {
    for await (const chunk of req) {
      received += chunk.length;
      if (maxTotalBytes && received > maxTotalBytes) throw httpError(413, 'Request body too large');
      if (done) continue; // drain the remainder so the client is not reset mid-write
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      await pump();
    }
    if (!done && state === 'body') throw httpError(400, 'multipart body truncated');
  } catch (err) {
    if (sink) {
      try { await sink.discard(); } catch { /* best effort */ }
      sink = null;
    }
    throw err;
  }

  return { parts, received };
}

// Buffered parser kept for small in-memory payloads and existing callers.
export function parseMultipart(buffer, boundary) {
  const out = [];
  const marker = Buffer.from(`--${boundary}`);
  let pos = 0;
  while (true) {
    const start = buffer.indexOf(marker, pos);
    if (start < 0) break;
    let cursor = start + marker.length;
    if (buffer[cursor] === DASH && buffer[cursor + 1] === DASH) break;
    if (buffer[cursor] === CR && buffer[cursor + 1] === 10) cursor += 2;
    const headerEnd = buffer.indexOf(HEADER_END, cursor);
    if (headerEnd < 0) break;
    const headers = buffer.slice(cursor, headerEnd).toString('utf8');
    const next = buffer.indexOf(marker, headerEnd + 4);
    const end = next < 0 ? buffer.length : next - 2;
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/.exec(headers)?.[1] || null;
    if (name) out.push({ name, filename, data: buffer.slice(headerEnd + 4, end) });
    if (next < 0) break;
    pos = next;
  }
  return out;
}
