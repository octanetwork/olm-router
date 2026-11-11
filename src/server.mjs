import http from "node:http";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, Fault, requireThat, digest, secret } from "./core/store.mjs";
import { Antigravity } from "./core/provider.mjs";
import { gateway, candidates } from "./api/gateway.mjs";
const publicDir = fileURLToPath(new URL("./frontend/public/", import.meta.url));
export async function readJson(req, max = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  requireThat(
    (req.headers["content-type"] || "").split(";")[0] === "application/json",
    415,
    "Требуется Content-Type: application/json",
  );
  for await (const chunk of req) {
    size += chunk.length;
    requireThat(size <= max, 413, "Тело запроса слишком велико");
    chunks.push(chunk);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requireThat(
      v && typeof v === "object" && !Array.isArray(v),
      400,
      "Требуется JSON-объект",
    );
    return v;
  } catch (e) {
    if (e instanceof Fault) throw e;
    throw new Fault(400, "Неверный JSON");
  }
}
export class Limiter {
  constructor() {
    this.buckets = new Map();
  }
  check(key, max, window = 60000) {
    const now = Date.now();
    if (this.buckets.size > 20000) {
      for (const [k, v] of this.buckets)
        if (v.until <= now) this.buckets.delete(k);
      requireThat(this.buckets.size < 20000, 503, "Сервис временно занят");
    }
    let b = this.buckets.get(key);
    if (!b || b.until <= now) {
      b = { n: 0, until: now + window };
      this.buckets.set(key, b);
    }
    requireThat(++b.n <= max, 429, "Слишком много запросов. Попробуйте позже");
  }
}
export async function createApplication({
  store,
  provider,
  secure = true,
  panelOrigin = "https://olm.octx.space",
} = {}) {
  const limiter = new Limiter();
  let logins = 0;
  const concurrent = new Map();
  const origin = new URL(panelOrigin);
  const trusted = new Set(
    (process.env.OLM_TRUSTED_PROXIES || "").split(",").filter(Boolean),
  );
  const cookie = (token, age = 43200) =>
    `olm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? "; Secure" : ""}`;
  const json = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(data));
  };
  const server = http.createServer(async (req, res) => {
    const requestId = secret().slice(0, 16);
    res.setHeader("x-request-id", requestId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const controller = new AbortController();
    req.on("aborted", () => controller.abort());
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname,
        method = req.method;
      const remote = req.socket.remoteAddress;
      const ip = trusted.has(remote)
        ? String(req.headers["x-real-ip"] || remote)
        : remote;
      limiter.check("ip:" + ip, 240);
      if (req.headers.origin === panelOrigin) {
        res.setHeader("Access-Control-Allow-Origin", panelOrigin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
      if (method === "OPTIONS") {
        requireThat(req.headers.origin === panelOrigin, 403, "Origin запрещён");
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, PATCH, DELETE",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, x-api-key, x-goog-api-key, x-csrf-token, anthropic-version",
        );
        res.writeHead(204);
        return res.end();
      }
      if (p === "/health" && method === "GET")
        return json(res, 200, { status: "ready" });
      const rawCookie = (req.headers.cookie || "")
        .split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("olm_session="))
        ?.slice(12);
      const session = store.session(rawCookie);
      if (p === "/api/login" && method === "POST") {
        requireThat(
          req.headers.origin === panelOrigin ||
            (!secure && !req.headers.origin),
          403,
          "Origin запрещён",
        );
        limiter.check("login-ip:" + ip, 10, 15 * 60000);
        const body = await readJson(req, 8192);
        limiter.check(
          "login-user:" + digest(String(body.login).toLowerCase()),
          15,
          15 * 60000,
        );
        requireThat(logins < 4, 429, "Попробуйте войти позже");
        logins++;
        try {
          const data = await store.login(body.login, body.password);
          res.setHeader("Set-Cookie", cookie(data.token));
          return json(res, 200, { user: data.user, csrf: data.csrf });
        } finally {
          logins--;
        }
      }
      if (p.startsWith("/api/")) {
        requireThat(session, 401, "Войдите в кабинет");
        const user = session.user;
        if (!["GET", "HEAD"].includes(method))
          requireThat(
            req.headers.origin === panelOrigin &&
              req.headers["x-csrf-token"] === session.csrf,
            403,
            "Проверка CSRF не пройдена",
          );
        if (p === "/api/me" && method === "GET")
          return json(res, 200, {
            user: store.publicUser(user),
            csrf: session.csrf,
            providerConfigured: provider.configured(),
            creditScale: 1e6,
            reserved: store.db
              .prepare(
                "SELECT coalesce(sum(amount),0) AS n FROM reservations WHERE user_id=?",
              )
              .get(user.id).n,
          });
        if (p === "/api/logout" && method === "POST") {
          store.db
            .prepare("DELETE FROM sessions WHERE hash=?")
            .run(session.hash);
          res.setHeader("Set-Cookie", cookie("", 0));
          return json(res, 200, { ok: true });
        }
        if (p === "/api/password" && method === "POST") {
          const b = await readJson(req, 8192);
          requireThat(
            await store.passwordMatches(b.current, user.password),
            403,
            "Неверный текущий пароль",
          );
          const hash = await store.passwordHash(b.password);
          store.transaction(() => {
            store.db
              .prepare("UPDATE users SET password=? WHERE id=?")
              .run(hash, user.id);
            store.db
              .prepare("DELETE FROM sessions WHERE user_id=?")
              .run(user.id);
            store.audit(user.id, "password.change");
          });
          res.setHeader("Set-Cookie", cookie("", 0));
          return json(res, 200, { ok: true });
        }
        if (p === "/api/settings" && method === "PATCH") {
          const b = await readJson(req, 8192);
          requireThat(
            ["stop", "auto"].includes(b.mode) &&
              typeof b.sharedFallback === "boolean",
            400,
            "Неверные настройки",
          );
          if (b.accountId)
            requireThat(
              store.db
                .prepare(
                  "SELECT id FROM accounts WHERE id=? AND user_id=? AND enabled=1",
                )
                .get(b.accountId, user.id),
              403,
              "Нет доступа к аккаунту",
            );
          store.db.prepare("UPDATE users SET settings=? WHERE id=?").run(
            JSON.stringify({
              mode: b.mode,
              accountId: b.accountId || null,
              sharedFallback: b.sharedFallback,
            }),
            user.id,
          );
          return json(res, 200, { ok: true });
        }
        if (p === "/api/keys") {
          if (method === "GET")
            return json(res, 200, {
              keys: store.db
                .prepare(
                  "SELECT id,name,prefix,created FROM api_keys WHERE user_id=?",
                )
                .all(user.id),
            });
          if (method === "POST") {
            const b = await readJson(req, 8192);
            return json(res, 201, store.createKey(user, b.name));
          }
        }
        if (p.startsWith("/api/keys/") && method === "DELETE") {
          const id = p.split("/").at(-1);
          store.db
            .prepare("DELETE FROM api_keys WHERE id=? AND user_id=?")
            .run(id, user.id);
          store.audit(user.id, "key.revoke", id);
          return json(res, 200, { ok: true });
        }
        if (p === "/api/accounts" && method === "GET")
          return json(res, 200, {
            accounts: store.db
              .prepare("SELECT * FROM accounts WHERE user_id=?")
              .all(user.id)
              .map((a) => ({ ...store.accountSafe(a), email: a.email })),
          });
        if (p === "/api/accounts/oauth" && method === "POST") {
          limiter.check("oauth:" + user.id, 10, 600000);
          return json(res, 200, provider.start(user.id, session.hash));
        }
        if (p === "/api/accounts/callback" && method === "POST") {
          limiter.check("oauth-finish:" + user.id, 10, 600000);
          const b = await readJson(req, 16384);
          const a = await provider.finish(user.id, session.hash, b.url);
          let warning = null;
          try {
            await provider.discover(
              store.db.prepare("SELECT * FROM accounts WHERE id=?").get(a.id),
              controller.signal,
            );
          } catch (e) {
            warning = e.status ? e.message : "Не удалось проверить аккаунт";
          }
          return json(res, 201, { account: a, warning });
        }
        if (p.startsWith("/api/accounts/")) {
          const [, , , id, action] = p.split("/");
          const a = store.db
            .prepare("SELECT * FROM accounts WHERE id=? AND user_id=?")
            .get(id, user.id);
          requireThat(a, 404, "Аккаунт не найден");
          if (action === "refresh" && method === "POST") {
            limiter.check("quota:" + id, 2);
            return json(res, 200, {
              models: await provider.discover(a, controller.signal),
            });
          }
          if (!action && method === "PATCH") {
            const b = await readJson(req, 8192);
            requireThat(typeof b.shared === "boolean", 400, "Укажите shared");
            requireThat(
              !b.shared || user.role !== "user",
              403,
              "Публиковать аккаунт может администратор",
            );
            store.db
              .prepare("UPDATE accounts SET shared=? WHERE id=?")
              .run(Number(b.shared), id);
            store.audit(
              user.id,
              b.shared ? "account.publish" : "account.unpublish",
              id,
            );
            return json(res, 200, { ok: true });
          }
          if (!action && method === "DELETE") {
            store.db
              .prepare("UPDATE accounts SET enabled=0,shared=0 WHERE id=?")
              .run(id);
            provider.tokens.delete(id);
            store.audit(user.id, "account.disable", id);
            return json(res, 200, { ok: true });
          }
        }
        if (p === "/api/usage" && method === "GET") {
          const year = Number(
              url.searchParams.get("year") || new Date().getUTCFullYear(),
            ),
            month = Number(
              url.searchParams.get("month") || new Date().getUTCMonth() + 1,
            );
          const tz = url.searchParams.get("timezone") || "Europe/Moscow";
          requireThat(
            Number.isInteger(year) &&
              year >= 2020 &&
              year <= 2100 &&
              Number.isInteger(month) &&
              month >= 1 &&
              month <= 12,
            400,
            "Неверный месяц",
          );
          let format;
          try {
            format = new Intl.DateTimeFormat("en-CA", {
              timeZone: tz,
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            });
          } catch {
            throw new Fault(400, "Неверный часовой пояс");
          }
          const start = Date.UTC(year, month - 1, 1) - 86400000,
            end = Date.UTC(year, month, 1) + 86400000;
          const prefix = `${year}-${String(month).padStart(2, "0")}`;
          const items = store.db
            .prepare(
              "SELECT * FROM usage WHERE user_id=? AND created>=? AND created<? ORDER BY created DESC LIMIT 10000",
            )
            .all(user.id, start, end);
          const days = {};
          for (const u of items) {
            const day = format.format(new Date(u.created));
            if (!day.startsWith(prefix)) continue;
            const d = (days[day] ||= {
              input: 0,
              output: 0,
              credits: 0,
              requests: 0,
              unknown: 0,
            });
            d.input += u.input || 0;
            d.output += u.output || 0;
            d.credits += u.credits;
            d.requests++;
            if (u.input === null) d.unknown++;
          }
          return json(res, 200, {
            year,
            month,
            timezone: tz,
            days,
            recent: items.slice(0, 50).map(({ account_id, ...r }) => r),
            ledger: store.db
              .prepare(
                "SELECT delta,reason,created FROM ledger WHERE user_id=? ORDER BY created DESC LIMIT 50",
              )
              .all(user.id),
          });
        }
        if (p.startsWith("/api/admin/")) {
          requireThat(user.role !== "user", 403, "Недостаточно прав");
          if (p === "/api/admin/users" && method === "GET") {
            const list =
              user.role === "superadmin"
                ? store.db.prepare("SELECT * FROM users ORDER BY login").all()
                : store.db
                    .prepare(
                      "SELECT * FROM users WHERE manager=? ORDER BY login",
                    )
                    .all(user.id);
            return json(res, 200, {
              users: list.map((u) => store.publicUser(u)),
            });
          }
          if (p === "/api/admin/users" && method === "POST")
            return json(
              res,
              201,
              await store.createUser(user, await readJson(req, 8192)),
            );
          if (p.startsWith("/api/admin/users/")) {
            const id = p.split("/")[4];
            const target = store.db
              .prepare("SELECT * FROM users WHERE id=?")
              .get(id);
            requireThat(
              target && store.canManage(user, target),
              403,
              "Нет доступа к пользователю",
            );
            if (p.endsWith("/credits") && method === "POST") {
              const b = await readJson(req, 8192);
              store.transfer(user, id, b.amount, b.reason);
              return json(res, 200, { ok: true });
            }
            if (method === "PATCH") {
              const b = await readJson(req, 8192);
              requireThat(
                typeof b.enabled === "boolean",
                400,
                "Укажите enabled",
              );
              requireThat(id !== user.id, 400, "Нельзя отключить себя");
              store.transaction(() => {
                if (!b.enabled && target.role === "superadmin")
                  requireThat(
                    store.db
                      .prepare(
                        "SELECT count(*) AS n FROM users WHERE role='superadmin' AND enabled=1",
                      )
                      .get().n > 1,
                    409,
                    "Нельзя отключить последнего superadmin",
                  );
                store.db
                  .prepare("UPDATE users SET enabled=? WHERE id=?")
                  .run(Number(b.enabled), id);
                if (!b.enabled) {
                  store.db
                    .prepare("DELETE FROM sessions WHERE user_id=?")
                    .run(id);
                  store.db
                    .prepare("UPDATE accounts SET shared=0 WHERE user_id=?")
                    .run(id);
                }
                store.audit(user.id, "user.enabled", id);
              });
              return json(res, 200, { ok: true });
            }
          }
          if (p === "/api/admin/prices" && method === "GET")
            return json(res, 200, {
              prices: store.db
                .prepare("SELECT * FROM prices")
                .all()
                .map((p) => ({ model: p.model, ...JSON.parse(p.value) })),
            });
          if (p === "/api/admin/prices" && method === "POST") {
            requireThat(user.role === "superadmin", 403, "Недостаточно прав");
            const b = await readJson(req, 8192);
            requireThat(
              typeof b.model === "string" &&
                b.model.length <= 150 &&
                [b.input, b.output].every(
                  (n) => Number.isSafeInteger(n) && n > 0 && n <= 1e12,
                ),
              400,
              "Укажите положительные цены input/output",
            );
            store.db
              .prepare(
                "INSERT INTO prices VALUES(?,?) ON CONFLICT(model) DO UPDATE SET value=excluded.value",
              )
              .run(
                b.model,
                JSON.stringify({ input: b.input, output: b.output }),
              );
            store.audit(user.id, "price.set", b.model);
            return json(res, 200, { ok: true });
          }
          if (p === "/api/admin/reconcile" && method === "GET") {
            requireThat(user.role === "superadmin", 403, "Недостаточно прав");
            return json(res, 200, {
              reservations: store.db
                .prepare(
                  "SELECT r.*,u.login FROM reservations r JOIN users u ON u.id=r.user_id JOIN usage x ON x.id=r.id WHERE x.state='reconcile'",
                )
                .all(),
            });
          }
          if (p === "/api/admin/reconcile" && method === "POST") {
            requireThat(user.role === "superadmin", 403, "Недостаточно прав");
            const b = await readJson(req, 8192);
            requireThat(
              store.db
                .prepare(
                  "SELECT r.id FROM reservations r JOIN usage u ON u.id=r.id WHERE r.id=? AND u.state='reconcile'",
                )
                .get(b.id),
              409,
              "Запрос не ожидает сверки",
            );
            const usage = store.db
              .prepare("SELECT input,output FROM usage WHERE id=?")
              .get(b.id);
            store.settle(b.id, b.cost, { ...usage, state: "reconciled" });
            store.audit(user.id, "usage.reconcile", b.id);
            return json(res, 200, { ok: true });
          }
          if (p === "/api/admin/audit" && method === "GET") {
            requireThat(user.role === "superadmin", 403, "Недостаточно прав");
            return json(res, 200, {
              events: store.db
                .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 100")
                .all(),
            });
          }
        }
        throw new Fault(404, "Маршрут не найден");
      }
      if (p.startsWith("/v1/") || p.startsWith("/v1beta/")) {
        const key =
          req.headers["x-api-key"] ||
          req.headers["x-goog-api-key"] ||
          (req.headers.authorization?.startsWith("Bearer ")
            ? req.headers.authorization.slice(7)
            : null);
        const auth = store.apiKey(key);
        requireThat(auth, 401, "Неверный или отсутствующий API-ключ");
        const user = auth.user;
        limiter.check("api:" + user.id, 60);
        if (
          (p === "/v1/models" || p === "/v1beta/models") &&
          method === "GET"
        ) {
          const ids = new Set();
          const accounts = store.db
            .prepare(
              "SELECT * FROM accounts WHERE enabled=1 AND (user_id=? OR shared=1)",
            )
            .all(user.id);
          for (const a of accounts)
            for (const m of JSON.parse(a.quota || "[]")) ids.add(m.id);
          if (p.startsWith("/v1beta"))
            return json(res, 200, {
              models: [...ids].map((id) => ({
                name: "models/" + id,
                displayName: id,
                supportedGenerationMethods: [
                  "generateContent",
                  "streamGenerateContent",
                  "countTokens",
                ],
              })),
            });
          return json(res, 200, {
            object: "list",
            data: [...ids].map((id) => ({
              id,
              object: "model",
              owned_by: "antigravity",
            })),
          });
        }
        if (
          method === "POST" &&
          (p === "/v1/messages" ||
            p === "/v1/chat/completions" ||
            /^\/v1beta\/models\/[^/]+:(streamGenerateContent|generateContent|countTokens)$/.test(
              p,
            ))
        ) {
          requireThat(
            (concurrent.get(user.id) || 0) < 2,
            429,
            "Не больше двух одновременных запросов",
          );
          concurrent.set(user.id, (concurrent.get(user.id) || 0) + 1);
          try {
            let body = await readJson(req);
            let protocol =
                p === "/v1/chat/completions" ? "openai" : "anthropic",
              nativeRequest;
            if (p.startsWith("/v1beta")) {
              protocol = "gemini";
              const m = p.match(
                /^\/v1beta\/models\/([^/]+):(streamGenerateContent|generateContent|countTokens)$/,
              );
              requireThat(
                Array.isArray(body.contents) && body.contents.length > 0,
                400,
                "Требуется contents",
              );
              if (m[2] === "countTokens") {
                const allowed = candidates(store, user, m[1]);
                requireThat(
                  allowed.length,
                  409,
                  "Нет доступного аккаунта для подсчёта токенов",
                );
                return json(
                  res,
                  200,
                  await provider.countTokens(
                    allowed[0],
                    m[1],
                    body.contents,
                    controller.signal,
                  ),
                );
              }
              nativeRequest = body;
              body = {
                model: m[1],
                messages: [{ role: "user", content: "native Gemini request" }],
                max_tokens: body.generationConfig?.maxOutputTokens || 8192,
                stream: m[2] === "streamGenerateContent",
              };
            }
            await gateway({
              store,
              provider,
              user,
              body,
              res,
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(600000),
              ]),
              protocol,
              nativeRequest,
              scope: auth.id,
            });
            return;
          } finally {
            concurrent.set(
              user.id,
              Math.max(0, (concurrent.get(user.id) || 1) - 1),
            );
          }
        }
        throw new Fault(404, "Протокол или маршрут не поддерживается");
      }
      if (method === "GET") {
        const names = {
          "/": "index.html",
          "/panel": "index.html",
          "/app.js": "app.js",
          "/styles.css": "styles.css",
          "/favicon.svg": "favicon.svg",
        };
        requireThat(names[p], 404, "Страница не найдена");
        const file = path.join(publicDir, names[p]);
        res.writeHead(200, {
          "Content-Type": p.endsWith(".js")
            ? "application/javascript"
            : p.endsWith(".css")
              ? "text/css"
              : p.endsWith(".svg")
                ? "image/svg+xml"
                : "text/html; charset=utf-8",
        });
        return fs.createReadStream(file).pipe(res);
      }
      throw new Fault(404, "Маршрут не найден");
    } catch (e) {
      if (!res.headersSent && !res.destroyed) {
        if (e.status === 429) res.setHeader("Retry-After", "60");
        json(res, e.status || 500, {
          type: "error",
          error: {
            type: e.status === 401 ? "authentication_error" : "api_error",
            message: e.status ? e.message : "Внутренняя ошибка",
            request_id: requestId,
          },
        });
      } else if (!res.writableEnded) res.end();
      if (!e.status)
        console.error(
          JSON.stringify({ event: "request.failed", requestId, type: e.name }),
        );
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  server.maxConnections = 256;
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.env.DATA_DIR || "./data";
  let key = process.env.OLM_ENCRYPTION_KEY;
  if (!key && process.env.NODE_ENV !== "production") {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = path.join(dir, ".encryption-key");
    if (!fs.existsSync(f))
      fs.writeFileSync(f, randomBytes(32).toString("hex"), { mode: 0o600 });
    key = fs.readFileSync(f, "utf8").trim();
  }
  const store = new Store(dir, key);
  store.db
    .prepare("UPDATE usage SET state='reconcile' WHERE state='pending'")
    .run();
  await store.bootstrap(process.env.OLM_BOOTSTRAP_FILE);
  const provider = new Antigravity(store);
  const server = await createApplication({
    store,
    provider,
    secure: process.env.NODE_ENV === "production",
    panelOrigin: process.env.OLM_PANEL_ORIGIN || "http://localhost:8045",
  });
  server.listen(
    Number(process.env.PORT || 8045),
    process.env.HOST || "127.0.0.1",
    () => console.log("OLM Router ready"),
  );
  let refreshing = false;
  const timer = setInterval(async () => {
    if (refreshing || !provider.configured()) return;
    refreshing = true;
    try {
      for (const a of store.db
        .prepare("SELECT * FROM accounts WHERE enabled=1")
        .all()) {
        try {
          await provider.discover(a, AbortSignal.timeout(20000));
        } catch {}
      }
    } finally {
      refreshing = false;
    }
  }, 300000);
  timer.unref();
  for (const event of ["SIGINT", "SIGTERM"])
    process.once(event, () => {
      clearInterval(timer);
      server.close(() => {
        store.db.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref();
    });
}
