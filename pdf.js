// PDF dan matn chiqarish (tashqi kutubxonasiz). Fayl saqlanmaydi — faqat xotirada o'qiladi.
// Word/Google Docs kabi dasturlarda yaratilgan matnli PDF'lar uchun. Skanerlangan PDF'larni o'qimaydi.

const WIN_ANSI = { 0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰",
  0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–",
  0x97: "—", 0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ" };

async function inflate(bytes) {
  for (const fmt of ["deflate", "deflate-raw"]) {
    try {
      const ds = new DecompressionStream(fmt);
      const w = ds.writable.getWriter();
      w.write(bytes).catch(() => {});
      w.close().catch(() => {});
      const chunks = [];
      const r = ds.readable.getReader();
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await r.read();
          if (done) break;
          chunks.push(value);
          total += value.length;
        }
      } catch (e) {
        if (!total) throw e; // qisman o'qilgan bo'lsa — borini ishlatamiz
      }
      const out = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    } catch {}
  }
  return new Uint8Array(0);
}

function ascii85(u8) {
  let s = bin(u8).replace(/\s+/g, "");
  if (s.startsWith("<~")) s = s.slice(2);
  const end = s.indexOf("~>");
  if (end >= 0) s = s.slice(0, end);
  const out = [];
  let group = [];
  const flush = (n) => {
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const c of group) v = v * 85 + c;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n));
    group = [];
  };
  for (const ch of s) {
    if (ch === "z" && !group.length) { out.push(0, 0, 0, 0); continue; }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) continue;
    group.push(c);
    if (group.length === 5) flush(4);
  }
  if (group.length) flush(group.length - 1);
  return new Uint8Array(out);
}

function asciiHex(u8) {
  let h = bin(u8).replace(/>[\s\S]*$/, "").replace(/[^0-9a-fA-F]/g, "");
  if (h.length % 2) h += "0";
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

const bin = (u8) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return s;
};

// ---------- PDF qiymatlarini o'qish ----------
const WS = /[\0\t\n\f\r ]/;
const DELIM = /[()<>\[\]{}\/%]/;

class Lexer {
  constructor(s, pos = 0) { this.s = s; this.p = pos; }
  skip() {
    const s = this.s;
    for (;;) {
      while (this.p < s.length && WS.test(s[this.p])) this.p++;
      if (s[this.p] === "%") { while (this.p < s.length && s[this.p] !== "\n" && s[this.p] !== "\r") this.p++; }
      else return;
    }
  }
  // qiymat yoki operator qaytaradi: {op:"..."} operatorlar uchun
  next() {
    this.skip();
    const s = this.s;
    if (this.p >= s.length) return undefined;
    const c = s[this.p];
    if (c === "/") {
      let e = this.p + 1;
      while (e < s.length && !WS.test(s[e]) && !DELIM.test(s[e])) e++;
      const n = s.slice(this.p + 1, e).replace(/#([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
      this.p = e;
      return { name: n };
    }
    if (c === "(") return this.literal();
    if (c === "<") {
      if (s[this.p + 1] === "<") {
        this.p += 2;
        const d = {};
        for (;;) {
          this.skip();
          if (s[this.p] === ">" && s[this.p + 1] === ">") { this.p += 2; return d; }
          const k = this.next();
          if (k === undefined) return d;
          d[k.name] = this.value();
        }
      }
      const e = s.indexOf(">", this.p);
      let h = s.slice(this.p + 1, e).replace(/[^0-9a-fA-F]/g, "");
      if (h.length % 2) h += "0";
      let str = "";
      for (let i = 0; i < h.length; i += 2) str += String.fromCharCode(parseInt(h.substr(i, 2), 16));
      this.p = e + 1;
      return { str };
    }
    if (c === "[") {
      this.p++;
      const a = [];
      for (;;) {
        this.skip();
        if (s[this.p] === "]") { this.p++; return a; }
        if (this.p >= s.length) return a;
        a.push(this.value());
      }
    }
    if (c === "]" || c === ">" || c === ")" || c === "{" || c === "}") { this.p++; return { op: c }; }
    let e = this.p;
    while (e < s.length && !WS.test(s[e]) && !DELIM.test(s[e])) e++;
    if (e === this.p) e++;
    const tok = s.slice(this.p, e);
    this.p = e;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) return +tok;
    if (tok === "true") return true;
    if (tok === "false") return false;
    if (tok === "null") return null;
    return { op: tok };
  }
  // qiymat (havola "n g R" ni ham taniydi)
  value() {
    const v = this.next();
    if (typeof v === "number" && Number.isInteger(v)) {
      const save = this.p;
      const g = this.next();
      if (typeof g === "number") {
        const r = this.next();
        if (r && r.op === "R") return { ref: v };
      }
      this.p = save;
    }
    return v;
  }
  literal() {
    const s = this.s;
    let depth = 0, out = "", i = this.p;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === "\\") {
        const n = s[++i];
        const map = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
        if (map[n]) out += map[n];
        else if (/[0-7]/.test(n)) {
          let oct = n;
          while (oct.length < 3 && /[0-7]/.test(s[i + 1])) oct += s[++i];
          out += String.fromCharCode(parseInt(oct, 8) & 255);
        } else if (n === "\r") { if (s[i + 1] === "\n") i++; }
        else if (n !== "\n") out += n;
      } else if (c === "(") { if (depth++) out += c; }
      else if (c === ")") { if (--depth === 0) break; out += c; }
      else out += c;
    }
    this.p = i + 1;
    return { str: out };
  }
}

