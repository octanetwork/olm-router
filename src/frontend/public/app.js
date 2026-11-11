const root = document.querySelector("#app");
let me,
  csrf,
  view = "usage",
  month = new Date(),
  noticeTimer;
const credit = (n) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 6 }).format(
    (n || 0) / 1e6,
  );
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
  me.reserved = d.reserved;
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
  if (me.role === "superadmin") navs.push(["prices", "Цены и сверка"]);
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
          prices: "Цены и сверка",
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
      prices: pricesView,
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
      credits: a.credits + d.credits,
      requests: a.requests + d.requests,
    }),
    { input: 0, output: 0, credits: 0, requests: 0 },
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
          ? `${day} ${month.toLocaleDateString("ru-RU", { month: "long" })}: ${number(d.input)} входных, ${number(d.output)} выходных токенов · ${credit(d.credits)} credits${d.unknown ? " · Есть запросы без точного usage" : ""}`
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
        el("small", {}, "Баланс"),
        el("strong", {}, credit(me.balance)),
        el("small", {}, "credits"),
      ),
      el(
        "div",
        {},
        el("small", {}, "За месяц"),
        el("strong", {}, number(totals.input + totals.output)),
        el("small", {}, "токенов"),
      ),
      el(
        "div",
        {},
        el("small", {}, "Списано"),
        el("strong", {}, credit(totals.credits)),
        el("small", {}, "credits"),
      ),
    ),
    me.reserved
      ? el(
          "p",
          { class: "note" },
          `В резерве ${credit(me.reserved)} credits. Запросы без итогового usage проверяет superadmin.`,
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
            ["Модель", "Токены", "Источник", "Credits", "Время"],
            data.recent.map((u) => [
              u.model,
              u.input === null ? "Нет данных" : number(u.input + u.output),
              u.source === "own" ? "Свой аккаунт" : "Общий пул",
              credit(u.credits) + (u.state === "reconcile" ? " · сверка" : ""),
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
  let d;
  const content = el(
    "div",
    {},
    el("p", {}, "Войдите в Google, затем вернитесь сюда."),
  );
  d = dialog("Подключить Antigravity", content);
  const flow = await api("/api/accounts/oauth", "POST", {});
  content.append(
    el(
      "a",
      { href: flow.url, target: "_blank", rel: "noopener noreferrer" },
      "Открыть Google",
    ),
    el(
      "p",
      { class: "note" },
      flow.mode === "loopback"
        ? "После входа Google откроет localhost. Скопируйте полный адрес из адресной строки, даже если страница недоступна."
        : "Скопируйте полный адрес возврата Google.",
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
        "Подключите свой аккаунт. Credits за его использование не списываются.",
      ),
    );
  for (const a of accounts) {
    const active = me.settings.accountId === a.id;
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
        ? button(active ? "Выбран" : "Выбрать", async () => {
            await api("/api/settings", "PATCH", {
              ...me.settings,
              accountId: a.id,
            });
            await refreshMe();
            await navigate("accounts");
          })
        : null,
      a.enabled
        ? button("Обновить", async () => {
            await api(`/api/accounts/${a.id}/refresh`, "POST", {});
            await navigate("accounts");
          })
        : null,
    );
    if (me.role !== "user" && a.enabled)
      actions.append(
        button(a.shared ? "Убрать из пула" : "В общий пул", async () => {
          await api("/api/accounts/" + a.id, "PATCH", { shared: !a.shared });
          await navigate("accounts");
        }),
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
                !a.enabled ? "Отключён" : a.shared ? "Общий пул" : "Приватный",
              ),
            ),
            el(
              "small",
              {},
              a.checked
                ? "Проверено " + date(a.checked)
                : "Квоты ещё не получены",
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
    form(
      [
        el(
          "label",
          {},
          "Когда квота закончится",
          el(
            "select",
            { name: "mode" },
            el(
              "option",
              {
                value: "stop",
                selected: me.settings.mode === "stop" ? "" : undefined,
              },
              "Остановить (Deadswitch)",
            ),
            el(
              "option",
              {
                value: "auto",
                selected: me.settings.mode === "auto" ? "" : undefined,
              },
              "Переключить на мой следующий аккаунт",
            ),
          ),
        ),
        el(
          "label",
          { class: "checkbox" },
          el("input", {
            type: "checkbox",
            name: "sharedFallback",
            checked: me.settings.sharedFallback,
          }),
          "Разрешить общий пул со списанием credits",
        ),
      ],
      async (b) => {
        await api("/api/settings", "PATCH", {
          ...me.settings,
          mode: b.mode,
          sharedFallback: b.sharedFallback === "on",
        });
        await refreshMe();
        notify("Настройки сохранены");
      },
      "Сохранить",
      "narrow",
    ),
  );
}
async function keysView(main) {
  const { keys } = await api("/api/keys");
  main.replaceChildren(
    el(
      "div",
      { class: "topline" },
      el("h1", {}, "API-ключи"),
      button(
        "Создать ключ",
        () => {
          const d = dialog(
            "Новый API-ключ",
            form(
              [field("Название", "name")],
              async (b) => {
                const k = await api("/api/keys", "POST", b);
                d.close();
                await navigate("keys");
                dialog(
                  "Сохраните ключ",
                  el(
                    "div",
                    {},
                    el("p", {}, "Полностью он показывается только сейчас."),
                    el("pre", { class: "code-key" }, k.key),
                    button("Скопировать", () => copy(k.key)),
                  ),
                );
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
  const { accounts } = await api("/api/accounts");
  const model =
    accounts.flatMap((a) => a.quota || [])[0]?.id || "MODEL_FROM_V1_MODELS";
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
      note: "Для совместимого клиента: base URL https://api-olm.octx.space/v1. Поддерживаются Chat Completions, streaming и инструменты. Responses пока недоступен.",
    },
    "Gemini API": {
      text: `curl 'https://api-olm.octx.space/v1beta/models/${model}:generateContent' \\\n  -H "x-api-key: YOUR_OLM_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"contents":[{"role":"user","parts":[{"text":"Привет"}]}],"generationConfig":{"maxOutputTokens":1024}}'`,
      note: "Gemini generateContent и streamGenerateContent. Подписка Google AI Pro не включает Google Cloud API billing.",
    },
    "Другие клиенты": {
      text: `curl https://api-olm.octx.space/v1/models \\\n  -H "Authorization: Bearer YOUR_OLM_KEY"`,
      note: "Claude Desktop, Gemini CLI и Antigravity IDE требуют отдельной проверки версии и способа входа. Их Google/Anthropic OAuth нельзя заменить адресом этого API. Пока не заявлены как совместимые.",
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
        ["Логин", "Роль", "Credits", "Доступ", ""],
        users.map((u) => [
          u.login,
          u.role,
          credit(u.balance),
          u.enabled ? "Открыт" : "Закрыт",
          u.id === me.id
            ? ""
            : el(
                "div",
                { class: "actions" },
                button("Выдать credits", () => {
                  let d;
                  d = dialog(
                    "Credits: " + u.login,
                    form(
                      [
                        field("Количество credits", "amount", "number", {
                          min: 0.000001,
                          step: 0.000001,
                        }),
                        field("Причина", "reason"),
                      ],
                      async (b) => {
                        await api(`/api/admin/users/${u.id}/credits`, "POST", {
                          amount: Math.round(Number(b.amount) * 1e6),
                          reason: b.reason,
                        });
                        d.close();
                        await navigate("users");
                      },
                      "Выдать",
                    ),
                  );
                }),
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
async function pricesView(main) {
  const [{ prices }, { reservations }] = await Promise.all([
    api("/api/admin/prices"),
    api("/api/admin/reconcile"),
  ]);
  main.replaceChildren(
    el("h1", {}, "Цены и сверка"),
    el(
      "section",
      { class: "panel" },
      el("h2", {}, "Credits за миллион токенов"),
      prices.length
        ? table(
            ["Модель", "Вход", "Выход"],
            prices.map((p) => [p.model, credit(p.input), credit(p.output)]),
          )
        : el(
            "p",
            { class: "empty" },
            "Без цены модель недоступна в общем пуле.",
          ),
      form(
        [
          field("Модель", "model"),
          field("Input credits / 1M", "input", "number", {
            min: 0.000001,
            step: 0.000001,
          }),
          field("Output credits / 1M", "output", "number", {
            min: 0.000001,
            step: 0.000001,
          }),
        ],
        async (b) => {
          await api("/api/admin/prices", "POST", {
            model: b.model,
            input: Math.round(Number(b.input) * 1e6),
            output: Math.round(Number(b.output) * 1e6),
          });
          await navigate("prices");
        },
        "Сохранить",
        "inline-form",
      ),
    ),
    el(
      "section",
      { class: "panel" },
      el("h2", {}, "Запросы на сверку"),
      reservations.length
        ? reservations.map((r) =>
            el(
              "div",
              { class: "list-item row" },
              el(
                "div",
                {},
                el("strong", {}, r.login),
                el("div", {}, credit(r.amount) + " credits в резерве"),
                el("small", {}, date(r.created)),
              ),
              button("Сверить", () => {
                let d;
                d = dialog(
                  "Итоговое списание",
                  form(
                    [
                      field("Credits", "cost", "number", {
                        min: 0,
                        max: r.amount / 1e6,
                        step: 0.000001,
                      }),
                    ],
                    async (b) => {
                      await api("/api/admin/reconcile", "POST", {
                        id: r.id,
                        cost: Math.round(Number(b.cost) * 1e6),
                      });
                      d.close();
                      await navigate("prices");
                    },
                    "Подтвердить",
                  ),
                );
              }),
            ),
          )
        : el("p", { class: "empty" }, "Сверка не требуется."),
    ),
  );
}
refreshMe()
  .then(shell)
  .catch(() => login());
