import { Store } from "../src/core/store.mjs";
import { Antigravity } from "../src/core/provider.mjs";
const store = new Store(process.env.DATA_DIR, process.env.OLM_ENCRYPTION_KEY),
  provider = new Antigravity(store);
try {
  for (const a of store.db
    .prepare("SELECT * FROM accounts WHERE enabled=1")
    .all()) {
    const models = await provider.discover(a, AbortSignal.timeout(30000));
    console.log(
      JSON.stringify({
        account: store.accountSafe(a).email,
        models: models.map((m) => ({
          id: m.id,
          remaining: m.remaining,
          resetAt: m.resetAt,
        })),
      }),
    );
  }
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
} catch (e) {
  console.error(e.status ? e.message : "Provider connection failed");
  process.exitCode = 1;
} finally {
  store.db.close();
}
