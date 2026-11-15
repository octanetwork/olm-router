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
  assignedAccount = null,
  apiKey = null,
}) {
  if (protocol === "openai") body = fromOpenAI(body);
  validate(body);
  requireThat(assignedAccount && apiKey, 403, "Запрос не привязан к API-ключу");
  const quota = JSON.parse(assignedAccount.quota || "[]").find(
    (item) => item.id === body.model,
  );
  requireThat(quota, 409, "Модель больше не доступна в этом Google-аккаунте");
  requireThat(
    quota.remaining === null ||
      quota.remaining === undefined ||
      Number(quota.remaining) > 0,
    429,
    "Квота этой модели в назначенном Google-аккаунте исчерпана",
  );
  const cooldown = store.db
    .prepare(
      "SELECT until FROM cooldowns WHERE account_id=? AND model=? AND until>?",
    )
    .get(assignedAccount.id, body.model, Date.now());
  requireThat(!cooldown, 429, "Модель временно ограничена Google");
  const assignment = store.db
    .prepare(
      "SELECT account_id FROM api_key_models WHERE api_key_id=? AND model=?",
    )
    .get(apiKey.id, body.model);
  requireThat(
    assignment?.account_id === assignedAccount.id &&
      assignedAccount.user_id === user.id &&
      assignedAccount.enabled,
    403,
    "Модель и Google-аккаунт не назначены этому API-ключу",
  );
  const id = randomUUID(),
    created = Date.now(),
    accounts = [{ ...assignedAccount, source: "own" }];
  let input = null,
    output = null,
    upstream,
    selected,
    keyReserved = false,
    keyReservation = 0;
  for (const a of accounts) {
    let providerCall = false;
    try {
      store.transaction(() => {
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
        store.db
          .prepare(
            "INSERT INTO usage_details(usage_id,api_key_id,tokens) VALUES(?,?,0) ON CONFLICT(usage_id) DO UPDATE SET api_key_id=excluded.api_key_id",
          )
          .run(id, apiKey.id);
      });
      const request =
        nativeRequest || provider.convert(body, a.id + ":" + scope);
      if (apiKey?.token_limit !== null && apiKey?.token_limit !== undefined) {
        providerCall = true;
        const count = await provider.countTokens(
          a,
          body.model,
          request,
          signal,
        );
        providerCall = false;
        input = count.totalTokens;
        const activeReservations = store.db
          .prepare(
            "SELECT coalesce(sum(amount),0) AS n FROM token_reservations WHERE api_key_id=?",
          )
          .get(apiKey.id).n;
        const keyState = store.db
          .prepare(
            "SELECT token_limit,tokens_used FROM api_key_policies WHERE api_key_id=?",
          )
          .get(apiKey.id);
        requireThat(keyState, 401, "API-ключ отозван");
        const available =
          keyState.token_limit - keyState.tokens_used - activeReservations;
        requireThat(
          available > input,
          429,
          "Лимита API-ключа не хватает даже на входные токены запроса",
        );
        body.max_tokens = Math.min(body.max_tokens, available - input);
        request.generationConfig ||= {};
        request.generationConfig.maxOutputTokens = body.max_tokens;
        keyReservation = input + body.max_tokens;
        store.reserveKeyTokens(apiKey, keyReservation, id);
        keyReserved = true;
        store.db
          .prepare("UPDATE usage SET input=? WHERE id=?")
          .run(input, id);
      }
      providerCall = true;
      upstream = await provider.generate(a, body.model, request, signal);
      providerCall = false;
      selected = a;
      break;
    } catch (e) {
      if (e.dispatched && !e.rejected) {
        if (keyReserved) {
          store.settleKeyTokens(id, keyReservation, {
            input,
            output: null,
            state: "usage_unknown",
          });
          keyReserved = false;
        }
        store.db
          .prepare("UPDATE usage SET state=? WHERE id=?")
          .run("usage_unknown", id);
        throw e;
      }
      store.db.prepare("UPDATE usage SET state='failed' WHERE id=?").run(id);
      if (keyReserved) {
        store.releaseKeyTokens(id);
        keyReserved = false;
      }
      if (providerCall && e.status === 429) {
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
    const state = actual ? "complete" : "usage_unknown";
    if (apiKey) {
      const charged = actual ? input + output : keyReserved ? keyReservation : 0;
      store.settleKeyTokens(id, charged, { input, output, state });
      keyReserved = false;
    }
    store.db
      .prepare("UPDATE usage SET input=?,output=?,state=? WHERE id=?")
      .run(input, output, state, id);
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
    if (keyReserved) {
      store.settleKeyTokens(id, keyReservation, {
        input,
        output: null,
        state: "usage_unknown",
      });
      keyReserved = false;
    }
    store.db
      .prepare("UPDATE usage SET input=?,output=?,state=? WHERE id=?")
      .run(
        input,
        output,
        "usage_unknown",
        id,
      );
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
