# OLM Router (Octa Network)

> **Universal LLM Gateway with Google OAuth Antigravity, multi-provider failover, Claude Code API, protection & web panel.**

OLM Router is an enterprise-grade LLM routing and proxy engine built for the Octa ecosystem. It originates from the Antigravity session **"Claude Code Google OAuth Integration"**, evolving into a standalone microservice featuring frontend management, multi-provider resilience, and LTE whitelist protection.

---

## 🌐 Domains Architecture

| Domain | Type | Purpose | Features |
| :--- | :--- | :--- | :--- |
| **`olm.octx.space`** | Web Panel | Main management dashboard | One-click Google OAuth login, account switcher, API key management, client configs, real-time playground. |
| **`api-olm.octx.space`** | Primary API | High-performance inference endpoint | Full Claude Code (`/v1/messages`), OpenAI (`/v1/chat/completions`), token counting, SSE streaming, multi-provider routing. |
| **`wapi-olm.octx.space`** | LTE Reserve | Emergency whitelisted IP gateway | Direct IP routing bypass, TSPU/mobile carrier block resilience, priority request queue, optimized TCP keepalive. |

---

## ⚡ Features & Capabilities

1. **Google Antigravity OAuth Bridge**:
   - Native integration with Google Cloud Code / Antigravity (`https://daily-cloudcode-pa.googleapis.com`).
   - Supports **Gemini 3.8 Flash**, **Gemini 3.8 Flash-Lite**, and **Thinking Level/Budget** controls (`low`, `medium`, `high`, `max`).
   - Thought signatures preservation (`signatureStore`) for seamless multi-turn tool loops.
   - Inject system instructions into the first turn to prevent Cloud Code PA `systemInstruction` 429 quota exhaustion.
   - Automatic token refresh and Google Cloud project ID discovery.

2. **Claude Code Full Emulation**:
   - 100% compatible with Claude Code CLI and Claude Desktop (`/v1/messages`, `/v1/models`, `/v1/messages/count_tokens`, `/api/claude_cli/bootstrap`).
   - Convert Anthropic tool use & result structures into Google Gemini function calling and back into Anthropic SSE stream events.

3. **Multi-Provider Fallback**:
   - **Google Antigravity**: Gemini 3.8 Flash, Flash-Lite, Thinking.
   - **Alibaba Qwen**: Qwen 2.5 Coder 32B, Qwen Max, QwQ Reasoning.
   - **DeepSeek AI**: DeepSeek Chat V3, DeepSeek Reasoner R1.
   - **CheapVibeCode**: Custom gateway proxy.
   - **Nvidia NIM**: Llama 3.3 70B Instruct, Mistral.

4. **Security & Protection Layer ("Защита")**:
   - **Sliding-window Rate Limiter**: Configurable requests per minute, burst protection, automatic temporary ban on abusive clients.
   - **IP & CIDR Firewall**: Whitelist and blacklist filtering.
   - **LTE Whitelist Mode (`wapi-olm.octx.space`)**: Priority access with `x-olm-lte-bypass` support for restricted mobile networks.
   - **Anti-DDoS & Payload Protection**: Request size capping (20MB default), malicious User-Agent blocking.
   - **API Key Guard**: Generate, track, and revoke client API keys (`olm_live_...`).

5. **Context Compaction Engine**:
   - Intelligent token budgeting (`compactAnthropicMessages`) prevents upstream context overflow errors by pruning historical tool outputs while keeping system prompts and active conversation state intact.

---

## 🚀 Quick Start

### 1. Local Run

```bash
cd olm-router
npm install
npm start
```

Default port is `8045`. Access the dashboard at `http://localhost:8045`.

### 2. Docker & Docker Compose

```bash
docker compose up -d
```

---

## 🛠 Client Integration Guides

### Claude Code CLI

```bash
export ANTHROPIC_BASE_URL="https://api-olm.octx.space"
export ANTHROPIC_API_KEY="olm_live_your_api_key"
claude
```

### Claude Desktop (`claude_desktop_config.json`)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "inferenceGateways": {
    "default": {
      "baseUrl": "https://api-olm.octx.space",
      "apiKey": "olm_live_your_api_key"
    }
  }
}
```

### LTE Emergency Whitelist Access (`wapi`)

When standard API traffic is throttled by mobile operators or TSPU:

```bash
export ANTHROPIC_BASE_URL="https://wapi-olm.octx.space"
export ANTHROPIC_API_KEY="olm_live_your_api_key"
export ANTHROPIC_CUSTOM_HEADERS="x-olm-lte-bypass: octa-lte-emergency"
claude
```

### Cursor / OpenAI Clients

- **Base URL**: `https://api-olm.octx.space/v1`
- **API Key**: `olm_live_your_api_key`
- **Models**: `claude-3-8-flash`, `claude-qn-coder`, `claude-seek-r1`

---

## 📁 Repository Structure

```
olm-router/
├── config/
│   ├── domains.json          # Domain topology definition
│   ├── providers.json        # Provider configurations
│   ├── security.json         # Firewall, rate limits & whitelist rules
│   └── caddy/Caddyfile       # Caddy reverse proxy config with auto-TLS
├── src/
│   ├── server.mjs            # Main HTTP server & host dispatcher
│   ├── core/
│   │   ├── oauth.mjs         # Google Antigravity OAuth flow & token management
│   │   ├── accounts.mjs      # Account persistence & switching
│   │   ├── context.mjs       # Context compaction & token budgeting
│   │   └── proxy.mjs         # Upstream proxy pool (Xray/SOCKS5/HTTP) & failover
│   ├── providers/
│   │   ├── antigravity.mjs   # Google Cloud Code Gemini engine & tool conversion
│   │   ├── qwen.mjs          # Alibaba DashScope adapter
│   │   ├── deepseek.mjs      # DeepSeek V3/R1 adapter
│   │   ├── cheapvibecode.mjs # CheapVibeCode gateway adapter
│   │   ├── nvidia.mjs        # Nvidia NIM adapter
│   │   └── registry.mjs      # Unified model resolver
│   ├── security/
│   │   ├── firewall.mjs      # IP filtering, LTE whitelist check & anti-DDoS
│   │   ├── ratelimit.mjs     # Sliding window rate limiter
│   │   ├── auth-guard.mjs    # API key generation & validation
│   │   └── cors.mjs          # CORS & security headers
│   ├── api/
│   │   ├── claude.mjs        # Anthropic /v1/messages compatible endpoints
│   │   ├── openai.mjs        # OpenAI /v1/chat/completions compatible endpoints
│   │   └── admin.mjs         # Admin metrics, key management & status
│   └── frontend/
│       ├── public/           # Web panel assets (index.html, styles.css, app.js)
│       └── serve.mjs         # Static asset streaming handler
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md
```

---

## 📜 License & Attribution

Part of the **Octa Network** ecosystem. Created by `@genkauzen`. MIT License.
