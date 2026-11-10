// Runs inside Stake's page. Reports the page's own GraphQL calls (with their answers) to the extension, keeps the
// latest login header in memory only, and repeats a call when the extension asks.
(() => {
  if (!/(^|\.)stake\d*\.[a-z]{2,}(\.[a-z]{2})?$/i.test(location.hostname)) return;
  const TOKEN = ["x-access-token", "authorization"];
  let token = {};
  const orig = window.fetch;
  const post = m => window.postMessage({ from: "tbs-main", ...m }, location.origin);
  const hObj = h => { const o = {}; if (!h) return o;
    if (h instanceof Headers) h.forEach((v, k) => (o[k.toLowerCase()] = v));
    else if (Array.isArray(h)) h.forEach(([k, v]) => (o[String(k).toLowerCase()] = v));
    else for (const k of Object.keys(h)) o[k.toLowerCase()] = h[k];
    return o; };
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input && input.url) || "";
    const res = await orig.apply(this, arguments);
    try {
      if (/graphql/i.test(url)) {
        const h = hObj((init && init.headers) || (input && input.headers));
        for (const k of TOKEN) if (h[k]) token[k] = h[k];
        let body = null; try { body = JSON.parse(init && init.body); } catch (e) {}
        if (body && body.query) {
          const json = await res.clone().json().catch(() => null);
          const keep = {}; for (const [k, v] of Object.entries(h)) if (!TOKEN.includes(k) && k !== "cookie") keep[k] = v;
          if (json && json.data) post({ type: "seen", page: location.pathname, req: { path: new URL(url, location.href).pathname, query: body.query, variables: body.variables || {}, operationName: body.operationName || null, headers: keep }, data: json.data });
        }
      }
    } catch (e) {}
    return res;
  };
  window.addEventListener("message", async e => {
    const d = e.data;
    if (e.source !== window || !d || d.from !== "tbs-iso" || d.cmd !== "run") return;
    const reply = m => post({ type: "result", nonce: d.nonce, ...m });
    try {
      const r = d.req;
      const res = await orig(location.origin + r.path, { method: "POST", credentials: "include",
        headers: { "content-type": "application/json", ...r.headers, ...token },
        body: JSON.stringify({ query: r.query, variables: r.variables, operationName: r.operationName || undefined }) });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || !json.data) { reply({ ok: false, status: res.status, error: (json && json.errors && json.errors.map(x => x.message).join("; ")) || "status " + res.status }); return; }
      reply({ ok: true, data: json.data });
    } catch (er) { reply({ ok: false, status: 0, error: String(er && er.message || er) }); }
  });
})();
