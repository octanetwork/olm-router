# OLM Router

Закрытый кабинет и API для доступа к моделям Antigravity. Сервис работает на VPS без запущенного Claude Desktop и без зависимости от Mac владельца.

- Кабинет: `https://olm.octx.space`
- API: `https://api-olm.octx.space`
- Требования к изменениям: [AGENTS.md](AGENTS.md)

Регистрация закрыта. Superadmin создаёт администраторов и пользователей; администраторы управляют только своими пользователями и выдают им API-ключи с лимитом токенов. Пользователь также может создать собственный ключ для своих Google-аккаунтов. Вход в кабинет отделён от подключения Google.

## Аккаунты и лимиты

Каждый API-ключ содержит явный список пар «модель → Google-аккаунт». При создании ключа пользователь или администратор выбирает обе части для каждой модели. `GET /v1/models` показывает только назначенные ключу модели. Запрос всегда идёт через закреплённый аккаунт; автоматического переключения на другие подключённые или общие аккаунты нет.

Если квота закреплённой модели исчерпана, запрос останавливается. Чтобы использовать другой аккаунт, нужно назначить его в новом API-ключе. Отключённый аккаунт сразу перестаёт отдавать модели, а его устаревшая квота очищается.

Модели и квоты запрашиваются у провайдера, обновляются каждые пять минут и по кнопке. Отсутствующее значение не заменяется вымышленным процентом. Из выдачи исключаются внутренние, отключённые и модели генерации изображений, для которых адаптер не реализован.

## Учёт токенов

Платежей и денежных credits нет. Один учётный токен равен одному токену, который сообщил провайдер; суммируются вход и выход, reasoning входит в выход. Лимит, который администратор задаёт при выпуске ключа, действует на весь срок его жизни без автоматического сброса. Собственные ключи пользователя не имеют внутреннего лимита и ограничены квотами подключённых Google-аккаунтов.

Для ключа с лимитом сервис заранее считает входные токены и резервирует максимум ответа. По завершении списывается фактическое потребление. Если провайдер не вернул точный расход либо запрос оборвался после отправки, используется зарезервированный максимум; это не позволяет параллельным запросам превысить лимит. Неопределённое потребление помечается в истории. Для ключа без внутреннего лимита неизвестное значение остаётся без вымышленной оценки.

Календарь группирует запросы по часовому поясу браузера. Пользователь видит помесячное потребление; администратор видит суммарное потребление пользователей и детали выданных ключей. Промпты и ответы в БД не сохраняются. Хранятся модель, назначенный аккаунт, токены, состояние запроса и время.

## Подключение клиентов

Создайте ключ в кабинете. Полностью он показывается один раз. Реальные ID моделей вернёт:

```sh
curl https://api-olm.octx.space/v1/models \
  -H 'Authorization: Bearer YOUR_OLM_KEY'
```

### Anthropic Messages

```sh
curl https://api-olm.octx.space/v1/messages \
  -H 'x-api-key: YOUR_OLM_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"MODEL_FROM_V1_MODELS","max_tokens":1024,"stream":false,"messages":[{"role":"user","content":"Привет"}]}'
```

Для streaming установите `stream: true`. В адаптере Anthropic/OpenAI системные инструкции, включая сообщения `role: system` из новых клиентов, кодируются в первом пользовательском turn по схеме исходного моста. Это отличается от нативного `systemInstruction` Gemini и позволяет избежать наблюдавшихся 429 на этом поле. Поддерживаются текст, входные base64-изображения, инструменты с приведением JSON Schema к подмножеству Gemini, tool results и сохранение thought signatures в пределах аккаунта, API-ключа и процесса. После перезапуска продолжение старого tool-цикла с подписями может потребовать нового диалога.

### Claude Code

```sh
export ANTHROPIC_BASE_URL='https://api-olm.octx.space'
export ANTHROPIC_AUTH_TOKEN='YOUR_OLM_KEY'
export ANTHROPIC_MODEL='MODEL_FROM_V1_MODELS'
claude --setting-sources ""
```

