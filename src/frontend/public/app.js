const root = document.querySelector("#app");
let me,
  csrf,
  view = "usage",
  month = new Date(),
  noticeTimer;
const number = (n) =>
  n === null ? "Нет данных" : new Intl.NumberFormat("ru-RU").format(n || 0);
const date = (n) => new Date(n).toLocaleString("ru-RU");
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on")) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "checked") n.checked = v;
    else if (k === "value") n.value = v;
    else if (v !== undefined) n.setAttribute(k, v);
  }
  for (const c of children.flat())
    if (c !== null && c !== undefined)
      n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
function button(text, fn, cls = "") {
  return el(
    "button",
    {
      type: "button",
      class: cls,
      onClick: async (e) => {
        const target = e.currentTarget;
        target.disabled = true;
        try {
          await fn(e);
        } catch (err) {
          notify(err.message);
        } finally {
          target.disabled = false;
        }
      },
    },
    text,
  );
}
function notify(text) {
  const n = document.querySelector("#notice");
  n.textContent = text;
  n.classList.add("visible");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => n.classList.remove("visible"), 6000);
}
async function api(path, method = "GET", body) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      "x-csrf-token": csrf || "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await res.json();
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/login") login();
    throw new Error(d.error?.message || "Не удалось выполнить запрос");
  }
  return d;
}
function field(label, name, type = "text", props = {}) {
  return el(
    "label",
    {},
    label,
    el("input", { name, type, required: "", ...props }),
  );
}
function form(fields, onSubmit, label = "Сохранить", cls = "") {
  const error = el("p", { class: "error", role: "alert" });
  const submit = el("button", { type: "submit", class: "primary" }, label);
  const f = el(
    "form",
    {
      class: cls,
      onSubmit: async (e) => {
        e.preventDefault();
        error.textContent = "";
        submit.disabled = true;
        try {
          await onSubmit(Object.fromEntries(new FormData(f)));
        } catch (err) {
          error.textContent = err.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    fields,
    error,
    submit,
  );
  return f;
}
function dialog(title, contents) {
  const d = el(
    "dialog",
    {},
    button("×", () => d.close(), "dialog-close"),
    el("h2", {}, title),
    contents,
  );
  root.append(d);
  d.addEventListener("close", () => d.remove());
  d.querySelector(".dialog-close").setAttribute("aria-label", "Закрыть");
  d.showModal();
  return d;
}
async function copy(text) {
  await navigator.clipboard.writeText(text);
  notify("Скопировано");
}
function login() {
  me = null;
  root.replaceChildren(
    el(
      "div",
      { class: "login" },
      el(
        "div",
        {},
        el("div", { class: "brand" }, "OLM", el("span", {}, "ROUTER")),
        el("h1", {}, "Вход"),
        form(
          [
            field("Логин", "login", "text", {
              autocomplete: "username",
              autocapitalize: "none",
            }),
            field("Пароль", "password", "password", {
              autocomplete: "current-password",
            }),
          ],
          async (b) => {
            const d = await api("/api/login", "POST", b);
            csrf = d.csrf;
            me = d.user;
            await shell();
          },
          "Войти",
        ),
      ),
    ),
  );
}
async function refreshMe() {
  const d = await api("/api/me");
  me = d.user;
  csrf = d.csrf;
  me.tokenReserved = d.tokenReserved;
  me.configured = d.providerConfigured;
}
async function logout() {
  await api("/api/logout", "POST", {});
  login();
}
async function shell() {
  await refreshMe();
  const navs = [
    ["usage", "Потребление"],
    ["accounts", "Аккаунты"],
    ["keys", "API-ключи"],
    ["clients", "Подключение"],
    ["settings", "Настройки"],
  ];
  if (me.role !== "user") navs.push(["users", "Пользователи"]);
  const nav = el(
    "nav",
    { "aria-label": "Навигация" },
    navs.map(([id, label]) =>
      button(label, () => navigate(id), view === id ? "active" : ""),
    ),
  );
  const main = el("main", { id: "main" });
  root.replaceChildren(
    el(
      "div",
      { class: "layout" },
      el(
        "aside",
        { class: "sidebar" },
        el("div", { class: "brand" }, "OLM", el("span", {}, "ROUTER")),
        nav,
        el(
          "div",
          { class: "profile" },
          el("strong", {}, me.login),
          el("span", { class: "role" }, me.role),
          button("Выйти", logout),
        ),
      ),
      main,
    ),
  );
  await navigate(view);
}
async function navigate(next) {
  view = next;
  for (const b of document.querySelectorAll("nav button"))
    b.classList.toggle(
      "active",
      b.textContent ===
        {
          usage: "Потребление",
          accounts: "Аккаунты",
          keys: "API-ключи",
          clients: "Подключение",
          settings: "Настройки",
          users: "Пользователи",
        }[view],
    );
  const main = document.querySelector("main");
  main.replaceChildren(el("div", { class: "skeleton" }, "Загрузка…"));
  try {
    await {
      usage: usageView,
      accounts: accountsView,
      keys: keysView,
      clients: clientsView,
      settings: settingsView,
      users: usersView,
    }[view](main);
  } catch (e) {
    main.replaceChildren(
      el("h1", {}, "Не удалось загрузить"),
      el("p", { class: "error" }, e.message),
      button("Повторить", () => navigate(next)),
    );
  }
}
async function usageView(main) {
  await refreshMe();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const data = await api(
    `/api/usage?year=${month.getFullYear()}&month=${month.getMonth() + 1}&timezone=${encodeURIComponent(tz)}`,
  );
  const totals = Object.values(data.days).reduce(
    (a, d) => ({
      input: a.input + d.input,
      output: a.output + d.output,
      tokens: a.tokens + d.tokens,
      requests: a.requests + d.requests,
    }),
    { input: 0, output: 0, tokens: 0, requests: 0 },
  );
  const grid = el("div", { class: "calendar" });
  for (const d of ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"])
    grid.append(el("div", { class: "weekday" }, d));
  const start =
    (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7;
  for (let i = 0; i < start; i++) grid.append(el("div"));
  const detail = el(
    "div",
    { class: "day-detail", "aria-live": "polite" },
    "Выберите день",
  );
  const count = new Date(
    month.getFullYear(),
    month.getMonth() + 1,
    0,
  ).getDate();
  for (let day = 1; day <= count; day++) {
    const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const d = data.days[key];
    const b = button(
      "",
      () => {
        for (const b of grid.querySelectorAll("button"))
          b.classList.remove("selected");
        b.classList.add("selected");
        detail.textContent = d
          ? `${day} ${month.toLocaleDateString("ru-RU", { month: "long" })}: ${number(d.input)} входных, ${number(d.output)} выходных, всего ${number(d.tokens)} токенов${d.unknown ? " · Есть запросы без точного usage" : ""}`
          : `${day}: запросов нет`;
      },
      "day" + (d?.requests ? " used" : "") + (d?.requests > 20 ? " busy" : ""),
    );
    b.setAttribute("aria-label", `${day}, ${d?.requests || 0} запросов`);
    b.append(
      el("span", {}, day),
      el("small", {}, d ? number(d.input + d.output) : ""),
    );
    grid.append(b);
  }
  main.replaceChildren(
    el("h1", {}, "Потребление"),
    el(
      "div",
      { class: "summary" },
      el(
        "div",
        {},
        el("small", {}, "За месяц"),
        el("strong", {}, number(totals.tokens)),
        el("small", {}, "токенов за месяц"),
      ),
      el(
        "div",
        {},
        el("small", {}, "Входные"),
        el("strong", {}, number(totals.input)),
        el("small", {}, "токены"),
      ),
      el(
        "div",
        {},
        el("small", {}, "Выходные"),
        el("strong", {}, number(totals.output)),
        el("small", {}, "токены"),
      ),
    ),
    me.tokenReserved
      ? el(
          "p",
          { class: "note" },
          `Для активных запросов зарезервировано до ${number(me.tokenReserved)} токенов. Неопределённое потребление учитывается по верхней границе запроса.`,
        )
      : null,
    el(
      "section",
      { class: "panel" },
      el(
        "div",
        { class: "calendar-toolbar" },
        button("←", () => {
          month = new Date(month.getFullYear(), month.getMonth() - 1, 1);
          return navigate("usage");
        }),
        el(
          "h2",
          {},
          month.toLocaleDateString("ru-RU", { month: "long", year: "numeric" }),
        ),
        button("→", () => {
          month = new Date(month.getFullYear(), month.getMonth() + 1, 1);
          return navigate("usage");
        }),
      ),
      grid,
      detail,
      el("small", {}, tz),
    ),
    el(
      "section",
      { class: "panel" },
      el("h2", {}, "Последние запросы"),
      data.recent.length
        ? table(
            ["Модель", "Токены", "API-ключ", "Аккаунт", "Статус", "Время"],
            data.recent.map((u) => [
              u.model,
              u.state === "usage_unknown"
                ? u.tokens
                  ? `до ${number(u.tokens)} (оценка)`
                  : "Нет данных"
                : number(u.tokens),
              u.key_name || "Удалённый ключ",
              u.account_email || "Аккаунт удалён",
              u.state === "complete" ? "Завершён" : u.state,
              date(u.created),
            ]),
          )
        : el("div", { class: "empty" }, "Запросов пока нет"),
    ),
  );
}
function table(head, rows) {
  return el(
    "div",
    { class: "table-wrap" },
    el(
      "table",
      {},
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          head.map((h) => el("th", {}, h)),
        ),
      ),
      el(
        "tbody",
        {},
        rows.map((r) =>
          el(
            "tr",
            {},
            r.map((c) => el("td", {}, c)),
          ),
        ),
      ),
    ),
  );
}
async function connectGoogle() {
  const flow = await api("/api/accounts/oauth", "POST", {});
  let d;
  const content = el(
    "div",
    {},
    el("p", {}, "Войдите в Google, затем вернитесь сюда."),
  );
  d = dialog("Подключить Antigravity", content);
  const link = el(
    "a",
    {
      href: flow.url,
      ...(flow.mode === "loopback" ? { target: "_blank" } : {}),
      rel: "noreferrer",
    },
    "Открыть Google",
  );
  if (flow.mode === "web") {
    content.replaceChildren(
      el("p", {}, "После входа Google вернёт вас в кабинет."),
      link,
    );
    return;
  }
  content.append(
    link,
    el(
      "p",
      { class: "note" },
      "Google вернёт вас на localhost. Скопируйте полный адрес, даже если страница не открылась.",
    ),
    form(
      [
        field("Адрес возврата", "url", "url", {
          autocomplete: "off",
          placeholder: flow.redirectUri + "?code=…&state=…",
        }),
      ],
      async (b) => {
        const r = await api("/api/accounts/callback", "POST", b);
        d.close();
        notify(r.warning || "Аккаунт подключён");
        await refreshMe();
        await navigate("accounts");
      },
      "Подключить",
    ),
  );
}
async function accountsView(main) {
  const { accounts } = await api("/api/accounts");
  const list = el("section", { class: "panel" });
  if (!accounts.length)
    list.append(
      el(
        "div",
        { class: "empty" },
        "Подключите Google-аккаунт, чтобы привязать его модели к API-ключу.",
      ),
    );
  for (const a of accounts) {
    const quotas = el("div", { class: "quota" });
    for (const q of a.quota || []) {
      const meter = el("meter", {
        min: 0,
        max: 1,
        value: q.remaining ?? 0,
        "aria-label": q.name + " остаток квоты",
      });
      quotas.append(
        el(
          "div",
          {},
          el(
            "div",
            { class: "quota-line" },
            el("span", {}, q.name),
            meter,
            el(
              "span",
              {},
              q.remaining === null
                ? "н/д"
                : Math.round(q.remaining * 100) + "%",
            ),
          ),
          q.resetAt ? el("small", {}, "Сброс: " + date(q.resetAt)) : null,
        ),
      );
    }
    const actions = el(
      "div",
      { class: "actions" },
      a.enabled
        ? button("Обновить", async () => {
            await api(`/api/accounts/${a.id}/refresh`, "POST", {});
            await navigate("accounts");
          })
        : null,
    );
    if (a.enabled)
      actions.append(
        button(
          "Отключить",
          async () => {
            await api("/api/accounts/" + a.id, "DELETE", {});
            await navigate("accounts");
          },
          "danger",
        ),
      );
    list.append(
      el(
        "article",
        { class: "list-item" },
        el(
          "div",
          { class: "row wrap" },
          el(
            "div",
            {},
            el(
              "div",
              { class: "account-title" },
              a.email,
              el(
                "span",
                { class: "tag" },
                !a.enabled ? "Отключён" : "Подключён",
              ),
            ),
            el(
              "small",
              {},
              a.enabled && a.checked
                ? "Проверено " + date(a.checked)
                : a.enabled
                  ? "Квоты ещё не получены"
                  : "Подключение отключено",
            ),
          ),
          actions,
        ),
        quotas,
      ),
    );
  }
  main.replaceChildren(
    el(
      "div",
      { class: "topline" },
      el("h1", {}, "Аккаунты"),
      button("Подключить Google", connectGoogle, "primary"),
    ),
    list,
  );
}
function modelAccountSelect(accounts) {
  const options = accounts.flatMap((account) =>
    (account.quota || []).map((model) =>
      el(
        "option",
        { value: JSON.stringify([account.id, model.id]) },
        `${model.name || model.id} — ${account.email}`,
      ),
    ),
  );
  return el("select", { "data-assignment": "" }, options);
}
function assignmentEditor(accounts) {
  const rows = el("div", { class: "assignment-editor" });
  const add = () => rows.insertBefore(modelAccountSelect(accounts), control);
  const control = button("Добавить модель", add);
  rows.append(control);
  if (accounts.some((account) => (account.quota || []).length))
    add();
  return rows;
}
async function issueKeyDialog(target = null) {
  const { accounts } = target
    ? await api(`/api/admin/users/${target.id}/accounts`)
    : await api("/api/accounts");
  const available = accounts.some((account) => (account.quota || []).length);
  if (!available) {
    notify("Сначала подключите аккаунт и обновите его список моделей");
    return;
  }
  const assignments = assignmentEditor(accounts);
  let d;
  d = dialog(
    target ? `Выдать ключ: ${target.login}` : "Новый API-ключ",
    form(
      [
        field("Название", "name"),
        target
          ? field("Лимит токенов на весь срок ключа", "tokenLimit", "number", {
              min: 1,
              step: 1,
              inputmode: "numeric",
            })
          : el(
              "p",
              { class: "note" },
              "Ключ использует только выбранные модели и аккаунты. Внутреннего лимита нет, действуют квоты Google.",
            ),
        el(
          "fieldset",
          { class: "assignment-fields" },
          el("legend", {}, "Модель → аккаунт"),
          assignments,
          el(
            "small",
            {},
            "Каждая модель этого ключа всегда использует указанный аккаунт. Переключения на другие аккаунты нет.",
          ),
        ),
      ],
      async (b) => {
        const selected = [...assignments.querySelectorAll("select")].map(
          (select) => {
            const [accountId, model] = JSON.parse(select.value);
            return { accountId, model };
          },
        );
        const path = target
          ? `/api/admin/users/${target.id}/keys`
          : "/api/keys";
        const key = await api(path, "POST", {
          name: b.name,
          assignments: selected,
          ...(target ? { tokenLimit: Number(b.tokenLimit) } : {}),
        });
        d.close();
        await navigate(target ? "users" : "keys");
        dialog(
          "Сохраните API-ключ",
          el(
            "div",
            {},
            el("p", {}, "Полностью ключ показывается только один раз."),
            el("pre", { class: "code-key" }, key.key),
            button("Скопировать", () => copy(key.key)),
          ),
        );
      },
      "Создать ключ",
    ),
  );
}
async function keysView(main) {
  const { keys } = await api("/api/keys");
  const accountData = await api("/api/accounts");
  const canCreate = accountData.accounts.some((account) => (account.quota || []).length);
  main.replaceChildren(
    el(
      "div",
      { class: "topline" },
      el("h1", {}, "API-ключи"),
      canCreate
        ? button("Создать ключ", () => issueKeyDialog(), "primary")
        : null,
    ),
    el(
      "section",
      { class: "panel" },
      !canCreate
        ? el(
            "p",
            { class: "note" },
            "Подключите аккаунт и обновите модели в разделе «Аккаунты», прежде чем создавать ключ.",
          )
        : null,
      keys.length
        ? keys.map((k) =>
            el(
              "div",
              { class: "list-item row" },
              el(
                "div",
                {},
                el("strong", {}, k.name),
                el("div", { class: "muted" }, k.prefix + "…"),
                el("small", {}, date(k.created)),
                  el(
                    "div",
                    { class: "key-assignments" },
                    k.assignments.map((assignment) =>
                      el(
                        "div",
                        {},
                        `${assignment.model} → ${assignment.email}${assignment.enabled ? "" : " · аккаунт отключён"}`,
                      ),
                    ),
                  ),
                  el(
                    "small",
                    {},
                    k.tokenLimit === null
                      ? `${number(k.tokensUsed)} токенов использовано · лимит Google`
                      : `${number(k.tokensUsed)} из ${number(k.tokenLimit)} токенов использовано`,
                  ),
                  k.tokensReserved
                    ? el(
                        "small",
                        {},
                        `Зарезервировано: ${number(k.tokensReserved)} токенов`,
                      )
                    : null,
              ),
              button(
                "Отозвать",
                async () => {
                  await api("/api/keys/" + k.id, "DELETE", {});
                  await navigate("keys");
                },
                "danger",
              ),
            ),
          )
        : el(
            "div",
            { class: "empty" },
            "Создайте ключ для подключения клиента.",
          ),
    ),
  );
}
async function clientsView(main) {
  const { keys } = await api("/api/keys");
  const model = keys.flatMap((key) => key.assignments)[0]?.model || "MODEL_FROM_V1_MODELS";
  const tabs = el("div", { class: "client-tabs" }),
    code = el("pre"),
    desc = el("p", { class: "muted" });
  const examples = {
    "Claude Code": {
      text: `export ANTHROPIC_BASE_URL="https://api-olm.octx.space"\nexport ANTHROPIC_AUTH_TOKEN="YOUR_OLM_KEY"\nexport ANTHROPIC_MODEL="${model}"\nclaude --setting-sources ""`,
      note: "Anthropic Messages. Модель остаётся моделью Antigravity. OAuth Claude здесь не используется.",
    },
    OpenAI: {
      text: `curl https://api-olm.octx.space/v1/chat/completions \\\n  -H "Authorization: Bearer YOUR_OLM_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${model}","messages":[{"role":"user","content":"Привет"}],"max_tokens":1024,"stream":false}'`,
      note: "Chat Completions. Для Codex CLI ниже настроен Responses API с текстом, streaming и function tools.",
    },
    "Codex CLI": {
      text: `# ~/.codex/config.toml
model_provider = "olm"
model = "${model}"

[model_providers.olm]
name = "OLM Router"
base_url = "https://api-olm.octx.space/v1"
env_key = "OLM_API_KEY"
wire_api = "responses"

# В терминале задайте ключ:
export OLM_API_KEY="YOUR_OLM_KEY"`,
      note: "Вставьте настройки в ~/.codex/config.toml и задайте OLM_API_KEY. Поддерживаются Responses, текст, function tools и streaming.",
    },
    "Gemini API": {
      text: `curl 'https://api-olm.octx.space/v1beta/models/${model}:generateContent' \\\n  -H "x-goog-api-key: YOUR_OLM_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"contents":[{"role":"user","parts":[{"text":"Привет"}]}],"generationConfig":{"maxOutputTokens":1024}}'`,
      note: "Gemini generateContent и streamGenerateContent. Подписка Google AI Pro не включает Google Cloud API billing.",
    },
    "Gemini CLI": {
      text: `export GEMINI_API_KEY="YOUR_OLM_KEY"
export GOOGLE_GEMINI_BASE_URL="https://api-olm.octx.space"
export GOOGLE_GENAI_API_VERSION="v1beta"
gemini --model "${model}"`,
      note: "В /auth выберите API key. Проверено с Gemini CLI 0.61.0. Вход Google OAuth и Vertex billing у клиента используют другие маршруты.",
    },
    "AGY CLI": {
      text: `export OLM_API_KEY="YOUR_OLM_KEY"
# Необязательно для api-olm.octx.space:
export OLM_API_BASE_URL="https://api-olm.octx.space"
agy --model "${model}"`,
      note: "AGY CLI отправляет запросы и function tools через ваш OLM API-ключ. Удалите OLM_API_KEY, чтобы вернуться к собственному Google OAuth.",
    },
    "Другие клиенты": {
      text: `curl https://api-olm.octx.space/v1/models \\\n  -H "Authorization: Bearer YOUR_OLM_KEY"`,
      note: "Claude Desktop и Antigravity IDE требуют отдельной проверки версии и способа подключения.",
    },
  };
  const select = (name) => {
    code.textContent = examples[name].text;
    desc.textContent = examples[name].note;
    for (const b of tabs.children)
      b.classList.toggle("active", b.textContent === name);
  };
  for (const name of Object.keys(examples))
    tabs.append(button(name, () => select(name)));
  main.replaceChildren(
    el("h1", {}, "Подключение"),
    el(
      "section",
      { class: "panel" },
      tabs,
      desc,
      code,
      button("Скопировать", () => copy(code.textContent)),
    ),
    el(
      "p",
      { class: "note" },
      "Примеры используют ваш API-ключ. Список моделей появляется после подключения аккаунта и проверки квот. Совместимость с конкретными версиями клиентов проверяется отдельно.",
    ),
  );
  select("Claude Code");
}
async function settingsView(main) {
  main.replaceChildren(
    el("h1", {}, "Настройки"),
    el(
      "section",
      { class: "panel narrow" },
      el("h2", {}, "Пароль"),
      form(
        [
          field("Текущий пароль", "current", "password", {
            autocomplete: "current-password",
          }),
          field("Новый пароль", "password", "password", {
            autocomplete: "new-password",
            minlength: 12,
          }),
        ],
        async (b) => {
          await api("/api/password", "POST", b);
          notify("Пароль изменён. Войдите заново");
          login();
        },
        "Изменить",
      ),
    ),
    button("Выйти из аккаунта", logout),
  );
}
async function usersView(main) {
  const { users } = await api("/api/admin/users");
  main.replaceChildren(
    el(
      "div",
      { class: "topline" },
      el("h1", {}, "Пользователи"),
      button(
        "Создать пользователя",
        () => {
          let d;
          d = dialog(
            "Новый пользователь",
            form(
              [
                field("Логин", "login", "text", {
                  pattern: "[a-z0-9][a-z0-9_.-]{2,39}",
                  autocomplete: "off",
                }),
                field("Пароль", "password", "password", {
                  minlength: 12,
                  autocomplete: "new-password",
                }),
                me.role === "superadmin"
                  ? el(
                      "label",
                      {},
                      "Роль",
                      el(
                        "select",
                        { name: "role" },
                        el("option", { value: "user" }, "user"),
                        el("option", { value: "admin" }, "admin"),
                      ),
                    )
                  : null,
              ],
              async (b) => {
                await api("/api/admin/users", "POST", b);
                d.close();
                await navigate("users");
              },
              "Создать",
            ),
          );
        },
        "primary",
      ),
    ),
    el(
      "section",
      { class: "panel" },
      table(
        ["Логин", "Роль", "API-ключи", "Всего токенов", "Доступ", ""],
        users.map((u) => [
          u.login,
          u.role,
          number(u.keyCount),
          u.reservedTokens
            ? `${number(u.tokenUsage)} (+${number(u.reservedTokens)} в работе)`
            : number(u.tokenUsage),
          u.enabled ? "Открыт" : "Закрыт",
          u.id === me.id
            ? ""
            : el(
                "div",
                { class: "actions" },
                button("Ключи", async () => {
                  let keyDialog;
                  const { keys } = await api(`/api/admin/users/${u.id}/keys`);
                  keyDialog = dialog(
                    `API-ключи: ${u.login}`,
                    keys.length
                      ? el(
                          "div",
                          {},
                          keys.map((key) =>
                            el(
                              "article",
                              { class: "list-item" },
                              el(
                                "div",
                                { class: "row wrap" },
                                el(
                                  "div",
                                  {},
                                  el("strong", {}, key.name),
                                  el(
                                    "div",
                                    { class: "muted" },
                                    `${key.prefix}… · ${number(key.tokensUsed)} из ${key.tokenLimit === null ? "∞" : number(key.tokenLimit)} токенов${key.tokensReserved ? ` · ${number(key.tokensReserved)} в работе` : ""}`,
                                  ),
                                  key.assignments.map((assignment) =>
                                    el(
                                      "small",
                                      {},
                                      `${assignment.model} → ${assignment.email}${assignment.enabled ? "" : " · отключён"}`,
                                    ),
                                  ),
                                ),
                                button(
                                  "Отозвать",
                                  async () => {
                                    await api(
                                      `/api/admin/users/${u.id}/keys/${key.id}`,
                                      "DELETE",
                                      {},
                                    );
                                    notify("Ключ отозван");
                                    keyDialog.close();
                                    await navigate("users");
                                  },
                                  "danger",
                                ),
                              ),
                            ),
                          ),
                        )
                      : el("p", { class: "empty" }, "Ключей пока нет"),
                  );
                }),
                u.enabled
                  ? button("Выдать ключ", () => issueKeyDialog(u), "primary")
                  : null,
                button(u.enabled ? "Отключить" : "Включить", async () => {
                  await api("/api/admin/users/" + u.id, "PATCH", {
                    enabled: !u.enabled,
                  });
                  await navigate("users");
                }),
              ),
        ]),
      ),
    ),
  );
}
const oauthResult = new URLSearchParams(location.search).get("oauth");
if (["connected", "warning", "cancelled", "failed"].includes(oauthResult))
  history.replaceState(null, "", location.pathname);
refreshMe()
  .then(async () => {
    await shell();
    if (oauthResult) {
      await navigate("accounts");
      notify(
        {
          connected: "Google-аккаунт подключён",
          warning: "Аккаунт подключён, проверка квот не завершилась",
          cancelled: "Вход в Google отменён",
          failed: "Не удалось подключить аккаунт Google",
        }[oauthResult],
      );
    }
  })
  .catch(() => login());
