import fs from "node:fs";
import { Store, requireThat } from "../src/core/store.mjs";
const store = new Store(process.env.DATA_DIR, process.env.OLM_ENCRYPTION_KEY);
try {
  if (process.argv[2]) await store.bootstrap(process.argv[2]);
  if (process.argv[3]) {
    const source = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
    const accounts =
      source.accounts ||
      (source.account ? [source.account] : Array.isArray(source) ? source : []);
    const account = accounts[source.activeIndex ?? 0];
    requireThat(
      account?.refreshToken,
      400,
      "В выбранном аккаунте нет refresh token",
    );
    const owner = store.db
      .prepare("SELECT id FROM users WHERE login='octadmin'")
      .get();
    requireThat(owner, 400, "Сначала создайте владельца");
    const a = store.saveAccount(owner.id, account);
    console.log("Imported account:", a.email);
  }
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  console.log("Provisioning complete");
} finally {
  store.db.close();
}
