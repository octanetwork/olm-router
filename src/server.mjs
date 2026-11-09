import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { proxyManager } from "./core/proxy.mjs";
import { accountManager } from "./core/accounts.mjs";
import { startOAuthFlow } from "./core/oauth.mjs";
import { Firewall } from "./security/firewall.mjs";
import { RateLimiter } from "./security/ratelimit.mjs";
import { AuthGuard } from "./security/auth-guard.mjs";
import { applyCors } from "./security/cors.mjs";
import { handleClaudeMessages, handleCountTokens, handleListModels, handleUsage, handleBootstrap } from "./api/claude.mjs";
import { handleOpenAIChatCompletions } from "./api/openai.mjs";
import { handleAdminStatus, handleAdminKeys } from "./api/admin.mjs";
import { serveFrontend } from "./frontend/serve.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load configurations
const configDir = path.resolve(__dirname, "../config");
let securityConfig = {};
try {
  securityConfig = JSON.parse(fs.readFileSync(path.join(configDir, "security.json"), "utf8")).security || {};
} catch (_) {}

let domainsConfig = {};
try {
  domainsConfig = JSON.parse(fs.readFileSync(path.join(configDir, "domains.json"), "utf8")).domains || {};
} catch (_) {}

const PORT = parseInt(process.env.PORT || "8045", 10);
const HOST = process.env.HOST || "0.0.0.0";

const PANEL_DOMAIN = process.env.PANEL_DOMAIN || "olm.octx.space";
const API_DOMAIN = process.env.API_DOMAIN || "api-olm.octx.space";
const WAPI_DOMAIN = process.env.WAPI_DOMAIN || "wapi-olm.octx.space";

// Initialize Security Modules
const firewall = new Firewall(securityConfig.firewall);
const rateLimiter = new RateLimiter(securityConfig.rateLimiting);
const authGuard = new AuthGuard(securityConfig);

const server = http.createServer(async (req, res) => {
  // 1. CORS Preflight & Headers
  if (applyCors(req, res, securityConfig.cors)) {
    return;
  }

  // 2. Identify Domain / Route Type
  const hostHeader = (req.headers["host"] || "").split(":")[0].toLowerCase();
  const gatewayHeader = req.headers["x-olm-gateway-type"];
  let gatewayType = "standard";

  if (hostHeader === WAPI_DOMAIN || gatewayHeader === "wapi") {
    gatewayType = "wapi"; // LTE reserve
  } else if (hostHeader === PANEL_DOMAIN) {
    gatewayType = "panel"; // Frontend
  } else if (hostHeader === API_DOMAIN) {
    gatewayType = "api"; // Primary API
  }

  // 3. Firewall Inspection
  const fwCheck = firewall.inspectRequest(req, res, gatewayType);
  if (!fwCheck.allowed) return;

  const clientIp = fwCheck.clientIp || firewall.getClientIp(req);

  // 4. Rate Limiting Check
  const rateLimitKey = authGuard.extractKey(req) || clientIp;
  const rlCheck = rateLimiter.check(rateLimitKey);
  if (!rlCheck.allowed) {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": String(rlCheck.retryAfter || 60)
    });
    res.end(JSON.stringify({ error: rlCheck.message }));
    return;
  }

  const url = new URL(req.url, `http://${req.headers["host"] || "localhost"}`);
  const pathname = url.pathname;

  // 5. Public / System Health & Info
  if (pathname === "/health" || pathname === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", timestamp: Date.now(), gateway: gatewayType }));
    return;
  }

  // 6. OAuth & Authorization Endpoints
  if (pathname === "/login" || pathname === "/auth/login") {
    return startOAuthFlow(res);
  }

  if (pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      issuer: `http://${req.headers["host"] || "localhost"}`,
      authorization_endpoint: `http://${req.headers["host"] || "localhost"}/login`,
      token_endpoint: `http://${req.headers["host"] || "localhost"}/oauth/token`,
      device_authorization_endpoint: `http://${req.headers["host"] || "localhost"}/oauth/device/code`,
      userinfo_endpoint: `http://${req.headers["host"] || "localhost"}/oauth/userinfo`,
      response_types_supported: ["code"],
      grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code", "authorization_code", "refresh_token"]
    }));
    return;
  }

  if (pathname === "/oauth/device/code" && req.method === "POST") {
    const deviceCode = "dev_" + Math.random().toString(36).slice(2);
    const userCode = "OLM-" + Math.random().toString(36).slice(2, 6).toUpperCase();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `http://${req.headers["host"] || "localhost"}/login`,
      expires_in: 600,
      interval: 5
    }));
    return;
  }

  if (pathname === "/oauth/token" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      access_token: "olm_session_" + Math.random().toString(36).slice(2),
      token_type: "Bearer",
      expires_in: 86400,
      scope: "read write"
    }));
    return;
  }

  if (pathname === "/oauth/userinfo" && req.method === "GET") {
    const { account } = accountManager.loadAccounts();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      sub: "olm-user-1",
      email: account?.email || "user@octanet.online",
      name: account?.email ? account.email.split("@")[0] : "OLM User"
    }));
    return;
  }

  // 7. Administrative API Routes
  if (pathname === "/api/admin/status") {
    return handleAdminStatus(req, res, { authGuard, firewall, rateLimiter });
  }

  if (pathname.startsWith("/api/admin/keys")) {
    return handleAdminKeys(req, res, { authGuard });
  }

  // 8. Claude API Endpoints (Auth Guarded if required)
  if (pathname === "/v1/messages" && req.method === "POST") {
    const authCheck = authGuard.verifyRequest(req, res);
    if (!authCheck.authorized) return;
    return await handleClaudeMessages(req, res, { gatewayType });
  }

  if (pathname === "/v1/chat/completions" && req.method === "POST") {
    const authCheck = authGuard.verifyRequest(req, res);
    if (!authCheck.authorized) return;
    return await handleOpenAIChatCompletions(req, res, { gatewayType });
  }

  if (pathname === "/v1/messages/count_tokens" && req.method === "POST") {
    return handleCountTokens(req, res);
  }

  if (pathname === "/v1/models" && req.method === "GET") {
    return handleListModels(req, res);
  }

  if ((pathname === "/api/oauth/usage" || pathname === "/v1/usage") && req.method === "GET") {
    return await handleUsage(req, res);
  }

  if (pathname === "/api/claude_cli/bootstrap" && req.method === "GET") {
    return handleBootstrap(req, res);
  }

  // 9. If host is olm.octx.space or request is for web panel / root
  if (gatewayType === "panel" || pathname === "/" || pathname === "/panel" || pathname.startsWith("/styles.css") || pathname.startsWith("/app.js") || pathname.startsWith("/favicon.svg")) {
    return serveFrontend(req, res);
  }

  // 10. Fallback: serve frontend for GET requests on root, else 404
  if (req.method === "GET") {
    return serveFrontend(req, res);
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Endpoint not found on OLM Router", path: pathname }));
});

server.listen(PORT, HOST, () => {
  console.log(`
============================================================
           OLM ROUTER — OCTA NETWORK GATEWAY
============================================================
  Listening: http://${HOST}:${PORT}
  Domains:
    - Frontend Panel: https://${PANEL_DOMAIN}
    - Primary API:     https://${API_DOMAIN}
    - LTE Reserve:     https://${WAPI_DOMAIN}
  Upstream Proxy:     ${proxyManager.primaryProxy}
  Google OAuth:       Antigravity (${process.env.ANTIGRAVITY_CLIENT_ID ? 'Custom' : 'Default'})
  Protection:         Firewall (Active) | RateLimit (Active)
============================================================
  `);
});

export { server };
