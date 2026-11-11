import { Store } from "../src/core/store.mjs";
const store = new Store(process.env.DATA_DIR, process.env.OLM_ENCRYPTION_KEY),
  owner = store.db.prepare("SELECT * FROM users WHERE login='octadmin'").get(),
  key = store.createKey(owner, "temporary smoke");
const base = process.env.OLM_SMOKE_URL || "http://127.0.0.1:18046";
async function call(path, body) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key.key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(r.status + " " + text);
  return { text, headers: r.headers };
}
try {
  const body = {
    model: "gemini-3.8-flash-low",
    messages: [{ role: "user", content: "Reply OK only." }],
    system: "You are a helpful assistant.",
    max_tokens: 512,
    stream: false,
  };
  const a = JSON.parse((await call("/v1/messages", body)).text);
  console.log(
    JSON.stringify({
      protocol: "anthropic",
      content: a.content,
      usage: a.usage,
    }),
  );
  const o = JSON.parse(
    (
      await call("/v1/chat/completions", {
        model: body.model,
        messages: [{ role: "user", content: "Reply OK only." }],
        max_tokens: 128,
      })
    ).text,
  );
  console.log(
    JSON.stringify({
      protocol: "openai",
      content: o.choices?.[0]?.message,
      usage: o.usage,
    }),
  );
  const g = JSON.parse(
    (
      await call(`/v1beta/models/${body.model}:generateContent`, {
        contents: [{ role: "user", parts: [{ text: "Reply OK only." }] }],
        generationConfig: { maxOutputTokens: 128 },
      })
    ).text,
  );
  console.log(
    JSON.stringify({
      protocol: "gemini",
      parts: g.candidates?.[0]?.content?.parts,
      usage: g.usageMetadata,
    }),
  );
  const streaming = await call("/v1/messages", { ...body, stream: true });
  if (!streaming.text.includes("message_stop"))
    throw new Error("stream did not finish");
  console.log("Anthropic streaming passed");
  const tools = [
    {
      name: "lookup",
      description: "Get the test number",
      input_schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ];
  const first = JSON.parse(
    (
      await call("/v1/messages", {
        ...body,
        system: undefined,
        messages: [
          {
            role: "user",
            content: "Call lookup to get a number. Use the result to answer.",
          },
        ],
        tools,
        tool_choice: { type: "any" },
      })
    ).text,
  );
  const tool = first.content.find((b) => b.type === "tool_use");
  if (!tool) throw new Error("No tool call");
  const second = JSON.parse(
    (
      await call("/v1/messages", {
        ...body,
        system: undefined,
        messages: [
          {
            role: "user",
            content: "Call lookup to get a number. Use the result to answer.",
          },
          { role: "assistant", content: first.content },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: tool.id, content: "42" },
            ],
          },
        ],
        tools,
      })
    ).text,
  );
  console.log(
    JSON.stringify({
      protocol: "tool-roundtrip",
      content: second.content,
      usage: second.usage,
    }),
  );
} finally {
  store.db.prepare("DELETE FROM api_keys WHERE id=?").run(key.id);
  store.db.close();
}
