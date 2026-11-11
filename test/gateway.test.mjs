import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, Fault, digest } from "../src/core/store.mjs";
import { Antigravity, events, geminiSchema } from "../src/core/provider.mjs";
import { createApplication } from "../src/server.mjs";
import { fromOpenAI, priceCost } from "../src/api/gateway.mjs";
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
  generate: async () => sse(),
  discover: async () => [],
  start: () => ({ url: "https://accounts.google.com" }),
};
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
      await request("/api/admin/users/" + user.id + "/credits", {
        method: "POST",
        sessionCookie: mc,
        csrfToken: m.csrf,
        body: { amount: 100, reason: "test" },
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
    403,
  );
});
await test("api keys stored hashed and revocable, private usage free", async () => {
  const k = store.createKey(store.user(user.id), "test");
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
    .prepare("SELECT * FROM usage WHERE user_id=?")
    .get(user.id);
  assert.equal(u.credits, 0);
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
await test("atomic credits, reservation and exactly-once settlement", async () => {
  store.transfer(admin, user.id, 1000, "allocation");
  assert.equal(store.user(user.id).balance, 1000);
  assert.throws(() => store.reserve(user.id, 1001, "too-much"), {
    status: 402,
  });
  store.reserve(user.id, 800, "reserve");
  assert.throws(() => store.reserve(user.id, 800, "other"), { status: 402 });
  store.settle("reserve", 20);
  assert.equal(store.user(user.id).balance, 980);
  store.settle("reserve", 20);
  assert.equal(store.user(user.id).balance, 980);
  const managed = await store.createUser(store.user(manager.id), {
    login: "managed",
    password: "test-password-12345",
  });
  assert.throws(
    () => store.transfer(store.user(manager.id), managed.id, 1, "allocation"),
    { status: 402 },
  );
  store.transfer(admin, manager.id, 100, "budget");
  store.transfer(store.user(manager.id), managed.id, 10, "allocation");
  assert.equal(store.user(manager.id).balance, 90);
  assert.equal(store.user(managed.id).balance, 10);
  assert.equal(priceCost({ input: 1000000, output: 2000000 }, 10, 4), 18);
});
await test("shared billing requires price and balance, tracks exact usage", async () => {
  const pool = store.saveAccount(admin.id, {
    email: "pool@gmail.com",
    refreshToken: "pool-secret",
    projectId: "project",
  });
  store.db
    .prepare("UPDATE accounts SET shared=1,quota=? WHERE id=?")
    .run(JSON.stringify([{ id: "gemini-test", remaining: 1 }]), pool.id);
  const key = store.createKey(store.user(other.id), "shared");
  assert.equal(
    (
      await request("/v1/messages", {
        method: "POST",
        body: payload,
        key: key.key,
      })
    ).status,
    409,
  );
  store.db
    .prepare("INSERT INTO prices VALUES(?,?)")
    .run("gemini-test", JSON.stringify({ input: 1000000, output: 2000000 }));
  assert.equal(
    (
      await request("/v1/messages", {
        method: "POST",
        body: payload,
        key: key.key,
      })
    ).status,
    402,
  );
  store.transfer(admin, other.id, 1000000, "allocation");
  const r = await request("/v1/messages", {
    method: "POST",
    body: payload,
    key: key.key,
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(store.user(other.id).balance, 999982);
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM reservations").get().n,
    0,
  );
  provider.generate = async () => sse([{ text: "unknown usage" }], undefined); // undefined uses default, use explicit null below
  provider.generate = async () => sse([{ text: "unknown usage" }], null);
  const unknown = await request("/v1/messages", {
    method: "POST",
    body: payload,
    key: key.key,
  });
  assert.equal(unknown.status, 200, unknown.text);
  assert.equal(JSON.parse(unknown.text).usage.input_tokens, null);
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM reservations").get().n,
    1,
  );
  assert.equal(
    (
      await request("/v1/messages", {
        method: "POST",
        body: payload,
        key: key.key,
      })
    ).status,
    409,
  );
  provider.generate = async () => sse();
  const pending = store.db.prepare("SELECT * FROM reservations").get();
  store.settle(pending.id, 0);
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
await test("invalid JSON, settings and unknown protocol fail safely", async () => {
  const k = store.createKey(store.user(user.id), "invalid");
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
        body: payload,
        key: k.key,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request("/api/settings", {
        method: "PATCH",
        body: {
          mode: "stop",
          sharedFallback: false,
          accountId: "someone-elses",
        },
      })
    ).status,
    403,
  );
});
await test("Deadswitch and failover keep account and model boundaries", async () => {
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
  const key = store.createKey(store.user(user.id), "failover");
  store.db.prepare("UPDATE users SET settings=? WHERE id=?").run(
    JSON.stringify({
      mode: "stop",
      accountId: first.id,
      sharedFallback: false,
    }),
    user.id,
  );
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
  store.db.exec("DELETE FROM cooldowns");
  attempts = [];
  store.db.prepare("UPDATE users SET settings=? WHERE id=?").run(
    JSON.stringify({
      mode: "auto",
      accountId: first.id,
      sharedFallback: false,
    }),
    user.id,
  );
  const switched = await request("/v1/messages", {
    method: "POST",
    body: payload,
    key: key.key,
  });
  assert.equal(switched.status, 200, switched.text);
  assert.deepEqual(attempts, [first.id, second.id]);
  assert.equal(
    store.db
      .prepare("SELECT model FROM cooldowns WHERE account_id=?")
      .get(first.id).model,
    "gemini-test",
  );
  provider.generate = async () => sse();
  store.db.exec("DELETE FROM cooldowns");
});
await test("concurrent paid requests cannot overspend the same balance", async () => {
  const u = await store.createUser(admin, {
    login: "concurrent",
    password: "test-password-12345",
  });
  store.transfer(admin, u.id, 6000, "allocation");
  const key = store.createKey(store.user(u.id), "parallel");
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
  assert.equal(second.status, 402, second.text);
  release();
  const done = await first;
  assert.equal(done.status, 200, done.text);
  assert.equal(store.user(u.id).balance, 5982);
  provider.generate = async () => sse();
});
await test("native Gemini SSE and OpenAI tool chunks preserve their protocol", async () => {
  const key = store.createKey(store.user(user.id), "protocols");
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
    "projectId",
    "refreshToken",
  ]);
  if (oldId === undefined) delete process.env.ANTIGRAVITY_CLIENT_ID;
  else process.env.ANTIGRAVITY_CLIENT_ID = oldId;
  if (oldSecret === undefined) delete process.env.ANTIGRAVITY_CLIENT_SECRET;
  else process.env.ANTIGRAVITY_CLIENT_SECRET = oldSecret;
});
await test("native SDK key header and exact token count endpoint", async () => {
  const key = store.createKey(store.user(user.id), "native sdk");
  let called = false;
  provider.countTokens = async (a, m, contents) => {
    called = true;
    assert.equal(m, "gemini-test");
    assert.equal(contents[0].parts[0].text, "Hi");
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
      }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { totalTokens: 7 });
  assert.equal(called, true);
  const models = await fetch(base + "/v1beta/models", {
    headers: { "x-goog-api-key": key.key },
  });
  assert.equal(models.status, 200);
  assert.ok(
    (await models.json()).models.some((m) => m.name === "models/gemini-test"),
  );
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  store.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
