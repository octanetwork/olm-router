// OpenAI /v1/chat/completions compatibility layer for OLM Router
import { handleClaudeMessages } from "./claude.mjs";

export function convertOpenAIToAnthropic(openAIReq) {
  const anthropicReq = {
    model: openAIReq.model || "claude-3-8-flash",
    stream: openAIReq.stream !== false,
    max_tokens: openAIReq.max_tokens || 8192,
    temperature: openAIReq.temperature ?? 0.7,
    messages: []
  };

  const systemParts = [];
  for (const m of openAIReq.messages || []) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else {
      anthropicReq.messages.push({
        role: m.role,
        content: m.content
      });
    }
  }

  if (systemParts.length > 0) {
    anthropicReq.system = systemParts.join("\n\n");
  }

  if (Array.isArray(openAIReq.tools)) {
    anthropicReq.tools = openAIReq.tools.map(t => ({
      name: t.function?.name,
      description: t.function?.description,
      input_schema: t.function?.parameters
    }));
  }

  return anthropicReq;
}

export async function handleOpenAIChatCompletions(req, res, options) {
  let bodyText = "";
  req.on("data", chunk => { bodyText += chunk; });
  req.on("end", async () => {
    try {
      const openAIReq = JSON.parse(bodyText || "{}");
      const anthropicReq = convertOpenAIToAnthropic(openAIReq);

      // Re-encode and pass through Claude handler
      const fakeReq = {
        ...req,
        on: (event, handler) => {
          if (event === "data") handler(JSON.stringify(anthropicReq));
          if (event === "end") handler();
        }
      };

      await handleClaudeMessages(fakeReq, res, options);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
  });
}
