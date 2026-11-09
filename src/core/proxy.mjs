import { ProxyAgent, setGlobalDispatcher } from "undici";

// Proxy pool management for bypassing regional restrictions
export class ProxyManager {
  constructor(options = {}) {
    this.primaryProxy = options.primaryProxy || process.env.UPSTREAM_PROXY || "http://127.0.0.1:10859";
    this.backupProxy = options.backupProxy || process.env.BACKUP_PROXY || "http://127.0.0.1:10809";

    const candidateUrls = [this.primaryProxy, this.backupProxy].filter(Boolean);
    const uniqueUrls = [...new Set(candidateUrls)];

    this.routes = uniqueUrls.map(url => {
      let dispatcher = null;
      try {
        dispatcher = new ProxyAgent(url);
      } catch (err) {
        console.warn(`[ProxyManager] Failed to create ProxyAgent for ${url}:`, err.message);
      }
      return {
        url,
        dispatcher,
        unavailableUntil: 0,
        failures: 0,
        successes: 0
      };
    });

    if (this.routes.length > 0 && this.routes[0].dispatcher) {
      setGlobalDispatcher(this.routes[0].dispatcher);
    }
  }

  getRouteStatus() {
    const now = Date.now();
    return this.routes.map(r => ({
      url: r.url,
      available: r.unavailableUntil <= now,
      failures: r.failures,
      successes: r.successes,
      cooldownRemainingSec: Math.max(0, Math.ceil((r.unavailableUntil - now) / 1000))
    }));
  }

  async fetch(url, options = {}, { signal, headerTimeout = 60_000 } = {}) {
    const now = Date.now();
    // Sort routes: available ones first
    const sortedRoutes = [...this.routes].sort((a, b) =>
      Number(a.unavailableUntil > now) - Number(b.unavailableUntil > now)
    );

    let lastError;
    // Try routes with fallback
    for (const route of sortedRoutes) {
      signal?.throwIfAborted();
      const headersController = new AbortController();
      const timer = setTimeout(
        () => headersController.abort(new Error("Provider response headers timed out")),
        headerTimeout
      );

      try {
        const fetchOptions = {
          ...options,
          signal: signal ? AbortSignal.any([signal, headersController.signal]) : headersController.signal
        };

        if (route.dispatcher) {
          fetchOptions.dispatcher = route.dispatcher;
        }

        const response = await fetch(url, fetchOptions);
        route.unavailableUntil = 0;
        route.successes++;
        return response;
      } catch (error) {
        signal?.throwIfAborted();
        lastError = error;
        route.failures++;

        // If client aborted or slow worker headers timed out
        if (headersController.signal.aborted) {
          throw error;
        }

        // Mark route unavailable for 60 seconds
        route.unavailableUntil = Date.now() + 60_000;
        try {
          const parsed = new URL(url);
          console.warn(`[ProxyManager] ${parsed.host} via ${route.url} failed: ${error.cause?.code || error.name}`);
        } catch (_) {}
      } finally {
        clearTimeout(timer);
      }
    }

    // Direct fallback if all proxies failed
    try {
      console.warn(`[ProxyManager] All proxies failed, attempting direct fetch for ${url}`);
      return await fetch(url, { ...options, signal });
    } catch (directErr) {
      throw lastError || directErr;
    }
  }
}

export const proxyManager = new ProxyManager();
