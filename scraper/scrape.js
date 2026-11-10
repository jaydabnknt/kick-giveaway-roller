// The scraper itself. It learns two Stake requests by watching you browse:
//   the slot list (open Stake's Slots page and load more once), and
//   a slot's details (open any slot).
// Then, on Start, it repeats them: the list page by page, then each slot's details, slowly (see pace).
// Everything is kept in the extension's storage until you download the file.
(() => {
  if (!/(^|\.)stake\d*\.[a-z]{2,}(\.[a-z]{2})?$/i.test(location.hostname)) return;
  const S = chrome.storage.local;
  const PAGE_KEYS = /^(offset|skip)$/i, SIZE_KEYS = /^(limit|first|take|size)$/i;

  // The biggest list of game-like objects (have a slug and a name) anywhere in an answer.
  function gamesIn(data) {
    let best = [];
    const walk = (v, d) => {
      if (!v || typeof v !== "object" || d > 14) return;
      if (Array.isArray(v)) {
        const isGame = x => x && typeof x === "object" && typeof x.slug === "string" && (x.name || x.title);
        // a list item is the game itself, or wraps it one level down (like { id, game: { slug, name } })
        const g = v.map(x => isGame(x) ? x : x && typeof x === "object" ? Object.values(x).find(isGame) : null).filter(Boolean);
        if (g.length > best.length) best = g;
        v.forEach(x => walk(x, d + 1)); return;
      }
      for (const k of Object.keys(v)) walk(v[k], d + 1);
    };
    walk(data, 0); return best;
  }
  // Finds the paging numbers in a request's variables: { path to offset, size }.
  function paging(vars) {
    let off = null, size = null;
    const walk = (v, p) => { if (!v || typeof v !== "object") return;
      for (const k of Object.keys(v)) {
        if (typeof v[k] === "number" && PAGE_KEYS.test(k)) off = p.concat(k);
        else if (typeof v[k] === "number" && SIZE_KEYS.test(k)) size = v[k];
        else walk(v[k], p.concat(k));
      } };
    walk(vars, []); return off ? { off, size } : null;
  }
  const setPath = (o, p, val) => { const c = JSON.parse(JSON.stringify(o)); let x = c; for (let i = 0; i < p.length - 1; i++) x = x[p[i]]; x[p[p.length - 1]] = val; return c; };
  const slugHere = () => (location.pathname.match(/\/casino\/games\/([^/?#]+)/i) || [])[1] || "";

  window.addEventListener("message", async e => {
    const d = e.data;
    if (e.source !== window || !d || d.from !== "tbs-main") return;
    if (d.type === "result" && waiting.has(d.nonce)) { waiting.get(d.nonce)(d); waiting.delete(d.nonce); return; }
    if (d.type !== "seen" || running) return;
    const games = gamesIn(d.data), pg = paging(d.req.variables);
    const st = await S.get(["listReq", "detailReq"]);
    if (pg && games.length >= 5 && (!st.listReq || games.length >= st.listReq.n)) {
      await S.set({ listReq: { req: d.req, off: pg.off, size: pg.size || games.length, n: games.length, op: d.req.operationName } });
    }
    const slug = slugHere();
    if (slug && JSON.stringify(d.req.variables).includes(JSON.stringify(slug))) {
      const size = JSON.stringify(d.data).length;
      if (!st.detailReq || size > st.detailReq.bytes) await S.set({ detailReq: { req: d.req, slug, bytes: size, op: d.req.operationName } });
    }
  });

  const waiting = new Map();
  const ask = req => new Promise(res => {
    const nonce = Math.random().toString(36).slice(2); waiting.set(nonce, res);
    setTimeout(() => { if (waiting.has(nonce)) { waiting.delete(nonce); res({ ok: false, status: 0, error: "timed out" }); } }, 30000);
    window.postMessage({ from: "tbs-iso", cmd: "run", nonce, req }, location.origin);
  });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // Paced like a person browsing: 3 to 6 seconds between requests, and a 1 to 2 minute break every 40 requests.
  let sent = 0;
  let testFast = false;   // only for testing the extension against a fake page
  const pace = async () => { sent++; if (testFast) return; await wait(3000 + Math.random() * 3000); if (sent % 40 === 0) { await status({ state: "running", note: "Taking a short break so Stake doesn't mind…" }); await wait(60000 + Math.random() * 60000); } };
  let running = false, stop = false, stopNote = "";
  const status = (o) => S.set({ status: { ...o, at: Date.now() } });

  // Asks once, waiting and retrying when Stake slows us down. Gives up after a few failures in a row.
  async function call(req) {
    for (let tries = 0; tries < 3; tries++) {
      const r = await ask(req);
      if (r.ok) return r;
      await status({ state: "running", note: `Stake said: ${r.error}. Waiting before trying again…` });
      if (r.status === 403 || r.status === 429) { stopNote = `Stake asked us to slow down (status ${r.status}), so it stopped. Wait an hour, then tap Start to carry on.`; stop = true; return r; }
      await wait(30000 * (tries + 1));
      if (stop) return r;
    }
    return { ok: false, error: "Stake kept refusing" };
  }

  async function run() {
    if (running) return; running = true; stop = false; stopNote = "";
    try {
      let { listReq, detailReq, prog = { phase: "list", offset: 0, done: 0 }, slugs = [], testFast: tf } = await S.get(["listReq", "detailReq", "prog", "slugs", "testFast"]);
      testFast = !!tf;
      if (!listReq) { await status({ state: "idle", note: "Open Stake's Slots page and load more once first." }); return; }
      const have = new Set(slugs);
      while (prog.phase === "list" && !stop) {
        const r = await call({ ...listReq.req, variables: setPath(listReq.req.variables, listReq.off, prog.offset) });
        if (!r.ok) { if (stop) break; await status({ state: "error", note: "Couldn't read the slot list: " + r.error }); return; }
        const games = gamesIn(r.data); let fresh = 0;
        const put = {};
        for (const g of games) if (!have.has(g.slug)) { have.add(g.slug); slugs.push(g.slug); put["g:" + g.slug] = { list: g }; fresh++; }
        prog.offset += games.length || listReq.size;
        if (!games.length || !fresh) prog.phase = detailReq ? "detail" : "done";
        await S.set({ ...put, slugs, prog });
        await status({ state: "running", note: `Reading the slot list: ${slugs.length} slots so far.` });
        await pace();
      }
      while (prog.phase === "detail" && !stop) {
        if (prog.done >= slugs.length) { prog.phase = "done"; break; }
        const slug = slugs[prog.done];
        const vars = JSON.parse(JSON.stringify(detailReq.req.variables).split(JSON.stringify(detailReq.slug)).join(JSON.stringify(slug)));
        const r = await call({ ...detailReq.req, variables: vars });
        if (stop && !r.ok) break;
        const k = "g:" + slug, cur = (await S.get(k))[k] || {};
        cur.detail = r.ok ? r.data : null; if (!r.ok) cur.err = r.error;
        prog.done++;
        await S.set({ [k]: cur, prog });
        await status({ state: "running", note: `Reading slot details: ${prog.done} of ${slugs.length}.` });
        await pace();
      }
      await S.set({ prog });
      await status(prog.phase === "done" ? { state: "done", note: `Finished: ${slugs.length} slots. Download the file.` } : { state: "paused", note: stopNote || "Paused. Tap Start to carry on." });
    } finally { running = false; }
  }
  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m.cmd === "start") { run(); reply({ ok: true }); }
    if (m.cmd === "pause") { stop = true; reply({ ok: true }); }
  });
})();
