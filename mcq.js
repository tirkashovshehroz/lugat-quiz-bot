// Tayyor test savollarini o'qish (har qanday fan): savol, A) B) C) D) variantlar, to'g'ri javob, izoh va rasm.
// To'g'ri javob quyidagi usullardan biri bilan topiladi:
//   "Javob: B" / "Javob: B) Samarqand" / "To'g'ri javob: Samarqand" / "Answer: B" / "Ответ: Б"
//   variant oldida yoki oxirida belgi: "*B) ...", "+B) ...", "B) ... *", "B) ... ✓"
//   oxirida javoblar kaliti: "1-A 2-B 3-C" yoki "Javoblar: 1.A, 2.B"
// Izoh: "Izoh: ..." / "Tushuntirish: ..." / "Explanation: ..." — javobdan keyin ko'rsatiladi.
// Rasm: Word faylidagi rasm o'zi joylashgan savolga biriktiriladi (⟦IMGn⟧ belgisi orqali).

const LAT = "ABCDEFGHIJ";
const CYR = "АБВГДЕЖЗИК";
const letterIndex = (ch) => {
  const u = ch.toUpperCase();
  const i = LAT.indexOf(u);
  return i >= 0 ? i : CYR.indexOf(u);
};

const Q_START = /^\s*(?:(\d{1,4})\s*[.)]\s*|(\d{1,4})\s*-\s*savol\s*[.:)]?\s*|savol\s*(\d{1,4})?\s*[.:)]\s*|(?:question|вопрос|soru)\s*(\d{1,4})?\s*[.:)]\s*)(.+)$/i;
const OPT = /^\s*([*+#✓✔]\s*)?([A-Ja-jА-Ка-к])\s*[).:]\s*(.*)$/;
const ANS = /^\s*(?:to['‘’`ʻ]?g['‘’`ʻ]?ri\s+javob(?:i)?|javob(?:i)?|answer|correct(?:\s+answer)?|ответ|правильный\s+ответ|cevap|doğru\s+cevap|kalit)\s*[:\-–—=]\s*(.*)$/i;
const EXP = /^\s*(?:izoh|izohi|tushuntirish|sharh|explanation|explain|пояснение|объяснение|izah|açıklama)\s*[:\-–—=]\s*(.*)$/i;
const EXP_INLINE = /\s*[.;,]?\s*(?:izoh|tushuntirish|explanation|пояснение|açıklama)\s*[:\-–—]\s*(.*)$/i;
const KEY_PAIR = /(\d{1,4})\s*[-.)–:]\s*([A-Ja-jА-Га-г])(?![\p{L}])/gu;
const MARK = /\s*(\*|\+|✓|✔|\(to['‘’`ʻ]?g['‘’`ʻ]?ri\))\s*$/i;
const IMG = /⟦IMG(\d+)⟧/g;

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9 * Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.1;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const ga = grams(a), gb = grams(b);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) || 0);
  return (2 * inter) / (a.length - 1 + b.length - 1 || 1);
}

// "A) x B) y C) z" bir qatorda bo'lsa — bo'lib chiqamiz
function splitInlineOptions(line) {
  const re = /(?:^|\s)([*+]?[A-Ja-j])\)\s+/g;
  const hits = [...line.matchAll(re)];
  if (hits.length < 2) return [line];
  const letters = hits.map((h) => h[1].replace(/[*+]/, "").toUpperCase());
  if (letters[0] !== "A" || letters[1] !== "B") return [line];
  const out = [];
  const head = line.slice(0, hits[0].index).trim();
  if (head) out.push(head);
  hits.forEach((h, k) => {
    const start = h.index + (h[0].startsWith(" ") ? 1 : 0);
    const end = k + 1 < hits.length ? hits[k + 1].index : line.length;
    out.push(line.slice(start, end).trim());
  });
  return out;
}

function resolveAnswer(q, raw) {
  raw = (raw || "").trim();
  if (!raw) return -1;
  // Javob matni variantlardan biriga aynan mos kelsa — o'sha (masalan "D. I. Mendeleyev")
  const exact = q.opts.findIndex((o) => norm(o) && norm(o) === norm(raw));
  if (exact >= 0) return exact;
  const m = raw.match(/^([A-Ja-jА-Ка-к])(?:\s*[).:]|\s*$|\s+)/);
  if (m) {
    const i = letterIndex(m[1]);
    if (i >= 0 && i < q.opts.length) return i;
  }
  // matn bo'yicha eng o'xshash variant
  let best = -1, score = 0;
  q.opts.forEach((o, i) => {
    const s = similarity(o, raw.replace(/^[A-Ja-j]\)\s*/, ""));
    if (s > score) { score = s; best = i; }
  });
  return score >= 0.5 ? best : -1;
}

