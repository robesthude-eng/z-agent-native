/**
 * llm-relay — Cloudflare Worker (direct-only LLM relay).
 *
 * Обходит гео-блокировки: сервер → этот воркер (egress Cloudflare) → провайдер.
 * Routing: /<SECRET>/<host>/<path> -> https://<host>/<path>
 * Метод, заголовки (включая Authorization) и тело пробрасываются as-is,
 * ответ стримится обратно. Hop-by-hop и «утечки» (cf-*, x-forwarded-*) удаляются.
 *
 * Деплой: wrangler deploy. Секрет задаётся переменной SECRET
 * (wrangler secret put SECRET или vars в wrangler.toml).
 */
const HOP_BY_HOP = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
];
const LEAKY = [
  "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cf-worker",
  "cf-ew-via", "true-client-ip", "x-real-ip", "x-forwarded-for",
  "x-forwarded-proto", "x-forwarded-host", "x-original-forwarded-for",
  "forwarded", "via",
];
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const BLOCKED = /(^|\.)(localhost|local|internal|lan|home\.arpa|test|example|invalid|onion)$/i;

export default {
  async fetch(request, env) {
    const secret = typeof env?.SECRET === "string" ? env.SECRET : "";
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("ok", { status: 200 });
    const prefix = `/${secret}/`;
    if (secret === "" || !url.pathname.startsWith(prefix)) {
      return new Response("Not found", { status: 404 });
    }
    const rest = url.pathname.slice(prefix.length);
    const slash = rest.indexOf("/");
    const host = slash === -1 ? rest : rest.slice(0, slash);
    if (
      !host ||
      !host.includes(".") ||
      !HOST_RE.test(host) ||
      /^\d+(\.\d+){3}$/.test(host) ||
      BLOCKED.test(host)
    ) {
      return new Response(JSON.stringify({ error: "bad host" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const target = `https://${rest}${url.search}`;
    const headers = new Headers(request.headers);
    for (const name of [...HOP_BY_HOP, ...LEAKY, "host"]) headers.delete(name);
    const init = { method: request.method, headers, redirect: "manual" };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }
    try {
      const upstream = await fetch(target, init);
      const responseHeaders = new Headers(upstream.headers);
      for (const name of HOP_BY_HOP) responseHeaders.delete(name);
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    } catch (error) {
      return new Response(JSON.stringify({ error: "upstream fetch failed", detail: String(error) }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
