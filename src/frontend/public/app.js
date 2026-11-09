// OLM Router Web Panel Client Logic

async function loadStatus() {
  try {
    const res = await fetch("/api/admin/status");
    if (!res.ok) throw new Error("Status check failed");
    const data = await res.json();

    // 1. Google Account
    const accEl = document.getElementById("google-account-info");
    const authBtn = document.getElementById("google-auth-btn");

    if (data.googleAccount && data.googleAccount.email) {
      accEl.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 0.5rem;">
          <span style="color:#10b981; font-weight:600;">✓ Connected</span>
          <span style="font-family:var(--font-mono); font-size:0.8rem; color:var(--text-muted);">${data.googleAccount.projectId}</span>
        </div>
        <div style="font-size:1.05rem; font-weight:700; color:#fff;">${data.googleAccount.email}</div>
      `;
      authBtn.innerText = "Re-connect Account";
      authBtn.className = "btn btn-secondary";
    } else {
      accEl.innerHTML = `
        <div style="color:var(--warning); margin-bottom:0.5rem;">⚠ Not Connected</div>
        <div style="font-size:0.9rem; color:var(--text-secondary);">Authenticate with Google to enable Antigravity Gemini 3.8/3.5 models.</div>
      `;
      authBtn.innerText = "Connect Google Account";
      authBtn.className = "btn";
    }

    // 2. Upstream Proxies
    const proxyListEl = document.getElementById("proxy-list");
    if (proxyListEl && Array.isArray(data.proxies)) {
      proxyListEl.innerHTML = data.proxies.map(p => `
        <div class="model-item">
          <div>
            <div class="model-name">${p.url}</div>
            <div class="model-target">Successes: ${p.successes} | Failures: ${p.failures}</div>
          </div>
          <span class="domain-tag ${p.available ? 'tag-api' : 'tag-wapi'}">${p.available ? 'Active' : 'Cooldown'}</span>
        </div>
      `).join("");
    }
  } catch (err) {
    console.warn("loadStatus error:", err);
  }
}

async function loadModels() {
  try {
    const res = await fetch("/v1/models");
    if (!res.ok) return;
    const { data: models } = await res.json();
    const listEl = document.getElementById("models-list");
    if (listEl && Array.isArray(models)) {
      listEl.innerHTML = models.map(m => `
        <div class="model-item">
          <div>
            <div class="model-name">${m.id}</div>
            <div class="model-target">${m.display_name} (${m.provider})</div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="selectModelForTest('${m.id}')">Test</button>
        </div>
      `).join("");
    }
  } catch (_) {}
}

async function loadKeys() {
  try {
    const res = await fetch("/api/admin/keys");
    if (!res.ok) return;
    const { keys } = await res.json();
    const tableEl = document.getElementById("keys-list");
    if (tableEl && Array.isArray(keys)) {
      if (keys.length === 0) {
        tableEl.innerHTML = `<div style="color:var(--text-muted); font-size:0.85rem; padding:1rem 0;">No API keys generated yet. Click "Generate Key" above.</div>`;
        return;
      }
      tableEl.innerHTML = keys.map(k => `
        <div class="model-item" style="margin-bottom:0.5rem;">
          <div>
            <div class="model-name" style="font-size:0.9rem;">${k.name}</div>
            <div style="font-family:var(--font-mono); font-size:0.8rem; color:var(--accent);">${k.key}</div>
            <div class="model-target">Tier: ${k.tier} | RPM: ${k.maxRpm}</div>
          </div>
          <button class="btn btn-secondary btn-sm" style="color:var(--danger);" onclick="revokeKey('${k.key}')">Revoke</button>
        </div>
      `).join("");
    }
  } catch (_) {}
}

async function createNewKey() {
  const name = prompt("Key label (e.g. Claude Desktop, Work Mac, Bot):", "My Client Key");
  if (!name) return;
  try {
    const res = await fetch("/api/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    if (res.ok) {
      loadKeys();
    }
  } catch (e) {
    alert("Failed to create key: " + e.message);
  }
}

async function revokeKey(key) {
  if (!confirm("Revoke this key?")) return;
  try {
    await fetch(`/api/admin/keys?key=${encodeURIComponent(key)}`, { method: "DELETE" });
    loadKeys();
  } catch (e) {
    alert("Error revoking: " + e.message);
  }
}

function selectModelForTest(modelId) {
  const sel = document.getElementById("test-model");
  if (sel) sel.value = modelId;
}

async function runPromptTest() {
  const model = document.getElementById("test-model").value;
  const prompt = document.getElementById("test-prompt").value;
  const out = document.getElementById("test-output");
  const btn = document.getElementById("test-run-btn");

  if (!prompt.trim()) return;

  btn.disabled = true;
  btn.innerText = "Generating...";
  out.innerText = "Connecting to OLM Router...";

  try {
    const res = await fetch("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        max_tokens: 1024
      })
    });

    if (!res.ok) {
      const err = await res.text();
      out.innerText = `Error (${res.status}): ${err}`;
      return;
    }

    out.innerText = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (raw === "[DONE]") continue;
        try {
          const json = JSON.parse(raw);
          if (json.type === "content_block_delta" && json.delta?.text) {
            out.innerText += json.delta.text;
          }
        } catch (_) {}
      }
    }
  } catch (err) {
    out.innerText = "Fetch error: " + err.message;
  } finally {
    btn.disabled = false;
    btn.innerText = "Send Request";
  }
}

function copyCode(btn, elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  navigator.clipboard.writeText(el.innerText).then(() => {
    const orig = btn.innerText;
    btn.innerText = "Copied!";
    setTimeout(() => { btn.innerText = orig; }, 1500);
  });
}

function switchTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach(c => c.style.display = "none");
  const btn = document.getElementById(`tab-btn-${tabId}`);
  const content = document.getElementById(`tab-content-${tabId}`);
  if (btn) btn.classList.add("active");
  if (content) content.style.display = "block";
}

document.addEventListener("DOMContentLoaded", () => {
  loadStatus();
  loadModels();
  loadKeys();
  setInterval(loadStatus, 10000);
});
