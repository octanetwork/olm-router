import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { proxyManager } from "../core/proxy.mjs";

const HOME = os.homedir();
const LOCAL_CVC_FILE = path.resolve(process.env.DATA_DIR || "./data", "cheapvibecode.json");
const CLAUDE_ANTIGRAVITY_CVC = path.join(HOME, ".config", "claude-antigravity", "cheapvibecode.json");

export function loadCheapVibeCodeConfig() {
  try {
    if (fs.existsSync(LOCAL_CVC_FILE)) {
      return JSON.parse(fs.readFileSync(LOCAL_CVC_FILE, "utf8"));
    }
  } catch (_) {}
  try {
    if (fs.existsSync(CLAUDE_ANTIGRAVITY_CVC)) {
      return JSON.parse(fs.readFileSync(CLAUDE_ANTIGRAVITY_CVC, "utf8"));
    }
  } catch (_) {}
  return {
    apiKey: process.env.CHEAPVIBECODE_API_KEY || "",
    baseUrl: process.env.CHEAPVIBECODE_BASE_URL || "https://ru.cheapvibecode.ru/v1"
  };
}

export async function handleCheapVibeCodeMessage(anthropicReq, modelInfo, res) {
  const cvcConf = loadCheapVibeCodeConfig();
  if (!cvcConf.apiKey) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "CheapVibeCode API Key not configured." }
    }));
    return;
  }

  const endpoint = `${cvcConf.baseUrl.replace(/\/$/, "")}/messages`;

  // Forward Anthropic format directly to CVC
  const response = await proxyManager.fetch(endpoint, {
    method: "POST",
    headers: {
      "x-api-key": cvcConf.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(anthropicReq)
  });

  const headers = {};
  for (const [k, v] of response.headers.entries()) {
    if (k.toLowerCase() !== "content-encoding") headers[k] = v;
  }
  headers["x-olm-provider"] = "cheapvibecode";

  res.writeHead(response.status, headers);
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}
