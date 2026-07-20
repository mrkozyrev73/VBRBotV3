// ═══════════════════════════════════════════════════════════════
//  VBR БОТ — Worker статистики (vbr-stats)
//  Эндпоинты:
//    POST /track — приём событий с сайта (без авторизации)
//    GET  /stats?days=N — данные для админки (нужен ключ или Telegram)
//
//  НАСТРОЙКА (один раз, в дашборде Cloudflare):
//  1. Storage & Databases → D1 → Create database → имя: vbr_stats
//  2. Workers & Pages → Create Worker → имя: vbr-stats → вставить этот код
//  3. У воркера: Bindings → Add → D1 database → Variable name: DB → выбрать vbr_stats
//  4. Settings → Variables and Secrets → Add:
//       ADMIN_KEY  (Secret)  — придумай длинный пароль для входа из браузера
//       BOT_TOKEN  (Secret)  — токен твоего бота из BotFather (для входа из Telegram)
//  5. Deploy. URL должен быть: https://vbr-stats.kozyrant.workers.dev
// ═══════════════════════════════════════════════════════════════

const ADMIN_TG_IDS = [292620456]; // Антон

const ALLOW_ORIGIN = "https://vbrbot.pro";

const CORS = {
  "Access-Control-Allow-Origin": ALLOW_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key, X-Tg-Init",
};

const KNOWN_EVENTS = new Set([
  "screen", "quiz_start", "quiz_q", "quiz_done", "device_open", "buy_click",
  "donate_click", "consent_given", "share_results", "shared_open",
  "fav_add", "cmp_add", "search",
]);

async function ensureSchema(db) {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL, uid TEXT NOT NULL, plat TEXT, name TEXT NOT NULL, param TEXT)"
  );
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ── Проверка Telegram initData (подпись HMAC токеном бота) ──
async function verifyTgInit(initData, botToken) {
  try {
    if (!initData || !botToken) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const pairs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const dataCheck = pairs.map(([k, v]) => `${k}=${v}`).join("\n");
    const enc = new TextEncoder();
    const secretKey = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const secret = await crypto.subtle.sign("HMAC", secretKey, enc.encode(botToken));
    const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(dataCheck));
    const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
    if (hex !== hash) return null;
    const user = JSON.parse(params.get("user") || "{}");
    return user.id || null;
  } catch (e) { return null; }
}

async function isAdmin(request, env) {
  const key = request.headers.get("X-Admin-Key");
  if (key && env.ADMIN_KEY && key === env.ADMIN_KEY) return true;
  const init = request.headers.get("X-Tg-Init");
  if (init && env.BOT_TOKEN) {
    const uid = await verifyTgInit(init, env.BOT_TOKEN);
    if (uid && ADMIN_TG_IDS.includes(Number(uid))) return true;
  }
  return false;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    await ensureSchema(env.DB);

    // ── приём событий ──
    if (url.pathname === "/track" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
      const uid = String(body.uid || "anon").slice(0, 40);
      const plat = String(body.plat || "").slice(0, 20);
      const ev = Array.isArray(body.ev) ? body.ev.slice(0, 40) : [];
      const now = Date.now();
      const stmts = [];
      for (const e of ev) {
        const name = String(e.n || "").slice(0, 40);
        if (!KNOWN_EVENTS.has(name)) continue;
        const ts = Math.min(Math.max(Number(e.ts) || now, now - 864e5), now + 60e3);
        const day = new Date(ts).toISOString().slice(0, 10);
        const param = String(e.p == null ? "" : e.p).slice(0, 120);
        stmts.push(env.DB.prepare("INSERT INTO events (ts, day, uid, plat, name, param) VALUES (?,?,?,?,?,?)").bind(ts, day, uid, plat, name, param));
      }
      if (stmts.length) await env.DB.batch(stmts);
      return json({ ok: true });
    }

    // ── статистика для админки ──
    if (url.pathname === "/stats" && request.method === "GET") {
      if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
      const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "7", 10), 1), 180);
      const since = Date.now() - days * 864e5;

      const q = async (sql, ...binds) => (await env.DB.prepare(sql).bind(...binds).all()).results || [];

      const dayRows = await q(
        "SELECT day AS date, COUNT(DISTINCT uid) AS uniques, SUM(CASE WHEN name='screen' THEN 1 ELSE 0 END) AS visits FROM events WHERE ts >= ? GROUP BY day ORDER BY day",
        since
      );
      const totals = (await q(
        "SELECT COUNT(DISTINCT uid) AS uniques, SUM(CASE WHEN name='screen' THEN 1 ELSE 0 END) AS visits FROM events WHERE ts >= ?",
        since
      ))[0] || {};

      const funnelRows = await q(
        "SELECT name, COUNT(*) AS c FROM events WHERE ts >= ? AND name IN ('quiz_start','quiz_done','device_open','buy_click','donate_click','share_results','consent_given') GROUP BY name",
        since
      );
      const funnel = {};
      for (const r of funnelRows) funnel[r.name] = r.c;

      const top = (name, limit = 10) => q(
        "SELECT param AS name, COUNT(*) AS count FROM events WHERE ts >= ? AND name = ? AND param != '' GROUP BY param ORDER BY count DESC LIMIT ?",
        since, name, limit
      );

      return json({
        days: dayRows,
        totals,
        funnel,
        topOpens: await top("device_open"),
        topBuys: await top("buy_click"),
        topFavs: await top("fav_add"),
        topSearches: await top("search", 15),
        topScreens: await top("screen"),
        platforms: await q(
          "SELECT plat AS name, COUNT(DISTINCT uid) AS count FROM events WHERE ts >= ? AND plat != '' GROUP BY plat ORDER BY count DESC",
          since
        ),
      });
    }

    return json({ error: "not found" }, 404);
  },
};