// ---------- Hujjat tuzilmasi ----------
class Doc {
  constructor(raw) {
    this.raw = raw;
    this.s = bin(raw);
    this.objs = new Map();
    this.cache = new Map();
  }
  async load() {
    const s = this.s;
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    const objStms = [];
    while ((m = re.exec(s))) {
      const num = +m[1];
      const lx = new Lexer(s, re.lastIndex);
      let val;
      try { val = lx.value(); } catch { continue; }
      const entry = { val };
      lx.skip();
      if (s.startsWith("stream", lx.p)) {
        let start = lx.p + 6;
        if (s[start] === "\r") start++;
        if (s[start] === "\n") start++;
        let len = val && typeof val.Length === "number" ? val.Length : -1;
        let end = len >= 0 && s.startsWith("endstream", this.skipWs(start + len)) ? start + len : s.indexOf("endstream", start);
        if (len < 0) { while (end > start && (s[end - 1] === "\n" || s[end - 1] === "\r")) end--; }
        entry.stream = [start, end];
        re.lastIndex = end;
      }
      this.objs.set(num, entry);
      if (val && val.Type && val.Type.name === "ObjStm") objStms.push(num);
    }
    for (const num of objStms) {
      const e = this.objs.get(num);
      const data = bin(await this.streamData(e));
      const lx = new Lexer(data);
      const pairs = [];
      for (let i = 0; i < e.val.N; i++) pairs.push([lx.next(), lx.next()]);
      for (const [n, off] of pairs) {
        if (this.objs.has(n) && !this.objs.get(n).fromStm) continue; // to'g'ridan-to'g'ri ta'rif ustun
        const vl = new Lexer(data, e.val.First + off);
        try { this.objs.set(n, { val: vl.value(), fromStm: true }); } catch {}
      }
    }
  }
  skipWs(p) { while (p < this.s.length && WS.test(this.s[p])) p++; return p; }
  get(v) {
    let guard = 0;
    while (v && v.ref !== undefined && guard++ < 20) v = this.objs.get(v.ref)?.val;
    return v;
  }
  entry(v) { return v && v.ref !== undefined ? this.objs.get(v.ref) : null; }
  async streamData(entry) {
    if (!entry || !entry.stream) return new Uint8Array(0);
    const key = entry;
    if (this.cache.has(key)) return this.cache.get(key);
    let data = this.raw.subarray(entry.stream[0], entry.stream[1]);
    let f = this.get(entry.val.Filter);
    f = Array.isArray(f) ? f.map((x) => this.get(x)?.name) : f ? [f.name] : [];
    for (const name of f) {
      if (name === "FlateDecode" || name === "Fl") data = await inflate(data);
      else if (name === "ASCII85Decode" || name === "A85") data = ascii85(data);
      else if (name === "ASCIIHexDecode" || name === "AHx") data = asciiHex(data);
      else return new Uint8Array(0); // rasmlar va boshqa filtrlar — kerak emas
    }
    this.cache.set(key, data);
    return data;
  }
  pages() {
    const rootRef = [...this.s.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)].pop();
    const out = [];
    const walk = (node, inh, depth) => {
      node = this.get(node);
      if (!node || depth > 50) return;
      const inherit = { Resources: node.Resources ?? inh.Resources, MediaBox: node.MediaBox ?? inh.MediaBox };
      if (node.Kids) for (const k of this.get(node.Kids)) walk(k, inherit, depth + 1);
      else out.push({ ...node, ...inherit });
    };
    if (rootRef) {
      const cat = this.objs.get(+rootRef[1])?.val;
      if (cat?.Pages) walk(cat.Pages, {}, 0);
    }
    if (!out.length) for (const e of this.objs.values()) if (e.val?.Type?.name === "Page") out.push(e.val);
    return out;
  }
}

