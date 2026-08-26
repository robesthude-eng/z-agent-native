import crypto from 'node:crypto';
import { sendJson } from '../native/json.mjs';
import { activeTurnCount } from '../native/agent.mjs';
import { readinessCheck } from '../native/readiness.mjs';
import { prometheusMetrics } from '../native/metrics.mjs';
import { runtimeCapabilities } from '../native/runtime-capabilities.mjs';

export async function handleSystemRoutes(req, res, p, { draining, startedAt, isDraining }) {
  if (p === '/metrics' && req.method === 'GET') {
    const expected = String(process.env.Z_AGENT_METRICS_BEARER_TOKEN || '').trim();
    if (!expected) {
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }
    const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
    if (!ok) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const body = Buffer.from(prometheusMetrics({ activeTurns: activeTurnCount() }));
    res.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    });
    res.end(body);
    return true;
  }

  if (p === '/health' || p === '/health/ready' || p === '/api/global/health' || p === '/global/health') {
    if (isDraining()) {
      sendJson(res, 503, {
        status: 'draining',
        runtime: 'z-agent-native',
        version: '1.0.0',
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        checks: {},
      });
      return true;
    }
    const readiness = await readinessCheck();
    const checks = Object.fromEntries(Object.entries(readiness.checks || {}).map(([name, value]) => [name, {
      ok: Boolean(value?.ok),
      latencyMs: Number(value?.latencyMs) || 0,
    }]));
    sendJson(res, readiness.ok ? 200 : 503, {
      status: readiness.ok ? 'ok' : 'not_ready',
      runtime: 'z-agent-native',
      version: '1.0.0',
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      checks,
    });
    return true;
  }

  if (p === '/api/ui-config' && req.method === 'GET') {
    sendJson(res, 200, { systemInstruction: '', runtime: 'z-agent-native', version: '1.0.0' });
    return true;
  }

  if (p === '/api/runtime-capabilities' && req.method === 'GET') {
    sendJson(res, 200, runtimeCapabilities());
    return true;
  }

  return false;
}
