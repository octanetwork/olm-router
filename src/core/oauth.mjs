import crypto from "node:crypto";
import http from "node:http";
import { exec } from "node:child_process";
import { proxyManager } from "./proxy.mjs";
import { accountManager } from "./accounts.mjs";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveClientCredentials() {
  if (process.env.ANTIGRAVITY_CLIENT_ID && process.env.ANTIGRAVITY_CLIENT_SECRET) {
    return {
      clientId: process.env.ANTIGRAVITY_CLIENT_ID,
      clientSecret: process.env.ANTIGRAVITY_CLIENT_SECRET
    };
  }
  try {
    const sPath = path.join(os.homedir(), ".config", "claude-antigravity", "server.mjs");
    if (fs.existsSync(sPath)) {
      const code = fs.readFileSync(sPath, "utf8");
      const mId = code.match(/ANTIGRAVITY_CLIENT_ID\s*=\s*["'`]([^"'`]+)/);
      const mSec = code.match(/ANTIGRAVITY_CLIENT_SECRET\s*=\s*["'`]([^"'`]+)/);
      if (mId && mSec) {
        return { clientId: mId[1], clientSecret: mSec[1] };
      }
    }
  } catch (_) {}

  const decodeXor = (hex, key) => {
    const buf = Buffer.from(hex, "hex");
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key.charCodeAt(i % key.length);
    return out.toString("utf8");
  };

  const KEY = "olm-router-octa";
  const ID_HEX = "5e5c5a1c425f43445342185652591502041e5e1b01471c5743410c1111535c591b591d031a1e0d464a5b5347041f420c5d021c5b130a1d4a030601120a1e0e421c1b101a115c4e000e";
  const SEC_HEX = "28232e7e2237583f504a6b3831405959200961385e1838274a5e3720401b591d296c14";

  return {
    clientId: decodeXor(ID_HEX, KEY),
    clientSecret: decodeXor(SEC_HEX, KEY)
  };
}

const { clientId: RESOLVED_CLIENT_ID, clientSecret: RESOLVED_CLIENT_SECRET } = resolveClientCredentials();

export const ANTIGRAVITY_CLIENT_ID = RESOLVED_CLIENT_ID;
export const ANTIGRAVITY_CLIENT_SECRET = RESOLVED_CLIENT_SECRET;
export const OAUTH_PORT = parseInt(process.env.OAUTH_PORT || "51121", 10);
export const ANTIGRAVITY_REDIRECT_URI = `http://localhost:${OAUTH_PORT}/oauth-callback`;

export const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

export const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const USER_AGENT = "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)";

let cachedAccessToken = null;
let tokenExpiresAt = 0;
let activeOAuthListener = null;

export async function getValidAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && tokenExpiresAt > now + 60000) {
    return cachedAccessToken;
  }

  const { account } = accountManager.loadAccounts();
  if (!account || !account.refreshToken) {
    throw new Error("No Google Antigravity account found. Please sign in via web panel or /login");
  }

  const tokenRes = await proxyManager.fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: account.refreshToken,
    })
  });

  if (!tokenRes.ok) {
    const errorText = await tokenRes.text();
    cachedAccessToken = null;
    throw new Error(`Google token refresh failed: ${errorText}`);
  }

  const tokenData = await tokenRes.json();
  cachedAccessToken = tokenData.access_token;
  tokenExpiresAt = Date.now() + ((tokenData.expires_in || 3600) * 1000);
  return cachedAccessToken;
}

export async function fetchProjectID(accessToken) {
  try {
    const res = await proxyManager.fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
    });

    if (res.ok) {
      const data = await res.json();
      if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject) {
        return data.cloudaicompanionProject;
      }
      if (data.cloudaicompanionProject?.id) {
        return data.cloudaicompanionProject.id;
      }
    }
  } catch (err) {
    console.warn("[ProjectID] loadCodeAssist error:", err.message);
  }
  return "aicode-consumers";
}

export async function fetchGoogleQuota(accessToken, projectId) {
  try {
    const res = await proxyManager.fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ project: projectId }),
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn("[GoogleQuota] fetchAvailableModels failed:", err.message);
  }
  return null;
}

export function calculateUsageWindows(quotaData) {
  if (!quotaData || !quotaData.models) return null;
  // Look for quota entries on gemini models
  for (const m of Object.values(quotaData.models)) {
    if (m.quotaInfo) {
      const resetTime = m.quotaInfo.resetTime ? Math.floor(new Date(m.quotaInfo.resetTime).getTime() / 1000) : Math.floor(Date.now() / 1000) + 18000;
      const fraction = typeof m.quotaInfo.remainingFraction === "number" ? (1 - m.quotaInfo.remainingFraction) : 0.05;
      return {
        utilization: Math.max(0, Math.min(1, fraction)),
        resets_at: resetTime
      };
    }
  }
  return { utilization: 0.05, resets_at: Math.floor(Date.now() / 1000) + 18000 };
}

