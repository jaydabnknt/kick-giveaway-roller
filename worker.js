// JDBBot: a tiny Kick chat bot for Giveaway Tools, running on Cloudflare Workers' free plan. It posts as the
// Kick app's own bot (bot badge) in channels whose streamer pressed Allow on their bot page; their Kick tokens
// live in Workers KV and are refreshed here, never in the site.
//
// Routes:  GET /allow -> the streamer allows the bot on Kick (once); /callback stores their token
//          POST /say {channel, event, data} from the site, POST /webhook from Kick (chat commands)
//          GET /channel?ch= for the site's bot pages, /room?ch=, /clips?ch=, /health, /setup

const SCOPES = "user:read channel:read chat:write events:subscribe";
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS } });
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-bot-key, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" };
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

async function accessToken(env, key) {   // key is "stok:<streamer's user id>"
  const tok = await env.STORE.get(key, "json");
  if (!tok) throw new Error("not signed in");
  if (Date.now() < tok.exp - 120000) return tok.access;
  const fresh = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: tok.refresh });
  if (!fresh.refresh) fresh.refresh = tok.refresh;
  await env.STORE.put(key, JSON.stringify(fresh));
  return fresh.access;
}

async function kickApi(env, path, init = {}, key) {
  const r = await fetch("https://api.kick.com/public/v1" + path, {
    ...init, headers: { accept: "application/json", "content-type": "application/json", authorization: "Bearer " + await accessToken(env, key), ...(init.headers || {}) }
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
  const d = await kickApp(env, "/channels?slug=" + encodeURIComponent(slug));
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
  callAck: d => at(d.name) && `${at(d.name)} called ${clean(d.slot, 60)} (${+d.i || 1}/${+d.max || 1})`,
  raid: d => at(d.name) && `🚨 Thank you ${at(d.name)} for the raid${+d.viewers > 0 ? " with " + plural(+d.viewers, "viewer", "viewers") : ""}! Everyone go check them out and drop a follow: https://kick.com/${at(d.name).slice(1).toLowerCase().replace(/_/g, "-")}`
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
  return o === new URL(env.SITE_URL).origin || o === "https://jaydabnknt.github.io" || /^https:\/\/([a-z0-9-]+\.)?jdbbot(-[a-z0-9]+)?\.pages\.dev$/.test(o);
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
async function subscribeChat(env, slug = env.BOT_CHANNEL) {
  const id = await broadcasterId(env, slug);
  const have = await kickApp(env, "/events/subscriptions?broadcaster_user_id=" + id).catch(e => ({ error: String(e.message) }));
  const want = ["chat.message.sent", ...String(env.EXTRA_EVENTS || "").split(",").map(x => x.trim()).filter(Boolean)];
  const got = new Set((have.data || []).map(x => x.event || x.name));
  const missing = want.filter(n => !got.has(n));
  if (!missing.length) return { ok: true, already: true, have: have.data };
  const res = await kickApp(env, "/events/subscriptions", { method: "POST", body: JSON.stringify({ broadcaster_user_id: id, method: "webhook", events: missing.map(name => ({ name, version: 1 })) }) });
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
// Post a line in a channel as the app's bot (the one with the bot badge). Kick only allows that with the
// streamer's permission, which they give once with the Allow button on their bot page (/allow).
async function postAsBot(env, broadcasterUserId, text) {
  if (!(await env.STORE.get("stok:" + broadcasterUserId))) throw new Error("this channel hasn't pressed Allow on its bot page");
  await kickApi(env, "/chat", { method: "POST", body: JSON.stringify({ content: text.slice(0, 500), type: "bot" }) }, "stok:" + broadcasterUserId);
}
async function setOnce(env, k, v) { if ((await env.STORE.get(k)) !== v) await env.STORE.put(k, v); }

// Short-lived flags (repeat deliveries, cooldowns) are kept in memory: KV's free plan only allows 1,000
// writes a day, and a busy chat would use that up. A flag can be lost when Cloudflare restarts the worker;
// that only means a command might answer twice.
const flags = new Map();
function flag(k, secs) {
  const now = Date.now();
  if (flags.size > 5000) for (const [x, t] of flags) if (t < now) flags.delete(x);
  if ((flags.get(k) || 0) > now) return false;
  flags.set(k, now + secs * 1000); return true;
}

// ---------- channels that use JDBBot ----------
// Any streamer can add the bot from their page on the site (?c=name): they get a short code, put it in their
// stream title or channel bio for a moment, and the bot checks it there. Nobody signs in to anything.
const normSlug = v => String(v || "").trim().toLowerCase().replace(/^https?:\/\/(www\.)?kick\.com\//, "").replace(/[/?#].*$/, "").replace(/^@/, "").replace(/_/g, "-");
async function channelList(env) {
  const list = (await env.STORE.get("channels", "json")) || [];
  if (!list.some(c => c.slug === env.BOT_CHANNEL)) list.unshift({ slug: env.BOT_CHANNEL, since: 0 });
  return list;
}
const isEnabled = async (env, slug) => (await channelList(env)).some(c => c.slug === normSlug(slug));
async function unsubscribe(env, slug) {
  const id = await broadcasterId(env, slug);
  const have = await kickApp(env, "/events/subscriptions?broadcaster_user_id=" + id).catch(() => ({}));
  for (const x of have.data || []) await kickApp(env, "/events/subscriptions?id=" + encodeURIComponent(x.id), { method: "DELETE" }).catch(() => {});
}
// ---------- access keys (Jay's dashboard) ----------
// Each key is its own KV entry "key:JDB-XXXX-XXXX" with { note, at, ch?, usedBy?, usedAt? } as metadata, and each
// request is "req:<slug>" with { note, at, approved? }, so two changes close together can't overwrite each
// other. A key with ch only works for that channel (that's what approving a request makes).
async function listMeta(env, prefix) {
  const out = {}; let cursor;
  do { const r = await env.STORE.list({ prefix, cursor }); for (const k of r.keys) out[k.name.slice(prefix.length)] = k.metadata || {}; cursor = r.list_complete ? null : r.cursor; } while (cursor);
  return out;
}
const getKeys = env => listMeta(env, "key:"), getRequests = env => listMeta(env, "req:");
const putKey = (env, k, rec) => env.STORE.put("key:" + k, "1", { metadata: rec });
const putReq = (env, slug, rec) => env.STORE.put("req:" + slug, "1", { metadata: rec });
async function findKey(env, key, slug) {   // a usable key for this channel: the one typed, or one made for it
  const keys = await getKeys(env);
  if (key && keys[key] && !keys[key].usedBy && (!keys[key].ch || keys[key].ch === slug)) return key;
  return Object.keys(keys).find(k => keys[k].ch === slug && !keys[k].usedBy) || null;
}
const newKey = () => "JDB-" + Array.from(crypto.getRandomValues(new Uint8Array(8)), b => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("").replace(/(.{4})(.{4})/, "$1-$2");
async function removeChannel(env, slug) {
  if (slug === env.BOT_CHANNEL) return;
  const id = await broadcasterId(env, slug).catch(() => 0);
  await env.STORE.put("channels", JSON.stringify((await channelList(env)).filter(c => c.slug !== slug)));
  if (id) { await env.STORE.delete("stok:" + id); await unsubscribe(env, slug).catch(() => {}); }
}
async function adminOk(req, env) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  return t.length > 20 && !!(await env.STORE.get("sess:" + t));
}

const BUILTINS = [
  ["!commands", "Shows this list", "Everyone"],
  ["!uptime", "Shows stream uptime", "Everyone"],
  ["!followage", "Shows how long you've followed", "Everyone"],
  ["!followers", "Shows the follower count", "Everyone"],
  ["!watchtime", "Shows your watchtime", "Everyone"],
  ["!top", "Shows the top 5 by watchtime", "Everyone"],
  ["!clip [seconds]", "Clips the last 30s (max 120)", "Everyone"],
  ["!so name", "Shoutout a streamer", "Mods"],
  ["!gtb start / stop", "Opens or closes GTB guesses (site open)", "Mods"],
  ["!jdb add name text", "Adds a command", "Mods"],
  ["!jdb edit name text", "Edits a command", "Mods"],
  ["!jdb del name", "Deletes a command", "Mods"],
  ["!jdb leave", "Removes the bot", "Streamer"]
];
const RESERVED = new Set(["commands", "clip", "uptime", "so", "jdb", "gtb", "followage", "followers", "watchtime", "top"]);

// Chat activity for !watchtime / !top. Kick doesn't tell bots who is watching, so someone counts as watching
// for up to 10 minutes after each message they send while the stream is live. Totals are saved to KV every
// 5 minutes.
const pending = new Map(), lastSave = new Map(), liveCache = new Map();
async function isLive(env, bid) {
  const c = liveCache.get(bid);
  if (c && Date.now() - c.at < 60000) return c.live;
  const live = !!(await liveStart(env, bid));
  liveCache.set(bid, { live, at: Date.now() }); return live;
}
async function loyalty(env, slug) {   // saved totals plus what hasn't been saved yet
  const saved = (await env.STORE.get("loyal:" + slug, "json")) || {};
  for (const [name, p] of pending.get(slug) || []) { const t = saved[name] || (saved[name] = { m: 0 }); t.m += p.m; }
  return saved;
}
async function noteChat(env, slug, bid, who) {
  if (!(await isLive(env, bid))) return;
  const key = who.toLowerCase(), map = pending.get(slug) || new Map(); pending.set(slug, map);
  const p = map.get(key) || { m: 0, last: 0 }, now = Date.now();
  if (p.last) p.m += Math.min(10, (now - p.last) / 60000);
  p.last = now; map.set(key, p);
  if (now - (lastSave.get(slug) || now - 1) < 300000) { if (!lastSave.has(slug)) lastSave.set(slug, now); return; }
  lastSave.set(slug, now);
  const all = await loyalty(env, slug);
  for (const q of map.values()) q.m = 0;
  await env.STORE.put("loyal:" + slug, JSON.stringify(all));
}
function since(t) {   // "1 year, 2 months, 5 days"
  const a = new Date(t), b = new Date(Date.now());
  let mo = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
  if (b.getUTCDate() < a.getUTCDate()) mo--;
  const from = new Date(a); from.setUTCMonth(a.getUTCMonth() + mo);
  const d = Math.floor((b - from) / 86400000), y = Math.floor(mo / 12); mo %= 12;
  const part = (n, w) => n ? `${n} ${w}${n === 1 ? "" : "s"}` : "";
  return [part(y, "year"), part(mo, "month"), part(d, "day")].filter(Boolean).join(", ") || "less than a day";
}
const dur = mins => { mins = Math.floor(mins); const d = Math.floor(mins / 1440), h = Math.floor(mins / 60) % 24, m = mins % 60; return [d && d + "d", h && h + "h", m + "m"].filter(Boolean).join(" "); };
async function kickV2(path) {
  const r = await fetch("https://kick.com/api/v2/" + path, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" } });
  return r.ok ? r.text() : "";
}
async function onChat(env, ev) {
  const text = String(ev.content || "").trim(), who = (ev.sender && ev.sender.username) || "";
  const chan = ev.broadcaster || {}, bid = chan.user_id, slug = normSlug(chan.channel_slug || chan.username);
  if (!bid || who.toLowerCase() === String(env.BOT_USERNAME).toLowerCase()) return;
  if (ev.message_id && !flag("msg:" + ev.message_id, 600)) return;   // the same chat message can arrive twice
  if (!(await isEnabled(env, slug))) return;
  const badges = ((ev.sender && ev.sender.identity && ev.sender.identity.badges) || []).map(b => String(b.type || b.text || "").toLowerCase());
  const isStreamer = normSlug(who) === slug || badges.includes("broadcaster");
  const isMod = isStreamer || badges.some(b => /moderator|^mod$/.test(b));
  await noteChat(env, slug, bid, who).catch(() => {});
  if (!text.startsWith("!")) return;
  const [cmd, arg] = [text.split(/\s+/)[0].toLowerCase(), text.split(/\s+/)[1] || ""];
  const cdKey = "cd:" + bid + ":" + cmd;                      // a few seconds' cooldown per command
  const cooldown = secs => flag(cdKey, secs);
  if (flags.get(cdKey) > Date.now()) return;
  const target = (arg || who).replace(/^@/, "").replace(/[^A-Za-z0-9_-]/g, "");
  if (cmd === "!followage") {
    cooldown(5);
    const t = await kickV2(`channels/${slug}/users/${encodeURIComponent(target.toLowerCase())}`).catch(() => "");
    const m = t.match(/"following_since"\s*:\s*"([^"]+)"/);
    if (!m) return postAsBot(env, bid, `@${target} isn't following ${chan.username || slug}.`);
    return postAsBot(env, bid, `@${target} has been following for ${since(Date.parse(m[1]))}`);
  }
  if (cmd === "!followers") {
    cooldown(15);
    const t = await kickV2("channels/" + slug).catch(() => ""), m = t.match(/"followers_?[cC]ount"\s*:\s*(\d+)/);
    return postAsBot(env, bid, m ? `${chan.username || slug} has ${Number(m[1]).toLocaleString("en-US")} followers` : "Couldn't get the follower count right now.");
  }
  if (cmd === "!watchtime") {
    cooldown(5);
    const t = (await loyalty(env, slug))[target.toLowerCase()] || { m: 0 };
    return postAsBot(env, bid, `@${target} has watched for ${dur(t.m)}`);
  }
  if (cmd === "!top") {
    cooldown(15);
    const top = Object.entries(await loyalty(env, slug)).sort((a, b) => b[1].m - a[1].m).slice(0, 5);
    return postAsBot(env, bid, top.length ? "🏆 " + top.map(([n, t], i) => `${i + 1}. ${n} (${dur(t.m)})`).join(" · ") : "No watchtime yet.");
  }
  if (cmd === "!clip") {
    cooldown(60);
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
    cooldown(60);
    const start = await liveStart(env, bid);
    return postAsBot(env, bid, start ? `⏱️ Live for ${hms((Date.now() - start) / 1000)}` : "The stream is offline.");
  }
  if (cmd === "!so") {
    if (!isMod) return;
    const target = arg.replace(/^@/, "").replace(/^https?:\/\/(www\.)?kick\.com\//i, "").replace(/[^A-Za-z0-9_-]/g, "");
    if (!target) return postAsBot(env, bid, "Usage: !so name");
    cooldown(10);
    return postAsBot(env, bid, await shoutout(env, target));
  }
  if (cmd === "!commands") {
    cooldown(30);
    return postAsBot(env, bid, `📋 Commands for this channel, and who can use them: ${env.SITE_URL}?c=${slug}`);
  }
  const key = "cmds:" + slug;
  if (cmd === "!jdb") {
    if (!isMod) return;
    const m = text.match(/^!jdb\s+(\S+)(?:\s+!?(\S+))?(?:\s+([\s\S]+))?$/i) || [];
    const sub = (m[1] || "").toLowerCase(), name = (m[2] || "").toLowerCase(), reply = clean(m[3], 400);
    const cmds = (await env.STORE.get(key, "json")) || {};
    const usage = "Usage: !jdb add name text · !jdb edit name text · !jdb del name";
    if (sub === "leave") {
      if (!isStreamer) return;
      if (slug === env.BOT_CHANNEL) return postAsBot(env, bid, "JDBBot can't leave its home channel.");
      await postAsBot(env, bid, "👋 JDBBot is leaving this channel. Add it back any time from " + env.SITE_URL + "?c=" + slug);
      await env.STORE.put("channels", JSON.stringify((await channelList(env)).filter(c => c.slug !== slug)));
      await env.STORE.delete("stok:" + bid);
      return unsubscribe(env, slug);
    }
    if (sub !== "add" && sub !== "edit" && !/^(del|delete|remove)$/.test(sub)) return postAsBot(env, bid, usage);
    if (!/^[a-z0-9_]{1,20}$/.test(name)) return postAsBot(env, bid, usage);
    if (RESERVED.has(name)) return postAsBot(env, bid, `!${name} is built in, so pick another name.`);
    if (sub === "add" || sub === "edit") {
      if (!reply) return postAsBot(env, bid, usage);
      if (sub === "add" && cmds[name]) return postAsBot(env, bid, `!${name} already exists. Use !jdb edit ${name} text to change it.`);
      if (sub === "edit" && !cmds[name]) return postAsBot(env, bid, `There's no !${name} yet. Use !jdb add ${name} text.`);
      if (sub === "add" && Object.keys(cmds).length >= 100) return postAsBot(env, bid, "This channel already has 100 commands. Delete one first.");
      cmds[name] = { text: reply, by: who, at: Date.now() };
      await env.STORE.put(key, JSON.stringify(cmds));
      return postAsBot(env, bid, sub === "add" ? `✅ Added !${name}` : `✏️ Updated !${name}`);
    }
    if (!cmds[name]) return postAsBot(env, bid, `There's no !${name}.`);
    delete cmds[name];
    await env.STORE.put(key, JSON.stringify(cmds));
    return postAsBot(env, bid, `🗑️ Deleted !${name}`);
  }
  const all = (await env.STORE.get(key, "json")) || {}, custom = all[cmd.slice(1)];
  if (custom) {
    cooldown(5);
    if (/\{count\}/i.test(custom.text)) { custom.count = (custom.count || 0) + 1; await env.STORE.put(key, JSON.stringify(all)); }
    return postAsBot(env, bid, custom.text.replace(/\{user\}/gi, "@" + who).replace(/\{touser\}/gi, "@" + target).replace(/\{count\}/gi, String(custom.count || 0)));
  }
}
async function channelInfo(env, slug) {
  slug = String(slug).toLowerCase().replace(/_/g, "-");
  const d = await kickApp(env, "/channels?slug=" + encodeURIComponent(slug)).catch(() => ({}));
  return d.data && d.data[0];
}
async function shoutout(env, name) {
  const ch = await channelInfo(env, name);
  const slug = (ch && ch.slug) || name.toLowerCase().replace(/_/g, "-");
  const what = ch && ch.category && ch.category.name ? ` · last streaming ${ch.category.name}` : "";
  return ch ? `📣 Go show some love to ${name}! Check them out at https://kick.com/${slug}${what}` : `Couldn't find a Kick channel called ${name}.`;
}
async function onRaid(env, ev) {
  const raider = ev.raider || ev.host || ev.from_broadcaster || ev.broadcaster_from || {};
  const name = raider.username || raider.channel_slug || raider.slug || "";
  const bid = (ev.broadcaster && ev.broadcaster.user_id) || await broadcasterId(env, env.BOT_CHANNEL);
  const viewers = ev.viewers || ev.viewer_count || ev.number_viewers || 0;
  if (!name) { await env.STORE.put("lastraid", JSON.stringify(ev).slice(0, 2000)); return; }
  const slug = String(raider.channel_slug || name).toLowerCase().replace(/_/g, "-");
  await postAsBot(env, bid, `🚨 Thank you ${name} for the raid${viewers ? " with " + viewers + " viewers" : ""}! Everyone go check them out and drop a follow: https://kick.com/${slug}`);
}
async function clipsPage(env, slug) {
  const id = await broadcasterId(env, slug || env.BOT_CHANNEL);
  const list = (await env.STORE.get("clips:" + id, "json")) || [];
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const rows = list.map(c => `<tr><td>${new Date(c.stream).toISOString().slice(0, 10)}</td><td><b>${hms(c.from)} – ${hms(c.to)}</b></td><td>${esc(c.by)}</td><td>${c.secs}s</td></tr>`).join("");
  return page("Clip markers", `Times are from the start of each stream, so you can find them in the VOD.<table style="width:100%;margin-top:12px;border-collapse:collapse" cellpadding="6"><tr style="text-align:left;color:#9aa"><th>Stream</th><th>Time</th><th>By</th><th>Length</th></tr>${rows || '<tr><td colspan="4">No clips marked yet.</td></tr>'}</table>`);
}

export default {
  async scheduled(event, env, ctx) {   // keep every channel's chat subscription alive
    ctx.waitUntil((async () => { for (const c of await channelList(env)) await subscribeChat(env, c.slug).catch(() => {}); })());
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/webhook" && req.method === "POST") {
      const body = await req.text();
      if (!(await verifyKick(req, body).catch(() => false))) return new Response("bad signature", { status: 401 });
      const mid = req.headers.get("kick-event-message-id");
      if (!flag("seen:" + mid, 600)) return new Response("dup");
      const type = req.headers.get("kick-event-type") || "";
      const fail = e => env.STORE.put("lasterror", String(e.message || e));
      if (type === "chat.message.sent") ctx.waitUntil(onChat(env, JSON.parse(body)).catch(fail));
      else if (/raid|host/i.test(type)) ctx.waitUntil(onRaid(env, JSON.parse(body)).catch(fail));
      else ctx.waitUntil(env.STORE.put("lastevent:" + type, body.slice(0, 2000), { expirationTtl: 86400 * 7 }));
      return new Response("ok");
    }
    if (url.pathname === "/setup") {       // harmless: (re)subscribes BOT_CHANNEL's chat to /webhook
      await env.STORE.delete("appbot-off");   // and lets the app bot be tried again right away
      const out = {};
      for (const c of await channelList(env)) out[c.slug] = await subscribeChat(env, c.slug).catch(e => ({ ok: false, error: String(e.message || e) }));
      return json(out);
    }
    if (url.pathname === "/clips") return clipsPage(env, normSlug(url.searchParams.get("ch")));
    if (url.pathname === "/try-event") {   // which event names does Kick accept? (one at a time, BOT_CHANNEL only)
      const name = clean(url.searchParams.get("name"), 60);
      try {
        const id = await broadcasterId(env, env.BOT_CHANNEL);
        return json(await kickApp(env, "/events/subscriptions", { method: "POST", body: JSON.stringify({ broadcaster_user_id: id, method: "webhook", events: [{ name, version: 1 }] }) }));
      } catch (e) { return json({ ok: false, error: String(e.message || e) }); }
    }

    if (url.pathname === "/" ) return page("JDBBot", `This is the chat bot for Giveaway Tools. Add it to your channel from your bot page on <a style="color:#53fc18" href="${env.SITE_URL}?c=">the site</a>.`);

    // /allow: a streamer lets the badge bot post in their chat. New channels need an access key from Jay's
    // dashboard (or an approved request); channels already using the bot can re-allow without one.
    // /admin/login: Jay signs in to the dashboard with Kick.
    if (url.pathname === "/allow" || url.pathname === "/admin/login") {
      const admin = url.pathname === "/admin/login";
      const ch = normSlug(url.searchParams.get("ch")), key = clean(url.searchParams.get("key"), 40).toUpperCase();
      if (!admin) {
        const back = err => Response.redirect(env.SITE_URL + "?c=" + encodeURIComponent(ch) + "&err=" + err, 302);
        if (!ch) return Response.redirect(env.SITE_URL + "?add", 302);
        if (!(await isEnabled(env, ch)) && !(await findKey(env, key, ch))) return back(key ? "badkey" : "nokey");
      }
      const state = (admin ? "d" : "a") + randomString(24), verifier = randomString(32);
      const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
      await env.STORE.put("oauth:" + state, JSON.stringify({ v: verifier, key, ch }), { expirationTtl: 600 });
      const u = new URL("https://id.kick.com/oauth/authorize");
      for (const [k, v] of Object.entries({ client_id: env.KICK_CLIENT_ID, response_type: "code", redirect_uri: redirectUri(req), scope: admin ? "user:read" : SCOPES, state, code_challenge: challenge, code_challenge_method: "S256" })) u.searchParams.set(k, v);
      return Response.redirect(u.toString(), 302);
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code"), state = url.searchParams.get("state") || "";
      if (url.searchParams.get("error")) return page("Sign-in cancelled", "Kick said: " + url.searchParams.get("error"));
      const saved = await env.STORE.get("oauth:" + state);
      if (!code || !saved) return page("Link expired", "Open your bot page and tap Allow again.");
      const st = saved.startsWith("{") ? JSON.parse(saved) : { v: saved }, verifier = st.v;
      await env.STORE.delete("oauth:" + state);
      const tok = await tokenRequest(env, { grant_type: "authorization_code", redirect_uri: redirectUri(req), code, code_verifier: verifier });
      const me = await fetch("https://api.kick.com/public/v1/users", { headers: { accept: "application/json", authorization: "Bearer " + tok.access } }).then(r => r.json()).catch(() => ({}));
      const name = (me.data && me.data[0] && me.data[0].name) || "";
      const uid = me.data && me.data[0] && me.data[0].user_id;
      if (!uid) return page("Couldn't check your account", "Kick didn't say who you are. Try again.");
      if (state.startsWith("d")) {   // dashboard sign-in: only the home channel's owner gets in
        if (Number(uid) !== Number(await broadcasterId(env, env.BOT_CHANNEL))) return page("Not allowed", "This dashboard is only for the owner of JDBBot.");
        const sess = randomString(32);
        await env.STORE.put("sess:" + sess, String(uid), { expirationTtl: 30 * 86400 });
        return Response.redirect(env.SITE_URL + "?admin#s=" + sess, 302);
      }
      {
        const ch = await fetch("https://api.kick.com/public/v1/channels?broadcaster_user_id=" + uid, { headers: { accept: "application/json", authorization: "Bearer " + tok.access } }).then(r => r.json()).catch(() => ({}));
        const slug = normSlug((ch.data && ch.data[0] && ch.data[0].slug) || name);
        if (!(await isEnabled(env, slug))) {   // new channel: use up the key now that Kick says whose channel it is
          const k = await findKey(env, st.key, slug);
          if (!k) return Response.redirect(env.SITE_URL + "?c=" + encodeURIComponent(slug) + "&err=" + (st.key ? "badkey" : "nokey"), 302);
          const rec = (await getKeys(env))[k] || {}; rec.usedBy = slug; rec.usedAt = Date.now();
          await putKey(env, k, rec);
          await env.STORE.delete("req:" + slug);
        }
        await env.STORE.put("stok:" + uid, JSON.stringify(tok));
        await env.STORE.put("ch:" + slug, String(uid));
        const list = await channelList(env);
        if (!list.some(c => c.slug === slug)) { await subscribeChat(env, slug).catch(() => {}); list.push({ slug, id: uid, since: Date.now() }); await env.STORE.put("channels", JSON.stringify(list)); }
        ctx.waitUntil(postAsBot(env, uid, "👋 JDBBot is here! Type !commands").catch(e => env.STORE.put("lasterror", String(e.message || e))));
        return Response.redirect(env.SITE_URL + "?c=" + encodeURIComponent(slug) + "&allowed=1", 302);
      }
      return page("Link expired", "Open your bot page and tap Allow again.");
    }

    if (url.pathname === "/health") {   // public: is the bot signed in? (no secrets)
      return json({ ok: true, bot: env.BOT_USERNAME, kickKeys: !!(env.KICK_CLIENT_ID && env.KICK_CLIENT_SECRET), channels: (await channelList(env)).length, lastError: await env.STORE.get("lasterror"), lastRaidRaw: await env.STORE.get("lastraid") });
    }

    if (url.pathname === "/say" && req.method === "POST") {
      const keyed = await checkKey(req, env);
      if (!keyed && !fromSite(req, env)) return json({ ok: false, error: "not allowed" }, 403);
      const body = await req.json().catch(() => ({}));
      const tpl = TEMPLATES[body.event];
      const text = keyed && body.text ? String(body.text).replace(/\s+/g, " ").trim().slice(0, 500) : tpl ? clean(tpl(body.data || {}) || "", 500) : "";
      if (!keyed && !(await isEnabled(env, body.channel))) return json({ ok: false, error: "JDBBot isn't added to this channel yet" }, 403);
      if (!keyed && !(await rateOk(env, clean(body.channel).toLowerCase()))) return json({ ok: false, error: "slow down" }, 429);
      if (!text) return json({ ok: false, error: "empty" }, 400);
      if (body.event === "raid") {           // the site and every OBS overlay may all see the same raid; thank it once
        const k = "raid:" + clean(body.channel).toLowerCase() + ":" + at(body.data && body.data.name).toLowerCase();
        if (await env.STORE.get(k)) return json({ ok: true, duplicate: true });
        await env.STORE.put(k, "1", { expirationTtl: 900 });
      }
      try {
        const id = await broadcasterId(env, body.channel);
        await postAsBot(env, id, text);
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, error: String(e.message || e) }, 502);
      }
    }
    if (url.pathname === "/channel") {   // public info for a channel's page on the site
      const slug = normSlug(url.searchParams.get("ch"));
      if (!/^[a-z0-9-]{2,40}$/.test(slug)) return json({ ok: false, error: "bad channel" }, 400);
      const enabled = await isEnabled(env, slug);
      const cmds = (await env.STORE.get("cmds:" + slug, "json")) || {};
      let clips = [];
      if (enabled) clips = ((await env.STORE.get("clips:" + await broadcasterId(env, slug).catch(() => 0), "json")) || []).slice(0, 50);
      const badge = enabled && !!(await env.STORE.get("stok:" + await broadcasterId(env, slug).catch(() => 0)));
      const requested = !enabled && !!(await getRequests(env))[slug], approved = !enabled && !!(await findKey(env, "", slug));
      return json({ ok: true, slug, enabled, badge, requested, approved, home: slug === env.BOT_CHANNEL, bot: env.BOT_USERNAME, builtins: BUILTINS.map(([name, does, who]) => ({ name, does, who })),
        custom: Object.entries(cmds).sort(([a], [b]) => a.localeCompare(b)).map(([name, c]) => ({ name: "!" + name, text: c.text, by: c.by })), clips });
    }
    if (url.pathname === "/request" && req.method === "POST") {   // a streamer asks Jay for access
      const b = await req.json().catch(() => ({}));
      const slug = normSlug(b.ch);
      if (!/^[a-z0-9-]{2,40}$/.test(slug)) return json({ ok: false, error: "Type your Kick channel name." }, 400);
      if (await isEnabled(env, slug)) return json({ ok: true, enabled: true });
      try { await broadcasterId(env, slug); } catch (e) { return json({ ok: false, error: "Kick has no channel called " + slug + "." }, 404); }
      const reqs = await getRequests(env);
      if (!reqs[slug]) {
        if (Object.keys(reqs).length >= 100) return json({ ok: false, error: "Too many requests right now. Try again later." }, 429);
        await putReq(env, slug, { note: clean(b.note, 200), at: Date.now() });
      }
      return json({ ok: true, requested: true, approved: !!(await findKey(env, "", slug)) });
    }
    if (url.pathname.startsWith("/admin/")) {
      if (!(await adminOk(req, env))) return json({ ok: false, error: "signin" }, 401);
      const b = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      for (const [old, put] of [["keys", putKey], ["requests", putReq]]) {   // move anything saved the old way (one big record)
        const o = await env.STORE.get(old, "json");
        if (o) { for (const k in o) await put(env, k, o[k]); await env.STORE.delete(old); }
      }
      const keys = await getKeys(env), reqs = await getRequests(env);   // listings can lag a few seconds, so changes below are applied to them too
      const op = url.pathname.slice(7);
      try {
        if (op === "key") { const k = newKey(); keys[k] = { note: clean(b.note, 100), at: Date.now() }; await putKey(env, k, keys[k]); }
        else if (op === "revoke") {
          const k = clean(b.key, 20), rec = keys[k] || (await env.STORE.getWithMetadata("key:" + k)).metadata;
          if (!rec) return json({ ok: false, error: "no such key" }, 404);
          if (rec.usedBy) await removeChannel(env, rec.usedBy);
          await env.STORE.delete("key:" + k); delete keys[k];
        }
        else if (op === "approve") {
          const slug = normSlug(b.ch), r = reqs[slug]; if (!r) return json({ ok: false, error: "no such request" }, 404);
          const k = newKey(); keys[k] = { note: "Request: " + slug, at: Date.now(), ch: slug }; await putKey(env, k, keys[k]);
          r.approved = Date.now(); await putReq(env, slug, r);
        }
        else if (op === "deny") { const slug = normSlug(b.ch); await env.STORE.delete("req:" + slug); delete reqs[slug]; }
        else if (op === "remove") {
          const slug = normSlug(b.ch); await removeChannel(env, slug);
          for (const k in keys) if (keys[k].usedBy === slug) { await env.STORE.delete("key:" + k); delete keys[k]; }
        }
      } catch (e) { return json({ ok: false, error: String(e.message || e).slice(0, 200) }, 500); }
      if (op === "logout") { await env.STORE.delete("sess:" + (req.headers.get("authorization") || "").replace(/^Bearer\s+/, "")); return json({ ok: true }); }
      if (!["state", "key", "revoke", "approve", "deny", "remove"].includes(op)) return json({ ok: false, error: "not found" }, 404);
      return json({ ok: true, home: env.BOT_CHANNEL, channels: await channelList(env), keys: Object.entries(keys).map(([key, k]) => ({ key, ...k })).sort((a, b) => b.at - a.at),
        requests: Object.entries(reqs).map(([ch, r]) => ({ ch, ...r })).sort((a, b) => b.at - a.at) });
    }
    if (url.pathname === "/room") {   // a channel's chatroom number, so OBS overlays can watch chat for raids
      if (req.method === "POST") {
        if (!fromSite(req, env)) return json({ ok: false, error: "not allowed" }, 403);
        const b = await req.json().catch(() => ({}));
        const slug = clean(b.ch, 40).toLowerCase(), id = Number(b.id);
        if (!/^[a-z0-9_-]{1,40}$/.test(slug) || !(id > 0)) return json({ ok: false, error: "bad room" }, 400);
        await env.STORE.put("room:" + slug, String(id));
        return json({ ok: true });
      }
      const slug = clean(url.searchParams.get("ch"), 40).toLowerCase().replace(/^@/, "");
      let id = Number(await env.STORE.get("room:" + slug)) || null;
      if (!id && slug) {                // Kick often blocks this from servers, so the site's copy above comes first
        const t = await fetch("https://kick.com/api/v2/channels/" + encodeURIComponent(slug), { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" } }).then(r => r.ok ? r.text() : "").catch(() => "");
        const m = t.match(/"chatroom"\s*:\s*\{[^{}]*?"id"\s*:\s*(\d+)/);
        if (m) { id = Number(m[1]); await env.STORE.put("room:" + slug, String(id)); }
      }
      return json({ ok: !!id, id });
    }
    return json({ ok: false, error: "not found" }, 404);
  }
};
