import assert from 'node:assert/strict';
import test from 'node:test';

const { handleSystemRoutes } = await import('../server/routes/system.mjs');

function call(token) {
  const res = { status: 0, writeHead(s) { this.status = s; }, end() {} };
  const req = { method: 'GET', headers: token ? { authorization: `Bearer ${token}` } : {} };
  return handleSystemRoutes(req, res, '/metrics', { startedAt: Date.now(), isDraining: () => false }).then(() => res.status);
}

test('/metrics is enabled by Z_AGENT_METRICS_TOKEN and the legacy alias', async () => {
  const saved = { a: process.env.Z_AGENT_METRICS_TOKEN, b: process.env.Z_AGENT_METRICS_BEARER_TOKEN };
  try {
    delete process.env.Z_AGENT_METRICS_TOKEN;
    delete process.env.Z_AGENT_METRICS_BEARER_TOKEN;
    assert.equal(await call('x'), 404);
    process.env.Z_AGENT_METRICS_TOKEN = 'primary-token';
    assert.equal(await call('wrong'), 401);
    assert.equal(await call('primary-token'), 200);
    delete process.env.Z_AGENT_METRICS_TOKEN;
    process.env.Z_AGENT_METRICS_BEARER_TOKEN = 'legacy-token';
    assert.equal(await call('legacy-token'), 200);
  } finally {
    for (const [k, v] of [['Z_AGENT_METRICS_TOKEN', saved.a], ['Z_AGENT_METRICS_BEARER_TOKEN', saved.b]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
