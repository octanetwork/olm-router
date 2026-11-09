import crypto from "node:crypto";
import { resolveModelAndTier, listSupportedModels } from "../providers/registry.mjs";
import { estimateRequestTokens, estimateFixedTokens, compactAnthropicMessages } from "../core/context.mjs";
import { handleAntigravityMessage } from "../providers/antigravity.mjs";
import { handleQwenMessage } from "../providers/qwen.mjs";
import { handleDeepSeekMessage } from "../providers/deepseek.mjs";
import { handleCheapVibeCodeMessage } from "../providers/cheapvibecode.mjs";
import { handleNvidiaNimMessage } from "../providers/nvidia.mjs";
import { getValidAccessToken, fetchGoogleQuota, calculateUsageWindows } from "../core/oauth.mjs";
import { accountManager } from "../core/accounts.mjs";

const GOOGLE_INPUT_BUDGET = 98000;
const NVIDIA_INPUT_BUDGET = 64000;

export async function handleClaudeMessages(req, res, { gatewayType = "standard" } = {}) {
  let bodyText = "";
  req.on("data", chunk => { bodyText += chunk; });
  req.on("end", async () => {
    try {
      if (!bodyText.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Empty request body" }));
        return;
      }

      const anthropicReq = JSON.parse(bodyText);
      const requestedModel = anthropicReq.model || "claude-3-8-flash";
      const modelInfo = resolveModelAndTier(requestedModel, anthropicReq);

      // Context Budgeting & Compaction
      const inputTokens = estimateRequestTokens(anthropicReq);
      const fixedTokens = estimateFixedTokens(anthropicReq);
      const inputBudget = modelInfo.isNvidiaNim ? NVIDIA_INPUT_BUDGET : GOOGLE_INPUT_BUDGET;
      const originalMessages = anthropicReq.messages;
      const historyBudget = inputBudget - fixedTokens;

      anthropicReq.messages = compactAnthropicMessages(originalMessages, historyBudget);
      if (estimateRequestTokens(anthropicReq) > inputBudget) {
        anthropicReq.messages = compactAnthropicMessages(originalMessages, historyBudget, true);
        if (estimateRequestTokens(anthropicReq) > inputBudget) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Prompt is too long: current request exceeds gateway context budget."
            }
          }));
          return;
        }
      }

      const sentTokens = estimateRequestTokens(anthropicReq);
      if (sentTokens < inputTokens * 0.9) {
        console.log(`[OLM Router] ${requestedModel} context compacted: ~${inputTokens} to ~${sentTokens} tokens`);
      }

      // Add Gateway Type Headers
      res.setHeader("x-olm-gateway", gatewayType);

      // Provider Dispatcher
      if (modelInfo.isNvidiaNim) {
        return await handleNvidiaNimMessage(anthropicReq, modelInfo, res, inputTokens);
      }
      if (modelInfo.isCheapVibeCode) {
        return await handleCheapVibeCodeMessage(anthropicReq, modelInfo, res);
      }
      if (modelInfo.isQwen) {
        return await handleQwenMessage(anthropicReq, res);
      }
      if (modelInfo.isDeepSeek) {
        return await handleDeepSeekMessage(anthropicReq, res);
      }

      // Default: Google Antigravity
      return await handleAntigravityMessage(anthropicReq, modelInfo, res, { inputTokens });
    } catch (err) {
      console.error("[OLM Router] handleClaudeMessages error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: `OLM Router internal error: ${err.message}`
          }
        }));
      }
    }
  });
}

export function handleCountTokens(req, res) {
  let bodyText = "";
  req.on("data", chunk => { bodyText += chunk; });
  req.on("end", () => {
    try {
      const data = JSON.parse(bodyText || "{}");
      const estimated = estimateRequestTokens(data);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ input_tokens: estimated }));
    } catch (_) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 100 }));
    }
  });
}

export function handleListModels(req, res) {
  const models = listSupportedModels();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    data: models.map(m => ({
      id: m.id,
      type: "model",
      created_at: 1731000000,
      display_name: m.name,
      provider: m.provider
    }))
  }));
}

export async function handleUsage(req, res) {
  let quota = null;
  try {
    const accessToken = await getValidAccessToken();
    const { account } = accountManager.loadAccounts();
    const quotaData = await fetchGoogleQuota(accessToken, account?.projectId || "aicode-consumers");
    quota = calculateUsageWindows(quotaData);
  } catch (err) {
    console.warn("[Usage] Error fetching Google usage:", err.message);
  }

  const limits = quota ? [{
    kind: "session",
    percent: Math.round(quota.utilization * 100),
    resets_at: new Date(quota.resets_at * 1000).toISOString()
  }] : [];

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    five_hour: quota,
    seven_day: null,
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: { is_enabled: false },
    limits
  }));
}

export function handleBootstrap(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    model_access: [
      { api_name: "claude-3-8-flash", entitled: true, max_effort_level: "high", effort_level_options: ["low", "medium", "high"] },
      { api_name: "claude-3-8-flash-lite", entitled: true, max_effort_level: "low", effort_level_options: ["low"] },
      { api_name: "claude-3-5-sonnet", entitled: true, max_effort_level: "high", effort_level_options: ["low", "medium", "high"] },
      { api_name: "claude-3-opus", entitled: true, max_effort_level: "max", effort_level_options: ["low", "medium", "high", "max"] },
      { api_name: "claude-qn-coder", entitled: true, max_effort_level: "medium", effort_level_options: ["low", "medium"] },
      { api_name: "claude-seek-r1", entitled: true, max_effort_level: "max", effort_level_options: ["high", "max"] }
    ]
  }));
}
