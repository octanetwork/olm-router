import { Store } from "../src/core/store.mjs";
import { Antigravity, events } from "../src/core/provider.mjs";
const store = new Store(process.env.DATA_DIR, process.env.OLM_ENCRYPTION_KEY),
  provider = new Antigravity(store);
try {
  const a = store.db
    .prepare("SELECT * FROM accounts WHERE enabled=1 LIMIT 1")
    .get();
  const model = process.argv[2] || "gemini-3.8-flash-low";
  const request = provider.convert(
    {
      messages: [{ role: "user", content: "Reply with OK only." }],
      max_tokens: 128,
    },
    a.id,
  );
  const r = await provider.generate(
    a,
    model,
    request,
    AbortSignal.timeout(60000),
  );
  let text = "",
    usage = null;
  for await (const raw of events(r.body)) {
    const d = raw.response || raw;
    for (const p of d.candidates?.[0]?.content?.parts || [])
      if (p.text && !p.thought) text += p.text;
    if (d.usageMetadata) usage = d.usageMetadata;
  }
  console.log(JSON.stringify({ model, text, usage }));
} catch (e) {
  console.error(e.status ? e.message : "Smoke failed");
  process.exitCode = 1;
} finally {
  store.db.close();
}
