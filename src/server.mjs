import http from "node:http";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, Fault, requireThat, digest, secret } from "./core/store.mjs";
import { Antigravity } from "./core/provider.mjs";
import { gateway } from "./api/gateway.mjs";
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
  const cookieName = secure ? "__Host-olm_session" : "olm_session";
  const oauthCookieName = secure ? "__Host-olm_oauth" : "olm_oauth";
  const cookie = (token, age = 43200) =>
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? "; Secure" : ""}`;
  const oauthCookie = (state, age = 600) =>
    `${oauthCookieName}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? "; Secure" : ""}`;
  const readCookie = (req, name) =>
    (req.headers.cookie || "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(name + "="))
      ?.slice(name.length + 1);
  const oauthResult = (res, result, status = 200, clearCookie = true) => {
    const messages = {
      connected: "Аккаунт Google подключён. Возвращаем вас в кабинет.",
      warning: "Аккаунт подключён. Проверка квот пока не завершилась.",
      cancelled: "Вход отменён. Возвращаем вас в кабинет.",
      failed: "Не удалось подключить аккаунт. Начните вход заново.",
    };
    if (clearCookie) res.setHeader("Set-Cookie", oauthCookie("", 0));
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>OLM Router</title></head><body><p>${messages[result]}</p><a href="/?oauth=${result}">Вернуться в кабинет</a><script src="/oauth-return.js" data-result="${result}" defer></script></body></html>`,
    );
  };
  const assignedAccount = (keyId, userId, model) => {
    const account = store.db
      .prepare(
        "SELECT a.* FROM api_key_models m JOIN accounts a ON a.id=m.account_id WHERE m.api_key_id=? AND m.model=? AND a.user_id=? AND a.enabled=1",
      )
      .get(keyId, model, userId);
    requireThat(account, 403, "Эта модель не назначена API-ключу");
    const quota = JSON.parse(account.quota || "[]").find(
      (item) => item.id === model,
    );
    requireThat(quota, 409, "Модель больше не доступна в этом Google-аккаунте");
    return account;
  };
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
      if (p === "/oauth/google/callback" && method === "GET") {
        limiter.check("oauth-callback:" + ip, 20, 600000);
        const state = url.searchParams.get("state");
        const stateCookie = readCookie(req, oauthCookieName);
        if (!state || state !== stateCookie)
          return oauthResult(res, "failed", 400, false);
        if (url.searchParams.has("error")) {
          try {
            provider.cancelWeb(state, stateCookie);
            return oauthResult(res, "cancelled");
          } catch {
            return oauthResult(res, "failed", 400);
          }
        }
        try {
          const account = await provider.finishWeb(
            state,
            url.searchParams.get("code"),
            stateCookie,
          );
          let result = "connected";
          try {
            await provider.discover(
              store.db
                .prepare("SELECT * FROM accounts WHERE id=?")
                .get(account.id),
              AbortSignal.timeout(20000),
            );
          } catch {
            result = "warning";
          }
          return oauthResult(res, result);
        } catch (e) {
          if (!e.status || e.status >= 500)
            console.warn(
              JSON.stringify({
                event: "oauth.callback.failed",
                requestId,
                status: e.status || 502,
                type: e.name,
              }),
            );
          try {
            provider.cancelWeb(state, stateCookie);
          } catch {}
          return oauthResult(res, "failed", 200);
        }
      }
      const rawCookie = readCookie(req, cookieName);
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
            tokenReserved: store.db
              .prepare(
                "SELECT coalesce(sum(r.amount),0) AS n FROM token_reservations r JOIN api_key_policies p ON p.api_key_id=r.api_key_id JOIN api_keys k ON k.id=p.api_key_id WHERE k.user_id=?",
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
        if (p === "/api/keys") {
          if (method === "GET")
            return json(res, 200, {
              keys: store.db
                .prepare(
                  "SELECT k.id,k.name,k.prefix,k.created,p.token_limit AS tokenLimit,p.tokens_used AS tokensUsed,coalesce((SELECT sum(r.amount) FROM token_reservations r WHERE r.api_key_id=k.id),0) AS tokensReserved FROM api_keys k JOIN api_key_policies p ON p.api_key_id=k.id WHERE k.user_id=? ORDER BY k.created DESC",
                )
                .all(user.id)
                .map((key) => ({
                  ...key,
                  assignments: store
                    .keyModels(key.id)
                    .map(({ model, accountId, email, enabled }) => ({
                      model,
                      accountId,
                      email,
                      enabled,
                    })),
                })),
            });
          if (method === "POST") {
            const b = await readJson(req, 8192);
            return json(
              res,
              201,
              store.createKey(user, {
                name: b.name,
                assignments: b.assignments,
                issuedBy: user.id,
              }),
            );
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
          const flow = provider.start(user.id, session.hash);
          if (flow.mode === "web")
            res.setHeader("Set-Cookie", oauthCookie(flow.state));
          return json(res, 200, {
            url: flow.url,
            redirectUri: flow.redirectUri,
            mode: flow.mode,
          });
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
          if (!action && method === "DELETE") {
            store.db
              .prepare(
                "UPDATE accounts SET enabled=0,shared=0,quota=NULL,checked=NULL WHERE id=?",
              )
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
              "SELECT u.*,d.api_key_id,d.tokens,a.email AS account_email,k.name AS key_name FROM usage u LEFT JOIN usage_details d ON d.usage_id=u.id LEFT JOIN accounts a ON a.id=u.account_id LEFT JOIN api_keys k ON k.id=d.api_key_id WHERE u.user_id=? AND u.created>=? AND u.created<? ORDER BY u.created DESC LIMIT 10000",
            )
            .all(user.id, start, end);
          const days = {};
          for (const u of items) {
            const day = format.format(new Date(u.created));
            if (!day.startsWith(prefix)) continue;
            const d = (days[day] ||= {
              input: 0,
              output: 0,
              tokens: 0,
              requests: 0,
              unknown: 0,
            });
            d.input += u.input || 0;
            d.output += u.output || 0;
            d.tokens += u.tokens || 0;
            d.requests++;
            if (u.input === null) d.unknown++;
          }
          return json(res, 200, {
            year,
            month,
            timezone: tz,
            days,
            recent: items.slice(0, 50).map(({ account_id, ...r }) => r),
          });
        }
        if (p.startsWith("/api/admin/")) {
          requireThat(user.role !== "user", 403, "Недостаточно прав");
          if (p === "/api/admin/users" && method === "GET") {
            const list =
              user.role === "superadmin"
                ? store.db
                    .prepare(
                      "SELECT u.*,coalesce((SELECT sum(d.tokens) FROM usage_details d JOIN usage x ON x.id=d.usage_id WHERE x.user_id=u.id),0) AS token_usage,coalesce((SELECT sum(r.amount) FROM token_reservations r JOIN api_key_policies p ON p.api_key_id=r.api_key_id JOIN api_keys k ON k.id=p.api_key_id WHERE k.user_id=u.id),0) AS reserved_tokens FROM users u ORDER BY u.login",
                    )
                    .all()
                : store.db
                    .prepare(
                      "SELECT u.*,coalesce((SELECT sum(d.tokens) FROM usage_details d JOIN usage x ON x.id=d.usage_id WHERE x.user_id=u.id),0) AS token_usage,coalesce((SELECT sum(r.amount) FROM token_reservations r JOIN api_key_policies p ON p.api_key_id=r.api_key_id JOIN api_keys k ON k.id=p.api_key_id WHERE k.user_id=u.id),0) AS reserved_tokens FROM users u WHERE u.manager=? ORDER BY u.login",
                    )
                    .all(user.id);
            return json(res, 200, {
              users: list.map((u) => ({
                ...store.publicUser(u),
                tokenUsage: u.token_usage,
                reservedTokens: u.reserved_tokens || 0,
                keyCount: store.db
                  .prepare("SELECT count(*) AS n FROM api_keys WHERE user_id=?")
                  .get(u.id).n,
              })),
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
            if (p.endsWith("/accounts") && method === "GET")
              return json(res, 200, {
                accounts: store.db
                  .prepare("SELECT * FROM accounts WHERE user_id=? AND enabled=1")
                  .all(id)
                  .map((a) => ({
                    ...store.accountSafe(a),
                    email: a.email,
                  })),
              });
            if (p.endsWith("/keys") && method === "GET")
              return json(res, 200, {
                keys: store.db
                  .prepare(
                    "SELECT k.id,k.name,k.prefix,k.created,p.token_limit AS tokenLimit,p.tokens_used AS tokensUsed,coalesce((SELECT sum(r.amount) FROM token_reservations r WHERE r.api_key_id=k.id),0) AS tokensReserved FROM api_keys k JOIN api_key_policies p ON p.api_key_id=k.id WHERE k.user_id=? ORDER BY k.created DESC",
                  )
                  .all(id)
                  .map((key) => ({
                    ...key,
                    assignments: store
                      .keyModels(key.id)
                      .map(({ model, accountId, email, enabled }) => ({
                        model,
                        accountId,
                        email,
                        enabled,
                      })),
                  })),
              });
            if (p.endsWith("/keys") && method === "POST") {
              const b = await readJson(req, 8192);
              requireThat(
                Number.isSafeInteger(b.tokenLimit) && b.tokenLimit > 0,
                400,
                "Укажите положительный лимит токенов",
              );
              return json(
                res,
                201,
                store.createKey(target, {
                  name: b.name,
                  assignments: b.assignments,
                  tokenLimit: b.tokenLimit,
                  issuedBy: user.id,
                }),
              );
            }
            const keyPath = p.match(/^\/api\/admin\/users\/[^/]+\/keys\/([^/]+)$/);
            if (keyPath && method === "DELETE") {
              store.db
                .prepare("DELETE FROM api_keys WHERE id=? AND user_id=?")
                .run(keyPath[1], id);
              store.audit(user.id, "key.revoke", keyPath[1]);
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
        limiter.check("api:" + auth.id, 60);
        if (
          (p === "/v1/models" || p === "/v1beta/models") &&
          method === "GET"
        ) {
          const ids = store
            .keyModels(auth.id)
            .filter(
              (assignment) =>
                assignment.enabled && assignment.models.includes(assignment.model),
            )
            .map((assignment) => assignment.model);
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
            p === "/v1/responses" ||
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
            requireThat(
              body && typeof body === "object" && !Array.isArray(body),
              400,
              "Ожидается JSON-объект",
            );
            let protocol =
                p === "/v1/chat/completions"
                  ? "openai"
                  : p === "/v1/responses"
                    ? "responses"
                    : "anthropic",
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
                const account = assignedAccount(auth.id, user.id, m[1]);
                return json(
                  res,
                  200,
                  await provider.countTokens(
                    account,
                    m[1],
                    body,
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
            requireThat(
              typeof body.model === "string" &&
                body.model.length > 0 &&
                body.model.length <= 150,
              400,
              "Укажите модель из /v1/models",
            );
            const account = assignedAccount(
              auth.id,
              user.id,
              body.model,
            );
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
              assignedAccount: account,
              apiKey: auth,
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
          "/oauth-return.js": "oauth-return.js",
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
  const abandoned = store.db
    .prepare(
      "SELECT r.id,r.amount,u.input FROM token_reservations r JOIN usage u ON u.id=r.id WHERE u.state='pending'",
    )
    .all();
  for (const item of abandoned)
    store.settleKeyTokens(item.id, item.amount, {
      input: item.input,
      output: null,
      state: "usage_unknown",
    });
  store.db
    .prepare("UPDATE usage SET state='usage_unknown' WHERE state='pending'")
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