// Clean JSON Schema for Antigravity function declarations
export function cleanSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "STRING" };
  }

  const cleaned = {};
  if (schema.type) {
    cleaned.type = String(schema.type).toUpperCase();
  } else {
    cleaned.type = "OBJECT";
  }

  if (schema.description) {
    cleaned.description = String(schema.description);
  }

  if (schema.enum && Array.isArray(schema.enum)) {
    cleaned.enum = schema.enum.map(String);
  }

  if (schema.properties && typeof schema.properties === "object") {
    cleaned.properties = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      cleaned.properties[key] = cleanSchema(val);
    }
  }

  if (schema.items) {
    cleaned.items = cleanSchema(schema.items);
  }

  if (schema.required && Array.isArray(schema.required)) {
    cleaned.required = schema.required.map(String);
  }

  return cleaned;
}

export function generateAuthUrl() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = Buffer.from(JSON.stringify({ verifier })).toString("base64url");

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
  authUrl.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  return { url: authUrl.toString(), verifier, state };
}

export function startOAuthFlow(res) {
  if (activeOAuthListener) {
    try { activeOAuthListener.close(); } catch (_) {}
  }

  const { url: authUrl, verifier } = generateAuthUrl();

  const oauthServer = http.createServer(async (req, callbackRes) => {
    try {
      const u = new URL(req.url, `http://localhost:${OAUTH_PORT}`);
      if (u.pathname !== "/oauth-callback") {
        callbackRes.writeHead(404, { "Content-Type": "text/plain" });
        callbackRes.end("Not found");
        return;
      }

      const code = u.searchParams.get("code");
      if (!code) {
        callbackRes.writeHead(400, { "Content-Type": "text/plain" });
        callbackRes.end("Missing OAuth code");
        return;
      }

      // Exchange code for tokens
      const tokenRes = await proxyManager.fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: ANTIGRAVITY_CLIENT_ID,
          client_secret: ANTIGRAVITY_CLIENT_SECRET,
          code,
          grant_type: "authorization_code",
          redirect_uri: ANTIGRAVITY_REDIRECT_URI,
          code_verifier: verifier,
        })
      });

      if (!tokenRes.ok) {
        const errorText = await tokenRes.text();
        callbackRes.writeHead(500, { "Content-Type": "text/plain" });
        callbackRes.end(`Token exchange failed: ${errorText}`);
        return;
      }

      const tokenPayload = await tokenRes.json();
      const accessToken = tokenPayload.access_token;
      const refreshToken = tokenPayload.refresh_token;

      // Get user profile
      const userRes = await proxyManager.fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const userData = userRes.ok ? await userRes.json() : {};
      const email = userData.email || "antigravity-user@gmail.com";

      const projectId = await fetchProjectID(accessToken);

      accountManager.saveAccount({
        id: `account-${Date.now()}`,
        email,
        refreshToken,
        projectId,
        enabled: true,
        updatedAt: new Date().toISOString()
      });

      cachedAccessToken = accessToken;
      tokenExpiresAt = Date.now() + ((tokenPayload.expires_in || 3600) * 1000);

      callbackRes.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      callbackRes.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>OLM Router — Connected</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #07090e; color: #c9d1d9; }
    .card { background: #0f141c; border: 1px solid #1f2937; border-radius: 12px; padding: 2.5rem; max-width: 440px; text-align: center; box-shadow: 0 12px 32px rgba(0,0,0,0.6); }
    h1 { color: #38bdf8; font-size: 1.5rem; margin-top: 0; }
    p { font-size: 0.95rem; line-height: 1.5; color: #94a3b8; }
    .email { font-weight: 600; color: #f8fafc; }
    .btn { display: inline-block; margin-top: 1.5rem; padding: 0.75rem 1.5rem; background: #0284c7; color: white; border-radius: 6px; text-decoration: none; font-weight: 600; cursor: pointer; border: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>All set!</h1>
    <p>Signed in as <span class="email">${email}</span>.</p>
    <p>Project ID: <span class="email">${projectId}</span></p>
    <p>Google Antigravity is active for OLM Router.</p>
    <button class="btn" onclick="window.close()">Close window</button>
  </div>
</body>
</html>`);

      setTimeout(() => {
        try { oauthServer.close(); } catch (_) {}
      }, 3000);
    } catch (err) {
      console.error("[OAuth] Error:", err);
      callbackRes.writeHead(500, { "Content-Type": "text/plain" });
      callbackRes.end(`OAuth Error: ${err.message}`);
    }
  });

  oauthServer.listen(OAUTH_PORT, "localhost", () => {
    activeOAuthListener = oauthServer;
    console.log(`[OAuth] Temporary callback listener active on port ${OAUTH_PORT}`);
    if (res) {
      res.writeHead(302, { Location: authUrl });
      res.end();
    }
    // Attempt to open in macOS browser
    if (process.platform === "darwin") {
      exec(`open "${authUrl}"`, () => {});
    }
  });
}
