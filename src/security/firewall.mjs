// Firewall and LTE Whitelist Protection for OLM Router

export class Firewall {
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.blockedIps = new Set(config.blockedIps || []);
    this.blockedUserAgents = (config.blockedUserAgents || []).map(u => u.toLowerCase());
    this.maxPayloadBytes = config.maxPayloadBytes || 20 * 1024 * 1024; // 20 MB

    // WAPI specific configuration (LTE emergency route)
    this.wapiConfig = config.wapiProtection || {
      requireWhitelist: false,
      whitelistedIps: ["*"],
      allowPrivateRanges: true
    };
  }

  getClientIp(req) {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      return forwarded.split(",")[0].trim();
    }
    return req.headers["x-real-ip"] || req.socket?.remoteAddress || "127.0.0.1";
  }

  isIpInCidr(ip, cidr) {
    if (cidr === "*" || cidr === ip) return true;
    if (!cidr.includes("/")) return ip === cidr;

    try {
      const [range, bits = 32] = cidr.split("/");
      const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1);
      const ipToLong = ipStr => ipStr.split(".").reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
      return (ipToLong(ip) & mask) === (ipToLong(range) & mask);
    } catch (_) {
      return false;
    }
  }

  isPrivateIp(ip) {
    return (
      ip === "127.0.0.1" ||
      ip === "::1" ||
      ip.startsWith("10.") ||
      ip.startsWith("192.168.") ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)
    );
  }

  isWapiWhitelisted(clientIp, req) {
    if (!this.wapiConfig.requireWhitelist) return true;
    if (this.wapiConfig.allowPrivateRanges && this.isPrivateIp(clientIp)) return true;

    // Check emergency bypass header
    const bypassHeader = this.wapiConfig.emergencyBypassHeader || "x-olm-lte-bypass";
    if (req.headers[bypassHeader] === "octa-lte-emergency") {
      return true;
    }

    const list = this.wapiConfig.whitelistedIps || ["*"];
    if (list.includes("*")) return true;

    return list.some(cidr => this.isIpInCidr(clientIp, cidr));
  }

  inspectRequest(req, res, gatewayType = "standard") {
    if (!this.enabled) return { allowed: true };

    const clientIp = this.getClientIp(req);

    // 1. Check IP Blacklist
    if (this.blockedIps.has(clientIp)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Access denied by OLM Firewall: IP blocked." }));
      return { allowed: false, reason: "ip_blocked" };
    }

    // 2. Check User-Agent
    const ua = (req.headers["user-agent"] || "").toLowerCase();
    for (const badUa of this.blockedUserAgents) {
      if (ua.includes(badUa)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Access denied by OLM Firewall: Invalid client User-Agent." }));
        return { allowed: false, reason: "bad_user_agent" };
      }
    }

    // 3. Special check for WAPI route (LTE reserve)
    if (gatewayType === "wapi") {
      if (!this.isWapiWhitelisted(clientIp, req)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "Access denied: wapi-olm.octx.space requires an active IP whitelist or valid LTE token."
        }));
        return { allowed: false, reason: "wapi_not_whitelisted" };
      }
    }

    return { allowed: true, clientIp };
  }

  addBlockedIp(ip) {
    this.blockedIps.add(ip);
  }

  removeBlockedIp(ip) {
    this.blockedIps.delete(ip);
  }

  setWapiWhitelist(ipsArray) {
    this.wapiConfig.whitelistedIps = ipsArray;
  }
}
