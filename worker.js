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

// ---------- chat commands (work on their own, no site needed) ----------
// Kick sends every chat message in BOT_CHANNEL to /webhook (set in the Kick developer app). The bot checks
// Kick's signature, then answers commands. Kick has no API for bots to cut clips, so !clip saves a
// timestamped marker instead; the list is at /clips.
async function appToken(env) {
  const c = await env.STORE.get("apptoken", "json");
  if (c && Date.now() < c.exp - 120000) return c.access;
  const t = await tokenRequest(env, { grant_type: "client_credentials" });
  await env.STORE.put("apptoken", JSON.stringify(t));
  return t.access;
}
async function kickApp(env, path, init = {}) {
  const r = await fetch("https://api.kick.com/public/v1" + path, {
    ...init, headers: { accept: "application/json", "content-type": "application/json", authorization: "Bearer " + await appToken(env), ...(init.headers || {}) }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Kick API ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}
async function subscribeChat(env) {
  const id = await broadcasterId(env, env.BOT_CHANNEL);
  const have = await kickApp(env, "/events/subscriptions?broadcaster_user_id=" + id).catch(e => ({ error: String(e.message) }));
  if (have.data && have.data.some(x => x.event === "chat.message.sent")) return { ok: true, already: true, have: have.data };
  const res = await kickApp(env, "/events/subscriptions", { method: "POST", body: JSON.stringify({ broadcaster_user_id: id, method: "webhook", events: [{ name: "chat.message.sent", version: 1 }] }) });
  return { ok: true, res, before: have };
}
let kickKey = null;
async function verifyKick(req, body) {
  const id = req.headers.get("kick-event-message-id"), ts = req.headers.get("kick-event-message-timestamp"), sig = req.headers.get("kick-event-signature");
  if (!id || !ts || !sig) return false;
  if (!kickKey) {
    const d = await fetch("https://api.kick.com/public/v1/public-key").then(r => r.json());
    const pem = (d.data && d.data.public_key) || "";
    const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), c => c.charCodeAt(0));
    kickKey = await crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  }
  const sigBytes = Uint8Array.from(atob(sig), c => c.charCodeAt(0));
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", kickKey, sigBytes, new TextEncoder().encode(`${id}.${ts}.${body}`));
}
const hms = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };
async function liveStart(env, id) {
  const d = await kickApp(env, "/livestreams?broadcaster_user_id=" + id).catch(() => ({}));
  const ls = d.data && d.data[0];
  return ls && ls.started_at ? Date.parse(ls.started_at) : null;
}
async function postAsBot(env, broadcasterUserId, text) {
  await kickApi(env, "/chat", { method: "POST", body: JSON.stringify({ broadcaster_user_id: broadcasterUserId, content: text.slice(0, 500), type: "user" }) });
}
async function onChat(env, ev) {
  const text = String(ev.content || "").trim(), who = (ev.sender && ev.sender.username) || "";
  const chan = ev.broadcaster || {}, bid = chan.user_id;
  if (!text.startsWith("!") || !bid || who.toLowerCase() === String(env.BOT_USERNAME).toLowerCase()) return;
  const [cmd, arg] = [text.split(/\s+/)[0].toLowerCase(), text.split(/\s+/)[1] || ""];
  const cdKey = "cd:" + bid + ":" + cmd;                      // a few seconds' cooldown per command
  if (await env.STORE.get(cdKey)) return;
  if (cmd === "!clip") {
    await env.STORE.put(cdKey, "1", { expirationTtl: 60 });
    const secs = Math.min(120, Math.max(5, parseInt(arg, 10) || 30));
    const start = await liveStart(env, bid);
    if (!start) return postAsBot(env, bid, `@${who} the stream isn't live, so there's nothing to clip.`);
    const end = (Date.now() - start) / 1000;
    const list = (await env.STORE.get("clips:" + bid, "json")) || [];
    list.unshift({ by: who, secs, from: Math.max(0, end - secs), to: end, stream: start, at: Date.now() });
    await env.STORE.put("clips:" + bid, JSON.stringify(list.slice(0, 200)));
    return postAsBot(env, bid, `📌 @${who} marked a clip: ${hms(end - secs)} to ${hms(end)} of this stream (last ${secs}s). Saved for the streamer to cut from the VOD.`);
  }
  if (cmd === "!uptime") {
    await env.STORE.put(cdKey, "1", { expirationTtl: 60 });
    const start = await liveStart(env, bid);
    return postAsBot(env, bid, start ? `⏱️ Live for ${hms((Date.now() - start) / 1000)}` : "The stream is offline.");
  }
  if (cmd === "!commands") {
    await env.STORE.put(cdKey, "1", { expirationTtl: 60 });
    return postAsBot(env, bid, "Commands: !clip [seconds] marks a clip of the last 30s (or up to 120s) · !uptime shows how long the stream has been live");
  }
}
async function clipsPage(env) {
  const id = await broadcasterId(env, env.BOT_CHANNEL);
  const list = (await env.STORE.get("clips:" + id, "json")) || [];
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const rows = list.map(c => `<tr><td>${new Date(c.stream).toISOString().slice(0, 10)}</td><td><b>${hms(c.from)} – ${hms(c.to)}</b></td><td>${esc(c.by)}</td><td>${c.secs}s</td></tr>`).join("");
  return page("Clip markers", `Times are from the start of each stream, so you can find them in the VOD.<table style="width:100%;margin-top:12px;border-collapse:collapse" cellpadding="6"><tr style="text-align:left;color:#9aa"><th>Stream</th><th>Time</th><th>By</th><th>Length</th></tr>${rows || '<tr><td colspan="4">No clips marked yet.</td></tr>'}</table>`);
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(subscribeChat(env).catch(() => {})); },   // keep the chat subscription alive
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/webhook" && req.method === "POST") {
      const body = await req.text();
      if (!(await verifyKick(req, body).catch(() => false))) return new Response("bad signature", { status: 401 });
      const mid = req.headers.get("kick-event-message-id");
      if (await env.STORE.get("seen:" + mid)) return new Response("dup");
      await env.STORE.put("seen:" + mid, "1", { expirationTtl: 600 });
      if ((req.headers.get("kick-event-type") || "") === "chat.message.sent") ctx.waitUntil(onChat(env, JSON.parse(body)).catch(e => env.STORE.put("lasterror", String(e.message || e))));
      return new Response("ok");
    }
    if (url.pathname === "/setup") {       // harmless: (re)subscribes BOT_CHANNEL's chat to /webhook
      try { return json(await subscribeChat(env)); } catch (e) { return json({ ok: false, error: String(e.message || e) }, 502); }
    }
    if (url.pathname === "/clips") return clipsPage(env);

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
      return json({ ok: true, signedIn: !!tok, bot: tok ? await env.STORE.get("botname") : null, kickKeys: !!(env.KICK_CLIENT_ID && env.KICK_CLIENT_SECRET), lastError: await env.STORE.get("lasterror") });
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
