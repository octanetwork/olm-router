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

function responseText(content, label) {
  if (typeof content === "string") return content;
  requireThat(Array.isArray(content), 400, `Неверный формат ${label}`);
  return content
    .map((part) => {
      requireThat(
        part && ["input_text", "output_text", "text"].includes(part.type),
        400,
        "Responses поддерживает только текстовые сообщения",
      );
      requireThat(typeof part.text === "string", 400, "Текстовое содержимое должно быть строкой");
      return part.text;
    })
    .join("");
}

export function fromResponses(body) {
  requireThat(
    body && typeof body === "object" && !Array.isArray(body),
    400,
    "Ожидается JSON-объект",
  );
  const input =
    typeof body.input === "string"
      ? [{ role: "user", content: body.input }]
      : body.input;
  requireThat(
    Array.isArray(input) && input.length > 0 && input.length <= 2000,
    400,
    "Responses требует от 1 до 2000 входных элементов",
  );
  const messages = [],
    system = [];
  if (body.instructions !== undefined) {
    requireThat(
      typeof body.instructions === "string",
      400,
      "instructions должен быть строкой",
    );
    system.push(body.instructions);
  }
  for (const item of input) {
    requireThat(
      item && typeof item === "object" && !Array.isArray(item),
      400,
      "Неверный входной элемент Responses",
    );
    if (item.type === "function_call") {
      const callId = item.call_id || item.id;
      requireThat(
        typeof callId === "string" && callId.length > 0 && callId.length <= 256,
        400,
        "Укажите call_id function call",
      );
      requireThat(
        typeof item.name === "string" &&
          /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(item.name),
        400,
        "Неверное имя function call",
      );
      let args;
      try {
        args = JSON.parse(item.arguments || "{}");
      } catch {
        throw new Fault(400, "Неверные аргументы function call");
      }
      requireThat(
        args && typeof args === "object" && !Array.isArray(args),
        400,
        "Аргументы function call должны быть JSON-объектом",
      );
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: callId,
            name: item.name,
            input: args,
          },
        ],
      });
      continue;
    }
    if (item.type === "function_call_output") {
      requireThat(
        typeof item.call_id === "string" &&
          item.call_id.length > 0 &&
          item.call_id.length <= 256,
        400,
        "Укажите call_id результата инструмента",
      );
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: item.call_id,
            content: responseText(item.output, "результата инструмента"),
          },
        ],
      });
      continue;
    }
    const role = item.role || "user";
    requireThat(
      item.type === undefined || item.type === "message",
      400,
      "Тип входного элемента Responses не поддерживается",
    );
    requireThat(
      ["user", "assistant", "system", "developer"].includes(role),
      400,
      "Неверная роль сообщения Responses",
    );
    const text = responseText(item.content, "сообщения");
    if (role === "system" || role === "developer") system.push(text);
    else messages.push({ role, content: [{ type: "text", text }] });
  }
  requireThat(
    body.tools === undefined ||
      (Array.isArray(body.tools) && body.tools.length <= 128),
    400,
    "Неверный список function tools",
  );
  const tools = body.tools?.map((tool) => {
    requireThat(tool?.type === "function", 400, "Поддерживаются только function tools");
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    };
  });
  const choice = body.tool_choice;
  const reasoning = body.reasoning;
  requireThat(
    reasoning === undefined ||
      (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)),
    400,
    "Неверный reasoning Responses",
  );
  const effort = reasoning?.effort;
  const thinkingBudget = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
    xhigh: 32768,
  }[effort];
  requireThat(
    effort === undefined || thinkingBudget,
    400,
    "Неверный reasoning.effort Responses",
  );
  requireThat(
    body.stream === undefined || typeof body.stream === "boolean",
    400,
    "stream должен быть boolean",
  );
  requireThat(
    choice === undefined ||
      ["auto", "none", "required"].includes(choice) ||
      (choice && choice.type === "function" && typeof choice.name === "string"),
    400,
    "Неверный tool_choice Responses",
  );
  return {
    model: body.model,
    messages,
    system: system.join("\n"),
    max_tokens: body.max_output_tokens ?? 8192,
    temperature: body.temperature,
    top_p: body.top_p,
    thinking:
      thinkingBudget === undefined
        ? undefined
        : { type: "enabled", budget_tokens: thinkingBudget },
    reasoning_effort: effort,
    stream: body.stream === true,
    tools,
    tool_choice:
      choice === "required"
        ? { type: "any" }
        : choice === "none"
          ? { type: "none" }
          : choice?.type === "function"
            ? { type: "tool", name: choice.name }
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
  requireThat(
    body.top_p === undefined ||
      (typeof body.top_p === "number" && body.top_p >= 0 && body.top_p <= 1),
    400,
    "Неверный top_p",
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
  sessionChat = false,
}) {
  if (protocol === "openai") body = fromOpenAI(body);
  if (protocol === "responses") body = fromResponses(body);
  validate(body);
  requireThat(
    assignedAccount && (apiKey || sessionChat),
    403,
    "Запрос не привязан к аккаунту",
  );
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
  if (apiKey) {
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
  } else {
    requireThat(
      sessionChat &&
        assignedAccount.user_id === user.id &&
        assignedAccount.enabled,
      403,
      "Этот Google-аккаунт недоступен",
    );
  }
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
          .run(id, apiKey?.id || null);
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
  const responseId = "resp_" + id.replaceAll("-", "");
  const responseCreated = Math.floor(created / 1000);
  const responseOutput = [];
  let responseSequence = 0,
    responseTextItem = null,
    responseTextIndex = -1,
    responseMessageCount = 0;
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
  const responseUsage = () => ({
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    total_tokens: input !== null && output !== null ? input + output : 0,
  });
  const responseObject = (status, completedAt = null) => ({
    id: responseId,
    object: "response",
    created_at: responseCreated,
    status,
    completed_at: completedAt,
    error: null,
    incomplete_details:
      status === "incomplete" ? { reason: "max_output_tokens" } : null,
    model: body.model,
    output: responseOutput,
    usage: input === null || output === null ? null : responseUsage(),
    instructions: body.system || null,
    max_output_tokens: body.max_tokens,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: body.reasoning_effort || null, summary: null },
    store: false,
    temperature: body.temperature ?? 0.7,
    text: { format: { type: "text" } },
    tool_choice:
      body.tool_choice?.type === "any"
        ? "required"
        : body.tool_choice?.type === "none"
          ? "none"
          : body.tool_choice?.type === "tool"
            ? { type: "function", name: body.tool_choice.name }
            : "auto",
    tools: (body.tools || []).map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema,
    })),
    top_p: body.top_p ?? 1,
    truncation: "disabled",
    user: null,
    metadata: {},
  });
  const responseEvent = async (type, fields = {}) =>
    write(
      { type, ...fields, sequence_number: ++responseSequence },
      type,
    );
  async function startResponseText() {
    if (responseTextItem) return;
    responseTextIndex = responseOutput.length;
    responseTextItem = {
      id: "msg_" + id.replaceAll("-", "") + "_" + responseMessageCount++,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [{ type: "output_text", text: "", annotations: [] }],
    };
    responseOutput.push(responseTextItem);
    if (stream && protocol === "responses") {
      await responseEvent("response.output_item.added", {
        output_index: responseTextIndex,
        item: { ...responseTextItem, content: [] },
      });
      await responseEvent("response.content_part.added", {
        item_id: responseTextItem.id,
        output_index: responseTextIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
  }
  async function finishResponseText() {
    if (!responseTextItem) return;
    responseTextItem.status = "completed";
    if (stream && protocol === "responses") {
      const textValue = responseTextItem.content[0].text;
      await responseEvent("response.output_text.done", {
        item_id: responseTextItem.id,
        output_index: responseTextIndex,
        content_index: 0,
        text: textValue,
      });
      await responseEvent("response.content_part.done", {
        item_id: responseTextItem.id,
        output_index: responseTextIndex,
        content_index: 0,
        part: { type: "output_text", text: textValue, annotations: [] },
      });
      await responseEvent("response.output_item.done", {
        output_index: responseTextIndex,
        item: responseTextItem,
      });
    }
    responseTextItem = null;
    responseTextIndex = -1;
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
      if (protocol === "responses") {
        await responseEvent("response.created", {
          response: responseObject("in_progress"),
        });
        await responseEvent("response.in_progress", {
          response: responseObject("in_progress"),
        });
      }
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
            if (protocol === "responses") {
              await startResponseText();
              responseTextItem.content[0].text += part.text;
              if (stream)
                await responseEvent("response.output_text.delta", {
                  item_id: responseTextItem.id,
                  output_index: responseTextIndex,
                  content_index: 0,
                  delta: part.text,
                  logprobs: [],
                });
            }
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
          if (protocol === "responses") await finishResponseText();
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
          if (protocol === "responses") {
            const outputIndex = responseOutput.length;
            const item = {
              id: "fc_" + toolId,
              type: "function_call",
              status: "completed",
              call_id: toolId,
              name: f.name,
              arguments: JSON.stringify(f.args || {}),
            };
            responseOutput.push(item);
            if (stream) {
              await responseEvent("response.output_item.added", {
                output_index: outputIndex,
                item: { ...item, status: "in_progress", arguments: "" },
              });
              await responseEvent("response.function_call_arguments.delta", {
                item_id: item.id,
                output_index: outputIndex,
                delta: item.arguments,
              });
              await responseEvent("response.function_call_arguments.done", {
                item_id: item.id,
                output_index: outputIndex,
                arguments: item.arguments,
              });
              await responseEvent("response.output_item.done", {
                output_index: outputIndex,
                item,
              });
            }
          }
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
    } else if (sessionChat) {
      store.db
        .prepare("UPDATE usage_details SET tokens=? WHERE usage_id=?")
        .run(actual ? input + output : 0, id);
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
      if (protocol === "responses") {
        await finishResponseText();
        res.end(
          JSON.stringify(
            responseObject(
              finishReason === "MAX_TOKENS" ? "incomplete" : "completed",
              Math.floor(Date.now() / 1000),
            ),
          ),
        );
      }
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
    if (stream && protocol === "responses") {
      await finishResponseText();
      const status = finishReason === "MAX_TOKENS" ? "incomplete" : "completed";
      await responseEvent(status === "completed" ? "response.completed" : "response.incomplete", {
        response: responseObject(status, Math.floor(Date.now() / 1000)),
      });
    }
    if (!res.writableEnded) res.end();
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
      else if (protocol === "responses")
        await responseEvent("error", { message: "Ответ провайдера прерван" });
      else await write({ error: { message: "Ответ провайдера прерван" } });
      res.end();
    } else throw e;
  } finally {
    if (!ended) await upstream.body.cancel().catch(() => {});
  }
}
