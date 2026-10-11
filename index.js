// Lug'at Quiz Bot — Cloudflare Workers versiyasi (bepul tarifda ishlaydi)
import { DurableObject } from "cloudflare:workers";
import { parseFile, parseText } from "./parse.js";

const MAX_FILE = 5 * 1024 * 1024;
const MAX_QUESTIONS = 300;
const GROUP_DEFAULT_TIMER = 30;
const DIRS = { fwd: "So'z → tarjima", rev: "Tarjima → so'z", mix: "Aralash" };

const HELP =
  "📚 <b>Lug'at Quiz Bot</b>\n\n" +
  "1️⃣ Lug'at faylini yuboring: <b>.txt, .docx, .xlsx, .csv</b>\n" +
  "   (yoki ro'yxatni shunchaki xabar qilib yozing)\n" +
  "2️⃣ Savollar sonini, yo'nalishni va vaqtni tanlang\n" +
  "3️⃣ Test tayyor! O'zingiz yeching yoki guruhga yuboring 👥\n\n" +
  "<b>Format</b> — har qatorda so'z va tarjima:\n" +
  "<code>kitap - kitob\nev — uy\nokul: maktab\napple = olma</code>\n" +
  "Excel/Word jadvalda: 1-ustun so'z, 2-ustun tarjima.\n" +
  "Istalgan til bo'laveradi 🌍\n\n" +
  "/mytests — mening testlarim\n/stop — testni to'xtatish";

// ---------------- Yordamchilar ----------------
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false, description: "bad json" }));
  if (!j.ok) console.log("TG xato", method, j.description);
  return j;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const btn = (text, data) => ({ text, callback_data: data });
const kb = (rows) => ({ inline_keyboard: rows.filter((r) => r.length) });
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const sample = (a, n) => shuffle([...a]).slice(0, n);

function newId() {
  const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => abc[x % abc.length]).join("");
}

async function webhookSecret(env) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("wh:" + env.BOT_TOKEN));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

export function buildQuestions(quiz, subset) {
  const pairs = quiz.pairs;
  const chosen = shuffle(subset ? [...subset] : sample(pairs, Math.min(quiz.count, pairs.length, MAX_QUESTIONS)));
  const out = [];
  for (const [word, tr] of chosen) {
    const d = quiz.direction === "mix" ? (Math.random() < 0.5 ? "fwd" : "rev") : quiz.direction;
    const [q, ans, pool] = d === "fwd" ? [word, tr, pairs.map((p) => p[1])] : [tr, word, pairs.map((p) => p[0])];
    const a = ans.slice(0, 100);
    const others = [...new Set(pool.map((p) => p.slice(0, 100)))].filter((p) => p.toLowerCase() !== a.toLowerCase());
    if (!others.length) continue;
    const opts = shuffle([...sample(others, 3), a]);
    out.push({ q: q.slice(0, 280), opts, correct: opts.indexOf(a), pair: [word, tr] });
  }
  return out;
}

