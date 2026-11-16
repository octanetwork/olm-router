import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, Fault, digest } from "../src/core/store.mjs";
import { Antigravity, events, geminiSchema } from "../src/core/provider.mjs";
import { createApplication } from "../src/server.mjs";
import { fromOpenAI, fromResponses } from "../src/api/gateway.mjs";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "olm-test-"));
const store = new Store(dir, "aa".repeat(32));
let server, base, admin, user, other, manager, session, cookie, csrf;
const payload = {
  model: "gemini-test",
  messages: [{ role: "user", content: "Hello" }],
  max_tokens: 128,
  stream: false,
};
const sse = (
  parts = [{ text: "Hello" }],
  usage = { promptTokenCount: 10, totalTokenCount: 14 },
) =>
  new Response(
    "data: " +
      JSON.stringify({
        response: {
          candidates: [{ content: { parts } }],
          usageMetadata: usage,
        },
      }) +
      "\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );
const provider = {
  configured: () => true,
  tokens: new Map(),
  signatures: new Map(),
  convert: (b) => b,
  countTokens: async () => ({ totalTokens: 10 }),
  generate: async () => sse(),
  discover: async () => [],
  start: () => ({ url: "https://accounts.google.com" }),
};
function ensureAccount(target, model = "gemini-test") {
  let account = store.db
    .prepare("SELECT * FROM accounts WHERE user_id=? AND enabled=1 ORDER BY id")
    .all(target.id)[0];
  if (!account)
    account = store.db.prepare("SELECT * FROM accounts WHERE id=?").get(
      store.saveAccount(target.id, {
        email: `${target.login}@gmail.com`,
        refreshToken: "test-refresh-token",
        projectId: "project",
      }).id,
    );
  const models = JSON.parse(account.quota || "[]");
  if (!models.some((item) => item.id === model))
    models.push({ id: model, remaining: 1 });
  store.db
    .prepare("UPDATE accounts SET quota=? WHERE id=?")
    .run(JSON.stringify(models), account.id);
  return store.db.prepare("SELECT * FROM accounts WHERE id=?").get(account.id);
}
function issueKey(target, name, { account, model = "gemini-test", tokenLimit = null, assignments } = {}) {
  const owner = store.user(target.id);
  const selected = assignments || [
    { model, accountId: (account || ensureAccount(owner, model)).id },
  ];
  return store.createKey(owner, {
    name,
    assignments: selected,
    tokenLimit,
  });
}
async function request(
  p,
  {
    method = "GET",
    body,
    key,
    sessionCookie = cookie,
    origin = "http://localhost:8045",
    csrfToken = csrf,
  } = {},
) {
  const r = await fetch(base + p, {
    method,
    headers: {
      ...(sessionCookie ? { cookie: sessionCookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "x-api-key": key } : {}),
      origin,
      "x-csrf-token": csrfToken || "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
await test("bootstrap, sessions and encrypted storage", async () => {
  const file = path.join(dir, "bootstrap.json");
  fs.writeFileSync(
    file,
    JSON.stringify([
      {
        login: "octadmin",
        password: "test-password-12345",
        role: "superadmin",
      },
    ]),
  );
  await store.bootstrap(file);
  assert.equal(fs.existsSync(file), false);
  admin = store.db.prepare("SELECT * FROM users WHERE login=?").get("octadmin");
  assert.ok(!admin.password.includes("test-password"));
  assert.equal(
    await store.passwordMatches("wrong password", admin.password),
    false,
  );
  session = await store.login("octadmin", "test-password-12345");
  cookie = "olm_session=" + session.token;
  csrf = session.csrf;
  assert.equal(store.session(session.token).user.id, admin.id);
  assert.equal(store.session("random"), null);
  user = await store.createUser(admin, {
    login: "alice",
    password: "test-password-12345",
  });
  other = await store.createUser(admin, {
    login: "other",
    password: "test-password-12345",
  });
  manager = await store.createUser(admin, {
    login: "manager",
    password: "test-password-12345",
    role: "admin",
  });
  const a = store.saveAccount(user.id, {
    email: "alice@gmail.com",
    refreshToken: "secret-refresh-token",
    projectId: "project",
  });
  const row = store.db.prepare("SELECT * FROM accounts WHERE id=?").get(a.id);
  assert.ok(!row.credentials.includes("secret-refresh-token"));
  assert.equal(
    store.accountCredentials(row).refreshToken,
    "secret-refresh-token",
  );
  assert.equal(a.email, "**lice@gmail.com");
  assert.equal(a.credentials, undefined);
  assert.equal(JSON.parse(store.user(user.id).settings).accountId, a.id);
  store.db
    .prepare("UPDATE accounts SET quota=?,checked=? WHERE id=?")
    .run(
      JSON.stringify([{ id: "gemini-test", remaining: 1 }]),
      Date.now(),
      a.id,
    );
  server = await createApplication({
    store,
    provider,
    secure: false,
    panelOrigin: "http://localhost:8045",
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
});
await test("legacy key routing migrates once and does not grant later accounts", () => {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "olm-legacy-"));
  const file = path.join(legacyDir, "olm.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY,login TEXT UNIQUE,password TEXT,role TEXT,manager TEXT,enabled INTEGER,balance INTEGER,settings TEXT);
    CREATE TABLE api_keys(id TEXT PRIMARY KEY,hash TEXT UNIQUE,user_id TEXT,name TEXT,prefix TEXT,created INTEGER);
    CREATE TABLE accounts(id TEXT PRIMARY KEY,user_id TEXT,email TEXT,credentials TEXT,shared INTEGER,enabled INTEGER,quota TEXT,checked INTEGER,cooldown INTEGER);
  `);
  db.prepare("INSERT INTO users VALUES(?,?,?,?,?,?,?,?)").run(
    "legacy-owner",
    "legacy",
    "unused",
    "user",
    null,
    1,
    0,
    JSON.stringify({ accountId: "legacy-account" }),
  );
  db.prepare("INSERT INTO users VALUES(?,?,?,?,?,?,?,?)").run(
    "late-owner",
    "late",
    "unused",
    "user",
    null,
    1,
    0,
    JSON.stringify({}),
  );
  db.prepare("INSERT INTO api_keys VALUES(?,?,?,?,?,?)").run(
    "legacy-key",
    digest("legacy-token"),
    "legacy-owner",
    "legacy",
    "legacy-prefix",
    Date.now(),
  );
  db.prepare("INSERT INTO api_keys VALUES(?,?,?,?,?,?)").run(
    "late-key",
    digest("late-token"),
    "late-owner",
    "late",
    "late-prefix",
    Date.now(),
  );
  db.prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?,?)").run(
    "legacy-account",
    "legacy-owner",
    "legacy@gmail.com",
    "{}",
    0,
    1,
    JSON.stringify([{ id: "gemini-test", remaining: 1 }]),
    Date.now(),
    0,
  );
  db.close();
  let migrated;
  try {
    migrated = new Store(legacyDir, "bb".repeat(32));
    assert.deepEqual(
      migrated.keyModels("legacy-key").map((item) => [item.model, item.accountId]),
      [["gemini-test", "legacy-account"]],
    );
    assert.deepEqual(migrated.keyModels("late-key"), []);
    const laterAccount = migrated.saveAccount("late-owner", {
      email: "late@gmail.com",
      refreshToken: "late-refresh",
      projectId: "project",
    });
    migrated.db
      .prepare("UPDATE accounts SET quota=? WHERE id=?")
      .run(JSON.stringify([{ id: "gemini-test", remaining: 1 }]), laterAccount.id);
    migrated.db.close();
    migrated = new Store(legacyDir, "bb".repeat(32));
    assert.deepEqual(migrated.keyModels("late-key"), []);
    assert.deepEqual(
      migrated.db
        .prepare("PRAGMA table_info(api_keys)")
        .all()
        .map((column) => column.name),
      ["id", "hash", "user_id", "name", "prefix", "created"],
    );
    migrated.db
      .prepare("INSERT INTO api_keys VALUES(?,?,?,?,?,?)")
      .run(
        "rollback-key",
        digest("rollback-token"),
        "legacy-owner",
        "from previous version",
        "rollback-prefix",
        Date.now(),
      );
    migrated.db
      .prepare("INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        "rollback-usage",
        "legacy-owner",
        "legacy-account",
        "gemini-test",
        "own",
        2,
        3,
        0,
        "complete",
        Date.now(),
      );
    migrated.db.close();
    migrated = new Store(legacyDir, "bb".repeat(32));
    assert.deepEqual(
      migrated.keyModels("rollback-key").map((item) => [item.model, item.accountId]),
      [["gemini-test", "legacy-account"]],
    );
    assert.equal(
      migrated.db
        .prepare("SELECT tokens FROM usage_details WHERE usage_id=?")
        .get("rollback-usage").tokens,
      5,
    );
  } finally {
    migrated?.db.close();
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});
await test("closed routes, csrf and cookie security", async () => {
  assert.equal(
    (await request("/api/admin/users", { sessionCookie: "" })).status,
    401,
  );
  assert.equal(
    (await request("/api/admin/keys", { sessionCookie: "" })).status,
    401,
  );
  assert.equal((await request("/oauth/token", { method: "POST" })).status, 404);
  assert.equal(
    (await request("/v1/models", { sessionCookie: "" })).status,
    401,
  );
  assert.equal(
    (
      await request("/api/keys", {
        method: "POST",
        body: { name: "key" },
        csrfToken: "wrong",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/keys", {
        method: "POST",
        body: { name: "key" },
        origin: "https://evil.example",
      })
    ).status,
    403,
  );
  const bad = await request("/api/login", {
    method: "POST",
    body: { login: "none", password: "bad" },
  });
  assert.equal(bad.status, 401);
  const login = await request("/api/login", {
    method: "POST",
    body: { login: "alice", password: "test-password-12345" },
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  assert.match(login.headers.get("set-cookie"), /SameSite=Strict/);
  const secured = await createApplication({
    store,
    provider,
    secure: true,
    panelOrigin: "https://olm.octx.space",
  });
  await new Promise((r) => secured.listen(0, "127.0.0.1", r));
  const address = "http://127.0.0.1:" + secured.address().port;
  try {
    const legacy = await fetch(address + "/api/me", { headers: { cookie } });
    assert.equal(legacy.status, 401);
    await legacy.arrayBuffer();
    const signed = await fetch(address + "/api/login", {
      method: "POST",
      headers: {
        Origin: "https://olm.octx.space",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ login: "alice", password: "test-password-12345" }),
    });
    assert.equal(signed.status, 200);
    const securedCookie = signed.headers.get("set-cookie");
    assert.match(securedCookie, /^__Host-olm_session=/);
    assert.match(securedCookie, /; Secure/);
    assert.ok(!securedCookie.includes("Domain="));
    await signed.arrayBuffer();
    const current = await fetch(address + "/api/me", {
      headers: { cookie: securedCookie.split(";")[0] },
    });
    assert.equal(current.status, 200);
    await current.arrayBuffer();
  } finally {
    await new Promise((r) => secured.close(r));
  }
});
await test("web OAuth callback keeps strict session and account client binding", async () => {
  const env = Object.fromEntries(
    [
      "ANTIGRAVITY_CLIENT_ID",
      "ANTIGRAVITY_CLIENT_SECRET",
      "ANTIGRAVITY_WEB_CLIENT_ID",
      "ANTIGRAVITY_WEB_CLIENT_SECRET",
      "OLM_PANEL_ORIGIN",
    ].map((name) => [name, process.env[name]]),
  );
  process.env.ANTIGRAVITY_CLIENT_ID = "desktop-client";
  process.env.ANTIGRAVITY_CLIENT_SECRET = "desktop-secret";
  process.env.ANTIGRAVITY_WEB_CLIENT_ID = "web-client";
  process.env.ANTIGRAVITY_WEB_CLIENT_SECRET = "web-secret";
  process.env.OLM_PANEL_ORIGIN = "https://olm.octx.space";
  const oauthSession = await store.login("alice", "test-password-12345");
  let webAccountId;
  const exchanges = [];
  const webProvider = new Antigravity(store, {
    fetch: async (url, options = {}) => {
      if (url.endsWith("/token")) {
        const form = new URLSearchParams(options.body);
        exchanges.push(form);
        return Response.json({
          access_token: "access-" + exchanges.length,
          ...(form.get("grant_type") === "authorization_code"
            ? { refresh_token: "web-refresh" }
            : {}),
          expires_in: 3600,
        });
      }
      if (url.endsWith("/userinfo"))
        return Response.json({
          email: "web-login@gmail.com",
          verified_email: true,
        });
      if (url.includes(":loadCodeAssist"))
        return Response.json({ cloudaicompanionProject: "web-project" });
      if (url.includes(":fetchAvailableModels"))
        return Response.json({
          models: { "gemini-test": { displayName: "Gemini Test" } },
        });
      throw new Error("Unexpected OAuth test request");
    },
  });
  const securePanel = await createApplication({
    store,
    provider: webProvider,
    secure: true,
    panelOrigin: "https://olm.octx.space",
  });
  await new Promise((resolve) => securePanel.listen(0, "127.0.0.1", resolve));
  const address = "http://127.0.0.1:" + securePanel.address().port;
  try {
    const started = await fetch(address + "/api/accounts/oauth", {
      method: "POST",
      headers: {
        cookie: "__Host-olm_session=" + oauthSession.token,
        origin: "https://olm.octx.space",
        "x-csrf-token": oauthSession.csrf,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(started.status, 200);
    const transactionCookie = started.headers.get("set-cookie");
    assert.match(transactionCookie, /^__Host-olm_oauth=/);
    assert.match(transactionCookie, /; Secure/);
    assert.match(transactionCookie, /; HttpOnly/);
    assert.match(transactionCookie, /; SameSite=Lax/);
    const flow = await started.json();
    assert.equal(flow.mode, "web");
    assert.equal(flow.redirectUri, "https://olm.octx.space/oauth/google/callback");
    const authUrl = new URL(flow.url);
    assert.equal(authUrl.searchParams.get("client_id"), "web-client");
    assert.equal(authUrl.searchParams.get("redirect_uri"), flow.redirectUri);
    const state = authUrl.searchParams.get("state");
    const cookieState = transactionCookie.split(";")[0];
    const callbackUrl =
      address + "/oauth/google/callback?code=one-time-code&state=" + state;
    const missingCookie = await fetch(callbackUrl);
    assert.equal(missingCookie.status, 400);
    await missingCookie.arrayBuffer();
    const callback = await fetch(callbackUrl, {
      headers: { cookie: cookieState },
    });
    assert.equal(callback.status, 200);
    assert.match(callback.headers.get("set-cookie"), /Max-Age=0/);
    const page = await callback.text();
    assert.match(page, /oauth-return\.js/);
    assert.ok(!page.includes("one-time-code"));
    assert.equal(exchanges[0].get("client_id"), "web-client");
    assert.equal(
      exchanges[0].get("redirect_uri"),
      "https://olm.octx.space/oauth/google/callback",
    );
    const replay = await fetch(callbackUrl, {
      headers: { cookie: cookieState },
    });
    assert.equal(replay.status, 200);
    await replay.arrayBuffer();
    assert.equal(exchanges.length, 1);
    const connected = store.db
      .prepare("SELECT * FROM accounts WHERE user_id=? AND email=?")
      .get(user.id, "web-login@gmail.com");
    webAccountId = connected.id;
    assert.equal(store.accountCredentials(connected).oauthClient, "web");
    webProvider.tokens.delete(connected.id);
    await webProvider.token(connected);
    assert.equal(exchanges[1].get("client_id"), "web-client");
    const legacy = store.db
      .prepare("SELECT * FROM accounts WHERE user_id=? AND email=?")
      .get(user.id, "alice@gmail.com");
    await webProvider.token(legacy);
    assert.equal(exchanges[2].get("client_id"), "desktop-client");
  } finally {
    if (webAccountId)
      store.db.prepare("DELETE FROM accounts WHERE id=?").run(webAccountId);
    store.db
      .prepare("DELETE FROM sessions WHERE hash=?")
      .run(digest(oauthSession.token));
    await new Promise((resolve) => securePanel.close(resolve));
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
await test("production Google sign-in cannot fall back to localhost", () => {
  const env = Object.fromEntries(
    [
      "NODE_ENV",
      "ANTIGRAVITY_CLIENT_ID",
      "ANTIGRAVITY_CLIENT_SECRET",
      "ANTIGRAVITY_WEB_CLIENT_ID",
      "ANTIGRAVITY_WEB_CLIENT_SECRET",
    ].map((name) => [name, process.env[name]]),
  );
  try {
    process.env.NODE_ENV = "production";
    process.env.ANTIGRAVITY_CLIENT_ID = "desktop-client";
    process.env.ANTIGRAVITY_CLIENT_SECRET = "desktop-secret";
    delete process.env.ANTIGRAVITY_WEB_CLIENT_ID;
    delete process.env.ANTIGRAVITY_WEB_CLIENT_SECRET;
    const before = store.db
      .prepare("SELECT count(*) AS n FROM oauth WHERE session_hash=?")
      .get("production-session").n;
    assert.throws(
      () => new Antigravity(store).start(user.id, "production-session"),
      (error) =>
        error.status === 503 &&
        error.message.includes("Вход Google через сайт не настроен"),
    );
    assert.equal(
      store.db
        .prepare("SELECT count(*) AS n FROM oauth WHERE session_hash=?")
        .get("production-session").n,
      before,
    );
  } finally {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
await test("role and object ownership enforcement", async () => {
  const normal = await store.login("alice", "test-password-12345");
  const c = "olm_session=" + normal.token;
  assert.equal(
    (await request("/api/admin/users", { sessionCookie: c })).status,
    403,
  );
  const m = await store.login("manager", "test-password-12345");
  const mc = "olm_session=" + m.token;
  const ownAccounts = JSON.parse(
    (await request("/api/accounts", { sessionCookie: c })).text,
  ).accounts;
  assert.equal(ownAccounts[0].email, "alice@gmail.com");
  assert.equal(ownAccounts[0].credentials, undefined);
  assert.equal(
    (
      await request("/api/admin/users", {
        method: "POST",
        sessionCookie: mc,
        csrfToken: m.csrf,
        body: {
          login: "badadmin",
          password: "test-password-12345",
          role: "admin",
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/api/admin/users/${user.id}/keys`, {
        method: "POST",
        sessionCookie: mc,
        csrfToken: m.csrf,
        body: { name: "blocked", tokenLimit: 100, assignments: [] },
      })
    ).status,
    403,
  );
  const accounts = JSON.parse((await request("/api/accounts")).text).accounts;
  assert.equal(accounts.length, 0);
  const userAccount = store.db
    .prepare("SELECT * FROM accounts WHERE user_id=?")
    .get(user.id);
  assert.equal(
    (
      await request("/api/accounts/" + userAccount.id + "/refresh", {
        method: "POST",
        body: {},
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request("/api/accounts/" + userAccount.id, {
        method: "PATCH",
        sessionCookie: c,
        csrfToken: normal.csrf,
        body: { shared: true },
      })
    ).status,
    404,
  );
});
await test("api keys are account-bound, usage is token-based and revocable", async () => {
  const k = issueKey(user, "test");
  assert.equal(store.apiKey(k.key).user.id, user.id);
  assert.ok(
    !JSON.stringify(store.db.prepare("SELECT * FROM api_keys").all()).includes(
      k.key,
    ),
  );
  const r = await request("/v1/messages", {
    method: "POST",
    body: payload,
    key: k.key,
  });
  assert.equal(r.status, 200, r.text);
  const b = JSON.parse(r.text);
  assert.equal(b.content[0].text, "Hello");
  assert.deepEqual(b.usage, { input_tokens: 10, output_tokens: 4 });
  assert.equal(store.user(user.id).balance, 0);
  const u = store.db
    .prepare(
      "SELECT u.*,d.tokens,d.api_key_id FROM usage u JOIN usage_details d ON d.usage_id=u.id WHERE u.user_id=?",
    )
    .get(user.id);
  assert.equal(u.credits, 0);
  assert.equal(u.tokens, 14);
  assert.equal(u.api_key_id, k.id);
  assert.equal(u.source, "own");
  assert.equal(u.state, "complete");
  const o = await request("/v1/chat/completions", {
    method: "POST",
    body: {
      model: "gemini-test",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 128,
      stream: false,
    },
    key: k.key,
  });
  assert.equal(o.status, 200, o.text);
  const ob = JSON.parse(o.text);
  assert.equal(ob.object, "chat.completion");
  assert.equal(ob.choices[0].message.content, "Hello");
  assert.equal(ob.usage.prompt_tokens, 10);
  const stream = await request("/v1/chat/completions", {
    method: "POST",
    body: {
      model: "gemini-test",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 128,
      stream: true,
    },
    key: k.key,
  });
  assert.match(stream.text, /chat.completion.chunk/);
  assert.match(stream.text, /data: \[DONE\]/);
  assert.ok(!stream.text.includes("event: message_start"));
  store.db.prepare("DELETE FROM api_keys WHERE id=?").run(k.id);
  assert.equal((await request("/v1/models", { key: k.key })).status, 401);
});
await test("per-key token limits reserve concurrent use and charge actual tokens", async () => {
  store.db.exec("DELETE FROM cooldowns");
  const key = issueKey(user, "twenty-token-cap", { tokenLimit: 20 });
  let generated = 0;
  provider.generate = async () => {
    generated++;
    return sse();
  };
  const first = await request("/v1/messages", {
    method: "POST",
    body: payload,
    key: key.key,
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(
    store.db
      .prepare("SELECT tokens_used FROM api_key_policies WHERE api_key_id=?")
      .get(key.id)
      .tokens_used,
    14,
  );
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM token_reservations").get().n,
    0,
  );
  const over = await request("/v1/messages", {
    method: "POST",
    body: payload,
    key: key.key,
  });
  assert.equal(over.status, 429, over.text);
  assert.equal(generated, 1);
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM cooldowns").get().n,
    0,
  );
  provider.generate = async () => sse();
});
await test("each API key only exposes its selected model and account", async () => {
  store.db.exec("DELETE FROM cooldowns");
  const first = ensureAccount(store.user(user.id));
  const second = store.saveAccount(user.id, {
    email: "backup@gmail.com",
    refreshToken: "backup-secret",
    projectId: "project",
  });
  store.db
    .prepare("UPDATE accounts SET quota=? WHERE id=?")
    .run(JSON.stringify([{ id: "gemini-test", remaining: 1 }]), second.id);
  const limited = issueKey(user, "pinned", {
    account: first,
    assignments: [{ model: "gemini-test", accountId: first.id }],
  });
  const models = await request("/v1/models", { key: limited.key });
  assert.deepEqual(
    JSON.parse(models.text).data.map((item) => item.id),
    ["gemini-test"],
  );
  const denied = await request("/v1/messages", {
    method: "POST",
    body: { ...payload, model: "not-assigned" },
    key: limited.key,
  });
  assert.equal(denied.status, 403);
  let attempted = [];
  provider.generate = async (account) => {
    attempted.push(account.id);
    throw new Fault(429, "quota");
  };
  const stopped = await request("/v1/messages", {
    method: "POST",
    body: payload,
    key: limited.key,
  });
  assert.equal(stopped.status, 429);
  assert.deepEqual(attempted, [first.id]);
  provider.generate = async () => sse();
});
await test("administrator issues model and account scoped keys", async () => {
  const account = ensureAccount(store.user(user.id));
  const issued = await request(`/api/admin/users/${user.id}/keys`, {
    method: "POST",
    body: {
      name: "issued",
      tokenLimit: 500,
      assignments: [{ model: "gemini-test", accountId: account.id }],
    },
  });
  assert.equal(issued.status, 201, issued.text);
  const data = JSON.parse(issued.text);
  assert.equal(data.tokenLimit, 500);
  assert.equal(store.apiKey(data.key).user.id, user.id);
  assert.deepEqual(store.keyModels(data.id).map((item) => item.accountId), [account.id]);
  assert.equal(
    (
      await request(`/api/admin/users/${user.id}/keys`, {
        method: "POST",
        body: {
          name: "bad-account",
          tokenLimit: 500,
          assignments: [{ model: "gemini-test", accountId: ensureAccount(other).id }],
        },
      })
    ).status,
    400,
  );
});
await test("disabled accounts hide stale quotas and stop serving assigned models", async () => {
  const disabledUser = await store.createUser(admin, {
    login: "disabled",
    password: "test-password-12345",
  });
  const account = ensureAccount(disabledUser);
  const key = issueKey(disabledUser, "before-disable", { account });
  const login = await store.login("disabled", "test-password-12345");
  const response = await request(`/api/accounts/${account.id}`, {
    method: "DELETE",
    sessionCookie: "olm_session=" + login.token,
    csrfToken: login.csrf,
    body: {},
  });
  assert.equal(response.status, 200);
  const accounts = JSON.parse(
    (
      await request("/api/accounts", {
        sessionCookie: "olm_session=" + login.token,
        csrfToken: login.csrf,
      })
    ).text,
  ).accounts;
  assert.equal(accounts[0].enabled, 0);
  assert.equal(accounts[0].quota, null);
  const models = await request("/v1/models", { key: key.key });
  assert.deepEqual(JSON.parse(models.text).data, []);
  assert.equal(
    (
      await request("/v1/messages", {
        method: "POST",
        body: payload,
        key: key.key,
      })
    ).status,
    403,
  );
});
await test("OpenAI tool conversion, SSE framing and OAuth isolation", async () => {
  const converted = fromOpenAI({
    model: "gemini-test",
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "read", arguments: '{"file":"x"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "result" },
    ],
  });
  assert.equal(converted.messages[0].content[0].type, "tool_use");
  assert.equal(converted.messages[1].content[0].tool_use_id, "a");
  const out = [];
  for await (const data of events(
    new Response('data: {"x":1}\r\n\r\ndata: {"x":2}\n\n').body,
  ))
    out.push(data);
  assert.deepEqual(out, [{ x: 1 }, { x: 2 }]);
  const oldId = process.env.ANTIGRAVITY_CLIENT_ID,
    oldSecret = process.env.ANTIGRAVITY_CLIENT_SECRET;
  process.env.ANTIGRAVITY_CLIENT_ID = "client";
  process.env.ANTIGRAVITY_CLIENT_SECRET = "secret";
  const ag = new Antigravity(store, {
    fetch: () => {
      throw new Error("must not exchange wrong state");
    },
  });
  const flow = ag.start(user.id, "session1");
  const u = new URL(flow.url);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  await assert.rejects(
    () =>
      ag.finish(
        other.id,
        "session2",
        "http://localhost:51121/oauth-callback?code=c&state=" +
          u.searchParams.get("state"),
      ),
    { status: 400 },
  );
  await assert.rejects(
    () =>
      ag.finish(
        user.id,
        "session1",
        "https://evil.example/?code=c&state=" + u.searchParams.get("state"),
      ),
    { status: 400 },
  );
  if (oldId === undefined) delete process.env.ANTIGRAVITY_CLIENT_ID;
  else process.env.ANTIGRAVITY_CLIENT_ID = oldId;
  if (oldSecret === undefined) delete process.env.ANTIGRAVITY_CLIENT_SECRET;
  else process.env.ANTIGRAVITY_CLIENT_SECRET = oldSecret;
});
await test("invalid request bodies fail safely", async () => {
  const k = issueKey(user, "invalid");
  assert.equal(
    (
      await request("/v1/messages", {
        method: "POST",
        body: { ...payload, max_tokens: -1 },
        key: k.key,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/v1/responses", {
        method: "POST",
        body: { model: "gemini-test", input: [] },
        key: k.key,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/v1/responses", {
        method: "POST",
        body: { input: "Hello" },
        key: k.key,
      })
    ).status,
    400,
  );
  assert.equal((await request("/api/settings", { method: "PATCH", body: {} })).status, 404);
});
await test("Responses API converts text and tools and streams Codex events", async () => {
  store.db.exec("DELETE FROM cooldowns");
  const oldConvert = provider.convert,
    oldGenerate = provider.generate;
  const key = issueKey(user, "codex-cli", { tokenLimit: 20 });
  let converted;
  provider.convert = (body) => {
    converted = body;
    return body;
  };
  try {
    const body = {
      model: "gemini-test",
      instructions: "Follow the repository rules.",
      input: [
        { role: "developer", content: [{ type: "input_text", text: "Use tools." }] },
        { role: "user", content: [{ type: "input_text", text: "Read file x." }] },
      ],
      max_output_tokens: 128,
      reasoning: { effort: "high" },
      top_p: 0.9,
      stream: false,
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    };
    provider.generate = async () => sse([{ text: "Hello" }]);
    const response = await request("/v1/responses", {
      method: "POST",
      body,
      key: key.key,
    });
    assert.equal(response.status, 200, response.text);
    const result = JSON.parse(response.text);
    assert.equal(result.object, "response");
    assert.equal(result.output[0].content[0].text, "Hello");
    assert.equal(result.usage.total_tokens, 14);
    assert.equal(converted.system, "Follow the repository rules.\nUse tools.");
    assert.equal(converted.tools[0].name, "read_file");
    assert.equal(converted.thinking.budget_tokens, 16384);
    assert.equal(converted.top_p, 0.9);
    assert.equal(
      store.db
        .prepare("SELECT tokens_used FROM api_key_policies WHERE api_key_id=?")
        .get(key.id).tokens_used,
      14,
    );

    provider.generate = async () =>
      sse([{ functionCall: { id: "call-1", name: "read_file", args: { path: "x" } } }]);
    const streamKey = issueKey(user, "codex-cli-stream");
    const toolStream = await request("/v1/responses", {
      method: "POST",
      body: { ...body, stream: true, max_output_tokens: 128 },
      key: streamKey.key,
    });
    assert.equal(toolStream.status, 200, toolStream.text);
    assert.match(toolStream.text, /event: response\.function_call_arguments\.delta/);
    assert.match(toolStream.text, /event: response\.completed/);
    assert.match(toolStream.text, /"type":"function_call"/);

    const convertedInput = fromResponses({
      model: "gemini-test",
      input: [
        { type: "function_call", call_id: "call-2", name: "read_file", arguments: '{"path":"x"}' },
        { type: "function_call_output", call_id: "call-2", output: "file contents" },
        { role: "user", content: "Continue" },
      ],
    });
    assert.equal(convertedInput.messages[0].content[0].type, "tool_use");
    assert.equal(convertedInput.messages[1].content[0].type, "tool_result");
    assert.equal(convertedInput.messages[1].content[0].tool_use_id, "call-2");
  } finally {
    provider.convert = oldConvert;
    provider.generate = oldGenerate;
  }
});
await test("model route never fails over to a different connected account", async () => {
  store.db.exec("DELETE FROM cooldowns");
  const first = store.db
    .prepare("SELECT * FROM accounts WHERE user_id=? LIMIT 1")
    .get(user.id);
  const second = store.saveAccount(user.id, {
    email: "backup@gmail.com",
    refreshToken: "backup-secret",
    projectId: "project",
  });
  store.db
    .prepare("UPDATE accounts SET quota=? WHERE id=?")
    .run(JSON.stringify([{ id: "gemini-test", remaining: 1 }]), second.id);
  const key = issueKey(user, "pinned-account", { account: first });
  let attempts = [];
  provider.generate = async (a) => {
    attempts.push(a.id);
    if (a.id === first.id) throw new Fault(429, "quota");
    return sse();
  };
  const stopped = await request("/v1/messages", {
    method: "POST",
    body: payload,
    key: key.key,
  });
  assert.equal(stopped.status, 429);
  assert.deepEqual(attempts, [first.id]);
  assert.equal(
    store.db
      .prepare("SELECT model FROM cooldowns WHERE account_id=?")
      .get(first.id).model,
    "gemini-test",
  );
  store.db.exec("DELETE FROM cooldowns");
  attempts = [];
  const backupKey = issueKey(user, "explicit-backup", { account: second });
  const switched = await request("/v1/messages", {
    method: "POST",
    body: payload,
    key: backupKey.key,
  });
  assert.equal(switched.status, 200, switched.text);
  assert.deepEqual(attempts, [second.id]);
  provider.generate = async () => sse();
  store.db.exec("DELETE FROM cooldowns");
});
await test("concurrent requests cannot exceed an API key token cap", async () => {
  const u = await store.createUser(admin, {
    login: "concurrent",
    password: "test-password-12345",
  });
  const key = issueKey(u, "parallel", { tokenLimit: 20 });
  let start, release;
  const began = new Promise((r) => (start = r)),
    gate = new Promise((r) => (release = r));
  provider.generate = async () => {
    start();
    await gate;
    return sse();
  };
  const first = request("/v1/messages", {
    method: "POST",
    body: payload,
    key: key.key,
  });
  await began;
  const second = await request("/v1/messages", {
    method: "POST",
    body: payload,
    key: key.key,
  });
  assert.equal(second.status, 429, second.text);
  release();
  const done = await first;
  assert.equal(done.status, 200, done.text);
  assert.equal(
    store.db
      .prepare("SELECT tokens_used FROM api_key_policies WHERE api_key_id=?")
      .get(key.id)
      .tokens_used,
    14,
  );
  provider.generate = async () => sse();
});
await test("native Gemini SSE and OpenAI tool chunks preserve their protocol", async () => {
  store.db.exec("DELETE FROM cooldowns");
  const key = issueKey(user, "protocols");
  const native = await request(
    "/v1beta/models/gemini-test:streamGenerateContent",
    {
      method: "POST",
      body: {
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        generationConfig: { maxOutputTokens: 128 },
      },
      key: key.key,
    },
  );
  assert.equal(native.status, 200, native.text);
  assert.ok(native.text.includes("usageMetadata"));
  assert.ok(!native.text.includes("message_start"));
  provider.generate = async () =>
    sse([
      {
        functionCall: { id: "call-1", name: "lookup", args: { n: 1 } },
        thoughtSignature: "sig",
      },
    ]);
  const tool = await request("/v1/chat/completions", {
    method: "POST",
    body: {
      model: "gemini-test",
      messages: [{ role: "user", content: "Call lookup" }],
      max_tokens: 128,
      stream: true,
    },
    key: key.key,
  });
  assert.equal(tool.status, 200, tool.text);
  assert.match(tool.text, /tool_calls/);
  assert.match(tool.text, /lookup/);
  assert.match(tool.text, /\[DONE\]/);
  provider.generate = async () => sse();
});
await test("Claude Code schemas and system turns are converted without cross-client signatures", () => {
  const schema = geminiSchema({
    $schema: "test",
    type: "object",
    properties: {
      file_path: { type: "string" },
      limit: { type: ["integer", "null"] },
    },
    required: ["file_path"],
    additionalProperties: false,
  });
  assert.equal(schema.type, "OBJECT");
  assert.equal(schema.additionalProperties, undefined);
  assert.equal(schema.properties.limit.nullable, true);
  assert.deepEqual(schema.required, ["file_path"]);
  const ag = new Antigravity(store, {});
  ag.signatures.set("account:key-one:t1", "private-signature");
  const body = {
    system: "Top instruction",
    messages: [
      { role: "user", content: "Read" },
      { role: "system", content: [{ type: "text", text: "Client extension" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: "x" },
          },
        ],
      },
    ],
    max_tokens: 128,
  };
  const own = ag.convert(body, "account:key-one"),
    other = ag.convert(body, "account:key-two");
  assert.equal(own.contents[1].parts[0].thoughtSignature, "private-signature");
  assert.equal(other.contents[1].parts[0].thoughtSignature, undefined);
  assert.match(own.contents[0].parts[0].text, /Client extension/);
  assert.equal(own.systemInstruction, undefined);
});
await test("OAuth callback is single-use and reconnect clears stale quotas", async () => {
  const oldId = process.env.ANTIGRAVITY_CLIENT_ID,
    oldSecret = process.env.ANTIGRAVITY_CLIENT_SECRET;
  process.env.ANTIGRAVITY_CLIENT_ID = "test";
  process.env.ANTIGRAVITY_CLIENT_SECRET = "test";
  let exchanges = 0;
  const ag = new Antigravity(store, {
    fetch: async (url) => {
      exchanges++;
      return Response.json(
        url.includes("/token")
          ? { access_token: "a", refresh_token: "r", expires_in: 3600 }
          : { email: "oauth@gmail.com", verified_email: true },
      );
    },
  });
  const flow = ag.start(user.id, "session"),
    state = new URL(flow.url).searchParams.get("state");
  const callback =
    "http://localhost:51121/oauth-callback?code=c&state=" + state;
  const account = await ag.finish(user.id, "session", callback);
  assert.equal(account.email, "**auth@gmail.com");
  assert.equal(account.refreshToken, undefined);
  await assert.rejects(() => ag.finish(user.id, "session", callback), {
    status: 400,
  });
  assert.equal(exchanges, 2);
  store.db
    .prepare("UPDATE accounts SET quota=?,checked=? WHERE id=?")
    .run('[{"id":"stale"}]', Date.now(), account.id);
  store.saveAccount(user.id, {
    email: "oauth@gmail.com",
    refreshToken: "new",
    projectId: "project",
  });
  const fresh = store.db
    .prepare("SELECT * FROM accounts WHERE id=?")
    .get(account.id);
  assert.equal(fresh.quota, null);
  assert.equal(fresh.checked, null);
  assert.deepEqual(Object.keys(store.accountCredentials(fresh)).sort(), [
    "oauthClient",
    "projectId",
    "refreshToken",
  ]);
  if (oldId === undefined) delete process.env.ANTIGRAVITY_CLIENT_ID;
  else process.env.ANTIGRAVITY_CLIENT_ID = oldId;
  if (oldSecret === undefined) delete process.env.ANTIGRAVITY_CLIENT_SECRET;
  else process.env.ANTIGRAVITY_CLIENT_SECRET = oldSecret;
});
await test("native SDK key header and exact token count endpoint", async () => {
  const key = issueKey(user, "native sdk");
  let called = false;
  provider.countTokens = async (a, m, request) => {
    called = true;
    assert.equal(m, "gemini-test");
    assert.equal(request.contents[0].parts[0].text, "Hi");
    assert.deepEqual(request.tools, [{ functionDeclarations: [] }]);
    assert.deepEqual(request.systemInstruction, {
      parts: [{ text: "Be concise" }],
    });
    return { totalTokens: 7 };
  };
  const response = await fetch(
    base + "/v1beta/models/gemini-test:countTokens",
    {
      method: "POST",
      headers: {
        "x-goog-api-key": key.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        systemInstruction: { parts: [{ text: "Be concise" }] },
        tools: [{ functionDeclarations: [] }],
      }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { totalTokens: 7 });
  assert.equal(called, true);
  store.db.prepare("UPDATE users SET enabled=0 WHERE id=?").run(other.id);
  assert.throws(
    () =>
      store.saveAccount(other.id, {
        email: "blocked@gmail.com",
        refreshToken: "blocked",
      }),
    { status: 403 },
  );
  store.db.prepare("UPDATE users SET enabled=1 WHERE id=?").run(other.id);
  const models = await fetch(base + "/v1beta/models", {
    headers: { "x-goog-api-key": key.key },
  });
  assert.equal(models.status, 200);
  assert.ok(
    (await models.json()).models.some((m) => m.name === "models/gemini-test"),
  );
  provider.countTokens = async () => ({ totalTokens: 10 });
});
await test("Antigravity countTokens includes system instructions and tools", async () => {
  const account = ensureAccount(store.user(user.id));
  let sent;
  const client = new Antigravity(store, {
    fetch: async (_url, options) => {
      sent = JSON.parse(options.body);
      return new Response(JSON.stringify({ totalTokens: 17 }));
    },
  });
  client.tokens.set(account.id, {
    token: "test-access-token",
    until: Date.now() + 3600000,
  });
  const request = {
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    systemInstruction: { parts: [{ text: "Be brief" }] },
    tools: [{ functionDeclarations: [{ name: "lookup" }] }],
    generationConfig: { maxOutputTokens: 128 },
  };
  assert.deepEqual(
    await client.countTokens(account, "gemini-test", request),
    { totalTokens: 17 },
  );
  assert.deepEqual(sent.request, {
    model: "models/gemini-test",
    contents: request.contents,
    systemInstruction: request.systemInstruction,
    tools: request.tools,
  });
});
await test("uncertain generations charge the reserved token ceiling", async () => {
  store.db.exec("DELETE FROM cooldowns");
  const u = await store.createUser(admin, {
    login: "cancelled",
    password: "test-password-12345",
  });
  for (const mode of ["uncertain", "empty"]) {
    const key = issueKey(u, `cancel-${mode}`, { tokenLimit: 138 });
    provider.generate = async () => {
      if (mode === "uncertain") {
        const e = new Fault(502, "transport lost");
        e.dispatched = true;
        throw e;
      }
      return new Response("");
    };
    const result = await request("/v1/messages", {
      method: "POST",
      body: payload,
      key: key.key,
    });
    assert.equal(result.status, 502, result.text);
    const usage = store.db
      .prepare(
        "SELECT u.*,d.api_key_id,d.tokens FROM usage u JOIN usage_details d ON d.usage_id=u.id WHERE d.api_key_id=?",
      )
      .get(key.id);
    assert.equal(usage.tokens, 138);
    assert.equal(usage.state, "usage_unknown");
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM token_reservations").get().n,
      0,
    );
    const again = await request("/v1/messages", {
      method: "POST",
      body: payload,
      key: key.key,
    });
    assert.equal(again.status, 429);
    store.db.exec("DELETE FROM cooldowns");
  }
  provider.generate = async () => sse();
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  store.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