Если в прежнем `settings.json` уже задан другой gateway, используйте отдельный профиль или запуск с `--setting-sources ""`, чтобы его переменные не переопределяли OLM.

Это подключение через формат Anthropic, а не вход Claude OAuth. Реальная модель остаётся моделью Antigravity. Anthropic описывает [подключение gateways](https://code.claude.com/docs/en/llm-gateway), но не поддерживает использование Claude Code с моделями других производителей. Версию клиента и результат отдельной проверки фиксируем в deployment-артефакте.

### OpenAI Chat Completions

Base URL для совместимого SDK: `https://api-olm.octx.space/v1`.

```sh
curl https://api-olm.octx.space/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_OLM_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"MODEL_FROM_V1_MODELS","max_tokens":1024,"stream":false,"messages":[{"role":"user","content":"Привет"}]}'
```

Streaming и function tools преобразуются в формат OpenAI. Responses API не реализован и возвращает 404. Для изображений используйте Anthropic или Gemini endpoint.

### Gemini generateContent

```sh
curl 'https://api-olm.octx.space/v1beta/models/MODEL_FROM_V1_MODELS:generateContent' \
  -H 'x-goog-api-key: YOUR_OLM_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"Привет"}]}],"generationConfig":{"maxOutputTokens":1024}}'
```

Для SSE используйте `:streamGenerateContent?alt=sse`. Этот API не превращает подписку Google AI Pro в оплаченный Google Cloud billing project. У Google API [отдельный порядок биллинга](https://ai.google.dev/gemini-api/docs/billing).

### Gemini CLI

```sh
export GEMINI_API_KEY='YOUR_OLM_KEY'
export GOOGLE_GEMINI_BASE_URL='https://api-olm.octx.space'
export GOOGLE_GENAI_API_VERSION='v1beta'
gemini --model 'MODEL_FROM_V1_MODELS'
```

Выберите API key в `/auth`. Это поддерживаемый [способ указания base URL](https://geminicli.com/docs/reference/configuration/), проверенный с Gemini CLI 0.61.0. Режимы Login with Google и Vertex AI не направляют авторизацию в OLM. Локальный `agy` на Mac является запускателем OmniCode; его нельзя считать стандартным Gemini CLI или обещать ему замену Google OAuth без отдельной настройки.

Нативный SDK использует `x-goog-api-key`. Endpoint `:countTokens` считает входной запрос, включая системные инструкции и описания инструментов, и не изменяет счётчик использования.

### Матрица

| Клиент или формат | Способ доступа | Статус |
| --- | --- | --- |
| Anthropic Messages | OLM API-ключ | Проверен с настоящим upstream: обычный ответ, SSE, tool roundtrip |
| OpenAI Chat Completions | OLM API-ключ | Проверен обычный ответ; формат SSE и tools покрыт тестами |
| Gemini generateContent | OLM API-ключ | Проверен обычный ответ |
| Gemini streamGenerateContent | OLM API-ключ | Реализован, требуется отдельный smoke test |
| Claude Code 2.1.319 | Base URL и OLM API-ключ | Проверены ответ и реальный вызов Read с возвратом результата в изолированном профиле |
| Claude Desktop | Зависит от версии приложения | Не заявлен как совместимый; вымышленных настроек конфигурации нет |
| Gemini CLI 0.61.0 | OLM API-ключ, GOOGLE_GEMINI_BASE_URL | Проверен реальный запрос в изолированном профиле |
| Antigravity IDE / OmniCode agy | Зависит от режима и версии | Google OAuth этих приложений не эмулируется |
| OpenAI Responses | OLM API-ключ | Не реализован |

## Google OAuth

Используется authorization code + PKCE S256, одноразовый state с TTL 10 минут, привязанный к сессии владельца. Пароль вводится только на странице Google. Refresh tokens зашифрованы AES-256-GCM, bearer-ключи и сессии хранятся в виде SHA-256-хешей. Пароли хешируются scrypt с уникальной солью.

Для входа из production-кабинета используйте отдельный Google OAuth client типа **Web application**. Укажите в нём точный Authorized redirect URI `https://olm.octx.space/oauth/google/callback`, затем задайте `ANTIGRAVITY_WEB_CLIENT_ID` и `ANTIGRAVITY_WEB_CLIENT_SECRET` в закрытом production `.env`. После входа Google вернёт браузер в кабинет. Не добавляйте этот HTTPS адрес в desktop-клиент: тип клиента и redirect URI должны совпадать.

`ANTIGRAVITY_CLIENT_ID`, `ANTIGRAVITY_CLIENT_SECRET` и `ANTIGRAVITY_REDIRECT_URI` остаются настройками desktop-клиента. Они нужны для уже связанных аккаунтов и loopback-резерва. При новом входе выбранный OAuth-клиент записывается в зашифрованные credentials аккаунта, поэтому добавление web-клиента не меняет способ обновления ранее связанных refresh tokens. Пока web-клиент не настроен, кабинет предлагает desktop loopback flow с ручным возвратом адреса.

Google проверяет точное совпадение redirect URI с настройкой OAuth-клиента. Для hosted web flow это должен быть HTTPS адрес из Google Cloud Console. См. [OAuth для web-приложений](https://developers.google.com/identity/protocols/oauth2/web-server) и [OAuth для desktop-приложений](https://developers.google.com/identity/protocols/oauth2/native-app).

Шифрование не скрывает данные от администратора VPS, имеющего доступ одновременно к БД и ключу шифрования. MFA пока не реализован; не считать эту версию соответствующей корпоративному профилю ASVS или ГОСТ.

## Разработка

Node.js 24 или новее:

```sh
npm ci --ignore-scripts
npm test
npm run lint
npm run build
```

Для локального запуска задайте `DATA_DIR`, `OLM_ENCRYPTION_KEY` (64 hex), `OLM_PANEL_ORIGIN`, OAuth client ID/secret и `OLM_PROXY_ROUTES`. Маршруты перечисляются через запятую; `direct` разрешён только как явно выбранный маршрут. Production compose использует только отдельный `olm-egress`.

```sh
node --env-file=/private/path/olm.env scripts/provision.mjs /private/path/bootstrap.json
node --env-file=/private/path/olm.env src/server.mjs
```

Bootstrap-файл содержит массив `{login,password,role}`, создаёт только отсутствующих пользователей и удаляется после успешного применения. Отдельный разрешённый импорт активного аккаунта OpenCode:

```sh
node --env-file=/private/path/olm.env scripts/provision.mjs '' /private/path/antigravity-accounts.json
```

Не направляйте тесты на production data. Старые модули `src/api/claude.mjs`, `src/api/openai.mjs`, `src/core/oauth.mjs` и прежние security/provider-модули не подключены новым сервером и не включаются в production-образ. Существующий WIP в них сохранён.

## Production

Compose поднимает только OLM и отдельный Xray egress. Порт приложения публикуется на `127.0.0.1:18045`. Caddy подключается через существующую `remnawave-network`; доверенный IP Caddy задаётся точно, без доверия ко всем private ranges. Общий Caddy не заменяется: добавляются два site-блока из `config/caddy/Caddyfile` после backup и validation.

`.env`, `egress.json`, данные и резервные копии исключены из Git и build context. Секреты не включаются в образ. Образ Node закреплён digest, npm использует lockfile. SQLite WAL рассчитан на один экземпляр приложения на этом VPS. Для нескольких процессов нужна отдельная архитектура очередей, лимитов и сверки резервов.

Перед обновлением сделайте online backup SQLite, отдельно сохраните ключ шифрования, закрепите работающий image и подготовьте rollback. Перезапуск Docker daemon, бота, Remnawave и существующих proxy не требуется. Результаты развёртывания и откат: `../artifacts/20261111-olm-router/README.md`.