// ---------------- Umumiy ombor (testlar va poll → chat bog'lanishi) ----------------
export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS quizzes(id TEXT PRIMARY KEY, owner INTEGER, title TEXT,
      pairs TEXT, count INTEGER, direction TEXT, timer INTEGER, created INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS polls(id TEXT PRIMARY KEY, chat TEXT, created INTEGER)`);
  }
  saveQuiz(owner, title, pairs, count, direction, timer) {
    const id = newId();
    this.sql.exec("INSERT INTO quizzes VALUES(?,?,?,?,?,?,?,?)", id, owner, title, JSON.stringify(pairs),
      count, direction, timer, Date.now());
    return id;
  }
  getQuiz(id) {
    const r = this.sql.exec("SELECT * FROM quizzes WHERE id=?", id).toArray()[0];
    return r ? { ...r, pairs: JSON.parse(r.pairs) } : null;
  }
  listQuizzes(owner) {
    return this.sql.exec("SELECT id,title,count FROM quizzes WHERE owner=? ORDER BY created DESC LIMIT 20", owner).toArray();
  }
  deleteQuiz(id, owner) {
    this.sql.exec("DELETE FROM quizzes WHERE id=? AND owner=?", id, owner);
  }
  mapPoll(pid, chat) {
    this.sql.exec("DELETE FROM polls WHERE created < ?", Date.now() - 86400000);
    this.sql.exec("INSERT OR REPLACE INTO polls VALUES(?,?,?)", pid, String(chat), Date.now());
  }
  pollChat(pid) {
    return this.sql.exec("SELECT chat FROM polls WHERE id=?", pid).toArray()[0]?.chat ?? null;
  }
}

// ---------------- Har bir chat uchun alohida obyekt ----------------
export class Chat extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.st = ctx.storage;
  }
  store() {
    return this.env.STORE.get(this.env.STORE.idFromName("db"));
  }
  send(text, extra = {}) {
    return tg(this.env, "sendMessage", { chat_id: this.chatId, text, parse_mode: "HTML", ...extra });
  }
  async me() {
    let me = await this.st.get("me");
    if (!me) {
      me = (await tg(this.env, "getMe", {})).result?.username;
      if (me) await this.st.put("me", me);
    }
    return me;
  }

  async handle(update, chatId) {
    this.chatId = chatId;
    await this.st.put("chatId", chatId);
    if (update.message) return this.onMessage(update.message);
    if (update.callback_query) return this.onCallback(update.callback_query);
  }

  // ---------- Xabarlar ----------
  async onMessage(m) {
    const isPrivate = m.chat.type === "private";
    const isGroup = m.chat.type === "group" || m.chat.type === "supergroup";
    const text = m.text || "";
    if (text.startsWith("/")) {
      const [head, ...rest] = text.trim().split(/\s+/);
      const [cmd, target] = head.slice(1).split("@");
      if (target && target.toLowerCase() !== (await this.me())?.toLowerCase()) return;
      const arg = rest.join(" ");
      switch (cmd.toLowerCase()) {
        case "start":
          if (arg) {
            const quiz = await this.store().getQuiz(arg);
            if (!quiz) return this.send("❗ Test topilmadi.");
            return isGroup ? this.startQuiz(m.from.id, m.chat.type, quiz) : this.card(quiz);
          }
          return isPrivate || target ? this.send(HELP) : null;
        case "help":
          return this.send(HELP);
        case "stop":
          return this.stop(m.from.id);
        case "mytests":
          return isPrivate ? this.myTests(m.from.id) : null;
      }
      return;
    }
    if (!isPrivate) return;
    if (m.document) return this.onFile(m.document);
    if (!text) return;
    const create = await this.st.get("create");
    if (create?.step === "custom") {
      const n = parseInt(text.trim(), 10);
      if (!/^\d+$/.test(text.trim()) || n < 1) return this.send("Raqam yozing, masalan: 25");
      create.count = Math.min(n, create.pairs.length);
      create.step = "dir";
      await this.st.put("create", create);
      return this.askDirection();
    }
    const pairs = parseText(text);
    if (pairs.length >= 4) {
      const d = new Date(Date.now() + 5 * 3600e3);
      const title = `Lug'at ${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      return this.beginCreate(pairs, title);
    }
    return this.send("Lug'at faylini yuboring yoki ro'yxatni yozing. Yordam: /help");
  }

  async onFile(doc) {
    if (doc.file_size > MAX_FILE) return this.send("❗ Fayl 5 MB dan katta.");
    const name = doc.file_name || "lugat.txt";
    if (/\.(pdf|doc|xls)$/i.test(name)) return this.send("❗ Bu formatni o'qiy olmayman. .txt, .docx, .xlsx yoki .csv yuboring.");
    try {
      const f = await tg(this.env, "getFile", { file_id: doc.file_id });
      const r = await fetch(`https://api.telegram.org/file/bot${this.env.BOT_TOKEN}/${f.result.file_path}`);
      const pairs = await parseFile(name, new Uint8Array(await r.arrayBuffer()));
      return this.beginCreate(pairs, name.replace(/\.[^.]+$/, ""));
    } catch (e) {
      console.log("Fayl xatosi", e);
      return this.send("❗ Faylni o'qib bo'lmadi. Formatni tekshiring: /help");
    }
  }

  async beginCreate(pairs, title) {
    if (pairs.length < 4) return this.send("❗ Kamida 4 ta so'z juftligi kerak. Format:\n<code>so'z - tarjima</code>\n\n/help");
    await this.st.put("create", { pairs, title: title.slice(0, 60), step: "count" });
    const n = pairs.length;
    const opts = [10, 20, 30, 50].filter((x) => x < n);
    return this.send(`📖 <b>${n}</b> ta so'z topildi.\n\nNechta savol bo'lsin?`, {
      reply_markup: kb([opts.map((x) => btn(String(x), `cnt:${x}`)),
        [btn(`Hammasi (${n})`, `cnt:${n}`), btn("✏️ Boshqa son", "cnt:custom")]]),
    });
  }

  askDirection(editId) {
    const markup = kb(Object.entries(DIRS).map(([k, v]) => [btn(v, `dir:${k}`)]));
    const text = "🔀 Savol yo'nalishini tanlang:";
    return editId
      ? tg(this.env, "editMessageText", { chat_id: this.chatId, message_id: editId, text, reply_markup: markup })
      : this.send(text, { reply_markup: markup });
  }

  async card(quiz, editId) {
    const me = await this.me();
    const tm = quiz.timer ? `${quiz.timer} s` : "cheklanmagan";
    const text = `✅ <b>${esc(quiz.title)}</b>\n\n📖 So'zlar: ${quiz.pairs.length}\n❓ Savollar: ${quiz.count}\n` +
      `🔀 Yo'nalish: ${DIRS[quiz.direction]}\n⏱ Vaqt: ${tm}`;
    const link = `https://t.me/${me}?start=${quiz.id}`;
    const markup = kb([
      [btn("▶️ Testni boshlash", `run:${quiz.id}`)],
      [{ text: "👥 Guruhda boshlash", url: `https://t.me/${me}?startgroup=${quiz.id}` }],
      [{ text: "🔗 Ulashish", url: `https://t.me/share/url?url=${encodeURIComponent(link)}` }],
    ]);
    return editId
      ? tg(this.env, "editMessageText", { chat_id: this.chatId, message_id: editId, text, parse_mode: "HTML", reply_markup: markup })
      : this.send(text, { reply_markup: markup });
  }

  async myTests(owner) {
    const rows = await this.store().listQuizzes(owner);
    if (!rows.length) return this.send("Hali test yo'q. Lug'at faylini yuboring 📄");
    return this.send("📚 Sizning testlaringiz:", {
      reply_markup: kb(rows.map((r) => [btn(`📘 ${r.title} (${r.count})`, `open:${r.id}`), btn("🗑", `del:${r.id}`)])),
    });
  }

  // ---------- Tugmalar ----------
  async onCallback(cq) {
    const data = cq.data || "";
    const msgId = cq.message.message_id;
    const answer = (text, alert = false) =>
      tg(this.env, "answerCallbackQuery", { callback_query_id: cq.id, text, show_alert: alert });
    const [kind, val] = [data.split(":")[0], data.slice(data.indexOf(":") + 1)];

    if (["cnt", "dir", "tm"].includes(kind)) {
      const create = await this.st.get("create");
      if (!create) return answer("Faylni qayta yuboring", true);
      if (kind === "cnt") {
        if (val === "custom") {
          create.step = "custom";
          await this.st.put("create", create);
          await tg(this.env, "editMessageText", { chat_id: this.chatId, message_id: msgId,
            text: `Nechta savol? (1–${create.pairs.length}) Raqam yozing:` });
        } else {
          create.count = Math.min(parseInt(val, 10), create.pairs.length);
          create.step = "dir";
          await this.st.put("create", create);
          await this.askDirection(msgId);
        }
        return answer();
      }
      if (kind === "dir") {
        create.direction = DIRS[val] ? val : "fwd";
        await this.st.put("create", create);
        await tg(this.env, "editMessageText", { chat_id: this.chatId, message_id: msgId, text: "⏱ Har bir savol uchun vaqt:",
          reply_markup: kb([[10, 15, 20, 30].map((t) => btn(`${t} s`, `tm:${t}`)),
            [btn("45 s", "tm:45"), btn("60 s", "tm:60"), btn("♾ Cheklanmagan", "tm:0")]]) });
        return answer();
      }
      if (!create.count) return answer("Faylni qayta yuboring", true);
      const store = this.store();
      const id = await store.saveQuiz(cq.from.id, create.title, create.pairs, create.count,
        create.direction || "fwd", parseInt(val, 10) || 0);
      await this.st.delete("create");
      await this.card(await store.getQuiz(id), msgId);
      return answer("Test yaratildi!");
    }
    if (kind === "run" || kind === "open") {
      const quiz = await this.store().getQuiz(val);
      if (!quiz) return answer("Test o'chirilgan", true);
      await answer();
      return kind === "run" ? this.startQuiz(cq.from.id, cq.message.chat.type, quiz) : this.card(quiz);
    }
    if (kind === "retry") {
      const r = await this.st.get("retry");
      const quiz = r && (await this.store().getQuiz(r.qid));
      await this.st.delete("retry");
      if (!quiz) return answer("Ma'lumot eskirgan", true);
      await answer();
      return this.startQuiz(cq.from.id, cq.message.chat.type, { ...quiz, title: quiz.title + " — xatolar" }, r.wrong);
    }
    if (kind === "del") {
      await this.store().deleteQuiz(val, cq.from.id);
      await answer("O'chirildi");
      return tg(this.env, "deleteMessage", { chat_id: this.chatId, message_id: msgId });
    }
    return answer();
  }

  // ---------- Test sessiyasi ----------
  async startQuiz(userId, chatType, quiz, subset) {
    if (await this.st.get("sess")) return this.send("⏳ Bu chatda test davom etmoqda. To'xtatish: /stop");
    const isGroup = chatType === "group" || chatType === "supergroup";
    const questions = buildQuestions(quiz, subset);
    if (!questions.length) return this.send("❗ Savol tuzib bo'lmadi.");
    const timer = quiz.timer || (isGroup ? GROUP_DEFAULT_TIMER : 0);
    const sess = { qid: quiz.id, title: quiz.title, questions, idx: -1, timer, isGroup, starter: userId,
      scores: {}, wrong: [], asked: 0, cur: null, stopped: false };
    await this.st.put("sess", sess);
    await this.send(`🎯 <b>${esc(quiz.title)}</b>\nSavollar: ${questions.length} | Vaqt: ${timer ? timer + " soniya" : "cheklanmagan"}\n` +
      (isGroup ? "Test 5 soniyadan so'ng boshlanadi! To'xtatish: /stop" : "Boshladik! To'xtatish: /stop"));
    await this.st.setAlarm(Date.now() + (isGroup ? 5000 : 1000));
  }

  // Taymer: joriy savolni yopadi va keyingisini yuboradi
  async alarm() {
    this.chatId = await this.st.get("chatId");
    const sess = await this.st.get("sess");
    if (!sess) return;
    if (sess.cur) {
      if (!sess.isGroup && !sess.cur.answered.length) sess.wrong.push(sess.questions[sess.idx].pair);
      sess.cur = null;
    }
    if (sess.stopped || sess.idx + 1 >= sess.questions.length) {
      await this.st.delete("sess");
      return this.finish(sess);
    }
    sess.idx++;
    const q = sess.questions[sess.idx];
    const body = { chat_id: this.chatId, question: `[${sess.idx + 1}/${sess.questions.length}] ${q.q}`,
      options: q.opts.map((text) => ({ text })), type: "quiz", correct_option_id: q.correct, is_anonymous: false };
    if (sess.timer) body.open_period = sess.timer;
    const r = await tg(this.env, "sendPoll", body);
    if (!r.ok) {
      await this.st.delete("sess");
      return this.send("⚠️ Xatolik yuz berdi, test to'xtatildi.");
    }
    sess.cur = { pid: r.result.poll.id, sent: Date.now(), answered: [] };
    sess.asked++;
    await this.st.put("sess", sess);
    await this.store().mapPoll(sess.cur.pid, this.chatId);
    await this.st.setAlarm(Date.now() + ((sess.timer || 600) + 1) * 1000);
  }

  async pollAnswer(pa) {
    const sess = await this.st.get("sess");
    if (!sess?.cur || sess.cur.pid !== pa.poll_id || !pa.user || !pa.option_ids?.length) return;
    const u = pa.user;
    if (sess.cur.answered.includes(u.id)) return;
    sess.cur.answered.push(u.id);
    const q = sess.questions[sess.idx];
    const ok = pa.option_ids[0] === q.correct;
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
    const sc = (sess.scores[u.id] ??= { name, ok: 0, bad: 0, t: 0 });
    sc[ok ? "ok" : "bad"]++;
    sc.t += (Date.now() - sess.cur.sent) / 1000;
    if (!sess.isGroup && !ok) sess.wrong.push(q.pair);
    await this.st.put("sess", sess);
    if (!sess.isGroup) await this.st.setAlarm(Date.now() + 1200);
  }

  async stop(userId) {
    const sess = await this.st.get("sess");
    if (!sess) return this.send("Hozir test ketmayapti.");
    if (sess.isGroup && userId !== sess.starter) {
      const m = await tg(this.env, "getChatMember", { chat_id: this.chatId, user_id: userId });
      if (!["administrator", "creator"].includes(m.result?.status))
        return this.send("Faqat testni boshlagan kishi yoki admin to'xtata oladi.");
    }
    sess.stopped = true;
    await this.st.put("sess", sess);
    await this.send("⏹ Test to'xtatildi.");
    await this.st.setAlarm(Date.now() + 500);
  }

  async finish(s) {
    const title = esc(s.title);
    if (s.isGroup) {
      const board = Object.values(s.scores).sort((a, b) => b.ok - a.ok || a.t - b.t);
      if (!board.length) return this.send(`🏁 <b>${title}</b> tugadi. Hech kim qatnashmadi.`);
      const medals = ["🥇", "🥈", "🥉"];
      const lines = board.slice(0, 15).map((u, i) =>
        `${medals[i] || i + 1 + "."} ${esc(u.name)} — <b>${u.ok}</b>/${s.asked} (${Math.round(u.t)} s)`);
      return this.send(`🏁 <b>${title}</b> natijalari:\n\n${lines.join("\n")}`,
        { reply_markup: kb([[btn("🔁 Yana o'ynash", `run:${s.qid}`)]]) });
    }
    const sc = Object.values(s.scores)[0] || { ok: 0, bad: 0 };
    const skipped = s.asked - sc.ok - sc.bad;
    const pct = s.asked ? Math.round((100 * sc.ok) / s.asked) : 0;
    let text = `🏁 <b>${title}</b>\n\n✅ To'g'ri: ${sc.ok}\n❌ Xato: ${sc.bad}\n⏭ O'tkazilgan: ${skipped}\n📊 Natija: <b>${pct}%</b>`;
    const rows = [[btn("🔁 Qayta boshlash", `run:${s.qid}`)]];
    if (s.wrong.length) {
      await this.st.put("retry", { qid: s.qid, wrong: s.wrong });
      text += "\n\n📝 <b>Takrorlash kerak:</b>\n" + s.wrong.slice(0, 30).map(([a, b]) => `• ${esc(a)} — ${esc(b)}`).join("\n");
      rows.unshift([btn(`🎯 Xatolarni qayta ishlash (${s.wrong.length})`, "retry")]);
    }
    return this.send(text, { reply_markup: kb(rows) });
  }
}

