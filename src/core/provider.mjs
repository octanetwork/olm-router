import { ProxyAgent, fetch as upstreamFetch } from "undici";
import { randomBytes, createHash } from "node:crypto";
import { Fault, requireThat, secret } from "./store.mjs";
export class Transport {
  constructor(routes = (process.env.OLM_PROXY_ROUTES || "direct").split(",")) {
    this.routes = routes.map((url) => ({
      url,
      dispatcher: url === "direct" ? undefined : new ProxyAgent(url),
      until: 0,
    }));
  }
  async fetch(url, options = {}) {
    let last;
    for (const route of this.routes.filter((r) => r.until <= Date.now())) {
      try {
        const r = await upstreamFetch(url, {
          ...options,
          dispatcher: route.dispatcher,
          signal: options.signal || AbortSignal.timeout(120000),
        });
        route.until = 0;
        return r;
      } catch (e) {
        if (options.signal?.aborted) throw e;
        route.until = Date.now() + 30000;
        last = e;
      }
    }
    throw new Fault(
      502,
      last
        ? "Мост провайдера недоступен"
        : "Маршруты провайдера временно недоступны",
    );
  }
}
const ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const AGENT =
  "antigravity/hub/2.24.0 (aidev_client; os_type=linux; arch=x86_64)";
