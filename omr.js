// LingoUP — javob varaqasi (OMR, EvalBee uslubida)
// Varaq tuzilishi millimetrlarda (A4: 210×297). Shu funksiya ilovadagi skanerga ham aynan yuboriladi.
export function omrLayout(n, k) {
  const L = {
    w: 210, h: 297, marker: 8, r: 2.6,
    markers: [[14, 14], [196, 14], [14, 283], [196, 283]],
    rows: 25, n: Math.min(n, 100), k: Math.min(Math.max(k, 2), 5), id: [], q: [],
  };
  // Savollar: 4 ustun × 25 qator
  for (let i = 0; i < L.n; i++) {
    const c = Math.floor(i / L.rows), r = i % L.rows;
    const x0 = 20 + c * 45, y = 78 + r * 7.8;
    const opts = [];
    for (let j = 0; j < L.k; j++) opts.push([x0 + 10 + j * 7, y]);
    L.q.push(opts);
  }
  return L;
}

export const LETTERS = ["A", "B", "C", "D", "E"];

// ---------- PDF matni: turkcha harflar (ş ğ ı İ) ----------
// Standart Helvetica shriftida bu harflar bor, lekin pdf-lib faqat WinAnsi kodlashni biladi.
// Shuning uchun ularni kam ishlatiladigan, eni bir xil belgilarga almashtirib, shriftga
// «Differences» jadvali bilan asl harf shaklini ko'rsatamiz — PDF'da to'g'ri ko'rinadi va qidiriladi.
const TR = { "ş": "š", "Ş": "Š", "ğ": "ƒ", "Ğ": "Ò", "ı": "·", "İ": "¦" };
const DIFF = [154, "scedilla", 138, "Scedilla", 131, "gbreve", 210, "Gbreve", 183, "dotlessi", 166, "Idotaccent"];
export const pdfStr = (s) => String(s ?? "")
  .replace(/[ʻ‘`´]/g, "‘").replace(/[ʼ’]/g, "’").replace(/[—–]/g, "-").replace(/\t/g, " ")
  .replace(/[şŞğĞıİ]/g, (c) => TR[c])
  .replace(/[^\x20-\x7E -ÿ‘’“”•…€™ŠšŒœŽžŸƒ]/g, "?");
export async function fonts(doc, StandardFonts, PDFName) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fix = async () => {
    for (const f of [font, bold]) {
      await f.embed();
      const dict = doc.context.lookup(f.ref);
      const diff = doc.context.obj(DIFF.map((v) => (typeof v === "number" ? v : PDFName.of(v))));
      dict.set(PDFName.of("Encoding"), doc.context.obj({ Type: "Encoding", BaseEncoding: "WinAnsiEncoding", Differences: diff }));
    }
  };
  return { font, bold, fix };
}
// Matnni berilgan kenglikka sig'diradigan qatorlarga bo'lish
function wrap(text, f, size, width) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (f.widthOfTextAtSize(w, size) > width) { // juda uzun so'z
        let cut = w.length - 1;
        while (cut > 1 && f.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
        if (line) { out.push(line); line = ""; }
        out.push(w.slice(0, cut)); w = w.slice(cut);
      }
      const t = line ? line + " " + w : w;
      if (f.widthOfTextAtSize(t, size) > width) { out.push(line); line = w; } else line = t;
    }
    out.push(line);
  }
  return out;
}
async function embedLogo(doc, logo) {
  if (!logo?.d) return null;
  try {
    const bytes = Uint8Array.from(atob(logo.d), (c) => c.charCodeAt(0));
    return logo.t === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch { return null; }
}

export async function answerSheetPdf({ title, n, k, author, brand }) {
  const { PDFDocument, StandardFonts, rgb, PDFName } = await import("./pdf-lib.js");
  const L = omrLayout(n, k);
  const MM = 72 / 25.4;
  const doc = await PDFDocument.create();
  doc.setTitle(pdfStr(title) + " - javob varaqasi");
  const page = doc.addPage([L.w * MM, L.h * MM]);
  const { font, bold, fix } = await fonts(doc, StandardFonts, PDFName);
  const X = (x) => x * MM, Y = (y) => (L.h - y) * MM;
  const black = rgb(0, 0, 0), grey = rgb(0.45, 0.45, 0.45), light = rgb(0.6, 0.6, 0.6);
  const text = (s, x, y, size, f = font, color = black) => page.drawText(pdfStr(s), { x: X(x), y: Y(y), size, font: f, color });
  const center = (s, x, y, size, f = font, color = black) => {
    const t = pdfStr(s);
    page.drawText(t, { x: X(x) - f.widthOfTextAtSize(t, size) / 2, y: Y(y) - size * 0.35, size, font: f, color });
  };
  const fit = (s, f, size, mm) => { let t = pdfStr(s); if (f.widthOfTextAtSize(t, size) <= mm * MM) return t;
    while (t.length > 3 && f.widthOfTextAtSize(t + "...", size) > mm * MM) t = t.slice(0, -1); return t + "..."; };
  // Burchak belgilari
  for (const [x, y] of L.markers)
    page.drawRectangle({ x: X(x - L.marker / 2), y: Y(y + L.marker / 2), width: L.marker * MM, height: L.marker * MM, color: black });
  // O'quv markazi: logotip va nomi (burchak belgilari orasida, skanerga xalal bermaydi)
  const img = await embedLogo(doc, brand?.logo);
  let tx = 24;
  if (img) {
    const hmm = 11, wmm = Math.min(30, (img.width / img.height) * hmm);
    const hh = Math.min(hmm, (img.height / img.width) * wmm);
    page.drawImage(img, { x: X(24), y: Y(10 + hh), width: wmm * MM, height: hh * MM });
    tx = 24 + wmm + 3;
  }
  if (brand?.name) page.drawText(fit(brand.name, bold, 11, 176 - tx), { x: X(tx), y: Y(16.5), size: 11, font: bold, color: rgb(0.15, 0.3, 0.6) });
  // Sarlavha
  page.drawText(fit(title, bold, 13, 150), { x: X(24), y: Y(27), size: 13, font: bold });
  text("JAVOB VARAQASI", 24, 32.5, 8, font, grey);
  text("Ism-familiya:", 24, 42, 10);
  page.drawLine({ start: { x: X(24), y: Y(52) }, end: { x: X(92), y: Y(52) }, thickness: 0.6, color: grey });
  text("Guruh / sana:", 24, 60, 10);
  page.drawLine({ start: { x: X(24), y: Y(66) }, end: { x: X(92), y: Y(66) }, thickness: 0.6, color: grey });
  // Ko'rsatma
  text("Doirachani to'liq bo'yang:", 24, 71, 7, font, grey);
  page.drawCircle({ x: X(60), y: Y(70.3), size: 1.6 * MM, color: black });
  text("To'g'ri", 62.5, 71, 7, font, grey);
  text("Belgi qo'ymang, chizmang. Varaqni bukmang.", 80, 71, 7, font, grey);
  // Savollar
  L.q.forEach((opts, i) => {
    const [x0, y] = opts[0];
    const num = String(i + 1);
    page.drawText(num, { x: X(x0 - 4.5) - bold.widthOfTextAtSize(num, 8), y: Y(y) - 2.8, size: 8, font: bold });
    opts.forEach(([x, yy], j) => {
      page.drawCircle({ x: X(x), y: Y(yy), size: L.r * MM, borderColor: black, borderWidth: 0.7 });
      center(LETTERS[j], x, yy, 6.5, font, light);
    });
  });
  text(`LingoUP bot${author ? "  ·  " + author : ""}  ·  ${L.n} ta savol`, 24, 290, 7, font, grey);
  await fix();
  return doc.save();
}

// Savollar varag'i (PDF): sarlavha, savollar va variantlar; oxirgi sahifada — javoblar kaliti
export async function questionsPdf({ title, description, questions, k, author, brand, withKey = true }) {
  const { PDFDocument, StandardFonts, rgb, PDFName } = await import("./pdf-lib.js");
  const MM = 72 / 25.4, W = 210 * MM, H = 297 * MM, M = 18 * MM, CW = W - 2 * M;
  const doc = await PDFDocument.create();
  doc.setTitle(pdfStr(title));
  const { font, bold, fix } = await fonts(doc, StandardFonts, PDFName);
  const img = await embedLogo(doc, brand?.logo);
  const grey = rgb(0.45, 0.45, 0.45);
  let page, y, pageNo = 0;
  const newPage = () => {
    page = doc.addPage([W, H]); pageNo++; y = H - M;
    page.drawText(pdfStr(`${brand?.name ? brand.name + "  ·  " : ""}${title}`).slice(0, 110), { x: M, y: 10 * MM, size: 7, font, color: grey });
    page.drawText(String(pageNo), { x: W - M - 6, y: 10 * MM, size: 8, font, color: grey });
  };
  const need = (h) => { if (y - h < 18 * MM) newPage(); };
  const lines = (txt, f, size, x, width, color) => {
    for (const ln of wrap(pdfStr(txt), f, size, width)) { need(size * 1.35); page.drawText(ln, { x, y: y - size, size, font: f, color }); y -= size * 1.35; }
  };
  newPage();
  // Shapka
  if (img || brand?.name) {
    let tx = M;
    if (img) { const h = 12 * MM, w = Math.min(34 * MM, (img.width / img.height) * h); page.drawImage(img, { x: M, y: y - h, width: w, height: (img.height / img.width) * w > h ? h : (img.height / img.width) * w }); tx = M + w + 8; }
    if (brand?.name) page.drawText(pdfStr(brand.name).slice(0, 80), { x: tx, y: y - 9 * MM, size: 12, font: bold, color: rgb(0.15, 0.3, 0.6) });
    y -= 16 * MM;
  }
  lines(title, bold, 15, M, CW);
  if (description) lines(description, font, 10, M, CW, grey);
  y -= 4;
  lines("Ism-familiya: ________________________________     Sana: ______________", font, 10, M, CW);
  y -= 8;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: grey });
  y -= 10;
  const qs = questions.slice(0, 100);
  qs.forEach((q, i) => {
    const num = `${i + 1}. `, nw = bold.widthOfTextAtSize(num, 11);
    const ql = wrap(pdfStr(q.q || "(rasmli savol)"), font, 11, CW - nw);
    const opts = q.opts.slice(0, k).map((o, j) => `${LETTERS[j]}) ${o}`);
    const ol = opts.flatMap((o) => wrap(pdfStr(o), font, 10.5, CW - 14));
    need(ql.length * 15 + Math.min(ol.length, 2) * 14 + 8);
    page.drawText(num, { x: M, y: y - 11, size: 11, font: bold });
    for (const ln of ql) { need(15); page.drawText(ln, { x: M + nw, y: y - 11, size: 11, font }); y -= 15; }
    // Qisqa variantlar bir qatorga, uzunlari alohida qatorlarga
    const short = opts.every((o) => font.widthOfTextAtSize(pdfStr(o), 10.5) < CW / opts.length - 10);
    if (short) {
      need(15);
      opts.forEach((o, j) => page.drawText(pdfStr(o), { x: M + 12 + (j * (CW - 12)) / opts.length, y: y - 10.5, size: 10.5, font }));
      y -= 15;
    } else for (const o of opts) lines(o, font, 10.5, M + 12, CW - 14);
    y -= 7;
  });
  if (withKey) {
    newPage();
    lines("Javoblar kaliti (o'qituvchi uchun)", bold, 14, M, CW);
    y -= 6;
    const per = 5, colW = CW / per;
    qs.forEach((q, i) => {
      if (i % per === 0) { need(16); y -= 16; }
      page.drawText(pdfStr(`${i + 1} - ${LETTERS[q.correct] || "?"}`), { x: M + (i % per) * colW, y, size: 11, font: i % per ? font : font });
    });
    y -= 20;
    if (author) lines(`${author} · LingoUP bot`, font, 9, M, CW, grey);
  }
  await fix();
  return doc.save();
}

const cell = (v) => { const t = String(v ?? ""); return /[;"\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };

// Skaner natijalari jadvali (.csv)
export function resultsCsv(questions, scans) {
  const n = Math.min(questions.length, 100);
  const A = (a) => (a >= 0 ? LETTERS[a] : a === -2 ? "*" : "");
  const lines = ["sep=;", ["#", "Raqam", "Ism", "To'g'ri", "Jami", "%", "Sana", ...Array.from({ length: n }, (_, i) => `${i + 1}`)].join(";"),
    ["", "", "KALIT", "", "", "", "", ...questions.slice(0, n).map((q) => A(q.correct))].map(cell).join(";")];
  scans.forEach((s, i) => lines.push([i + 1, s.student, s.name, s.ok, s.total, Math.round((s.ok / s.total) * 100),
    new Date(s.created + 5 * 3600e3).toISOString().slice(0, 16).replace("T", " "), ...s.answers.map(A)].map(cell).join(";")));
  return "﻿" + lines.join("\r\n");
}

// Skanerlangan javoblarni baholash
export function gradeAnswers(questions, answers) {
  const n = Math.min(questions.length, 100);
  const ans = (Array.isArray(answers) ? answers : []).slice(0, n).map((a) => (Number.isInteger(a) && a >= -2 && a < 5 ? a : -1));
  while (ans.length < n) ans.push(-1);
  const ok = ans.filter((a, i) => a === questions[i].correct).length;
  const stats = ans.map((a, i) => a !== -1 && { k: String(questions[i].pair ? questions[i].pair[0] + "|" + questions[i].pair[1] : questions[i].q).slice(0, 300),
    q: String(questions[i].q || "").slice(0, 200), ans: String(questions[i].opts[questions[i].correct] ?? "").slice(0, 100), wrong: a === questions[i].correct ? 0 : 1, total: 1 }).filter(Boolean);
  return { ans, ok, n, stats };
}

// Kulrang piksellar (RGBA dan), katta suratni kichraytirib
export function toGray(rgba, w, h, max = 1400) {
  const sc = Math.min(1, max / Math.max(w, h));
  const W = Math.round(w * sc), H = Math.round(h * sc), px = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.floor(y / sc));
    for (let x = 0; x < W; x++) {
      const i = (sy * w + Math.min(w - 1, Math.floor(x / sc))) * 4;
      px[y * W + x] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
    }
  }
  return { px, w: W, h: H };
}

// ---------- Skaner (brauzerda ishlaydi; funksiyalar o'zi yetarli — tashqi o'zgaruvchisiz) ----------
// 4 nuqtadan 4 nuqtaga perspektiv o'tkazish matritsasi
export function omrHomography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return (x, y) => {
    const d = h[6] * x + h[7] * y + 1;
    return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
  };
}

// px — kulrang piksellar (0–255), w×h; L — omrLayout natijasi; H — omrHomography
export function omrScan(px, w, h, L, H) {
  // Otsu bo'yicha qora/oq chegarasi
  const hist = new Array(256).fill(0);
  for (let i = 0; i < px.length; i += 3) hist[px[i]]++;
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  let sB = 0, wB = 0, best = 0, thr = 110;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sB += i * hist[i];
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = i; }
  }
  thr = Math.min(thr, 140);
  const lab = new Int32Array(w * h), stack = new Int32Array(w * h);
  const S = Math.max(w, h);
  // Berilgan chegarada qora dog'larni topib, 4 ta burchak belgisini tanlaydi
  const findMarkers = (t) => {
    lab.fill(0);
    const comps = [];
    for (let s = 0; s < w * h; s++) {
      if (lab[s] || px[s] >= t) continue;
      const id = comps.length + 1;
      let sp = 0, area = 0, sx = 0, sy = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
      stack[sp++] = s; lab[s] = id;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p - x) / w;
        area++; sx += x; sy += y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && !lab[p - 1] && px[p - 1] < t) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && !lab[p + 1] && px[p + 1] < t) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && !lab[p - w] && px[p - w] < t) { lab[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && !lab[p + w] && px[p + w] < t) { lab[p + w] = id; stack[sp++] = p + w; }
      }
      comps.push({ area, cx: sx / area, cy: sy / area, bw: x1 - x0 + 1, bh: y1 - y0 + 1 });
    }
    const cand = comps.filter((c) => c.bw > S * 0.01 && c.bh > S * 0.01 && c.bw < S * 0.09 && c.bh < S * 0.09 &&
      c.bw / c.bh > 0.6 && c.bw / c.bh < 1.6 && c.area / (c.bw * c.bh) > 0.6);
    const pick = [];
    for (const [qx, qy] of [[0, 0], [w, 0], [0, h], [w, h]]) {
      let bestC = null, bd = Infinity;
      for (const c of cand) {
        if ((qx ? c.cx < w / 2 : c.cx > w / 2) || (qy ? c.cy < h / 2 : c.cy > h / 2)) continue;
        const d = Math.hypot(c.cx - qx, c.cy - qy);
        if (d < bd) { bd = d; bestC = c; }
      }
      if (!bestC) return { found: pick.length };
      pick.push(bestC);
    }
    const sizes = pick.map((c) => Math.sqrt(c.area));
    if (Math.max(...sizes) > 2.2 * Math.min(...sizes)) return { found: 3 };
    return { pick };
  };
  let pick = null, found = 0;
  for (const t of [thr, thr * 0.75, thr * 0.55, thr * 0.4]) {
    const r = findMarkers(t);
    if (r.pick) { pick = r.pick; break; }
    found = Math.max(found, r.found);
  }
  if (!pick) return { error: "markers", found };
  const map = H(L.markers, pick.map((c) => [c.cx, c.cy]));
  if (!map) return { error: "markers", found: 4 };
  const at = (x, y) => {
    const [u, v] = map(x, y), ix = Math.round(u), iy = Math.round(v);
    return ix < 0 || iy < 0 || ix >= w || iy >= h ? 255 : px[iy * w + ix];
  };
  // Qog'oz va bo'yoq darajasi
  const black = pick.reduce((a, c) => a + at(...L.markers[pick.indexOf(c)]), 0) / 4;
  const paper = [];
  for (let x = 30; x < 190; x += 8) for (let y = 74; y < 275; y += 15.6) paper.push(at(x + 3.5, y + 3.9));
  paper.sort((a, b) => a - b);
  const white = paper[Math.floor(paper.length * 0.7)] || 230;
  const ring = [];
  for (let a = 0; a < 6.28; a += 0.5) for (const rr of [0.3, 0.75, 1.25]) ring.push([Math.cos(a) * rr * L.r * 0.5, Math.sin(a) * rr * L.r * 0.5]);
  const dark = ([x, y]) => {
    let s = 0;
    for (const [dx, dy] of ring) s += at(x + dx, y + dy);
    const g = s / ring.length;
    return Math.max(0, Math.min(1, (white - g) / Math.max(30, white - black)));
  };
  const choose = (ds) => {
    const order = ds.map((d, i) => [d, i]).sort((a, b) => b[0] - a[0]);
    const [top, i] = order[0], second = order[1][0];
    const med = order[Math.floor(order.length / 2)][0];
    if (top < 0.35 || top - med < 0.22) return -1; // bo'sh
    if (second > 0.35 && top - second < 0.18) return -2; // bir nechta belgilangan
    return i;
  };
  const scores = L.q.map((opts) => opts.map(dark));
  const answers = scores.map(choose);
  const digits = L.id.map((row) => choose(row.map(dark)));
  const id = digits.length && digits.every((d) => d >= 0) ? String(digits[0] * 100 + digits[1] * 10 + digits[2]).padStart(3, "0") : "";
  return { answers, id, map, markers: pick.map((c) => [c.cx, c.cy]), scores };
}
