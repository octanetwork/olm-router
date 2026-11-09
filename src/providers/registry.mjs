import fs from "node:fs";
import path from "node:path";

export function resolveModelAndTier(requestedModel, anthropicReq) {
  const model = (requestedModel || "claude-3-8-flash").toLowerCase();

  // 1. Qwen Models
  if (model.includes("qn-") || model.includes("qwen")) {
    return {
      provider: "qwen",
      isQwen: true,
      targetModel: model.includes("coder") ? "qwen2.5-coder-32b-instruct" : (model.includes("qwq") ? "qwq-32b-preview" : "qwen-max-latest")
    };
  }

  // 2. DeepSeek Models
  if (model.includes("seek-") || model.includes("deepseek")) {
    return {
      provider: "deepseek",
      isDeepSeek: true,
      targetModel: model.includes("r1") ? "deepseek-reasoner" : "deepseek-chat"
    };
  }

  // 3. CheapVibeCode Models
  if (model.includes("cvc-") || model.includes("cheapvibecode")) {
    return {
      provider: "cheapvibecode",
      isCheapVibeCode: true,
      targetModel: "claude-3-5-sonnet-20241022"
    };
  }

  // 4. Nvidia NIM Models
  if (model.includes("nv-") || model.includes("nim-") || model.includes("llama")) {
    return {
      provider: "nvidia",
      isNvidiaNim: true,
      targetModel: "meta/llama-3.3-70b-instruct"
    };
  }

  // 5. Google Antigravity (Default)
  let targetModel = "gemini-3.8-flash";
  let isGemini = true;
  let isThinking = true;
  let tier = "high";

  // Tier detection from request
  if (anthropicReq && anthropicReq.thinking) {
    const budget = anthropicReq.thinking.budget_tokens || 0;
    if (budget <= 4000) tier = "low";
    else if (budget <= 16000) tier = "medium";
    else tier = "high";
  }

  if (model.includes("lite") || model.includes("haiku")) {
    targetModel = "gemini-3.8-flash-lite";
    isThinking = false;
    tier = "low";
  } else if (model.includes("opus") || model.includes("max")) {
    targetModel = "gemini-3.8-flash";
    isThinking = true;
    tier = "max";
  }

  return {
    provider: "antigravity",
    isAntigravity: true,
    targetModel,
    isGemini,
    isThinking,
    tier
  };
}

export function listSupportedModels() {
  return [
    {
      id: "claude-3-8-flash",
      name: "Gemini 3.8 Flash (Antigravity Thinking)",
      provider: "google-antigravity",
      behavesAs: "claude-sonnet-5",
      max_tokens: 64000,
      thinking: true
    },
    {
      id: "claude-3-8-flash-lite",
      name: "Gemini 3.8 Flash-Lite (Fast)",
      provider: "google-antigravity",
      behavesAs: "claude-haiku-5",
      max_tokens: 32000,
      thinking: false
    },
    {
      id: "claude-3-5-sonnet",
      name: "Claude 3.5 Sonnet (Antigravity Bridge)",
      provider: "google-antigravity",
      behavesAs: "claude-sonnet-5",
      max_tokens: 64000,
      thinking: true
    },
    {
      id: "claude-3-5-haiku",
      name: "Claude 3.5 Haiku",
      provider: "google-antigravity",
      behavesAs: "claude-haiku-5",
      max_tokens: 16000,
      thinking: false
    },
    {
      id: "claude-3-opus",
      name: "Claude 3 Opus (Antigravity Max)",
      provider: "google-antigravity",
      behavesAs: "claude-opus-5",
      max_tokens: 64000,
      thinking: true
    },
    {
      id: "claude-qn-coder",
      name: "Qwen 2.5 Coder 32B Instruct",
      provider: "alibaba-qwen",
      behavesAs: "claude-sonnet-5",
      max_tokens: 8192
    },
    {
      id: "claude-qn-3-max",
      name: "Qwen 2.5 Max Latest",
      provider: "alibaba-qwen",
      behavesAs: "claude-sonnet-5",
      max_tokens: 8192
    },
    {
      id: "claude-qn-qwq",
      name: "QwQ 32B Reasoning Preview",
      provider: "alibaba-qwen",
      behavesAs: "claude-opus-5",
      max_tokens: 8192,
      thinking: true
    },
    {
      id: "claude-seek-v3",
      name: "DeepSeek Chat V3",
      provider: "deepseek",
      behavesAs: "claude-sonnet-5",
      max_tokens: 8192
    },
    {
      id: "claude-seek-r1",
      name: "DeepSeek Reasoner R1",
      provider: "deepseek",
      behavesAs: "claude-opus-5",
      max_tokens: 8192,
      thinking: true
    },
    {
      id: "claude-cvc-sonnet",
      name: "CheapVibeCode Claude Sonnet Gateway",
      provider: "cheapvibecode",
      behavesAs: "claude-sonnet-5",
      max_tokens: 8192
    },
    {
      id: "claude-nv-llama-70b",
      name: "Nvidia NIM Llama 3.3 70B",
      provider: "nvidia-nim",
      behavesAs: "claude-sonnet-5",
      max_tokens: 4096
    }
  ];
}
