import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const KEYS_FILE = path.resolve(process.env.DATA_DIR || "./data", "keys.json");

export class AuthGuard {
  constructor(options = {}) {
    this.requireAuth = options.requireAuth ?? (process.env.REQUIRE_AUTH_FOR_API === "true");
    this.adminToken = process.env.ADMIN_TOKEN || options.adminToken || "olm-master-change-me-secret-token";
    this.keys = new Map();
    this.loadKeys();
  }

  loadKeys() {
    try {
      if (fs.existsSync(KEYS_FILE)) {
        const raw = fs.readFileSync(KEYS_FILE, "utf8");
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.keys = new Map(list.map(k => [k.key, k]));
        }
      }
    } catch (e) {
      console.warn("[AuthGuard] Error loading keys:", e.message);
    }
  }

  saveKeys() {
    try {
      const dir = path.dirname(KEYS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(KEYS_FILE, JSON.stringify(Array.from(this.keys.values()), null, 2), "utf8");
    } catch (e) {
      console.error("[AuthGuard] Error saving keys:", e.message);
    }
  }

  createKey({ name = "Default Key", tier = "standard", maxRpm = 120 } = {}) {
    const rawSecret = crypto.randomBytes(24).toString("hex");
    const key = `olm_live_${rawSecret}`;
    const record = {
      key,
      name,
      tier,
      maxRpm,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      enabled: true
    };
    this.keys.set(key, record);
    this.saveKeys();
    return record;
  }

  revokeKey(key) {
    const exists = this.keys.has(key);
    if (exists) {
      this.keys.delete(key);
      this.saveKeys();
      return true;
    }
    return false;
  }

  listKeys() {
    return Array.from(this.keys.values()).map(k => ({
      name: k.name,
      keyMasked: k.key.slice(0, 12) + "..." + k.key.slice(-4),
      key: k.key,
      tier: k.tier,
      maxRpm: k.maxRpm,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      enabled: k.enabled
    }));
  }

  extractKey(req) {
    // 1. Header x-api-key
    const headerKey = req.headers["x-api-key"];
    if (headerKey) return headerKey.trim();

    // 2. Authorization: Bearer <key>
    const authHeader = req.headers["authorization"] || "";
    if (authHeader.startsWith("Bearer ")) {
      return authHeader.slice(7).trim();
    }

    // 3. Query param ?key=
    try {
      const url = new URL(req.url, "http://localhost");
      const qKey = url.searchParams.get("api_key") || url.searchParams.get("key");
      if (qKey) return qKey.trim();
    } catch (_) {}

    return null;
  }

  verifyRequest(req, res, { isAdministrative = false } = {}) {
    const token = this.extractKey(req);

    // Administrative route check
    if (isAdministrative) {
      if (!token || token !== this.adminToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized: Invalid or missing administrative token." }));
        return { authorized: false };
      }
      return { authorized: true, isAdmin: true };
    }

    // Master admin token bypasses all checks
    if (token && token === this.adminToken) {
      return { authorized: true, isAdmin: true, key: "admin" };
    }

    // Public access permitted if requireAuth is false
    if (!this.requireAuth) {
      return { authorized: true, key: token || "public" };
    }

    // If auth required, token must match
    if (!token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        type: "error",
        error: {
          type: "authentication_error",
          message: "API key missing. Pass 'x-api-key' or 'Authorization: Bearer <key>'."
        }
      }));
      return { authorized: false };
    }

    const keyRecord = this.keys.get(token);
    if (!keyRecord || !keyRecord.enabled) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        type: "error",
        error: {
          type: "authentication_error",
          message: "Invalid or disabled API key."
        }
      }));
      return { authorized: false };
    }

    keyRecord.lastUsedAt = new Date().toISOString();
    return { authorized: true, keyRecord, key: token };
  }
}
