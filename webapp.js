// LingoUP Mini App — server qismi (Telegram Web App API)
// 1-bosqich: «Mening testlarim» va savollarni tahrirlash
import { findLink, badWord } from "./index.js";
import { APP_HTML } from "./app.html.js";
import { omrLayout, omrScan, omrHomography, answerSheetPdf, questionsDoc, LETTERS } from "./omr.js";

// Skaner funksiyalari ilova sahifasiga to'g'ridan-to'g'ri qo'shiladi (server va ilova bir xil varaq tuzilishidan foydalanadi)
const PAGE = APP_HTML.replace("/*OMR_CODE*/", [omrLayout, omrHomography, omrScan].map((f) => f.toString()).join("\n"));

async function sendDoc(env, chatId, bytes, filename, caption, type) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (caption) { fd.append("caption", caption); fd.append("parse_mode", "HTML"); }
  fd.append("document", new Blob([bytes], { type }), filename);
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
  return r.json().catch(() => ({ ok: false }));
}
const fileName = (t) => (String(t || "test").replace(/[\\/:*?"<>|\n\r]+/g, " ").trim().slice(0, 60) || "test");

const MAX_Q = 5000;
const Q_MAX = 1000; // savol matni (300 dan uzuni bot tomonidan alohida xabar qilib yuboriladi)
const OPT_MAX = 100;
const EXP_MAX = 200;
const TIMERS = [10, 15, 30, 45, 60, 120, 180, 240, 300, 600];
const SHUFFLES = ["all", "none", "q", "a"];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
}

// Telegram initData imzosini tekshirish: foydalanuvchini Telegram o'zi tasdiqlaydi
async function verifyInit(initData, token) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac("WebAppData", token);
  if (hex(await hmac(secret, dcs)) !== hash) return null;
  const age = Date.now() / 1000 - Number(p.get("auth_date") || 0);
  if (age > 7 * 86400) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch { return null; }
}

const isAuthorUser = (env, u) => {
  const a = (env.AUTHOR || "@Shehroz_hoca").replace(/^@/, "").toLowerCase();
  return (u?.username || "").toLowerCase() === a || (env.ADMIN_ID && String(u?.id) === String(env.ADMIN_ID));
};

const str = (v, max) => String(v ?? "").replace(/\r/g, "").trim().slice(0, max);

// Mijozdan kelgan savollarni tekshirish va tozalash
function cleanQuestions(list) {
  if (!Array.isArray(list) || !list.length) return { error: "Kamida bitta savol bo'lishi kerak" };
  if (list.length > MAX_Q) return { error: `Ko'pi bilan ${MAX_Q} ta savol` };
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const x = list[i] || {};
    const q = str(x.q, Q_MAX);
    const opts = (Array.isArray(x.opts) ? x.opts : []).map((o) => str(o, OPT_MAX)).filter(Boolean).slice(0, 10);
    const n = i + 1;
    if (!q && !x.img) return { error: `${n}-savol matni bo'sh` };
    if (opts.length < 2) return { error: `${n}-savolda kamida 2 ta variant bo'lishi kerak` };
    if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) return { error: `${n}-savolda bir xil variantlar bor` };
    const correct = Number(x.correct);
    if (!Number.isInteger(correct) || correct < 0 || correct >= opts.length) return { error: `${n}-savolda to'g'ri javob belgilanmagan` };
    const item = { q, opts, correct };
    const exp = str(x.exp, EXP_MAX);
    if (exp) item.exp = exp;
    if (typeof x.img === "string" && x.img.length < 300) item.img = x.img;
    item.pair = Array.isArray(x.pair) && x.pair.length === 2 && x.pair.every((s) => typeof s === "string")
      ? [x.pair[0].slice(0, 300), x.pair[1].slice(0, 300)] : [q.slice(0, 300), opts[correct]];
    out.push(item);
  }
  return { questions: out };
}

const tgApi = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => ({ ok: false }));
const CP_STEPS = [0, 60, 300, 900, 1800, 3600];

