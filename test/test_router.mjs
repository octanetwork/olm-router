import assert from "node:assert";
import http from "node:http";
import { resolveModelAndTier, listSupportedModels } from "../src/providers/registry.mjs";
import { compactAnthropicMessages, estimateRequestTokens } from "../src/core/context.mjs";
import { Firewall } from "../src/security/firewall.mjs";
import { RateLimiter } from "../src/security/ratelimit.mjs";
import { AuthGuard } from "../src/security/auth-guard.mjs";
import { server } from "../src/server.mjs";

console.log("=== Running OLM Router Test Suite ===");

// 1. Test Model Resolution
{
  console.log("[1] Testing Model Resolution...");
  const antigravity = resolveModelAndTier("claude-3-8-flash", { thinking: { budget_tokens: 8000 } });
  assert.strictEqual(antigravity.provider, "antigravity");
  assert.strictEqual(antigravity.targetModel, "gemini-3.8-flash");
  assert.strictEqual(antigravity.tier, "medium");

  const qwen = resolveModelAndTier("claude-qn-coder");
  assert.strictEqual(qwen.provider, "qwen");
  assert.strictEqual(qwen.targetModel, "qwen2.5-coder-32b-instruct");

  const deepseek = resolveModelAndTier("claude-seek-r1");
  assert.strictEqual(deepseek.provider, "deepseek");
  assert.strictEqual(deepseek.targetModel, "deepseek-reasoner");

  const models = listSupportedModels();
  assert.ok(models.length >= 6);
  console.log("  ✓ Model resolution verified");
}

// 2. Test Context Compaction
{
  console.log("[2] Testing Context Compaction...");
  const largeMessages = [
    { role: "user", content: "Initial prompt that must be preserved." },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Working..." },
        { type: "tool_use", id: "t1", name: "read_file", input: {} }
      ]
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "X".repeat(50000) }
      ]
    },
    { role: "assistant", content: "Turn processed." },
    { role: "user", content: "Recent question?" }
  ];

  const compacted = compactAnthropicMessages(largeMessages, 5000);
  const toolResult = compacted[2].content[0].content;
  assert.ok(toolResult.includes("[... tool output truncated by router ...]"));
  assert.ok(toolResult.length < 5000);
  console.log("  ✓ Context compaction verified");
}

// 3. Test Firewall & LTE Whitelist
{
  console.log("[3] Testing Firewall & LTE Whitelist...");
  const fw = new Firewall({
    enabled: true,
    wapiProtection: {
      requireWhitelist: true,
      whitelistedIps: ["185.47.142.197", "10.0.0.0/8"],
      emergencyBypassHeader: "x-olm-lte-bypass"
    }
  });

  // Whitelisted IP passes
  assert.strictEqual(fw.isWapiWhitelisted("185.47.142.197", { headers: {} }), true);
  // CIDR match passes
  assert.strictEqual(fw.isWapiWhitelisted("10.5.2.1", { headers: {} }), true);
  // Unlisted external IP without bypass header fails
  assert.strictEqual(fw.isWapiWhitelisted("203.0.113.5", { headers: {} }), false);
  // Unlisted external IP WITH emergency bypass header passes
  assert.strictEqual(fw.isWapiWhitelisted("203.0.113.5", { headers: { "x-olm-lte-bypass": "octa-lte-emergency" } }), true);
  console.log("  ✓ Firewall & LTE whitelist verified");
}

// 4. Test Rate Limiter
{
  console.log("[4] Testing Rate Limiter...");
  const rl = new RateLimiter({ defaultMax: 3, windowMs: 1000, banThreshold: 2 });
  const key = "test-client-1";

  assert.strictEqual(rl.check(key).allowed, true);
  assert.strictEqual(rl.check(key).allowed, true);
  assert.strictEqual(rl.check(key).allowed, true);
  const over = rl.check(key);
  assert.strictEqual(over.allowed, false);
  assert.strictEqual(over.banned, false);
  console.log("  ✓ Rate limiter sliding window verified");
}

// 5. Test Auth Guard
{
  console.log("[5] Testing Auth Guard...");
  const guard = new AuthGuard({ requireAuth: true, adminToken: "test-admin" });
  const keyRecord = guard.createKey({ name: "Unit Test Key" });
  assert.ok(keyRecord.key.startsWith("olm_live_"));

  const reqAuthorized = { headers: { "x-api-key": keyRecord.key } };
  const resDummy = { writeHead() {}, end() {} };
  assert.strictEqual(guard.verifyRequest(reqAuthorized, resDummy).authorized, true);

  const reqAdmin = { headers: { authorization: "Bearer test-admin" } };
  assert.strictEqual(guard.verifyRequest(reqAdmin, resDummy, { isAdministrative: true }).authorized, true);

  guard.revokeKey(keyRecord.key);
  console.log("  ✓ Auth guard verified");
}

// 6. Test HTTP Endpoints on running server
{
  console.log("[6] Testing HTTP Server Endpoints...");
  if (!server.listening) {
    await new Promise(r => server.once("listening", r));
  }
  const port = server.address().port;

  function httpGet(path, headers = {}) {
    return new Promise((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path, headers }, res => {
        let body = "";
        res.on("data", c => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on("error", reject);
    });
  }

  const health = await httpGet("/health");
  assert.strictEqual(health.status, 200);
  assert.ok(health.body.includes("healthy"));

  const models = await httpGet("/v1/models");
  assert.strictEqual(models.status, 200);
  assert.ok(models.body.includes("claude-3-8-flash"));

  const panel = await httpGet("/panel", { Host: "olm.octx.space" });
  assert.strictEqual(panel.status, 200);
  assert.ok(panel.body.includes("OLM Router"));

  const wapiHealth = await httpGet("/health", { Host: "wapi-olm.octx.space" });
  assert.strictEqual(wapiHealth.status, 200);
  assert.ok(wapiHealth.body.includes('"gateway":"wapi"'));

  console.log("  ✓ HTTP endpoints & virtual host routing verified");
}

console.log("\n>>> ALL TESTS PASSED SUCCESSFULLY! <<<\n");
process.exit(0);
