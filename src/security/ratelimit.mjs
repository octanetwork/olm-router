// Sliding window rate limiter with temporary ban support

export class RateLimiter {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.windowMs = options.windowMs || 60_000; // 1 minute
    this.defaultMax = options.defaultMax || 120; // 120 requests/minute
    this.burstMax = options.burstMax || 30; // 30 req in burst
    this.banThreshold = options.banThreshold || 20; // 20 violations trigger temp ban
    this.banDurationMs = options.banDurationMs || 300_000; // 5 min ban

    this.clients = new Map();
    this.bans = new Map();

    // Cleanup stale entries every 5 minutes
    setInterval(() => this.cleanup(), 300_000).unref();
  }

  isBanned(clientKey) {
    const banUntil = this.bans.get(clientKey);
    if (!banUntil) return false;
    if (Date.now() > banUntil) {
      this.bans.delete(clientKey);
      return false;
    }
    return true;
  }

  check(clientKey, customMax = null) {
    if (!this.enabled) return { allowed: true, remaining: 999 };

    const now = Date.now();
    if (this.isBanned(clientKey)) {
      const remainingSec = Math.ceil((this.bans.get(clientKey) - now) / 1000);
      return {
        allowed: false,
        banned: true,
        retryAfter: remainingSec,
        message: `Too many requests. Temporarily banned for ${remainingSec}s.`
      };
    }

    let record = this.clients.get(clientKey);
    if (!record) {
      record = {
        timestamps: [],
        violations: 0
      };
      this.clients.set(clientKey, record);
    }

    // Filter out timestamps outside the sliding window
    const windowStart = now - this.windowMs;
    record.timestamps = record.timestamps.filter(ts => ts > windowStart);

    const maxAllowed = customMax || this.defaultMax;
    if (record.timestamps.length >= maxAllowed) {
      record.violations++;
      if (record.violations >= this.banThreshold) {
        this.bans.set(clientKey, now + this.banDurationMs);
        this.clients.delete(clientKey);
        return {
          allowed: false,
          banned: true,
          retryAfter: Math.ceil(this.banDurationMs / 1000),
          message: `Excessive rate limit violations. Temporarily banned.`
        };
      }

      const oldestInWindow = record.timestamps[0];
      const retryAfter = Math.ceil((oldestInWindow + this.windowMs - now) / 1000);
      return {
        allowed: false,
        banned: false,
        retryAfter: Math.max(1, retryAfter),
        message: `Rate limit exceeded. Retry after ${retryAfter}s.`
      };
    }

    record.timestamps.push(now);
    return {
      allowed: true,
      remaining: maxAllowed - record.timestamps.length,
      resetInSec: Math.ceil(this.windowMs / 1000)
    };
  }

  cleanup() {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    for (const [key, record] of this.clients.entries()) {
      record.timestamps = record.timestamps.filter(ts => ts > windowStart);
      if (record.timestamps.length === 0 && record.violations === 0) {
        this.clients.delete(key);
      }
    }
    for (const [key, banUntil] of this.bans.entries()) {
      if (now > banUntil) {
        this.bans.delete(key);
      }
    }
  }
}
