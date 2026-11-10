// Turns what the scraper collected into two files: a clean one for the site, and the raw answers in case the
// clean one missed fields (Claude can read them out of the raw file).
const num = v => { const n = parseFloat(String(v).replace(/,/g, "")); return isFinite(n) ? n : null; };
function strings(o, out = []) { if (typeof o === "string") out.push(o); else if (o && typeof o === "object") for (const k of Object.keys(o)) strings(o[k], out); return out; }
function findKey(o, re, d = 0) {   // first value whose key matches re
  if (!o || typeof o !== "object" || d > 12) return undefined;
  for (const k of Object.keys(o)) if (re.test(k) && o[k] != null && o[k] !== "") return o[k];
  for (const k of Object.keys(o)) { const v = findKey(o[k], re, d + 1); if (v !== undefined) return v; }
  return undefined;
}
function names(o, re, out = new Set(), d = 0) {   // names inside arrays/objects under keys matching re
  if (!o || typeof o !== "object" || d > 12) return out;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (re.test(k)) {
      const list = Array.isArray(v) ? v : [v];
      for (const x of list) {
        if (typeof x === "string") out.add(x);
        else if (x && typeof x === "object") { const n = x.name || x.title || (x.translation && x.translation.name) || (x.group && x.group.name) || x.slug; if (typeof n === "string") out.add(n); }
      }
    }
    names(v, re, out, d + 1);
  }
  return out;
}
function clean(slug, g) {
  const L = g.list || {}, D = g.detail || {}, H = g.html || {}, both = { L, D };
  let prov = findKey(both, /^provider$|providerName|^studio$/i);
  if (!prov) { const m = strings(H).join("\n").match(/"provider"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]+)"/i) || strings(H).join("\n").match(/\bby ([A-Z][\w&' .-]{2,40}?)(?: -|\.|,| \|)/); if (m) prov = m[1]; }
  let rtp = num(findKey(both, /rtp/i)), maxWin = num(findKey(both, /max.?(win|multiplier|payout|exposure)/i));
  const txt = strings({ both, H }).join("\n");
  if (rtp == null) { const m = txt.match(/RTP[^0-9]{0,30}(\d{2}(?:[.,]\d+)?)\s*%/i); if (m) rtp = num(m[1].replace(",", ".")); }
  if (maxWin == null) { const m = txt.match(/max(?:imum)?\.?\s*win[^0-9x]{0,30}x?\s*([\d,.]+)\s*x?/i); if (m) maxWin = num(m[1]); }
  if (rtp != null && rtp <= 1) rtp = +(rtp * 100).toFixed(2);
  const tagSet = names(both, /tag|categor|theme|feature|group|mechanic/i);
  for (const bit of (H.bits || [])) { const m = bit.match(/"(?:tags?|categor\w*)"\s*:\s*\[([^\]]*)/i); if (m) for (const t of m[1].matchAll(/"name"\s*:\s*"([^"]+)"/g)) tagSet.add(t[1]); }
  const tags = [...tagSet].filter(t => t.length < 40);
  return {
    name: L.name || L.title || D.name || slug, slug,
    provider: typeof prov === "string" ? prov : prov && (prov.name || prov.title) || "",
    rtp, maxWin, tags,
    type: L.type || L.__typename || findKey(D, /^type$|__typename/i) || ""
  };
}
(async () => {
  const all = await chrome.storage.local.get(null);
  const slugs = all.slugs || [];
  const slots = slugs.map(s => clean(s, all["g:" + s] || {}));
  const raw = slugs.map(s => ({ slug: s, ...(all["g:" + s] || {}) }));
  const meta = { at: new Date().toISOString(), count: slots.length, listQuery: all.listReq && all.listReq.op, detailQuery: all.detailReq && all.detailReq.op };
  const link = (name, obj) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(obj)], { type: "application/json" })); a.download = name; a.textContent = "Download " + name; return a; };
  const withRtp = slots.filter(s => s.rtp != null).length, withMax = slots.filter(s => s.maxWin != null).length, withTags = slots.filter(s => s.tags.length).length;
  document.getElementById("msg").textContent = `${slots.length} slots. ${withRtp} have an RTP, ${withMax} a max win, ${withTags} tags.`;
  const L = document.getElementById("links");
  const a = link("stake-slots.json", { ...meta, slots });
  L.append(a, document.createElement("br"), link("stake-slots-raw.json", { ...meta, listReq: all.listReq, detailReq: all.detailReq, seenLog: all.seenLog, raw }));
  a.click();
})();
