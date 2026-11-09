// Administrative & Operational Endpoints for OLM Router
import { accountManager } from "../core/accounts.mjs";
import { proxyManager } from "../core/proxy.mjs";
import { listSupportedModels } from "../providers/registry.mjs";

export function handleAdminStatus(req, res, { authGuard, firewall, rateLimiter }) {
  const { account, accounts } = accountManager.loadAccounts();
  const proxies = proxyManager.getRouteStatus();
  const models = listSupportedModels();

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    version: "1.0.0",
    domains: {
      panel: "olm.octx.space",
      api: "api-olm.octx.space",
      wapi: "wapi-olm.octx.space"
    },
    googleAccount: account ? {
      email: account.email,
      projectId: account.projectId,
      hasRefreshToken: !!account.refreshToken,
      updatedAt: account.updatedAt
    } : null,
    totalAccounts: accounts.length,
    proxies,
    totalModels: models.length,
    security: {
      authRequired: authGuard.requireAuth,
      firewallEnabled: firewall.enabled,
      rateLimiterEnabled: rateLimiter.enabled,
      wapiWhitelistConfig: firewall.wapiConfig
    }
  }));
}

export function handleAdminKeys(req, res, { authGuard }) {
  if (req.method === "GET") {
    const keys = authGuard.listKeys();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ keys }));
    return;
  }

  if (req.method === "POST") {
    let bodyText = "";
    req.on("data", c => { bodyText += c; });
    req.on("end", () => {
      try {
        const body = JSON.parse(bodyText || "{}");
        const created = authGuard.createKey({
          name: body.name || "API Key",
          tier: body.tier || "standard",
          maxRpm: body.maxRpm || 120
        });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ key: created }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === "DELETE") {
    const url = new URL(req.url, "http://localhost");
    const key = url.searchParams.get("key");
    if (!key) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing key param" }));
      return;
    }
    const revoked = authGuard.revokeKey(key);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ revoked }));
  }
}
