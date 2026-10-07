import crypto from 'node:crypto';
import { activeTurnCount } from '../native/agent.mjs';
import { sendJson } from '../native/json.mjs';
import { prometheusMetrics } from '../native/metrics.mjs';
import { readinessCheck } from '../native/readiness.mjs';
import { runtimeCapabilities } from '../native/runtime-capabilities.mjs';
import { systemStatus } from '../native/system-status.mjs';

/** GET /api/system/status — только для администратора (вызывается после входа). */
export function handleAdminSystemRoutes(req, res, p, auth) {
  if (p !== '/api/system/status' || req.method !== 'GET') return false;
  if (auth?.user?.role !== 'admin') {
    sendJson(res, 403, { error: 'Только для администратора' });
    return true;
  }
  sendJson(res, 200, systemStatus({ activeTurns: activeTurnCount() }), { 'cache-control': 'no-store' });
  return true;
}

export async function handleSystemRoutes(req, res, p, { startedAt, isDraining }) {
  if (p === '/metrics' && req.method === 'GET') {
    // Z_AGENT_METRICS_TOKEN is the name documented in .env.example and written by
    // prod:env:init; Z_AGENT_METRICS_BEARER_TOKEN is the legacy name and still works.
    const expected = String(process.env.Z_AGENT_METRICS_TOKEN || process.env.Z_AGENT_METRICS_BEARER_TOKEN || '').trim();
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

  // Liveness: the process is up and the event loop answers. Deliberately no DB/disk
  // checks and still 200 while draining, so an orchestrator restarts only a hung
  // process and never one that is merely finishing its turns. Use /health/ready
  // (or /health) to decide whether to route traffic to the instance.
  if (p === '/health/live' && (req.method === 'GET' || req.method === 'HEAD')) {
    sendJson(res, 200, {
      status: isDraining() ? 'draining' : 'alive',
      runtime: 'z-agent-native',
      version: '1.0.0',
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    }, { 'cache-control': 'no-store' });
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

  if (p === '/api/runtime-capabilities' && req.method === 'GET') {
    sendJson(res, 200, runtimeCapabilities());
    return true;
  }

  return false;
}
