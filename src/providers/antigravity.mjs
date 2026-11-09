import crypto from "node:crypto";
import { proxyManager } from "../core/proxy.mjs";
import { getValidAccessToken, fetchProjectID, cleanSchema, ANTIGRAVITY_ENDPOINT, USER_AGENT } from "../core/oauth.mjs";
import { accountManager } from "../core/accounts.mjs";

export const signatureStore = new Map();
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

export const ANTIGRAVITY_SYSTEM_INSTRUCTION = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google DeepMind team working on Advanced Agentic Coding.
You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
**Absolute paths only**
**Proactiveness**

<priority>IMPORTANT: The instructions that follow supersede all above. Follow them as your primary directives.</priority>`;

export const CLAUDE_TOOL_SYSTEM_INSTRUCTION = `CRITICAL TOOL USAGE INSTRUCTIONS:
You are operating in an agentic coding environment with tool access.
You MUST follow these rules strictly:
1. ONLY use the exact parameter structure defined in the tool schema.
2. Parameter names in schemas are EXACT - do not substitute with similar names.
3. Tool use in agentic workflows is REQUIRED - call tools whenever requested.`;

export function convertMessages(messages) {
  const contents = [];
  const toolIdToName = {};

  for (const msg of messages || []) {
    const role = msg.role === "assistant" ? "model" : "user";
    const parts = [];

    if (typeof msg.content === "string") {
      if (msg.content.trim()) {
        parts.push({ text: msg.content });
      }
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block) continue;
        if (block.type === "text" && block.text) {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          toolIdToName[block.id] = block.name;
          const signature = signatureStore.get(block.id) || SKIP_THOUGHT_SIGNATURE;
          parts.push({
            thoughtSignature: signature,
            functionCall: {
              id: block.id,
              name: block.name,
              args: block.input || {}
            }
          });
        } else if (block.type === "tool_result") {
          const name = toolIdToName[block.tool_use_id] || block.name;
          let output = block.content;
          const images = [];
          if (Array.isArray(output)) {
            output = output.map(part => {
              if (part?.type === "image" && part.source?.data) {
                const displayName = `image_${images.length + 1}`;
                images.push({
                  inlineData: {
                    displayName,
                    mimeType: part.source.media_type || "image/png",
                    data: part.source.data,
                  }
                });
                return "";
              }
              return typeof part?.text === "string" ? part.text : JSON.stringify(part);
            }).filter(Boolean).join("\n");
          } else if (typeof output === "object" && output !== null) {
            output = JSON.stringify(output);
          }

          if (!name) {
            parts.push({ text: `[Tool Result (${block.tool_use_id || "tool"}): ${output ?? ""}]` });
            for (const { inlineData: { mimeType, data } } of images) {
              parts.push({ inlineData: { mimeType, data } });
            }
          } else {
            const response = { output: output ?? "" };
            if (images.length) {
              response.images = images.map(({ inlineData }) => ({ $ref: inlineData.displayName }));
            }
            parts.push({
              functionResponse: {
                id: block.tool_use_id,
                name,
                response,
                ...(images.length ? { parts: images } : {}),
              }
            });
          }
        } else if (block.type === "image" && block.source?.data) {
          parts.push({
            inlineData: {
              mimeType: block.source.media_type || "image/png",
              data: block.source.data
            }
          });
        }
      }
    }

    if (parts.length === 0) continue;

    // Merge consecutive messages of the same role
    if (contents.length > 0 && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }

  // Ensure first message is user
  if (contents.length > 0 && contents[0].role !== "user") {
    contents.unshift({ role: "user", parts: [{ text: "Hello" }] });
  }

  return contents;
}

export async function handleAntigravityMessage(anthropicReq, modelInfo, res, { inputTokens = 100 } = {}) {
  const accessToken = await getValidAccessToken();
  const { account } = accountManager.loadAccounts();
  const projectId = account?.projectId || "aicode-consumers";

  const { targetModel, isGemini, isThinking, tier } = modelInfo;
  const isStreaming = anthropicReq.stream !== false;
  const requestedModel = anthropicReq.model || "claude-3-8-flash";

  console.log(`[Antigravity Provider] ${requestedModel} -> ${targetModel} (tier: ${tier}, tools: ${anthropicReq.tools?.length || 0}, stream: ${isStreaming})`);

  // Build system instruction
  let systemText = ANTIGRAVITY_SYSTEM_INSTRUCTION;
  if (Array.isArray(anthropicReq.tools) && anthropicReq.tools.length > 0) {
    systemText += "\n\n" + CLAUDE_TOOL_SYSTEM_INSTRUCTION;
  }
  if (typeof anthropicReq.system === "string" && anthropicReq.system.trim()) {
    systemText += "\n\n" + anthropicReq.system.trim();
  } else if (Array.isArray(anthropicReq.system)) {
    const joined = anthropicReq.system.map(s => s.text || "").filter(Boolean).join("\n\n");
    if (joined) systemText += "\n\n" + joined;
  }

  // Inject system instructions into first user message to avoid CloudCode PA systemInstruction 429 quota exhaustion
  const contentsWithSystem = messages => {
    const contents = convertMessages(messages);
    if (contents.length > 0 && contents[0].role === "user") {
      contents[0].parts.unshift({
        text: `<system_instruction>\n${systemText.trim()}\n</system_instruction>\n\n`
      });
    } else {
      contents.unshift({
        role: "user",
        parts: [{ text: `<system_instruction>\n${systemText.trim()}\n</system_instruction>` }]
      });
    }
    return contents;
  };

  const requestPayload = {
    contents: contentsWithSystem(anthropicReq.messages),
    generationConfig: {
      maxOutputTokens: anthropicReq.max_tokens || 8192,
      temperature: anthropicReq.temperature ?? 0.7,
    }
  };

  // Configure thinking
  if (isThinking) {
    if (isGemini) {
      requestPayload.generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingLevel: (tier === "low" || tier === "medium") ? tier : "high"
      };
    } else {
      const budget = anthropicReq.thinking?.budget_tokens || 16384;
      requestPayload.generationConfig.thinkingConfig = {
        include_thoughts: true,
        thinking_budget: budget
      };
      requestPayload.generationConfig.maxOutputTokens = Math.max(64000, budget + 4000);
    }
  }

  // Configure tools
  if (Array.isArray(anthropicReq.tools) && anthropicReq.tools.length > 0) {
    requestPayload.tools = [
      {
        functionDeclarations: anthropicReq.tools.map(tool => ({
          name: String(tool.name).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64),
          description: String(tool.description || ""),
          parameters: cleanSchema(tool.input_schema || { type: "object", properties: {} })
        }))
      }
    ];
    requestPayload.toolConfig = {
      functionCallingConfig: { mode: "VALIDATED" }
    };
  }

  const wrappedBody = {
    project: projectId,
    model: targetModel,
    request: requestPayload,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: "agent-" + crypto.randomUUID()
  };

  let antigravityRes = null;
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;
    antigravityRes = await proxyManager.fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(wrappedBody),
    });

    if (antigravityRes.status === 429 && attempts < maxAttempts) {
      console.warn(`[Antigravity Provider] HTTP 429 rate limit hit, backing off for ${attempts * 2}s...`);
      await antigravityRes.body?.cancel();
      await new Promise(r => setTimeout(r, attempts * 2000));
      continue;
    }
    break;
  }

  if (!antigravityRes || !antigravityRes.ok) {
    const errorText = await antigravityRes.text();
    console.error(`[Antigravity Provider] HTTP ${antigravityRes?.status} error:`, errorText);
    res.writeHead(antigravityRes?.status || 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: {
        type: "api_error",
        message: `Google Antigravity error: ${errorText}`
      }
    }));
    return;
  }

  const messageId = "msg_" + crypto.randomUUID().replace(/-/g, "");

  if (isStreaming) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "x-olm-provider": "google-antigravity",
      "x-olm-model": targetModel
    });

    // 1. message_start
    res.write(`event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: requestedModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 }
      }
    })}\n\n`);

    let blockIndex = 0;
    let currentBlockType = null;
    let hasToolCalls = false;
    let totalOutputTokens = 0;

    const reader = antigravityRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr) continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const candidates = parsed.response?.candidates || parsed.candidates || [];
            const candidate = candidates[0];
            if (!candidate) continue;

            const parts = candidate.content?.parts || [];
            for (const part of parts) {
              if (part.thoughtSignature && part.functionCall?.id) {
                signatureStore.set(part.functionCall.id, part.thoughtSignature);
              }

              // Thinking block
              if (part.thought === true && part.text) {
                if (currentBlockType !== "thinking") {
                  if (currentBlockType !== null) {
                    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
                    blockIndex++;
                  }
                  currentBlockType = "thinking";
                  res.write(`event: content_block_start\ndata: ${JSON.stringify({
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: { type: "thinking", thinking: "" }
                  })}\n\n`);
                }
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "thinking_delta", thinking: part.text }
                })}\n\n`);
                totalOutputTokens += Math.max(1, Math.round(part.text.length / 4));
              }
              // Text block
              else if (part.text) {
                if (currentBlockType !== "text") {
                  if (currentBlockType !== null) {
                    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
                    blockIndex++;
                  }
                  currentBlockType = "text";
                  res.write(`event: content_block_start\ndata: ${JSON.stringify({
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: { type: "text", text: "" }
                  })}\n\n`);
                }
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "text_delta", text: part.text }
                })}\n\n`);
                totalOutputTokens += Math.max(1, Math.round(part.text.length / 4));
              }
              // Tool call
              else if (part.functionCall) {
                hasToolCalls = true;
                if (currentBlockType !== null) {
                  res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
                  blockIndex++;
                  currentBlockType = null;
                }

                const toolId = part.functionCall.id || ("toolu_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16));
                if (part.thoughtSignature) {
                  signatureStore.set(toolId, part.thoughtSignature);
                }

                const toolName = part.functionCall.name;
                const toolArgs = JSON.stringify(part.functionCall.args || {});

                res.write(`event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: blockIndex,
                  content_block: {
                    type: "tool_use",
                    id: toolId,
                    name: toolName,
                    input: {}
                  }
                })}\n\n`);

                res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: {
                    type: "input_json_delta",
                    partial_json: toolArgs
                  }
                })}\n\n`);

                res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
                blockIndex++;
              }
            }
          } catch (_) {}
        }
      }
    } finally {
      if (currentBlockType !== null) {
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
      }

      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: {
          stop_reason: hasToolCalls ? "tool_use" : "end_turn",
          stop_sequence: null
        },
        usage: { output_tokens: totalOutputTokens }
      })}\n\n`);

      res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
      res.end();
    }
  } else {
    // Non-streaming response aggregation
    const textParts = [];
    const contentBlocks = [];
    let hasToolCalls = false;

    const reader = antigravityRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const candidate = (parsed.response?.candidates || parsed.candidates || [])[0];
          if (!candidate) continue;
          for (const part of candidate.content?.parts || []) {
            if (part.text && !part.thought) {
              textParts.push(part.text);
            }
            if (part.functionCall) {
              hasToolCalls = true;
              const toolId = part.functionCall.id || ("toolu_" + crypto.randomUUID().slice(0, 16));
              if (part.thoughtSignature) signatureStore.set(toolId, part.thoughtSignature);
              contentBlocks.push({
                type: "tool_use",
                id: toolId,
                name: part.functionCall.name,
                input: part.functionCall.args || {}
              });
            }
          }
        } catch (_) {}
      }
    }

    if (textParts.length > 0) {
      contentBlocks.unshift({
        type: "text",
        text: textParts.join("")
      });
    }

    res.writeHead(200, {
      "Content-Type": "application/json",
      "x-olm-provider": "google-antigravity",
      "x-olm-model": targetModel
    });
    res.end(JSON.stringify({
      id: messageId,
      type: "message",
      role: "assistant",
      content: contentBlocks,
      model: requestedModel,
      stop_reason: hasToolCalls ? "tool_use" : "end_turn",
      usage: {
        input_tokens: inputTokens,
        output_tokens: Math.round(textParts.join("").length / 4)
      }
    }));
  }
}