// ---------------- Kirish nuqtasi ----------------
async function route(update, env) {
  const chatStub = (id) => env.CHAT.get(env.CHAT.idFromName(String(id)));
  if (update.poll_answer) {
    const store = env.STORE.get(env.STORE.idFromName("db"));
    const chat = await store.pollChat(update.poll_answer.poll_id);
    if (chat) await chatStub(chat).pollAnswer(update.poll_answer);
    return;
  }
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  if (chatId != null) await chatStub(chatId).handle(update, chatId);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!env.BOT_TOKEN) return new Response("BOT_TOKEN o'rnatilmagan", { status: 500 });
    if (url.pathname === "/setup") {
      const r = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: await webhookSecret(env),
        allowed_updates: ["message", "callback_query", "poll_answer"],
        drop_pending_updates: true,
      });
      await tg(env, "setMyCommands", { commands: [
        { command: "start", description: "Boshlash" },
        { command: "mytests", description: "Mening testlarim" },
        { command: "stop", description: "Testni to'xtatish" },
        { command: "help", description: "Yordam" },
      ] });
      return new Response(r.ok ? "✅ Bot ulandi! Endi Telegramda botingizga /start yozing." : "❌ Xato: " + r.description,
        { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/webhook" && req.method === "POST") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await webhookSecret(env)))
        return new Response("forbidden", { status: 403 });
      const update = await req.json();
      ctx.waitUntil(route(update, env).catch((e) => console.log("Xato", e)));
      return new Response("ok");
    }
    return new Response("Lug'at Quiz Bot ishlayapti ✅", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
