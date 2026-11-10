// The scraper itself. It learns two Stake requests by watching you browse:
//   the slot list (open Stake's Slots page and load more once), and
//   a slot's details (open any slot).
// Then, on Start, it repeats them: the list page by page, then each slot's details, slowly (see pace).
// Everything is kept in the extension's storage until you download the file.
(() => {
  if (!/(^|\.)stake\d*\.[a-z]{2,}(\.[a-z]{2})?$/i.test(location.hostname)) return;
  const S = chrome.storage.local;
  // Version 1 could learn the provider list by mistake; start clean once after updating.
  S.get("ver").then(({ ver }) => { if (ver !== 2) S.clear().then(() => S.set({ ver: 2 })); });
  const PAGE_KEYS = /^(offset|skip)$/i, SIZE_KEYS = /^(limit|first|take|size)$/i;

  // The biggest list of game-like objects (have a slug and a name) anywhere in an answer.
  // The best list of games anywhere in an answer. Lists of providers, groups or tags (which also have a name and
  // a slug) are skipped. Returns { items, gameish } where gameish counts signs that the items really are games.
  const NOT_GAME = /provider|studio|group|categor|tag|collection|theme|feature|currency|user/i;
  const isGame = x => x && typeof x === "object" && !Array.isArray(x) && typeof x.slug === "string" && (x.name || x.title) &&
    !NOT_GAME.test(String(x.__typename || "")) && !NOT_GAME.test(String(x.type || ""));
  const findGame = (x, d = 0) => {   // the item itself, or a game wrapped up to 3 levels down ({ node: { game: {...} } })
    if (isGame(x)) return x;
    if (!x || typeof x !== "object" || Array.isArray(x) || d >= 3) return null;
    for (const v of Object.values(x)) { const g = findGame(v, d + 1); if (g) return g; }
    return null;
  };
  const gameish = items => {
    const one = items[0] || {}, keys = Object.keys(one).join(" ");
    let n = 0;
    if (/thumb|image|icon|cover|banner/i.test(keys)) n++;
    if (/provider/i.test(keys)) n++;
    if (/edge|rtp|volatil|multiplier|maxwin/i.test(keys)) n++;
    if (/game/i.test(String(one.__typename || ""))) n++;
    return n;
  };
  function gamesIn(data) {
    let best = [];
    const walk = (v, d) => {
      if (!v || typeof v !== "object" || d > 14) return;
      if (Array.isArray(v)) {
        const g = v.map(x => findGame(x)).filter(Boolean);
        if (g.length > best.length) best = g;
        v.forEach(x => walk(x, d + 1)); return;
      }
      for (const k of Object.keys(v)) walk(v[k], d + 1);
    };
    walk(data, 0);
    return { items: best, gameish: gameish(best) };
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
    if (d.type !== "seen") return;
    const found = gamesIn(d.data), games = found.items, pg = paging(d.req.variables);
    const st = await S.get(["listReq", "detailReq", "seenLog"]);
    // keep a short note of what Stake's page asked for, so a failed run can be figured out from the file
    // shape of the answer: every array cut to its first item, long strings cut short
    const shape = (v, dep = 0) => dep > 9 ? "…" : Array.isArray(v) ? (v.length ? [`${v.length} items`, shape(v[0], dep + 1)] : []) :
      v && typeof v === "object" ? Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [k, shape(x, dep + 1)])) :
      typeof v === "string" ? v.slice(0, 60) : v;
    const aboutGames = /game|slug|group|kurator|provider/i.test(String(d.req.query)) && !/balance|houseBetList|deposit/i.test(String(d.req.query));
    const seenLog = !aboutGames ? (st.seenLog || []) : (st.seenLog || []).concat({ page: location.pathname, op: d.req.operationName, vars: d.req.variables || {}, query: String(d.req.query).slice(0, 1500), shape: shape(d.data), n: games.length, gameish: found.gameish, sample: games.slice(0, 3).map(g => g.name || g.title), keys: games[0] ? Object.keys(games[0]).slice(0, 20) : [] }).slice(-40);
    await S.set({ seenLog });
    const score = found.gameish * 100 + (/\/casino\/group\/slots/i.test(location.pathname) ? 50 : 0) + Math.min(games.length, 49);
    if (pg && games.length >= 5 && found.gameish >= 1 && (!st.listReq || (!running && score >= (st.listReq.score || 0)))) {
      await S.set({ listReq: { req: d.req, off: pg.off, size: pg.size || games.length, n: games.length, op: d.req.operationName, score, sample: games.slice(0, 3).map(g => g.name || g.title) } });
    }
    const slug = slugHere();
    if (slug && JSON.stringify(d.req.variables).includes(JSON.stringify(slug))) {
      const size = JSON.stringify(d.data).length;
      if (!st.detailReq || (!running && size > st.detailReq.bytes)) await S.set({ detailReq: { req: d.req, slug, bytes: size, op: d.req.operationName } });
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
      if (!slugs.length) {   // slots Jay already collected in an earlier run come with the extension: they're kept and not collected again
        const seed = typeof TB_SEED !== "undefined" ? TB_SEED : [];
        const put = {}; for (const g of seed) if (!put["g:" + g.slug]) { slugs.push(g.slug); put["g:" + g.slug] = { list: g }; }
        if (slugs.length) await S.set({ ...put, slugs });
      }
      if (!listReq && prog.phase === "list") { if (!(await domList(slugs, prog))) return; ({ listReq, detailReq } = await S.get(["listReq", "detailReq"])); }
      const have = new Set(slugs);
      while (listReq && prog.phase === "list" && !stop) {
        const r = await call({ ...listReq.req, variables: setPath(listReq.req.variables, listReq.off, prog.offset) });
        if (!r.ok) { if (stop) break; await S.set({ auto: false }); await status({ state: "error", note: "Couldn't read the slot list: " + r.error }); return; }
        const games = gamesIn(r.data).items; let fresh = 0;
        const put = {};
        for (const g of games) if (!have.has(g.slug)) { have.add(g.slug); slugs.push(g.slug); put["g:" + g.slug] = { list: g }; fresh++; }
        prog.offset += games.length || listReq.size;
        if (!games.length || !fresh) prog.phase = detailReq ? "detail" : "needDetail";
        await S.set({ ...put, slugs, prog });
        await status({ state: "running", note: `Reading the slot list: ${slugs.length} slots so far.` });
        await pace();
      }
      if (prog.phase === "needDetail" && !stop) {
        // Learn how Stake loads one slot's details by opening a slot page, then carry on there.
        const slug = slugHere();
        if (!slug) { await S.set({ prog }); await status({ state: "running", note: "Opening a slot to learn how its details load…" }); go("/casino/games/" + slugs[0]); return; }
        await status({ state: "running", note: "Learning how slot details load…" });
        for (let i = 0; i < 15 && !(await S.get("detailReq")).detailReq; i++) await wait(1000);
        detailReq = (await S.get("detailReq")).detailReq;
        prog.phase = detailReq ? "detail" : "html";   // no request to repeat: read each slot's page instead
        await S.set({ prog });
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
      while (prog.phase === "html" && !stop) {
        if (prog.done >= slugs.length) { prog.phase = "done"; break; }
        const slug = slugs[prog.done], k = "g:" + slug;
        let html = "", st = 0;
        try { const res = await fetch(location.origin + "/casino/games/" + encodeURIComponent(slug), { credentials: "include" }); st = res.status; html = await res.text(); } catch (e) {}
        if (st === 403 || st === 429) { stopNote = `Stake asked us to slow down (status ${st}), so it stopped. Wait an hour, then tap Start to carry on.`; break; }
        const cur = (await S.get(k))[k] || {};
        cur.html = pagePick(html);
        prog.done++;
        await S.set({ [k]: cur, prog });
        await status({ state: "running", note: `Reading slot pages: ${prog.done} of ${slugs.length}.` });
        await pace();
      }
      await S.set({ prog, auto: false });
      await status(prog.phase === "done" ? { state: "done", note: `Finished: ${slugs.length} slots. ${stopNote ? stopNote + " " : ""}Download the file.` } : { state: "paused", note: stopNote || "Paused. Tap Start to carry on." });
    } finally { running = false; }
  }
  // Keeps only the useful bits of a slot's page: its title, description, and short pieces of text around words
  // like RTP, max win, provider and tags (enough for the export to read them, and for Claude to check).
  function pagePick(html) {
    if (!html) return null;
    const meta = n => { const m = html.match(new RegExp(`<meta[^>]+(?:name|property)="${n}"[^>]+content="([^"]*)"`, "i")); return m ? m[1] : ""; };
    const bits = [];
    for (const re of [/rtp/gi, /max(imum)?[ _-]?(win|multiplier|payout)/gi, /"provider"/gi, /volatil/gi, /"tags?"/gi, /"categor/gi, /"edge"/gi]) {
      let m, c = 0;
      while ((m = re.exec(html)) && c < 3) { bits.push(html.slice(Math.max(0, m.index - 80), m.index + 220).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")); c++; }
    }
    return { title: (html.match(/<title>([^<]*)/i) || [])[1] || "", description: meta("description") || meta("og:description"), bits };
  }
  // Goes to another Stake page. The scraper picks up again there by itself (the "auto" flag).
  const go = path => location.assign(location.origin + path);
  const onSlotsPage = () => /\/casino\/group\/slots/i.test(location.pathname);
  // Reads the slot list straight off Stake's Slots page: collects every game link, presses "Load more" (and
  // scrolls, for pages that load as you scroll) until no new slots show up a few times in a row.
  async function domList(slugs, prog) {
    if (!onSlotsPage()) { await status({ state: "running", note: "Opening Stake's Slots page…" }); go("/casino/group/slots"); return false; }
    const have = new Set(slugs);
    const pretty = x => x.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    let quiet = 0;
    await wait(3000);
    while (!stop && quiet < 3) {
      const put = {};
      for (const a of document.querySelectorAll('a[href*="/casino/games/"]')) {
        const m = a.getAttribute("href").match(/\/casino\/games\/([^/?#]+)/i); if (!m) continue;
        const slug = decodeURIComponent(m[1]); if (have.has(slug)) continue;
        const img = a.querySelector("img");
        const name = (a.getAttribute("aria-label") || (img && img.alt) || a.textContent || "").trim() || pretty(slug);
        have.add(slug); slugs.push(slug);
        put["g:" + slug] = { list: { slug, name, thumbnailUrl: img ? img.currentSrc || img.src : "" } };
      }
      await S.set({ ...put, slugs, prog });
      await status({ state: "running", note: `Reading the Slots page: ${slugs.length} slots so far.` });
      const btn = [...document.querySelectorAll("button, a")].find(b => /^\s*(load|show|view) more/i.test(b.textContent || ""));
      // Load the next page right away, then carry on the moment its slots show up (or after 10 seconds).
      const before = document.querySelectorAll('a[href*="/casino/games/"]').length;
      if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); }
      else { scrollTo(0, document.body.scrollHeight); document.querySelectorAll("*").forEach(el => { if (el.scrollHeight > el.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight; }); }
      for (let t = 0; t < 50 && !stop && document.querySelectorAll('a[href*="/casino/games/"]').length <= before; t++) await wait(200);
      quiet = document.querySelectorAll('a[href*="/casino/games/"]').length > before ? 0 : quiet + 1;   // stop once the page stops growing
      await wait(150);
    }
    if (stop) return false;
    if (!slugs.length && (await S.get("listReq")).listReq) return true;   // the page had no links, but its list request was learned: use that
    if (!slugs.length) { await S.set({ auto: false }); await status({ state: "error", note: "Couldn't find any slots on Stake's Slots page. Tap Download file and send Claude stake-slots-raw.json." }); return false; }
    prog.phase = "needDetail";   // run() learns the details request next (or uses the one it already knows)
    const { detailReq } = await S.get("detailReq"); if (detailReq) prog.phase = "detail";
    await S.set({ prog });
    return true;
  }
  // Learns the slot list request: opens the Slots page and presses its "Load more" button.
  async function learnList() {
    if (!onSlotsPage()) { await status({ state: "running", note: "Opening Stake's Slots page…" }); go("/casino/group/slots"); return false; }
    await status({ state: "running", note: "Learning how Stake loads the slot list…" });
    for (let i = 0; i < 6; i++) {
      await wait(4000);
      if ((await S.get("listReq")).listReq) return true;
      scrollTo(0, document.body.scrollHeight);
      const btn = [...document.querySelectorAll("button, a")].find(b => /^\s*(load|show) more/i.test(b.textContent || ""));
      if (btn) btn.click();
      if (stop) return false;
    }
    await wait(4000);
    if ((await S.get("listReq")).listReq) { run(); return; }
    await S.set({ auto: false });
    await status({ state: "error", note: "Couldn't find the slot list on Stake's Slots page. Tap Download file and send Claude stake-slots-raw.json." });
    return false;
  }
  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m.cmd === "start") { S.set({ auto: true }).then(run); reply({ ok: true }); }
    if (m.cmd === "pause") { stop = true; S.set({ auto: false }); reply({ ok: true }); }
  });
  // After the scraper moved to another page, carry on by itself once the page has loaded.
  S.get("auto").then(({ auto }) => { if (auto) setTimeout(run, 4000); });
})();
