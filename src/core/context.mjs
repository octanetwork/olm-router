// Token estimation and intelligent context compaction for OLM Router

export function estimateStringTokens(str) {
  if (!str) return 0;
  // Approximation: ~3.8 chars per token for code & English, ~1.5 chars for Cyrillic
  return Math.ceil(str.length / 3.2);
}

export function estimateContentTokens(content) {
  if (typeof content === "string") return estimateStringTokens(content);
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") {
      total += estimateStringTokens(part.text);
    } else if (part.type === "tool_use") {
      total += estimateStringTokens(part.name || "") + estimateStringTokens(JSON.stringify(part.input || {})) + 20;
    } else if (part.type === "tool_result") {
      if (typeof part.content === "string") {
        total += estimateStringTokens(part.content);
      } else if (Array.isArray(part.content)) {
        total += estimateContentTokens(part.content);
      }
      total += 15;
    }
  }
  return total;
}

export function estimateMessageTokens(message) {
  if (!message || typeof message !== "object") return 0;
  return estimateContentTokens(message.content) + 10;
}

export function estimateFixedTokens(anthropicReq) {
  let fixed = 1500; // base system instructions & wrapping
  if (anthropicReq.system) {
    if (typeof anthropicReq.system === "string") {
      fixed += estimateStringTokens(anthropicReq.system);
    } else if (Array.isArray(anthropicReq.system)) {
      fixed += anthropicReq.system.reduce((acc, s) => acc + estimateStringTokens(s.text || ""), 0);
    }
  }
  if (Array.isArray(anthropicReq.tools)) {
    fixed += anthropicReq.tools.reduce((acc, t) => {
      return acc + estimateStringTokens(t.name) + estimateStringTokens(t.description) + estimateStringTokens(JSON.stringify(t.input_schema || {})) + 25;
    }, 0);
  }
  return fixed;
}

export function estimateRequestTokens(anthropicReq) {
  const fixed = estimateFixedTokens(anthropicReq);
  const messagesTokens = Array.isArray(anthropicReq.messages)
    ? anthropicReq.messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0)
    : 0;
  return fixed + messagesTokens;
}

export function truncateStringWithEllipsis(str, maxChars, notice = "[... content compacted to preserve context ...]") {
  if (!str || str.length <= maxChars) return str;
  const keep = Math.max(0, maxChars - notice.length);
  const half = Math.floor(keep / 2);
  return str.slice(0, half) + "\n" + notice + "\n" + str.slice(-half);
}

// Compact messages history if it exceeds the token budget
export function compactAnthropicMessages(messages, budgetTokens, emergency = false) {
  if (!Array.isArray(messages) || messages.length <= 2) return messages;

  let currentBudget = budgetTokens;
  const compacted = JSON.parse(JSON.stringify(messages));

  // Always keep first user message and last 2 messages intact
  const firstIndex = 0;
  const recentCount = emergency ? 1 : 2;
  const protectedIndices = new Set([firstIndex]);
  for (let i = Math.max(1, compacted.length - recentCount); i < compacted.length; i++) {
    protectedIndices.add(i);
  }

  // Calculate current usage
  let totalUsage = compacted.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
  if (totalUsage <= currentBudget) return compacted;

  // Pass 1: Compact large tool_result bodies in historical messages
  for (let i = 1; i < compacted.length; i++) {
    if (protectedIndices.has(i)) continue;
    const msg = compacted[i];
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && part.type === "tool_result") {
          const maxResultChars = emergency ? 500 : 2000;
          if (typeof part.content === "string" && part.content.length > maxResultChars) {
            part.content = truncateStringWithEllipsis(part.content, maxResultChars, "[... tool output truncated by router ...]");
          } else if (Array.isArray(part.content)) {
            for (const sub of part.content) {
              if (sub.type === "text" && typeof sub.text === "string" && sub.text.length > maxResultChars) {
                sub.text = truncateStringWithEllipsis(sub.text, maxResultChars, "[... tool output truncated by router ...]");
              }
            }
          }
        }
      }
    }
  }

  totalUsage = compacted.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
  if (totalUsage <= currentBudget) return compacted;

  // Pass 2: Truncate long assistant thoughts and text in middle messages
  for (let i = 1; i < compacted.length; i++) {
    if (protectedIndices.has(i)) continue;
    const msg = compacted[i];
    const maxTextChars = emergency ? 800 : 3000;
    if (typeof msg.content === "string" && msg.content.length > maxTextChars) {
      msg.content = truncateStringWithEllipsis(msg.content, maxTextChars, "[... turn content compacted ...]");
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && typeof part.text === "string" && part.text.length > maxTextChars) {
          part.text = truncateStringWithEllipsis(part.text, maxTextChars, "[... message text compacted ...]");
        }
      }
    }
  }

  totalUsage = compacted.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
  if (totalUsage <= currentBudget) return compacted;

  // Pass 3 (Emergency): Drop oldest middle message pairs (user + assistant)
  const remaining = [];
  remaining.push(compacted[0]); // Keep initial prompt

  let droppedCount = 0;
  for (let i = 1; i < compacted.length; i++) {
    if (protectedIndices.has(i)) {
      remaining.push(compacted[i]);
    } else {
      // Check if we still exceed budget
      const tempUsage = remaining.reduce((acc, m) => acc + estimateMessageTokens(m), 0) +
                        compacted.slice(i).reduce((acc, m) => acc + estimateMessageTokens(m), 0);
      if (tempUsage > currentBudget) {
        droppedCount++;
      } else {
        remaining.push(compacted[i]);
      }
    }
  }

  if (droppedCount > 0 && remaining.length > 1) {
    // Insert a summary indicator
    remaining.splice(1, 0, {
      role: "user",
      content: `[Router notice: ${droppedCount} intermediate conversation turns were automatically pruned to fit token limits.]`
    }, {
      role: "assistant",
      content: "Acknowledged. Continuing with remaining context."
    });
  }

  return remaining;
}
