import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { proxyManager } from "../core/proxy.mjs";

const HOME = os.homedir();
const LOCAL_QWEN_FILE = path.resolve(process.env.DATA_DIR || "./data", "qwen.json");
const CLAUDE_ANTIGRAVITY_QWEN = path.join(HOME, ".config", "claude-antigravity", "qwen.json");

export function loadQwenConfig() {
  try {
    if (fs.existsSync(LOCAL_QWEN_FILE)) {
      return JSON.parse(fs.readFileSync(LOCAL_QWEN_FILE, "utf8"));
    }
  } catch (_) {}
  try {
    if (fs.existsSync(CLAUDE_ANTIGRAVITY_QWEN)) {
      return JSON.parse(fs.readFileSync(CLAUDE_ANTIGRAVITY_QWEN, "utf8"));
    }
  } catch (_) {}
  return { apiKey: process.env.DASHSCOPE_API_KEY || "" };
}

export async function handleQwenMessage(anthropicReq, res) {
  const qwenConf = loadQwenConfig();
  if (!qwenConf.apiKey) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "DashScope Qwen API Key not configured." }
    }));
    return;
  }

  const endpoint = qwenConf.endpoint || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";
  let targetModel = "qwen2.5-coder-32b-instruct";
  if (anthropicReq.model?.includes("max")) targetModel = "qwen-max-latest";
  if (anthropicReq.model?.includes("qwq")) targetModel = "qwq-32b-preview";

  // Convert Anthropic messages to OpenAI format
  const messages = [];
  if (anthropicReq.system) {
    const sys = typeof anthropicReq.system === "string" ? anthropicReq.system : anthropicReq.system.map(s => s.text).join("\n");
    messages.push({ role: "system", content: sys });
  }

  for (const m of anthropicReq.messages || []) {
    let content = "";
    if (typeof m.content === "string") content = m.content;
    else if (Array.isArray(m.content)) {
      content = m.content.map(p => p.text || (p.type === "tool_result" ? `[Tool result: ${p.content}]` : "")).filter(Boolean).join("\n");
    }
    messages.push({ role: m.role, content });
  }

  const isStreaming = anthropicReq.stream !== false;
  const payload = {
    model: targetModel,
    messages,
    stream: isStreaming,
    temperature: anthropicReq.temperature ?? 0.7,
    max_tokens: anthropicReq.max_tokens || 8192
  };

  const response = await proxyManager.fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${qwenConf.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const err = await response.text();
    res.writeHead(response.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { message: `Qwen API Error: ${err}` } }));
    return;
  }

  if (isStreaming) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "x-olm-provider": "alibaba-qwen"
    });

    const msgId = "msg_qn_" + Math.random().toString(36).slice(2);
    res.write(`event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { id: msgId, type: "message", role: "assistant", content: [], model: anthropicReq.model, usage: { input_tokens: 100, output_tokens: 0 } }
    })}\n\n`);

    res.write(`event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start", index: 0, content_block: { type: "text", text: "" }
    })}\n\n`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const tr = line.trim();
        if (!tr.startsWith("data:")) continue;
        const dataStr = tr.slice(5).trim();
        if (dataStr === "[DONE]") continue;
        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta?.content || "";
          if (delta) {
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta }
            })}\n\n`);
          }
        } catch (_) {}
      }
    }

    res.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
    res.write(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n`);
    res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
    res.end();
  } else {
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";
    res.writeHead(200, { "Content-Type": "application/json", "x-olm-provider": "alibaba-qwen" });
    res.end(JSON.stringify({
      id: "msg_qn_" + Math.random().toString(36).slice(2),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      model: anthropicReq.model,
      stop_reason: "end_turn",
      usage: { input_tokens: data.usage?.prompt_tokens || 100, output_tokens: data.usage?.completion_tokens || 100 }
    }));
  }
}