export function geminiSchema(schema, depth = 0) {
  requireThat(
    schema && typeof schema === "object" && depth < 20,
    400,
    "Неподдерживаемая схема инструмента",
  );
  const result = {};
  const type = Array.isArray(schema.type)
    ? schema.type.find((t) => t !== "null")
    : schema.type;
  result.type = String(
    type || (schema.properties ? "object" : "string"),
  ).toUpperCase();
  if (schema.description) result.description = schema.description;
  if (
    schema.nullable ||
    (Array.isArray(schema.type) && schema.type.includes("null"))
  )
    result.nullable = true;
  if (schema.enum?.every((v) => typeof v === "string"))
    result.enum = schema.enum;
  if (schema.properties)
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        geminiSchema(value, depth + 1),
      ]),
    );
  if (schema.items) result.items = geminiSchema(schema.items, depth + 1);
  if (schema.required) result.required = schema.required;
  return result;
}
export class Antigravity {
  constructor(store, transport = new Transport()) {
    this.store = store;
    this.transport = transport;
    this.tokens = new Map();
    this.refreshes = new Map();
    this.signatures = new Map();
    this.clientId = process.env.ANTIGRAVITY_CLIENT_ID;
    this.clientSecret = process.env.ANTIGRAVITY_CLIENT_SECRET;
    this.redirect =
      process.env.ANTIGRAVITY_REDIRECT_URI ||
      "http://localhost:51121/oauth-callback";
  }
  configured() {
    return !!(this.clientId && this.clientSecret);
  }
  async token(account, signal) {
    const cached = this.tokens.get(account.id);
    if (cached && cached.until > Date.now() + 60000) return cached.token;
    if (this.refreshes.has(account.id)) return this.refreshes.get(account.id);
    const task = (async () => {
      const data = this.store.accountCredentials(account);
      const r = await this.transport.fetch(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            grant_type: "refresh_token",
            refresh_token: data.refreshToken,
          }),
        },
      );
      if (!r.ok) {
        if (r.status === 400 || r.status === 401)
          throw new Fault(409, "Подключите Google-аккаунт заново");
        throw new Fault(502, "Не удалось обновить токен Google");
      }
      const t = await r.json();
      requireThat(t.access_token, 502, "Google не вернул access token");
      this.tokens.set(account.id, {
        token: t.access_token,
        until: Date.now() + (t.expires_in || 3600) * 1000,
      });
      if (t.refresh_token)
        this.store.db
          .prepare("UPDATE accounts SET credentials=? WHERE id=?")
          .run(
            this.store.seal({ ...data, refreshToken: t.refresh_token }),
            account.id,
          );
      return t.access_token;
    })();
    this.refreshes.set(account.id, task);
    try {
      return await task;
    } finally {
      this.refreshes.delete(account.id);
    }
  }
  async call(account, method, body, signal) {
    return this.transport.fetch(`${ENDPOINT}/v1internal:${method}`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${await this.token(account, signal)}`,
        "Content-Type": "application/json",
        "User-Agent": AGENT,
      },
      body: JSON.stringify(body),
    });
  }
  async discover(account, signal) {
    const data = this.store.accountCredentials(account);
    let project = data.projectId;
    if (!project) {
      const r = await this.call(
        account,
        "loadCodeAssist",
        { metadata: { ideType: "ANTIGRAVITY" } },
        signal,
      );
      requireThat(r.ok, 502, "Не удалось определить проект Antigravity");
      const p = await r.json();
      project =
        typeof p.cloudaicompanionProject === "string"
          ? p.cloudaicompanionProject
          : p.cloudaicompanionProject?.id;
      requireThat(
        project,
        409,
        "Google не предоставил проект. Завершите активацию аккаунта в Antigravity",
      );
      this.store.db
        .prepare("UPDATE accounts SET credentials=? WHERE id=?")
        .run(this.store.seal({ ...data, projectId: project }), account.id);
    }
    const r = await this.call(
      account,
      "fetchAvailableModels",
      { project },
      signal,
    );
    requireThat(r.ok, 502, "Не удалось получить модели и квоты Antigravity");
    const q = await r.json();
    const models = Object.entries(q.models || {})
      .filter(
        ([id, m]) =>
          /^(gemini-|claude-|gpt-oss-)/.test(id) &&
          !id.includes("disabled") &&
          !id.includes("image") &&
          m.disabled !== true,
      )
      .map(([id, m]) => ({
        id,
        name: m.displayName || id,
        remaining:
          typeof m.quotaInfo?.remainingFraction === "number"
            ? Math.max(0, Math.min(1, m.quotaInfo.remainingFraction))
            : null,
        resetAt: m.quotaInfo?.resetTime || null,
      }));
    requireThat(models.length > 0, 502, "Провайдер не вернул доступные модели");
    this.store.db
      .prepare("UPDATE accounts SET quota=?,checked=? WHERE id=?")
      .run(JSON.stringify(models), Date.now(), account.id);
    return models;
  }
  start(userId, sessionHash) {
    requireThat(this.configured(), 503, "OAuth Antigravity ещё не настроен");
    const state = secret(),
      verifier = randomBytes(48).toString("base64url");
    this.store.db.prepare("DELETE FROM oauth WHERE expires<?").run(Date.now());
    this.store.db
      .prepare("INSERT INTO oauth VALUES(?,?,?,?,?)")
      .run(
        state,
        userId,
        sessionHash,
        this.store.seal({ verifier }),
        Date.now() + 10 * 60000,
      );
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirect,
      response_type: "code",
      scope:
        "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    }).toString();
    return {
      url: url.toString(),
      redirectUri: this.redirect,
      mode: this.redirect.startsWith("http://localhost:") ? "loopback" : "web",
    };
  }
  async finish(userId, sessionHash, callbackUrl) {
    let u;
    try {
      u = new URL(callbackUrl);
    } catch {
      throw new Fault(400, "Вставьте полный адрес возврата Google");
    }
    const redirect = new URL(this.redirect);
    requireThat(
      u.origin === redirect.origin && u.pathname === redirect.pathname,
      400,
      "Неверный адрес возврата",
    );
    const flow = this.store.db
      .prepare(
        "SELECT * FROM oauth WHERE state=? AND user_id=? AND session_hash=? AND expires>?",
      )
      .get(u.searchParams.get("state"), userId, sessionHash, Date.now());
    requireThat(
      flow && u.searchParams.get("code"),
      400,
      "Запрос входа истёк или не принадлежит этой сессии",
    );
    this.store.db.prepare("DELETE FROM oauth WHERE state=?").run(flow.state);
    const r = await this.transport.fetch(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: "authorization_code",
          code: u.searchParams.get("code"),
          redirect_uri: this.redirect,
          code_verifier: this.store.unseal(flow.verifier).verifier,
        }),
      },
    );
    requireThat(r.ok, 502, "Google отклонил код. Начните подключение заново");
    const token = await r.json();
    requireThat(
      token.refresh_token,
      409,
      "Google не предоставил offline-доступ. Подключите аккаунт заново",
    );
    const profile = await this.transport.fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      { headers: { Authorization: `Bearer ${token.access_token}` } },
    );
    requireThat(profile.ok, 502, "Не удалось проверить Google-аккаунт");
    const p = await profile.json();
    requireThat(
      p.email && p.verified_email,
      403,
      "Требуется подтверждённая Google-почта",
    );
    const a = this.store.saveAccount(userId, {
      email: p.email,
      refreshToken: token.refresh_token,
    });
    this.tokens.set(a.id, {
      token: token.access_token,
      until: Date.now() + (token.expires_in || 3600) * 1000,
    });
    return a;
  }
  convert(body, accountId) {
    const toolNames = new Map();
    const contents = (body.messages || [])
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts:
          typeof m.content === "string"
            ? [{ text: m.content }]
            : m.content.map((b) => {
                if (b.type === "text") return { text: b.text };
                if (b.type === "thinking")
                  return {
                    text: b.thinking,
                    thought: true,
                    ...(b.signature ? { thoughtSignature: b.signature } : {}),
                  };
                if (b.type === "tool_use") {
                  toolNames.set(b.id, b.name);
                  const sig = this.signatures.get(accountId + ":" + b.id);
                  return {
                    functionCall: {
                      id: b.id,
                      name: b.name,
                      args: b.input || {},
                    },
                    ...(sig ? { thoughtSignature: sig } : {}),
                  };
                }
                if (b.type === "tool_result")
                  return {
                    functionResponse: {
                      id: b.tool_use_id,
                      name: toolNames.get(b.tool_use_id) || b.name || "tool",
                      response: { output: b.content },
                      ...(b.is_error ? { response: { error: b.content } } : {}),
                    },
                  };
                if (b.type === "image" && b.source?.type === "base64")
                  return {
                    inlineData: {
                      mimeType: b.source.media_type,
                      data: b.source.data,
                    },
                  };
                throw new Fault(400, "Тип содержимого не поддерживается");
              }),
      }));
    const generationConfig = {
      maxOutputTokens: body.max_tokens,
      temperature: body.temperature ?? 0.7,
    };
    if (body.thinking?.type === "enabled")
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: body.thinking.budget_tokens,
      };
    const request = { contents, generationConfig };
    const systemParts = [
      body.system,
      ...(body.messages || [])
        .filter((m) => m.role === "system")
        .map((m) => m.content),
    ].filter(Boolean);
    if (systemParts.length) {
      // preserve the original bridge encoding after observed systemInstruction 429s
      const text = systemParts
        .map((s) =>
          typeof s === "string" ? s : s.map((b) => b.text || "").join("\n"),
        )
        .join("\n");
      const instruction = {
        text: `<system_instruction>\n${text}\n</system_instruction>`,
      };
      if (contents[0]?.role === "user") contents[0].parts.unshift(instruction);
      else contents.unshift({ role: "user", parts: [instruction] });
    }
    if (body.tools?.length) {
      request.tools = [
        {
          functionDeclarations: body.tools.map((t) => ({
            name: t.name,
            description: t.description || "",
            parameters: geminiSchema(
              t.input_schema || { type: "object", properties: {} },
            ),
          })),
        },
      ];
      if (body.tool_choice?.type === "any")
        request.toolConfig = { functionCallingConfig: { mode: "ANY" } };
      if (body.tool_choice?.type === "none")
        request.toolConfig = { functionCallingConfig: { mode: "NONE" } };
      if (body.tool_choice?.type === "tool")
        request.toolConfig = {
          functionCallingConfig: {
            mode: "ANY",
            allowedFunctionNames: [body.tool_choice.name],
          },
        };
    }
    return request;
  }
  async generate(account, model, request, signal) {
    const data = this.store.accountCredentials(account);
    const r = await this.call(
      account,
      "streamGenerateContent?alt=sse",
      {
        project: data.projectId,
        model,
        request,
        requestType: "agent",
        userAgent: "antigravity",
        requestId: "agent-" + secret(),
      },
      signal,
    );
    if (!r.ok) {
      const retry = r.headers.get("retry-after");
      await r.body?.cancel();
      const e = new Fault(
        r.status === 429
          ? 429
          : r.status === 401 || r.status === 403
            ? 403
            : 502,
        r.status === 429
          ? "Квота модели временно недоступна"
          : "Провайдер отклонил запрос",
      );
      e.retryAfter = /^\d+$/.test(retry || "")
        ? Math.min(3600, Number(retry))
        : 60;
      throw e;
    }
    return r;
  }
  async countTokens(account, model, contents, signal) {
    const r = await this.call(
      account,
      "countTokens",
      { request: { model: "models/" + model, contents } },
      signal,
    );
    requireThat(r.ok, 502, "Провайдер не смог посчитать токены");
    const data = await r.json();
    requireThat(
      Number.isSafeInteger(data.totalTokens) && data.totalTokens >= 0,
      502,
      "Провайдер не вернул точный счётчик токенов",
    );
    return { totalTokens: data.totalTokens };
  }
}
export async function* events(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") yield JSON.parse(data);
      }
      requireThat(
        buffer.length < 4 * 1024 * 1024,
        502,
        "Слишком большой chunk провайдера",
      );
      if (done) {
        if (buffer.trim().startsWith("data:"))
          yield JSON.parse(buffer.trim().slice(5));
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
