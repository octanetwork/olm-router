// CORS and Security Headers Middleware for OLM Router

export function applyCors(req, res, config = {}) {
  const origin = req.headers["origin"] || "*";
  const allowedHeaders = [
    "Content-Type",
    "Authorization",
    "x-api-key",
    "x-requested-with",
    "x-anthropic-version",
    "anthropic-version",
    "x-olm-client",
    "x-olm-lte-bypass"
  ].join(", ");

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD, DELETE");
  res.setHeader("Access-Control-Allow-Headers", allowedHeaders);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Max-Age", "86400");

  // Modern Security Headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}