export function parseMcq(rawLines) {
  const lines = [];
  for (const l of rawLines) {
    const t = l.replace(/\t/g, " ").replace(/\s+/g, " ").trim();
    if (t) lines.push(...splitInlineOptions(t));
  }
  const questions = [];
  let title = null;
  let cur = null;
  let last = null; // "q", variant indeksi, "ans" yoki "exp"
  let pendingImg = null; // savoldan oldin turgan rasm
  const keys = new Map();
  const close = () => { if (cur) questions.push(cur); cur = null; last = null; };

  for (const rawLine of lines) {
    // Rasm belgilarini ajratib olamiz
    const imgs = [...rawLine.matchAll(IMG)].map((m) => +m[1]);
    const line = rawLine.replace(IMG, " ").replace(/\s+/g, " ").trim();
    if (!line) {
      for (const n of imgs) {
        // Savol boshlanib, hali variant yo'q bo'lsa — shu savolniki; aks holda keyingi savolniki
        if (cur && !cur.opts.length && cur.img == null) cur.img = n;
        else pendingImg = n;
      }
      continue;
    }
    const attach = () => { for (const n of imgs) { if (cur && cur.img == null) cur.img = n; else pendingImg = n; } };

    // Javoblar kaliti qatori: "1-A 2-B 3-C ..."
    const kp = [...line.matchAll(KEY_PAIR)];
    const keyHead = /^\s*(javoblar|kalitlar|kalit|answers?\s*key|answers|ответы|cevaplar)\b\s*[:\-–—]?\s*/i;
    if (kp.length >= 1 && keyHead.test(line)) {
      for (const k of kp) keys.set(+k[1], k[2]);
      continue;
    }
    if (kp.length >= 3 && kp.map((x) => x[0]).join("").length >= line.replace(/[\s,;]/g, "").length * 0.7) {
      for (const k of kp) keys.set(+k[1], k[2]);
      continue;
    }
    const exp = line.match(EXP);
    if (exp && cur) { cur.exp = exp[1].trim(); last = "exp"; attach(); continue; }
    const ans = line.match(ANS);
    if (ans && cur) {
      let raw = ans[1];
      const ie = raw.match(EXP_INLINE);
      if (ie) { cur.exp = ie[1].trim(); raw = raw.slice(0, ie.index); }
      cur.answerRaw = raw;
      last = ie ? "exp" : "ans";
      attach();
      continue;
    }

    const opt = line.match(OPT);
    if (opt && cur && last !== "ans" && last !== "exp") {
      const idx = letterIndex(opt[2]);
      if (idx === cur.opts.length) {
        let text = opt[3].trim();
        let marked = !!opt[1];
        if (MARK.test(text)) { marked = true; text = text.replace(MARK, "").trim(); }
        cur.opts.push(text);
        if (marked) cur.marked = idx;
        last = idx;
        attach();
        continue;
      }
    }
    const qs = line.match(Q_START);
    if (qs && !(cur && cur.opts.length === 0 && last === "q" && !cur.text)) {
      close();
      const num = +(qs[1] || qs[2] || qs[3] || qs[4] || 0);
      cur = { num, text: qs[5].trim(), opts: [], marked: -1, answerRaw: null, exp: "", img: pendingImg };
      pendingImg = null;
      last = "q";
      attach();
      continue;
    }
    // Davom etayotgan qator
    if (!cur) { if (!title && !questions.length) title = line; attach(); continue; }
    if (last === "q") cur.text += " " + line;
    else if (last === "exp") cur.exp += " " + line;
    else if (typeof last === "number") cur.opts[last] += " " + line;
    attach();
  }
  close();

  const out = [];
  let missing = 0;
  for (const q of questions) {
    if (q.opts.length < 2) continue;
    let correct = q.marked;
    if (correct < 0 && q.answerRaw) correct = resolveAnswer(q, q.answerRaw);
    if (correct < 0 && keys.has(q.num)) correct = letterIndex(keys.get(q.num));
    if (correct < 0 || correct >= q.opts.length) { missing++; continue; }
    const item = { q: q.text.trim(), opts: q.opts.map((o) => o.trim()), correct };
    if (q.exp && q.exp.trim()) item.exp = q.exp.trim();
    if (q.img != null) item.imgIdx = q.img;
    out.push(item);
  }
  if (title) title = title.replace(/\(\s*\d+\s*ta\s+savol\s*\)/i, "").replace(/\s+/g, " ").trim() || null;
  return { questions: out, missing, title };
}
