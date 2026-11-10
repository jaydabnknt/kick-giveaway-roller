// Runs inside Stake's own page (any Stake mirror). It does two things:
// 1. Watches the page's own GraphQL calls. It keeps the latest login header in memory (never saved), and on the
//    My Bets > Active page it reports the request that loads your active bets, so the extension can repeat it later.
// 2. When asked, repeats that request with your current login and returns the active bets it finds.
(() => {
  if (!/(^|\.)stake\d*\.[a-z]{2,}(\.[a-z]{2})?$/i.test(location.hostname)) return;
  const TOKEN_HEADERS = ["x-access-token", "authorization"];
  let token = {};   // header name -> value, from the page's latest calls
  const origFetch = window.fetch;
  const isActivePage = () => /\/my-bets\/casino\/active/i.test(location.pathname);
  const post = m => window.postMessage({ from: "tb-main", ...m }, location.origin);

  const headersToObj = h => {
    const o = {};
    if (!h) return o;
    if (h instanceof Headers) h.forEach((v, k) => (o[k.toLowerCase()] = v));
    else if (Array.isArray(h)) h.forEach(([k, v]) => (o[String(k).toLowerCase()] = v));
    else for (const k of Object.keys(h)) o[k.toLowerCase()] = h[k];
    return o;
  };

  // Finds bet-like objects anywhere in a response: something with an id and a game name.
  function findBets(json) {
    const out = [], ids = new Set();
    const gameOf = o => (o.game && typeof o.game === "object" && (o.game.name || o.game.slug)) ||
      (o.thirdPartyGame && o.thirdPartyGame.name) || o.gameName || (typeof o.game === "string" ? o.game : "") ||
      (o.bet && typeof o.bet === "object" && o.bet.game && o.bet.game.name) || "";
    const walk = (v, depth) => {
      if (!v || typeof v !== "object" || depth > 12) return;
      if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
      const g = gameOf(v), id = v.id || v.iid || (v.bet && v.bet.id);
      if (g && id && !ids.has(String(id))) {
        ids.add(String(id));
        const amt = v.amount ?? (v.bet && v.bet.amount) ?? v.betAmount ?? null;
        const cur = v.currency || (v.bet && v.bet.currency) || "";
        out.push({ id: String(id), game: String(g), slug: (v.game && v.game.slug) || "", amount: amt, currency: cur });
        return;
      }
      for (const k of Object.keys(v)) walk(v[k], depth + 1);
    };
    walk(json, 0);
    return out;
  }

  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input && input.url) || "";
    const res = await origFetch.apply(this, arguments);
    try {
      if (/graphql/i.test(url)) {
        const h = headersToObj((init && init.headers) || (input && input.headers));
        for (const k of TOKEN_HEADERS) if (h[k]) token[k] = h[k];
        if (isActivePage() && init && typeof init.body === "string") {
          let body = null; try { body = JSON.parse(init.body); } catch (e) {}
          if (body && body.query) {
            const json = await res.clone().json().catch(() => null);
            const bets = json ? findBets(json) : [];
            const text = (body.operationName || "") + " " + body.query;
            let score = 0;
            if (/active/i.test(body.operationName || "")) score += 3;
            if (/active/i.test(body.query)) score += 2;
            if (/bet/i.test(text)) score += 1;
            if (bets.length) score += 2;
            if (score >= 2) {
              const keep = {}; for (const [k, v] of Object.entries(h)) if (!TOKEN_HEADERS.includes(k) && k !== "cookie") keep[k] = v;
              post({ type: "candidate", score, bets, req: { path: new URL(url, location.href).pathname, query: body.query, variables: body.variables || {}, operationName: body.operationName || null, headers: keep } });
            }
          }
        }
      }
    } catch (e) {}
    return res;
  };

  window.addEventListener("message", async e => {
    const d = e.data;
    if (e.source !== window || !d || d.from !== "tb-iso" || d.cmd !== "active") return;
    const reply = m => post({ type: "activeResult", nonce: d.nonce, ...m });
    try {
      const r = d.req;
      const res = await origFetch(location.origin + r.path, {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json", ...r.headers, ...token },
        body: JSON.stringify({ query: r.query, variables: r.variables, operationName: r.operationName || undefined })
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || (json.errors && !json.data)) {
        reply({ ok: false, error: (json && json.errors && json.errors.map(x => x.message).join("; ")) || "status " + res.status, badReq: res.status === 400 || !!(json && json.errors) });
        return;
      }
      reply({ ok: true, bets: findBets(json.data) });
    } catch (er) { reply({ ok: false, error: String(er && er.message || er) }); }
  });
})();