async function savedChannels(store, uid) {
  try { return JSON.parse((await store.getSetting("uch:" + uid)) || "[]"); } catch { return []; }
}

export async function handleApp(req, env, url, store, h) {
  const { buildQuestions } = h;
  if (url.pathname === "/app") {
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  }
  // Savol rasmi (Telegram file_id orqali) — <img> sarlavha yubora olmagani uchun imzosiz
  if (url.pathname === "/api/img") {
    const f = String(url.searchParams.get("f") || "");
    if (!/^[\w-]{20,200}$/.test(f)) return new Response("bad", { status: 400 });
    const info = await tgApi(env, "getFile", { file_id: f });
    if (!info.ok) return new Response("not found", { status: 404 });
    const r = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.result.file_path}`);
    return new Response(r.body, { headers: { "content-type": r.headers.get("content-type") || "image/jpeg", "cache-control": "public, max-age=86400" } });
  }
  // --- API ---
  const user = await verifyInit(req.headers.get("X-Init-Data"), env.BOT_TOKEN);
  if (!user?.id) return json({ error: "Telegram orqali oching" }, 401);
  const uid = user.id;
  const author = isAuthorUser(env, user) || String(uid) === String(await store.getSetting("authorId"));
  const path = url.pathname.slice(4); // "/api" dan keyingi qism

  if (path === "/me" && req.method === "GET") return json({ id: uid, name: user.first_name || "", author });
  if (path === "/channels" && req.method === "GET") return json({ items: await savedChannels(store, uid) });

  if (path === "/quizzes" && req.method === "GET") {
    const q = str(url.searchParams.get("q"), 60);
    const off = Math.max(0, parseInt(url.searchParams.get("offset"), 10) || 0);
    const rows = q ? await store.searchQuizzes(uid, q) : await store.listQuizzes(uid, off, 50);
    const total = q ? rows.length : await store.countQuizzes(uid);
    return json({ total, items: rows.map((r) => ({ id: r.id, title: r.title, count: r.count, public: !!r.public,
      chan: !!r.chanMsg, req: !!r.chanReq, pending: r.status === "pending" })) });
  }

  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  // ---------- O'quvchi tomoni: test yechish ----------
  if (path === "/catalog" && req.method === "GET") {
    const authorId = await store.getSetting("authorId");
    const pub = authorId ? await store.catalog(+authorId, 0, 100) : [];
    const mine = String(uid) === String(authorId) ? [] : (await store.listQuizzes(uid, 0, 50)).filter((r) => r.status !== "pending");
    const pick = (r) => ({ id: r.id, title: r.title, count: r.count });
    return json({ author: env.AUTHOR || "@Shehroz_hoca", pub: pub.map(pick), mine: mine.map(pick) });
  }
  if (path === "/info" && req.method === "GET") {
    const q = await store.getQuiz(String(url.searchParams.get("id") || ""));
    if (!q || (q.status === "pending" && q.owner !== uid)) return json({ error: "Test topilmadi yoki o'chirilgan" }, 404);
    const best = await store.top(q.id, 3);
    return json({ id: q.id, title: q.title, description: q.description || "", timer: q.timer || 30,
      count: q.questions?.length || q.count, takers: await store.takers(q.id), owner: q.owner === uid,
      top: best.map((r) => ({ name: r.name, ok: r.ok, total: r.total })) });
  }
  if (path === "/play" && req.method === "POST") {
    const q = await store.getQuiz(String(body.id || ""));
    if (!q || (q.status === "pending" && q.owner !== uid)) return json({ error: "Test topilmadi yoki o'chirilgan" }, 404);
    const r = await h.chat(uid).appStart(uid, q, !!body.retry);
    return json(r, r.error ? 400 : 200);
  }
  if (path === "/answer" && req.method === "POST") {
    const r = await h.chat(uid).appAnswer(Number(body.i), Number(body.c));
    return json(r, r.error ? 400 : 200);
  }
  if (path === "/finish" && req.method === "POST") {
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ").slice(0, 60);
    const r = await h.chat(uid).appFinish(uid, name);
    return json(r, r.error ? 400 : 200);
  }

  const id = String(url.searchParams.get("id") || body.id || "").slice(0, 40);
  if (!id) return json({ error: "id kerak" }, 400);
  const quiz = await store.getQuiz(id);
  if (!quiz || quiz.owner !== uid) return json({ error: "Test topilmadi" }, 404);

  if (path === "/quiz" && req.method === "GET") {
    const questions = quiz.questions?.length ? quiz.questions : buildQuestions(quiz.pairs, quiz.count, quiz.direction || "fwd", quiz.pairs, true);
    return json({ id: quiz.id, title: quiz.title, description: quiz.description || "", timer: quiz.timer || 30,
      shuffle: quiz.shuffle || "all", pending: quiz.status === "pending", questions,
      timers: TIMERS, bot: env.BOT_NAME || null });
  }

  if (path === "/quiz" && req.method === "POST") {
    const title = str(body.title, 100);
    if (!title) return json({ error: "Test nomi bo'sh bo'lishi mumkin emas" }, 400);
    const description = str(body.description, 300);
    const timer = TIMERS.includes(Number(body.timer)) ? Number(body.timer) : quiz.timer || 30;
    const shuffle = SHUFFLES.includes(body.shuffle) ? body.shuffle : quiz.shuffle || "all";
    const c = cleanQuestions(body.questions);
    if (c.error) return json({ error: c.error }, 400);
    if (!author) {
      const texts = [title, description];
      for (const x of c.questions) texts.push(x.q, x.exp, ...x.opts);
      const link = findLink(texts);
      if (link) return json({ error: `Testda havola yoki kanal/username bor: ${link}. Uni olib tashlang.` }, 400);
      if (badWord(texts)) return json({ error: "Matnda bot qoidalariga to'g'ri kelmaydigan so'z bor" }, 400);
    }
    await store.saveEdits(id, uid, { title, description, timer, shuffle, questions: c.questions });
    return json({ ok: true, count: c.questions.length });
  }

  // ---------- Statistika ----------
  if (path === "/stats" && req.method === "GET") return json(await store.quizStats(id));

  // ---------- Kanalda so'rovnoma ----------
  if (path === "/cpcheck" && req.method === "POST") {
    let ch = str(body.channel, 100).replace(/^https?:\/\/t\.me\//i, "@").replace(/^t\.me\//i, "@");
    if (/^[A-Za-z][A-Za-z0-9_]{3,}$/.test(ch)) ch = "@" + ch;
    if (!/^@[A-Za-z0-9_]{4,}$/.test(ch) && !/^-100\d+$/.test(ch)) return json({ error: "Kanal manzilini @kanalim ko'rinishida yozing" }, 400);
    const info = await tgApi(env, "getChat", { chat_id: ch });
    if (!info.ok || info.result.type !== "channel") return json({ error: "Kanal topilmadi. Manzilni va bot kanalga admin qilinganini tekshiring." }, 400);
    const chat = info.result;
    const me = (await tgApi(env, "getMe", {})).result;
    const bm = await tgApi(env, "getChatMember", { chat_id: chat.id, user_id: me?.id });
    if (!bm.ok || bm.result.status !== "administrator" || !bm.result.can_post_messages)
      return json({ error: `Bot «${chat.title}» kanalida admin emas yoki «Xabar joylash» huquqi yo'q` }, 400);
    const um = await tgApi(env, "getChatMember", { chat_id: chat.id, user_id: uid });
    if (!um.ok || !["creator", "administrator"].includes(um.result.status))
      return json({ error: "Faqat o'zingiz admin bo'lgan kanalga joylay olasiz" }, 403);
    const list = (await savedChannels(store, uid)).filter((c) => c.id !== chat.id);
    list.unshift({ id: chat.id, title: chat.title, username: chat.username || "" });
    await store.setSetting("uch:" + uid, JSON.stringify(list.slice(0, 10)));
    return json({ ok: true, channel: list[0] });
  }
  if (path === "/cpstatus" && req.method === "GET") {
    const chat = String(url.searchParams.get("chat") || "");
    if (!(await savedChannels(store, uid)).some((c) => String(c.id) === chat)) return json({ job: null });
    const job = await h.chat(chat).getCpost();
    return json({ job: job && job.owner === uid ? job : job ? { busy: true } : null });
  }
  if (path === "/cpstart" && req.method === "POST") {
    const ch = (await savedChannels(store, uid)).find((c) => String(c.id) === String(body.chat));
    if (!ch) return json({ error: "Avval kanalni tekshiring" }, 400);
    if (quiz.status === "pending") return json({ error: "Test tekshiruvda — hozircha kanalga joylab bo'lmaydi" }, 400);
    const um = await tgApi(env, "getChatMember", { chat_id: ch.id, user_id: uid });
    if (!um.ok || !["creator", "administrator"].includes(um.result.status)) return json({ error: "Siz bu kanalda admin emassiz" }, 403);
    const interval = CP_STEPS.includes(Number(body.interval)) ? Number(body.interval) : 0;
    let questions = h.prepare(h.quizQuestions(quiz), quiz.shuffle || "all");
    const limit = parseInt(body.limit, 10);
    if (limit > 0) questions = questions.slice(0, limit);
    if (!questions.length) return json({ error: "Savol tuzib bo'lmadi" }, 400);
    const r = await h.chat(ch.id).startCpost({ chat: ch.id, chatTitle: ch.title, owner: uid, ownerChat: uid, qid: quiz.id, title: quiz.title,
      description: quiz.description || "", questions, idx: -1, interval, bot: await h.botName(env), started: Date.now() });
    if (!r.ok) return json({ error: "Bu kanalda hozir boshqa so'rovnoma joylanmoqda" }, 409);
    return json({ ok: true, total: questions.length });
  }
  if (path === "/cpstop" && req.method === "POST") {
    const ok = await h.chat(String(body.chat)).stopCpost(uid);
    return json({ ok });
  }

  // ---------- Javob varaqasi (OMR) ----------
  const omrKey = (qs) => ({ n: Math.min(qs.length, 100), k: Math.min(5, Math.max(2, ...qs.slice(0, 100).map((q) => q.opts.length))) });
  if (path === "/omrinfo" && req.method === "GET") {
    const qs = quiz.questions || [];
    const scans = await store.listScans(id, uid);
    return json({ ready: qs.length > 0, ...(qs.length ? omrKey(qs) : { n: Math.min(quiz.count || 0, 100), k: 4 }),
      key: qs.slice(0, 100).map((q) => q.correct), scans, big: qs.length > 100,
      wide: qs.slice(0, 100).some((q) => q.opts.length > 5) });
  }
  if (path === "/omrsheet" && req.method === "POST") {
    let qs = quiz.questions;
    if (!qs?.length) { // eski (lug'at) testlar: savollarni bir marta qotirib qo'yamiz, varaq kaliti o'zgarmasligi uchun
      qs = buildQuestions(quiz.pairs, quiz.count, quiz.direction || "fwd");
      await store.setQuestions(id, uid, qs);
    }
    const { n, k } = omrKey(qs);
    const author = env.AUTHOR || "@Shehroz_hoca";
    const pdf = await answerSheetPdf({ title: quiz.title, n, k, author });
    const r1 = await sendDoc(env, uid, pdf, `${fileName(quiz.title)} - javob varaqasi.pdf`,
      `📄 <b>Javob varaqasi</b> — ${n} ta savol, ${k} ta variant.\nKerakli sonda chop eting. Har bir o'quvchiga bitta varaq.`, "application/pdf");
    const doc = new TextEncoder().encode(questionsDoc({ title: quiz.title, description: quiz.description, questions: qs, k, author }));
    const r2 = await sendDoc(env, uid, doc, `${fileName(quiz.title)} - savollar.doc`,
      "📝 <b>Savollar varag'i</b> (Word). Oxirgi sahifada javoblar kaliti bor — uni o'quvchilarga bermang.", "application/msword");
    if (!r1.ok) return json({ error: "Faylni yuborib bo'lmadi. Botga /start yozib, qaytadan urinib ko'ring." }, 400);
    return json({ ok: true, n, k, doc: !!r2.ok });
  }
  if (path === "/omr" && req.method === "POST") {
    const qs = quiz.questions || [];
    if (!qs.length) return json({ error: "Avval javob varaqasini oling" }, 400);
    const { n } = omrKey(qs);
    const ans = (Array.isArray(body.answers) ? body.answers : []).slice(0, n).map((a) => (Number.isInteger(a) && a >= -2 && a < 5 ? a : -1));
    while (ans.length < n) ans.push(-1);
    const ok = ans.filter((a, i) => a === qs[i].correct).length;
    const scan = await store.addScan({ qid: id, owner: uid, student: str(body.student, 10), name: str(body.name, 60), answers: ans, ok, total: n });
    const rows = ans.map((a, i) => a !== -1 && { k: String(qs[i].pair ? qs[i].pair[0] + "|" + qs[i].pair[1] : qs[i].q).slice(0, 300),
      q: String(qs[i].q || "").slice(0, 200), ans: String(qs[i].opts[qs[i].correct] ?? "").slice(0, 100), wrong: a === qs[i].correct ? 0 : 1, total: 1 }).filter(Boolean);
    if (rows.length) await store.addQStats(id, rows);
    return json({ ok: true, scan, score: ok, total: n });
  }
  if (path === "/omrdel" && req.method === "POST") {
    await store.delScan(Number(body.scan), uid);
    return json({ ok: true });
  }
  if (path === "/omrxls" && req.method === "POST") {
    const qs = quiz.questions || [];
    const scans = (await store.listScans(id, uid)).reverse();
    if (!scans.length) return json({ error: "Hali skaner qilingan varaq yo'q" }, 400);
    const n = Math.min(qs.length, 100);
    const cell = (v) => { const t = String(v ?? ""); return /[;"\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const L = (a) => (a >= 0 ? LETTERS[a] : a === -2 ? "*" : "");
    const lines = ["sep=;", ["#", "Raqam", "Ism", "To'g'ri", "Jami", "%", "Sana", ...Array.from({ length: n }, (_, i) => `${i + 1}`)].join(";"),
      ["", "", "KALIT", "", "", "", "", ...qs.slice(0, n).map((q) => L(q.correct))].map(cell).join(";")];
    scans.forEach((s, i) => lines.push([i + 1, s.student, s.name, s.ok, s.total, Math.round((s.ok / s.total) * 100),
      new Date(s.created + 5 * 3600e3).toISOString().slice(0, 16).replace("T", " "), ...s.answers.map(L)].map(cell).join(";")));
    const avg = Math.round(scans.reduce((a, s) => a + s.ok / s.total, 0) / scans.length * 100);
    const r = await sendDoc(env, uid, new TextEncoder().encode("\ufeff" + lines.join("\r\n")), `${fileName(quiz.title)} - natijalar.csv`,
      `📊 <b>${scans.length} ta varaq natijasi</b> · o'rtacha ${avg}%\nExcel'da ochiladi. «*» — bir nechta javob belgilangan.`, "text/csv");
    return json(r.ok ? { ok: true } : { error: "Faylni yuborib bo'lmadi" }, r.ok ? 200 : 400);
  }

  if (path === "/delete" && req.method === "POST") {
    if (quiz.chanMsg && env.TESTS_CHANNEL)
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: env.TESTS_CHANNEL, message_id: quiz.chanMsg }) });
    await store.deleteQuiz(id, uid);
    return json({ ok: true });
  }

  return json({ error: "Topilmadi" }, 404);
}
