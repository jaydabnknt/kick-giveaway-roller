// Extension side of the Stake page. Notices when you open or leave a game. When you leave one, it checks your
// Active (unfinished) bets and passes any new ones to ToolBot. stake-main.js does the actual requests inside the page.
(() => {
  if (!/(^|\.)stake\d*\.[a-z]{2,}(\.[a-z]{2})?$/i.test(location.hostname)) return;
  const send = m => chrome.runtime.sendMessage(m).catch(() => {});
  const gameSlug = () => (location.pathname.match(/\/casino\/games\/([^/?#]+)/i) || [])[1] || "";
  const pretty = s => s.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const gameName = slug => {
    let t = (document.title || "").split(/ [-|–] | Slot by | by /i)[0].trim();
    if (!t || /^stake/i.test(t)) t = pretty(slug);
    return t;
  };
  const waiting = new Map();
  window.addEventListener("message", e => {
    const d = e.data;
    if (e.source !== window || !d || d.from !== "tb-main") return;
    if (d.type === "candidate") send({ type: "candidate", origin: location.origin, score: d.score, req: d.req, bets: d.bets });
    if (d.type === "activeResult" && waiting.has(d.nonce)) { waiting.get(d.nonce)(d); waiting.delete(d.nonce); }
  });
  const askActive = req => new Promise(res => {
    const nonce = Math.random().toString(36).slice(2);
    waiting.set(nonce, res);
    setTimeout(() => { if (waiting.has(nonce)) { waiting.delete(nonce); res({ ok: false, error: "no answer from the Stake page" }); } }, 15000);
    window.postMessage({ from: "tb-iso", cmd: "active", nonce, req }, location.origin);
  });

  let busy = false;
  async function checkActive(why) {
    if (busy) return; busy = true;
    try {
      const { activeReq, enabled = true } = await chrome.storage.local.get(["activeReq", "enabled"]);
      if (!enabled) return;
      if (!activeReq) { send({ type: "learn", origin: location.origin }); return; }
      const r = await askActive(activeReq);
      if (!r.ok) { send({ type: "log", text: "Couldn't read Active bets: " + r.error }); if (r.badReq) send({ type: "learn", origin: location.origin, again: true }); return; }
      send({ type: "active", bets: r.bets, why });
    } finally { busy = false; }
  }
  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m && m.cmd === "checkNow") { checkActive("check now").then(() => reply({ ok: true })); return true; }
  });

  // Stake is a single-page app, so watch the address for changes.
  let last = null;
  const tick = () => {
    if (last === location.href) return;
    const was = last === null ? "" : (new URL(last).pathname.match(/\/casino\/games\/([^/?#]+)/i) || [])[1] || "";
    last = location.href;
    const now = gameSlug();
    if (now && now !== was) setTimeout(() => { if (gameSlug() === now) send({ type: "playing", game: gameName(now) }); }, 2000);
    if (was && was !== now) { setTimeout(() => checkActive("left " + was), 2500); setTimeout(() => checkActive("left " + was), 10000); }
  };
  setInterval(tick, 700);
  addEventListener("DOMContentLoaded", tick);
  // The first time, learn the Active bets request right away, so bets that were already open don't get added later.
  if (!/\/my-bets\//i.test(location.pathname)) chrome.storage.local.get("activeReq").then(({ activeReq }) => { if (!activeReq) send({ type: "learn", origin: location.origin }); });
})();