// ---------- Shriftlar ----------
async function loadFont(doc, ref) {
  const f = doc.get(ref) || {};
  const font = { two: f.Subtype?.name === "Type0", map: null, widths: null, first: 0, dw: 1000, w: null };
  const tu = doc.entry(f.ToUnicode);
  if (tu) font.map = parseCMap(bin(await doc.streamData(tu)));
  if (font.two) {
    const desc = doc.get(doc.get(f.DescendantFonts)?.[0]) || {};
    font.dw = desc.DW ?? 1000;
    const W = doc.get(desc.W);
    if (Array.isArray(W)) {
      font.w = new Map();
      for (let i = 0; i < W.length; ) {
        const a = doc.get(W[i]);
        const b = doc.get(W[i + 1]);
        if (Array.isArray(b)) { b.forEach((wv, k) => font.w.set(a + k, doc.get(wv))); i += 2; }
        else { const wv = doc.get(W[i + 2]); for (let c = a; c <= b; c++) font.w.set(c, wv); i += 3; }
      }
    }
  } else {
    font.widths = doc.get(f.Widths) || null;
    font.first = doc.get(f.FirstChar) ?? 0;
    const enc = doc.get(f.Encoding);
    const diffs = enc?.Differences ? doc.get(enc.Differences) : null;
    if (diffs) {
      font.diff = new Map();
      let code = 0;
      for (const d of diffs) {
        if (typeof d === "number") code = d;
        else if (d?.name) font.diff.set(code++, glyphName(d.name));
      }
    }
  }
  return font;
}

function glyphName(n) {
  const m = n.match(/^uni([0-9A-F]{4})$/i);
  if (m) return String.fromCharCode(parseInt(m[1], 16));
  const named = { space: " ", hyphen: "-", endash: "–", emdash: "—", quoteleft: "‘", quoteright: "’", period: ".", comma: ",",
    parenleft: "(", parenright: ")", colon: ":", semicolon: ";", quotesingle: "'", quotedbl: '"' };
  return named[n] ?? (n.length === 1 ? n : "");
}

function utf16(hex) {
  let s = "";
  for (let i = 0; i + 3 < hex.length + 0; i += 4) s += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
  if (hex.length === 2) s = String.fromCharCode(parseInt(hex, 16));
  return s;
}

