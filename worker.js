// JDBBot: a tiny Kick chat bot for Giveaway Tools, running on Cloudflare Workers' free plan.
// The site sends POST /say with the key it was given at sign-in; the bot posts that line in Kick chat
// as the bot account. Kick tokens live in Workers KV and are refreshed here, never in the site.
//
// Routes:  GET /login  -> sign in to Kick as the bot account (once)
//          GET /callback -> Kick sends you back here; stores tokens, hands the site its key
//          GET /status, POST /say {channel, text}  (both need header X-Bot-Key)

const SCOPES = "user:read channel:read chat:write";
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS } });
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-bot-key", "access-control-allow-methods": "GET, POST, OPTIONS" };
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomString = n => b64url(crypto.getRandomValues(new Uint8Array(n)));
const page = (title, body) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px system-ui;background:#0b0e0f;color:#e8f0ea;padding:24px;max-width:520px;margin:auto"><h2>${title}</h2><p>${body}</p>`, { headers: { "content-type": "text/html;charset=utf-8" } });

function redirectUri(req) { return new URL("/callback", req.url).toString(); }

async function tokenRequest(env, params) {
  const r = await fetch("https://id.kick.com/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.KICK_CLIENT_ID, client_secret: env.KICK_CLIENT_SECRET, ...params })
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error("Kick token request failed: " + r.status + " " + JSON.stringify(t).slice(0, 200));
  return { access: t.access_token, refresh: t.refresh_token, exp: Date.now() + (t.expires_in || 3600) * 1000 };
}

async function accessToken(env) {
  const tok = await env.STORE.get("tokens", "json");
  if (!tok) throw new Error("not signed in");
  if (Date.now() < tok.exp - 120000) return tok.access;
  const fresh = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: tok.refresh });
  if (!fresh.refresh) fresh.refresh = tok.refresh;
  await env.STORE.put("tokens", JSON.stringify(fresh));
  return fresh.access;
}

