// LingoUP Mini App — server qismi (Telegram Web App API)
// 1-bosqich: «Mening testlarim» va savollarni tahrirlash
import { findLink, badWord } from "./index.js";
import { APP_HTML } from "./app.html.js";

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

export async function handleApp(req, env, url, store, buildQuestions) {
  if (url.pathname === "/app") {
    return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  }
  // --- API ---
  const user = await verifyInit(req.headers.get("X-Init-Data"), env.BOT_TOKEN);
  if (!user?.id) return json({ error: "Telegram orqali oching" }, 401);
  const uid = user.id;
  const author = isAuthorUser(env, user) || String(uid) === String(await store.getSetting("authorId"));
  const path = url.pathname.slice(4); // "/api" dan keyingi qism

  if (path === "/me" && req.method === "GET") return json({ id: uid, name: user.first_name || "", author });

  if (path === "/quizzes" && req.method === "GET") {
    const q = str(url.searchParams.get("q"), 60);
    const off = Math.max(0, parseInt(url.searchParams.get("offset"), 10) || 0);
    const rows = q ? await store.searchQuizzes(uid, q) : await store.listQuizzes(uid, off, 50);
    const total = q ? rows.length : await store.countQuizzes(uid);
    return json({ total, items: rows.map((r) => ({ id: r.id, title: r.title, count: r.count, public: !!r.public,
      chan: !!r.chanMsg, req: !!r.chanReq, pending: r.status === "pending" })) });
  }

  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
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

  if (path === "/delete" && req.method === "POST") {
    if (quiz.chanMsg && env.TESTS_CHANNEL)
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: env.TESTS_CHANNEL, message_id: quiz.chanMsg }) });
    await store.deleteQuiz(id, uid);
    return json({ ok: true });
  }

  return json({ error: "Topilmadi" }, 404);
}