function parseCMap(t) {
  const map = new Map();
  for (const sec of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of sec[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), utf16(m[2]));
  }
  for (const sec of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of sec[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (hi - lo > 65535) continue;
      if (m[3][0] === "[") {
        const items = [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16(x[1]));
        items.forEach((u, k) => map.set(lo + k, u));
      } else {
        const base = m[3].slice(1, -1);
        const head = utf16(base.slice(0, -4));
        const last = parseInt(base.slice(-4) || base, 16);
        for (let c = lo; c <= hi; c++) map.set(c, head + String.fromCharCode(last + (c - lo)));
      }
    }
  }
  return map;
}

// ---------- Sahifa matnini o'qish ----------
const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];

async function pageRuns(doc, page) {
  const res = doc.get(page.Resources) || {};
  const fontDict = doc.get(res.Font) || {};
  const fonts = {};
  for (const [name, ref] of Object.entries(fontDict)) fonts[name] = await loadFont(doc, ref);

  let contents = doc.get(page.Contents);
  if (!Array.isArray(contents)) contents = [page.Contents];
  let text = "";
  for (const c of contents) text += bin(await doc.streamData(doc.entry(c))) + "\n";

  const runs = [];
  const lx = new Lexer(text);
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let tm = [1, 0, 0, 1, 0, 0], tlm = tm;
  let font = null, fs = 0, tc = 0, tw = 0, th = 1, tl = 0;
  let ops = [];

  const show = (str) => {
    if (!font) return;
    const bytes = str;
    const trm = mul(tm, ctm);
    const size = Math.abs(fs * (Math.hypot(trm[2], trm[3]) || 1));
    let out = "", adv = 0;
    const step = font.two ? 2 : 1;
    for (let i = 0; i + step - 1 < bytes.length; i += step) {
      const code = step === 2 ? (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1) : bytes.charCodeAt(i);
      let u = font.map?.get(code);
      if (u === undefined) {
        if (font.two) u = "";
        else u = font.diff?.get(code) ?? WIN_ANSI[code] ?? String.fromCharCode(code);
      }
      out += u;
      let w;
      if (font.two) w = font.w?.get(code) ?? font.dw;
      else w = font.widths?.[code - font.first] ?? 500;
      adv += ((w / 1000) * fs + tc + (step === 1 && code === 32 ? tw : 0)) * th;
    }
    const start = trm;
    tm = mul([1, 0, 0, 1, adv, 0], tm);
    const end = mul(tm, ctm);
    if (out.trim()) runs.push({ x: start[4], y: start[5], x2: end[4], size, text: out });
  };

  for (;;) {
    const t = lx.next();
    if (t === undefined) break;
    if (!t || t.op === undefined || t.op === "]" || t.op === ">") { ops.push(t); continue; }
    const op = t.op;
    const a = ops;
    ops = [];
    switch (op) {
      case "q": stack.push(ctm); break;
      case "Q": ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; break;
      case "cm": if (a.length >= 6) ctm = mul(a.slice(-6), ctm); break;
      case "BT": tm = tlm = [1, 0, 0, 1, 0, 0]; break;
      case "Tf": font = fonts[a[0]?.name] || null; fs = a[1] || 0; break;
      case "Tc": tc = a[0] || 0; break;
      case "Tw": tw = a[0] || 0; break;
      case "Tz": th = (a[0] ?? 100) / 100; break;
      case "TL": tl = a[0] || 0; break;
      case "Td": tlm = mul([1, 0, 0, 1, a[0] || 0, a[1] || 0], tlm); tm = tlm; break;
      case "TD": tl = -(a[1] || 0); tlm = mul([1, 0, 0, 1, a[0] || 0, a[1] || 0], tlm); tm = tlm; break;
      case "Tm": if (a.length >= 6) { tlm = a.slice(-6); tm = tlm; } break;
      case "T*": tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; break;
      case "Tj": if (a[0]?.str !== undefined) show(a[0].str); break;
      case "'": tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; if (a[0]?.str !== undefined) show(a[0].str); break;
      case '"': tw = a[0] || 0; tc = a[1] || 0; tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; if (a[2]?.str !== undefined) show(a[2].str); break;
      case "TJ":
        for (const el of a[0] || []) {
          if (typeof el === "number") tm = mul([1, 0, 0, 1, (-el / 1000) * fs * th, 0], tm);
          else if (el?.str !== undefined) show(el.str);
        }
        break;
      case "BI": {
        const i = text.indexOf("EI", lx.p);
        lx.p = i < 0 ? text.length : i + 2;
        break;
      }
    }
  }
  return runs;
}

