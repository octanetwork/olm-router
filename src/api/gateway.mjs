import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Fault, requireThat } from "../core/store.mjs";
import { events } from "../core/provider.mjs";
export function fromOpenAI(body) {
  const messages = [],
    system = [];
  for (const m of body.messages || []) {
    if (m.role === "system" || m.role === "developer") {
      system.push(
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      );
      continue;
    }
    if (m.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id,
            content: m.content,
          },
        ],
      });
      continue;
    }
    let content =
      typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : (m.content || []).map((b) => {
            requireThat(
              b.type === "text",
              400,
              "Поддерживается только текст OpenAI; изображения передавайте через Anthropic или Gemini",
            );
            return b;
          });
    for (const t of m.tool_calls || []) {
      let input;
      try {
        input = JSON.parse(t.function.arguments || "{}");
      } catch {
        throw new Fault(400, "Неверные аргументы tool call");
      }
      content.push({
        type: "tool_use",
        id: t.id,
        name: t.function.name,
        input,
      });
    }
    messages.push({ role: m.role, content });
  }
  const choice = body.tool_choice;
  return {
    model: body.model,
    messages,
    system: system.join("\n"),
    max_tokens: body.max_completion_tokens ?? body.max_tokens ?? 8192,
    temperature: body.temperature,
    stream: body.stream === true,
    tools: body.tools?.map((t) => ({
      name: t.function?.name,
      description: t.function?.description,
      input_schema: t.function?.parameters,
    })),
    tool_choice:
      choice === "required"
        ? { type: "any" }
        : choice === "none"
          ? { type: "none" }
          : choice?.function
            ? { type: "tool", name: choice.function.name }
            : undefined,
  };
}
export function validate(body) {
  requireThat(
    body && typeof body === "object" && !Array.isArray(body),
    400,
    "Ожидается JSON-объект",
  );
  requireThat(
    typeof body.model === "string" && body.model.length <= 150,
    400,
    "Укажите модель из /v1/models",
  );
  requireThat(
    Array.isArray(body.messages) &&
      body.messages.length > 0 &&
      body.messages.length <= 2000,
    400,
    "Требуется от 1 до 2000 сообщений",
  );
  requireThat(
    Number.isSafeInteger(body.max_tokens) &&
      body.max_tokens > 0 &&
      body.max_tokens <= 65536,
    400,
    "max_tokens должен быть от 1 до 65536",
  );
  requireThat(
    body.temperature === undefined ||
      (typeof body.temperature === "number" &&
        body.temperature >= 0 &&
        body.temperature <= 2),
    400,
    "Неверная temperature",
  );
  for (const m of body.messages) {
    requireThat(
      m &&
        ["user", "assistant", "system"].includes(m.role) &&
        (typeof m.content === "string" || Array.isArray(m.content)),
      400,
      "Неверный формат сообщений",
    );
    if (Array.isArray(m.content))
      for (const b of m.content)
        requireThat(
          b && typeof b.type === "string",
          400,
          "Неверный блок сообщения",
        );
  }
  if (body.tools)
    requireThat(
      Array.isArray(body.tools) &&
        body.tools.length <= 128 &&
        body.tools.every(
          (t) =>
            t &&
            typeof t.name === "string" &&
            /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(t.name),
        ),
      400,
      "Неверное описание инструментов",
    );
  requireThat(
    body.stream === undefined || typeof body.stream === "boolean",
    400,
    "stream должен быть boolean",
  );
}
export const priceCost = (p, input, output) => {
  const total = Number(
    (BigInt(input) * BigInt(p.input) +
      BigInt(output) * BigInt(p.output) +
      999999n) /
      1000000n,
  );
  requireThat(
    Number.isSafeInteger(total) && total >= 0,
    400,
    "Расход слишком велик",
  );
  return total;
};
export function candidates(store, user, model) {
  const settings = JSON.parse(user.settings);
  let own = store.db
    .prepare("SELECT * FROM accounts WHERE user_id=? AND enabled=1 ORDER BY id")
    .all(user.id);
  if (settings.accountId)
    own.sort(
      (a, b) =>
        Number(b.id === settings.accountId) -
        Number(a.id === settings.accountId),
    );
  if (settings.mode === "stop") own = own.slice(0, 1);
  let pool = own.map((a) => ({ ...a, source: "own" }));
  if (own.length === 0 || settings.sharedFallback === true)
    pool.push(
      ...store.db
        .prepare(
          "SELECT * FROM accounts WHERE shared=1 AND enabled=1 AND user_id!=? ORDER BY id",
        )
        .all(user.id)
        .map((a) => ({ ...a, source: "shared" })),
    );
  const unsettled = store.db
    .prepare(
      "SELECT r.id FROM reservations r JOIN usage u ON u.id=r.id WHERE u.user_id=? AND u.state='reconcile' LIMIT 1",
    )
    .get(user.id);
  return pool.filter(
    (a) =>
      !(a.source === "shared" && unsettled) &&
      !store.db
        .prepare(
          "SELECT 1 FROM cooldowns WHERE account_id=? AND model=? AND until>?",
        )
        .get(a.id, model, Date.now()) &&
      a.quota &&
      JSON.parse(a.quota).some((m) => m.id === model && m.remaining !== 0),
  );
}
export async function gateway({
  store,
  provider,
  user,
  body,
  res,
  signal,
  protocol = "anthropic",
  nativeRequest,
  scope = user.id,
}) {
  if (protocol === "openai") body = fromOpenAI(body);
  validate(body);
  const id = randomUUID(),
    created = Date.now(),
    accounts = candidates(store, user, body.model);
  requireThat(
    accounts.length,
    409,
    "Нет доступного аккаунта с этой моделью. Проверьте квоту и режим переключения",
  );
  let upstream,
    selected,
    price,
    reserved = false;
  const prices = store.db
    .prepare("SELECT value FROM prices WHERE model=?")
    .get(body.model);
  const inputBound =
    Buffer.byteLength(JSON.stringify(nativeRequest || body), "utf8") + 4096;
  for (const a of accounts) {
    try {
      store.db
        .prepare(
          "INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,source=excluded.source,state='pending'",
        )
        .run(
          id,
          user.id,
          a.id,
          body.model,
          a.source,
          null,
          null,
          0,
          "pending",
          created,
        );
      if (a.source === "shared") {
        requireThat(prices, 409, "Для модели общего пула ещё не задана цена");
        price = JSON.parse(prices.value);
        store.reserve(
          user.id,
          priceCost(price, inputBound, body.max_tokens),
          id,
        );
        reserved = true;
      }
      const request =
        nativeRequest || provider.convert(body, a.id + ":" + scope);
      upstream = await provider.generate(a, body.model, request, signal);
      selected = a;
      break;
    } catch (e) {
      if (e.dispatched && !e.rejected) {
        store.db
          .prepare("UPDATE usage SET state=? WHERE id=?")
          .run(reserved ? "reconcile" : "failed", id);
        throw e;
      }
      store.db.prepare("UPDATE usage SET state='failed' WHERE id=?").run(id);
      if (reserved) {
        store.settle(id, 0);
        reserved = false;
      }
      if (e.status === 429) {
        store.db
          .prepare(
            "INSERT INTO cooldowns VALUES(?,?,?) ON CONFLICT(account_id,model) DO UPDATE SET until=excluded.until",
          )
          .run(a.id, body.model, Date.now() + (e.retryAfter || 60) * 1000);
      }
      if (![429, 502, 503].includes(e.status) || a === accounts.at(-1)) throw e;
    }
  }
  requireThat(upstream, 502, "Провайдер недоступен");
  const content = [],
    toolCalls = [];
  let text = "",
    input = null,
    output = null,
    nativeUsage = null,
    finishReason = "STOP",
    nativeParts = [],
    hasContent = false,
    index = -1,
    current = null,
    toolIndex = 0;
  const stream = body.stream === true;
  let ended = false;
  async function write(data, event) {
    if (res.destroyed) throw new Fault(499, "Соединение закрыто");
    if (
      !res.write(
        `${event ? "event: " + event + "\n" : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
      )
    )
      await once(res, "drain", { signal });
  }
  async function closeBlock() {
    if (current && protocol === "anthropic" && stream)
      await write({ type: "content_block_stop", index }, "content_block_stop");
    current = null;
  }
  async function openBlock(type) {
    if (current === type) return;
    await closeBlock();
    index++;
    current = type;
    if (stream && protocol === "anthropic")
      await write(
        {
          type: "content_block_start",
          index,
          content_block: {
            type,
            ...(type === "thinking" ? { thinking: "" } : { text: "" }),
          },
        },
        "content_block_start",
      );
  }
  const chunk = (delta) => ({
    id: "chatcmpl-" + id,
    object: "chat.completion.chunk",
    created: Math.floor(created / 1000),
    model: body.model,
    choices: [{ index: 0, delta, finish_reason: null }],
  });
  try {
    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "x-request-id": id,
      });
      if (protocol === "anthropic")
        await write(
          {
            type: "message_start",
            message: {
              id: "msg_" + id,
              type: "message",
              role: "assistant",
              model: body.model,
              content: [],
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          },
          "message_start",
        );
      if (protocol === "openai")
        await write(chunk({ role: "assistant", content: "" }));
    }
    for await (const raw of events(upstream.body)) {
      if (raw.error) throw new Fault(502, "Провайдер прервал ответ");
      const data = raw.response || raw;
      const usage = data.usageMetadata;
      if (usage) nativeUsage = usage;
      if (data.candidates?.[0]?.finishReason)
        finishReason = data.candidates[0].finishReason;
      if (
        usage &&
        Number.isSafeInteger(usage.promptTokenCount) &&
        Number.isSafeInteger(usage.totalTokenCount)
      ) {
        input = usage.promptTokenCount;
        output = usage.totalTokenCount - input;
        requireThat(
          input >= 0 && output >= 0,
          502,
          "Некорректный usage провайдера",
        );
      }
      if (protocol === "gemini" && stream) await write(data);
      for (const part of data.candidates?.[0]?.content?.parts || []) {
        nativeParts.push(part);
        if (part.text) {
          hasContent = true;
          if (part.thought) {
            if (current !== "thinking")
              content.push({ type: "thinking", thinking: "" });
            content.at(-1).thinking += part.text;
            if (part.thoughtSignature)
              content.at(-1).signature = part.thoughtSignature;
            await openBlock("thinking");
            if (stream && protocol === "anthropic")
              await write(
                {
                  type: "content_block_delta",
                  index,
                  delta: { type: "thinking_delta", thinking: part.text },
                },
                "content_block_delta",
              );
            if (part.thoughtSignature && stream && protocol === "anthropic")
              await write(
                {
                  type: "content_block_delta",
                  index,
                  delta: {
                    type: "signature_delta",
                    signature: part.thoughtSignature,
                  },
                },
                "content_block_delta",
              );
          } else {
            text += part.text;
            if (current !== "text") content.push({ type: "text", text: "" });
            content.at(-1).text += part.text;
            await openBlock("text");
            if (stream && protocol === "anthropic")
              await write(
                {
                  type: "content_block_delta",
                  index,
                  delta: { type: "text_delta", text: part.text },
                },
                "content_block_delta",
              );
            if (stream && protocol === "openai")
              await write(chunk({ content: part.text }));
          }
        }
        if (part.functionCall) {
          hasContent = true;
          await closeBlock();
          index++;
          const f = part.functionCall,
            toolId = f.id || "toolu_" + randomUUID();
          const tool = {
            type: "tool_use",
            id: toolId,
            name: f.name,
            input: f.args || {},
          };
          content.push(tool);
          toolCalls.push({
            id: toolId,
            type: "function",
            function: { name: f.name, arguments: JSON.stringify(f.args || {}) },
          });
          if (part.thoughtSignature) {
            requireThat(
              part.thoughtSignature.length <= 16384,
              502,
              "Подпись инструмента слишком велика",
            );
            provider.signatures.set(
              selected.id + ":" + scope + ":" + toolId,
              part.thoughtSignature,
            );
            if (provider.signatures.size > 1000)
              provider.signatures.delete(
                provider.signatures.keys().next().value,
              );
          }
          if (stream && protocol === "anthropic") {
            await write(
              {
                type: "content_block_start",
                index,
                content_block: {
                  type: "tool_use",
                  id: toolId,
                  name: f.name,
                  input: {},
                },
              },
              "content_block_start",
            );
            await write(
              {
                type: "content_block_delta",
                index,
                delta: {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(f.args || {}),
                },
              },
              "content_block_delta",
            );
            await write(
              { type: "content_block_stop", index },
              "content_block_stop",
            );
          }
          if (stream && protocol === "openai")
            await write(
              chunk({
                tool_calls: [{ index: toolIndex++, ...toolCalls.at(-1) }],
              }),
            );
        }
      }
    }
    requireThat(hasContent, 502, "Провайдер вернул пустой ответ");
    const actual = input !== null && output !== null;
    let cost = 0;
    if (reserved && actual) {
      cost = priceCost(price, input, output);
      const reservation = store.db
        .prepare("SELECT amount FROM reservations WHERE id=?")
        .get(id);
      if (reservation && cost <= reservation.amount) {
        store.settle(id, cost, { input, output, state: "complete" });
        reserved = false;
      } else cost = 0;
    }
    const state = reserved
      ? "reconcile"
      : actual
        ? "complete"
        : "usage_unknown";
    store.db
      .prepare("UPDATE usage SET input=?,output=?,credits=?,state=? WHERE id=?")
      .run(input, output, cost, state, id);
    const usage = { input_tokens: input, output_tokens: output };
    if (stream) {
      await closeBlock();
      if (protocol === "anthropic") {
        await write(
          {
            type: "message_delta",
            delta: {
              stop_reason: toolCalls.length
                ? "tool_use"
                : finishReason === "MAX_TOKENS"
                  ? "max_tokens"
                  : "end_turn",
              stop_sequence: null,
            },
            usage,
          },
          "message_delta",
        );
        await write({ type: "message_stop" }, "message_stop");
      }
      if (protocol === "openai") {
        await write({
          ...chunk({}),
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: toolCalls.length
                ? "tool_calls"
                : finishReason === "MAX_TOKENS"
                  ? "length"
                  : "stop",
            },
          ],
          usage: {
            prompt_tokens: input,
            completion_tokens: output,
            total_tokens: actual ? input + output : null,
          },
        });
        await write("[DONE]");
      }
    } else {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "x-request-id": id,
      });
      if (protocol === "anthropic")
        res.write(
          JSON.stringify({
            id: "msg_" + id,
            type: "message",
            role: "assistant",
            model: body.model,
            content,
            stop_reason: toolCalls.length
              ? "tool_use"
              : finishReason === "MAX_TOKENS"
                ? "max_tokens"
                : "end_turn",
            stop_sequence: null,
            usage,
          }),
        );
      if (protocol === "openai")
        res.write(
          JSON.stringify({
            id: "chatcmpl-" + id,
            object: "chat.completion",
            created: Math.floor(created / 1000),
            model: body.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: text || null,
                  ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
                },
                finish_reason: toolCalls.length
                  ? "tool_calls"
                  : finishReason === "MAX_TOKENS"
                    ? "length"
                    : "stop",
              },
            ],
            usage: {
              prompt_tokens: input,
              completion_tokens: output,
              total_tokens: actual ? input + output : null,
            },
          }),
        );
      if (protocol === "gemini")
        res.write(
          JSON.stringify({
            candidates: [
              { content: { role: "model", parts: nativeParts }, finishReason },
            ],
            usageMetadata: nativeUsage,
          }),
        );
    }
    res.end();
    ended = true;
  } catch (e) {
    store.db
      .prepare("UPDATE usage SET input=?,output=?,state=? WHERE id=?")
      .run(input, output, reserved ? "reconcile" : "failed", id);
    if (res.headersSent && !res.destroyed) {
      if (protocol === "anthropic")
        await write(
          {
            type: "error",
            error: { type: "api_error", message: "Ответ провайдера прерван" },
          },
          "error",
        );
      else await write({ error: { message: "Ответ провайдера прерван" } });
      res.end();
    } else throw e;
  } finally {
    if (!ended) await upstream.body.cancel().catch(() => {});
  }
}