async function kickApi(env, path, init = {}) {
  const r = await fetch("https://api.kick.com/public/v1" + path, {
    ...init, headers: { accept: "application/json", "content-type": "application/json", authorization: "Bearer " + await accessToken(env), ...(init.headers || {}) }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Kick API ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function broadcasterId(env, slug) {
  slug = String(slug || "").trim().toLowerCase().replace(/^@/, "").replace(/_/g, "-");
  if (!/^[a-z0-9-]{2,40}$/.test(slug)) throw new Error("bad channel name");
  const cached = await env.STORE.get("ch:" + slug);
  if (cached) return Number(cached);
  const d = await kickApi(env, "/channels?slug=" + encodeURIComponent(slug));
  const id = d.data && d.data[0] && d.data[0].broadcaster_user_id;
  if (!id) throw new Error("channel not found: " + slug);
  await env.STORE.put("ch:" + slug, String(id));
  return id;
}

// Keyless mode: the site sends an event name and a few fields, and the bot builds the line itself, so
// nobody can make JDBBot say arbitrary text. Only requests from the site's own page are accepted, and
// each channel is rate limited.
const clean = (v, n = 40) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const at = v => { const n = clean(v, 30).replace(/^@/, ""); return /^[A-Za-z0-9_.-]{1,30}$/.test(n) ? "@" + n : ""; };
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
const TEMPLATES = {
  test: () => "👋 Bot is connected and working!",
  winner: d => at(d.name) && `🎉 ${at(d.name)} won the giveaway! (${plural(+d.n || 0, "entry", "entries")})`,
  gtbOpen: d => `💰 Guess the Balance is open! Type ${clean(d.cmd, 15) || "!gtb"} <amount> to guess. One guess each${d.subs ? ", subs only" : ""}.`,
  gtbClose: d => `🔒 Guesses are closed! ${plural(+d.n || 0, "guess", "guesses")} in.`,
  gtbWin: d => at(d.name) ? `🏆 ${at(d.name)} wins Guess the Balance with ${clean(d.amount, 20)}! The balance was ${clean(d.final, 20)}.` : `The balance was ${clean(d.final, 20)}. Nobody won this round.`,
  callsOpen: d => `🎰 Slot calls are open! Type ${clean(d.cmd, 15) || "!call"} <slot name>. ${plural(+d.max || 1, "call", "calls")} each${d.subs ? ", subs only" : ""}.`,
  callsClose: d => `🔒 Slot calls are closed! ${plural(+d.n || 0, "call", "calls")} in.`,
  nowPlaying: d => at(d.name) && `▶️ Now playing ${clean(d.slot, 60)}, called by ${at(d.name)}`,
  bonus: d => at(d.name) && `🎁 ${clean(d.slot, 60)} (called by ${at(d.name)}) hit ${/^[aeiou]/i.test(clean(d.type)) ? "an" : "a"} ${clean(d.type, 10)} bonus! ${+d.n || 1} in the bonus hunt.`,
  callAck: d => at(d.name) && `${at(d.name)} called ${clean(d.slot, 60)} (${+d.i || 1}/${+d.max || 1})`
};
async function rateOk(env, channel) {
  const k = "rl:" + channel + ":" + Math.floor(Date.now() / 60000);
  const n = Number(await env.STORE.get(k) || 0);
  if (n >= 12) return false;
  await env.STORE.put(k, String(n + 1), { expirationTtl: 120 });
  return true;
}
function fromSite(req, env) {
  const o = req.headers.get("origin") || "";
  return o === new URL(env.SITE_URL).origin;
}

async function checkKey(req, env) {
  const key = req.headers.get("x-bot-key") || "";
  const real = await env.STORE.get("sitekey");
  return !!real && key.length > 20 && key === real;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/" ) return page("JDBBot", "This is the chat bot for Giveaway Tools. To sign it in, open <a style=\"color:#53fc18\" href=\"/login\">/login</a> while logged in to Kick as the bot account.");

    if (url.pathname === "/login") {
      const state = randomString(24), verifier = randomString(32);
      const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
      await env.STORE.put("oauth:" + state, verifier, { expirationTtl: 600 });
      const u = new URL("https://id.kick.com/oauth/authorize");
      for (const [k, v] of Object.entries({ client_id: env.KICK_CLIENT_ID, response_type: "code", redirect_uri: redirectUri(req), scope: SCOPES, state, code_challenge: challenge, code_challenge_method: "S256" })) u.searchParams.set(k, v);
      return Response.redirect(u.toString(), 302);
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code"), state = url.searchParams.get("state") || "";
      if (url.searchParams.get("error")) return page("Sign-in cancelled", "Kick said: " + url.searchParams.get("error"));
      const verifier = await env.STORE.get("oauth:" + state);
      if (!code || !verifier) return page("Link expired", "Open /login again.");
      await env.STORE.delete("oauth:" + state);
      const tok = await tokenRequest(env, { grant_type: "authorization_code", redirect_uri: redirectUri(req), code, code_verifier: verifier });
      const me = await fetch("https://api.kick.com/public/v1/users", { headers: { accept: "application/json", authorization: "Bearer " + tok.access } }).then(r => r.json()).catch(() => ({}));
      const name = (me.data && me.data[0] && me.data[0].name) || "";
      const want = String(env.BOT_USERNAME || "").toLowerCase();
      if (want && name.toLowerCase() !== want) return page("Wrong account", `You signed in as <b>${name || "someone else"}</b>. Log out of Kick in this browser, log in as <b>${env.BOT_USERNAME}</b>, then open /login again.`);
      await env.STORE.put("tokens", JSON.stringify(tok));
      await env.STORE.put("botname", name);
      let key = await env.STORE.get("sitekey");
      if (!key) { key = randomString(24); await env.STORE.put("sitekey", key); }
      const back = new URL(env.SITE_URL);
      back.hash = "bot=" + encodeURIComponent(new URL(req.url).origin) + "&botkey=" + encodeURIComponent(key);
      return Response.redirect(back.toString(), 302);
    }

    if (url.pathname === "/health") {   // public: is the bot signed in? (no secrets)
      const tok = await env.STORE.get("tokens");
      return json({ ok: true, signedIn: !!tok, bot: tok ? await env.STORE.get("botname") : null, kickKeys: !!(env.KICK_CLIENT_ID && env.KICK_CLIENT_SECRET) });
    }

    if (url.pathname === "/status") {
      if (!(await checkKey(req, env))) return json({ ok: false, error: "bad key" }, 401);
      const tok = await env.STORE.get("tokens");
      return json({ ok: !!tok, bot: await env.STORE.get("botname") });
    }

    if (url.pathname === "/say" && req.method === "POST") {
      const keyed = await checkKey(req, env);
      if (!keyed && !fromSite(req, env)) return json({ ok: false, error: "not allowed" }, 403);
      const body = await req.json().catch(() => ({}));
      const tpl = TEMPLATES[body.event];
      const text = keyed && body.text ? String(body.text).replace(/\s+/g, " ").trim().slice(0, 500) : tpl ? clean(tpl(body.data || {}) || "", 500) : "";
      if (!keyed && !(await rateOk(env, clean(body.channel).toLowerCase()))) return json({ ok: false, error: "slow down" }, 429);
      if (!text) return json({ ok: false, error: "empty" }, 400);
      try {
        const id = await broadcasterId(env, body.channel);
        await kickApi(env, "/chat", { method: "POST", body: JSON.stringify({ broadcaster_user_id: id, content: text, type: "user" }) });
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 502);
      }
    }
    return json({ ok: false, error: "not found" }, 404);
  }
};