// Bo'laklarni qatorlarga va ustunlarga yig'ish (2 ustunli sahifalar ham)
function layout(runs, width) {
  const mid = width / 2;
  runs.sort((p, q) => q.y - p.y || p.x - q.x);
  const lines = [];
  for (const r of runs) {
    const tol = Math.max(2, r.size * 0.45);
    const line = lines.find((l) => Math.abs(l.y - r.y) <= tol);
    if (line) line.runs.push(r);
    else lines.push({ y: r.y, runs: [r] });
  }
  const cols = [[], []];
  for (const l of lines) {
    l.runs.sort((p, q) => p.x - q.x);
    let seg = null;
    for (const r of l.runs) {
      const size = r.size || 10;
      if (seg) {
        const gap = r.x - seg.x2;
        const cross = seg.x2 < mid && r.x >= mid - size;
        // Jadval: chapda faqat tartib raqami, o'ngda matn — bu bitta qator, ustunlarga bo'lmaymiz
        const rowNum = /^\s*\d{1,4}[.)]?\s*$/.test(seg.text) && !/^\s*\d/.test(r.text);
        if (!rowNum && (gap > 2.5 * size || (cross && gap > 0.6 * size))) { pushSeg(cols, seg, mid, l.y); seg = null; }
      }
      if (!seg) seg = { x: r.x, x2: r.x2, text: r.text, size };
      else {
        const gap = r.x - seg.x2;
        const needSpace = (gap > 0.18 * size || gap > 2.5 * size) && !/\s$/.test(seg.text) && !/^\s/.test(r.text);
        seg.text += (needSpace ? " " : "") + r.text;
        seg.x2 = Math.max(seg.x2, r.x2);
      }
    }
    if (seg) pushSeg(cols, seg, mid, l.y);
  }
  const lineText = (col) => {
    col.sort((p, q) => q.y - p.y || p.x - q.x);
    const out = [];
    for (const s of col) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.y - s.y) <= s.size * 0.45) last.text += "   " + s.text;
      else out.push({ y: s.y, text: s.text });
    }
    return out.map((o) => fixRtl(o.text.normalize("NFKC")).replace(/\s+/g, " ").trim());
  };
  return [...lineText(cols[0]), ...lineText(cols[1])];
}

// PDF arab/ibroniy matnni ko'rinish tartibida (teskari) saqlaydi — to'g'ri tartibga qaytaramiz
const RTL = "\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFF";
const RTL_RUN = new RegExp(`[${RTL}]+(?:[\\s\\u0640]+[${RTL}]+)*`, "gu");
function fixRtl(s) {
  return s.replace(RTL_RUN, (m) => [...m].reverse().join(""));
}

function pushSeg(cols, seg, mid, y) {
  cols[seg.x >= mid - seg.size ? 1 : 0].push({ ...seg, y });
}

export async function pdfToLines(bytes) {
  const doc = new Doc(bytes);
  await doc.load();
  const lines = [];
  for (const page of doc.pages()) {
    const box = doc.get(page.MediaBox);
    const width = Array.isArray(box) ? doc.get(box[2]) - doc.get(box[0]) : 612;
    const runs = await pageRuns(doc, page);
    // ikki ustunli ekanini tekshirish: o'ng yarmida boshlanadigan bo'laklar ko'pmi
    const twoCol = runs.filter((r) => r.x > width * 0.45).length > runs.length * 0.2;
    lines.push(...layout(runs, twoCol ? width : width * 4));
  }
  return lines;
}
