import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
const scrypt = promisify(scryptCb);
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
export class Fault extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const requireThat = (condition, status, message) => {
  if (!condition) throw new Fault(status, message);
};
export class Store {
  constructor(dir, encryptionKey) {
    requireThat(
      /^[a-f0-9]{64}$/i.test(encryptionKey || ""),
      503,
      "Требуется ключ шифрования OLM_ENCRYPTION_KEY",
    );
    process.umask(0o077);
    this.key = Buffer.from(encryptionKey, "hex");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dir, "olm.sqlite"));
    fs.chmodSync(path.join(dir, "olm.sqlite"), 0o600);
    // Keep legacy billing fields in place for existing databases; inference no longer uses them.
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, login TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','admin','superadmin')), manager TEXT REFERENCES users(id), enabled INTEGER NOT NULL DEFAULT 1, balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0), settings TEXT NOT NULL DEFAULT '{"mode":"stop","accountId":null,"sharedFallback":false}');
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, prefix TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), email TEXT NOT NULL, credentials TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, quota TEXT, checked INTEGER, cooldown INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), actor TEXT, delta INTEGER NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL, model TEXT NOT NULL, source TEXT NOT NULL, input INTEGER, output INTEGER, credits INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), amount INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth(state TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), session_hash TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, actor TEXT, action TEXT NOT NULL, target TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cooldowns(account_id TEXT NOT NULL, model TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY(account_id,model));
      CREATE TABLE IF NOT EXISTS prices(model TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_user_date ON usage(user_id,created);`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_key_policies(
        api_key_id TEXT PRIMARY KEY REFERENCES api_keys(id) ON DELETE CASCADE,
        token_limit INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        issued_by TEXT,
        model_policy_migrated INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS api_key_models(
        api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        PRIMARY KEY(api_key_id,model)
      );
      CREATE TABLE IF NOT EXISTS usage_details(
        usage_id TEXT PRIMARY KEY REFERENCES usage(id) ON DELETE CASCADE,
        api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
        tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS token_reservations(
        id TEXT PRIMARY KEY,
        api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        amount INTEGER NOT NULL,
        created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_key_index ON usage_details(api_key_id,usage_id);
    `);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO api_key_policies(api_key_id) SELECT id FROM api_keys",
      )
      .run();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO usage_details(usage_id,tokens) SELECT id,coalesce(input,0)+coalesce(output,0) FROM usage",
      )
      .run();
    this.migrateLegacyKeyModels();
  }
  migrateLegacyKeyModels() {
    const keys = this.db
      .prepare(
        "SELECT k.id,k.user_id,u.settings FROM api_keys k JOIN users u ON u.id=k.user_id JOIN api_key_policies p ON p.api_key_id=k.id WHERE p.model_policy_migrated=0",
      )
      .all();
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO api_key_models(api_key_id,model,account_id) VALUES(?,?,?)",
    );
    for (const key of keys) {
      if (
        !this.db
          .prepare("SELECT 1 FROM api_key_models WHERE api_key_id=? LIMIT 1")
          .get(key.id)
      ) {
        const settings = JSON.parse(key.settings || "{}");
        const accounts = this.db
          .prepare(
            "SELECT id,quota FROM accounts WHERE user_id=? AND enabled=1 ORDER BY id",
          )
          .all(key.user_id);
        accounts.sort(
          (a, b) =>
            Number(b.id === settings.accountId) -
            Number(a.id === settings.accountId),
        );
        const assigned = new Set();
        for (const account of accounts) {
          for (const model of JSON.parse(account.quota || "[]")) {
            if (!model?.id || assigned.has(model.id)) continue;
            insert.run(key.id, model.id, account.id);
            assigned.add(model.id);
          }
        }
      }
      this.db
        .prepare(
          "UPDATE api_key_policies SET model_policy_migrated=1 WHERE api_key_id=?",
        )
        .run(key.id);
    }
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  audit(actor, action, target = null) {
    this.db
      .prepare("INSERT INTO audit(actor,action,target,created) VALUES(?,?,?,?)")
      .run(actor, action, target, Date.now());
  }
  seal(value) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
  }
  unseal(value) {
    const b = Buffer.from(value, "base64");
    const c = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    c.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([c.update(b.subarray(28)), c.final()]).toString(),
    );
  }
  async passwordHash(password, salt = secret()) {
    requireThat(
      typeof password === "string" &&
        password.length >= 12 &&
        password.length <= 256,
      400,
      "Пароль должен содержать от 12 до 256 символов",
    );
    const hash = await scrypt(password, salt, 64, {
      N: 32768,
      r: 8,
      p: 3,
      maxmem: 64 * 1024 * 1024,
    });
    return `s3:${salt}:${hash.toString("hex")}`;
  }
  async passwordMatches(password, stored) {
    if (typeof password !== "string" || password.length > 256) return false;
    const parts = stored.split(":");
    const modern = parts[0] === "s3";
    const [salt, hex] = modern ? parts.slice(1) : parts;
    const hash = await scrypt(password, salt, 64, {
      N: 32768,
      r: 8,
      p: modern ? 3 : 1,
      maxmem: 64 * 1024 * 1024,
    });
    return timingSafeEqual(hash, Buffer.from(hex, "hex"));
  }
  user(id) {
    return this.db
      .prepare("SELECT * FROM users WHERE id=? AND enabled=1")
      .get(id);
  }
  publicUser(user) {
    const { password, balance, settings, ...safe } = user;
    return safe;
  }
  canManage(actor, target) {
    return (
      actor.role === "superadmin" ||
      (actor.role === "admin" &&
        target.role === "user" &&
        target.manager === actor.id)
    );
  }
  async createUser(actor, { login, password, role = "user" }) {
    requireThat(
      typeof login === "string" && /^[a-z0-9][a-z0-9_.-]{2,39}$/.test(login),
      400,
      "Логин: от 3 до 40 латинских букв, цифр или ._-",
    );
    requireThat(
      ["user", "admin"].includes(role) &&
        (actor.role === "superadmin" ||
          (actor.role === "admin" && role === "user")),
      403,
      "Недостаточно прав",
    );
    const hash = await this.passwordHash(password);
    const id = secret();
    requireThat(this.user(actor.id), 403, "Недостаточно прав");
    requireThat(
      !this.db.prepare("SELECT id FROM users WHERE login=?").get(login),
      409,
      "Логин занят",
    );
    this.db
      .prepare(
        "INSERT INTO users(id,login,password,role,manager) VALUES(?,?,?,?,?)",
      )
      .run(id, login, hash, role, actor.id);
    this.audit(actor.id, "user.create", id);
    return this.publicUser(this.user(id));
  }
  async bootstrap(file) {
    if (!file) return;
    const list = JSON.parse(fs.readFileSync(file, "utf8"));
    requireThat(
      Array.isArray(list) && list.length <= 10,
      400,
      "Неверный bootstrap",
    );
    for (const u of list) {
      if (this.db.prepare("SELECT id FROM users WHERE login=?").get(u.login))
        continue;
      requireThat(
        ["superadmin", "admin"].includes(u.role),
        400,
        "Неверная bootstrap-роль",
      );
      this.db
        .prepare("INSERT INTO users(id,login,password,role) VALUES(?,?,?,?)")
        .run(secret(), u.login, await this.passwordHash(u.password), u.role);
    }
    fs.unlinkSync(file);
  }
  async login(login, password) {
    const user =
      typeof login === "string"
        ? this.db
            .prepare("SELECT * FROM users WHERE login=?")
            .get(login.toLowerCase())
        : null;
    const dummy = "s3:olm-dummy-salt:" + "00".repeat(64);
    const valid = await this.passwordMatches(password, user?.password || dummy);
    if (!valid || !user || !this.user(user.id)) {
      this.audit(null, "session.failed", digest(String(login)));
      throw new Fault(401, "Неверный логин или пароль");
    }
    if (!user.password.startsWith("s3:")) {
      user.password = await this.passwordHash(password);
      this.db
        .prepare("UPDATE users SET password=? WHERE id=?")
        .run(user.password, user.id);
    }
    const token = secret();
    const csrf = secret();
    const hash = digest(token);
    this.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
      .run(hash, user.id, csrf, Date.now() + 12 * 3600 * 1000);
    this.audit(user.id, "session.create");
    return { token, csrf, user: this.publicUser(user) };
  }
  session(token) {
    if (!token) return null;
    const s = this.db
      .prepare("SELECT * FROM sessions WHERE hash=? AND expires>?")
      .get(digest(token), Date.now());
    if (!s) return null;
    const user = this.user(s.user_id);
    return user ? { ...s, user } : null;
  }
  apiKey(token) {
    if (!token) return null;
    const k = this.db
      .prepare(
        "SELECT k.*,p.token_limit,p.tokens_used,p.issued_by FROM api_keys k JOIN api_key_policies p ON p.api_key_id=k.id WHERE k.hash=?",
      )
      .get(digest(token));
    if (!k) return null;
    const user = this.user(k.user_id);
    return user ? { ...k, user } : null;
  }
  createKey(user, { name, assignments, tokenLimit = null, issuedBy = user.id }) {
    requireThat(this.user(user.id), 403, "Учётная запись отключена");
    requireThat(
      typeof name === "string" && name.trim().length > 0 && name.length <= 80,
      400,
      "Укажите название ключа",
    );
    requireThat(
      Array.isArray(assignments) && assignments.length > 0 && assignments.length <= 100,
      400,
      "Добавьте хотя бы одну пару «модель → аккаунт»",
    );
    requireThat(
      tokenLimit === null ||
        (Number.isSafeInteger(tokenLimit) && tokenLimit > 0 && tokenLimit <= 1e12),
      400,
      "Лимит токенов должен быть положительным целым числом",
    );
    const seen = new Set();
    for (const item of assignments) {
      requireThat(
        item &&
          typeof item.model === "string" &&
          item.model.length > 0 &&
          item.model.length <= 150 &&
          typeof item.accountId === "string" &&
          !seen.has(item.model),
        400,
        "Проверьте выбранные модели и аккаунты",
      );
      const account = this.db
        .prepare("SELECT * FROM accounts WHERE id=? AND user_id=? AND enabled=1")
        .get(item.accountId, user.id);
      requireThat(account, 400, "Выбранный аккаунт недоступен этому пользователю");
      requireThat(
        JSON.parse(account.quota || "[]").some((model) => model.id === item.model),
        400,
        "Выбранная модель отсутствует в квотах аккаунта",
      );
      seen.add(item.model);
    }
    requireThat(
      this.db
        .prepare("SELECT count(*) AS n FROM api_keys WHERE user_id=?")
        .get(user.id).n < 30,
      400,
      "Не больше 30 ключей",
    );
    const key = "olm_live_" + secret();
    const id = secret();
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO api_keys VALUES(?,?,?,?,?,?)",
        )
        .run(
          id,
          digest(key),
          user.id,
          name.trim(),
          key.slice(0, 17),
          Date.now(),
        );
      this.db
        .prepare(
          "INSERT INTO api_key_policies(api_key_id,token_limit,tokens_used,issued_by,model_policy_migrated) VALUES(?,?,0,?,1)",
        )
        .run(id, tokenLimit, issuedBy);
      const insert = this.db.prepare(
        "INSERT INTO api_key_models(api_key_id,model,account_id) VALUES(?,?,?)",
      );
      for (const item of assignments)
        insert.run(id, item.model, item.accountId);
    });
    this.audit(user.id, "key.create", id);
    if (issuedBy !== user.id) this.audit(issuedBy, "key.issue", id);
    return { id, key, name: name.trim(), tokenLimit, assignments };
  }
  keyModels(id) {
    return this.db
      .prepare(
        "SELECT m.model,m.account_id AS accountId,a.email,a.enabled,a.quota FROM api_key_models m JOIN accounts a ON a.id=m.account_id WHERE m.api_key_id=? ORDER BY m.model",
      )
      .all(id)
      .map((item) => ({
        model: item.model,
        accountId: item.accountId,
        email: item.email,
        enabled: Boolean(item.enabled),
        models: JSON.parse(item.quota || "[]").map((model) => model.id),
      }));
  }
  reserveKeyTokens(apiKey, amount, id) {
    requireThat(
      Number.isSafeInteger(amount) && amount > 0,
      400,
      "Не удалось оценить объём запроса",
    );
    this.transaction(() => {
      const current = this.db
        .prepare(
          "SELECT p.token_limit,p.tokens_used,coalesce(sum(r.amount),0) AS reserved FROM api_key_policies p LEFT JOIN token_reservations r ON r.api_key_id=p.api_key_id WHERE p.api_key_id=? GROUP BY p.api_key_id",
        )
        .get(apiKey.id);
      requireThat(current, 401, "API-ключ отозван");
      requireThat(
        current.token_limit === null ||
          current.tokens_used + current.reserved + amount <= current.token_limit,
        429,
        "Запрос превышает остаток лимита токенов этого API-ключа",
      );
      this.db
        .prepare("INSERT INTO token_reservations VALUES(?,?,?,?)")
        .run(id, apiKey.id, amount, Date.now());
    });
  }
  settleKeyTokens(id, tokens, { input = null, output = null, state = "complete" } = {}) {
    requireThat(
      Number.isSafeInteger(tokens) && tokens >= 0,
      500,
      "Некорректное количество токенов",
    );
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT api_key_id FROM token_reservations WHERE id=?")
        .get(id);
      const apiKeyId =
        row?.api_key_id ||
        this.db
          .prepare("SELECT api_key_id FROM usage_details WHERE usage_id=?")
          .get(id)
          ?.api_key_id;
      if (apiKeyId) {
        this.db
          .prepare(
            "UPDATE api_key_policies SET tokens_used=tokens_used+? WHERE api_key_id=?",
          )
          .run(tokens, apiKeyId);
      }
      this.db
        .prepare(
          "UPDATE usage SET input=?,output=?,state=? WHERE id=?",
        )
        .run(input, output, state, id);
      this.db
        .prepare("UPDATE usage_details SET tokens=? WHERE usage_id=?")
        .run(tokens, id);
      this.db.prepare("DELETE FROM token_reservations WHERE id=?").run(id);
    });
  }
  releaseKeyTokens(id) {
    this.db.prepare("DELETE FROM token_reservations WHERE id=?").run(id);
  }
  accountSafe(a) {
    const [name, domain] = a.email.split("@");
    const { credentials, email, ...rest } = a;
    return {
      ...rest,
      email: `**${name.slice(-4)}@${domain}`,
      quota: a.enabled && a.quota ? JSON.parse(a.quota) : null,
    };
  }
  accountCredentials(a) {
    const data = this.unseal(a.credentials);
    return {
      refreshToken: data.refreshToken,
      projectId: data.projectId,
      oauthClient: data.oauthClient || "desktop",
    };
  }
  saveAccount(userId, data) {
    const owner = this.user(userId);
    requireThat(owner, 403, "Учётная запись отключена");
    requireThat(
      typeof data.email === "string" &&
        data.email.includes("@") &&
        data.refreshToken,
      400,
      "Неверный аккаунт",
    );
    const old = this.db
      .prepare("SELECT * FROM accounts WHERE user_id=?")
      .all(userId)
      .find((a) => a.email === data.email);
    requireThat(
      old ||
        this.db
          .prepare(
            "SELECT count(*) AS n FROM accounts WHERE user_id=? AND enabled=1",
          )
          .get(userId).n < 10,
      400,
      "Не больше десяти активных аккаунтов",
    );
    const id = old?.id || secret();
    this.db
      .prepare(
        "INSERT INTO accounts(id,user_id,email,credentials) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET credentials=excluded.credentials, enabled=1, quota=NULL, checked=NULL",
      )
      .run(
        id,
        userId,
        data.email,
        this.seal({
          refreshToken: data.refreshToken,
          projectId: data.projectId,
          oauthClient: data.oauthClient || "desktop",
        }),
      );
    const settings = JSON.parse(owner.settings);
    if (!settings.accountId)
      this.db
        .prepare("UPDATE users SET settings=? WHERE id=?")
        .run(JSON.stringify({ ...settings, accountId: id }), userId);
    this.audit(userId, "account.connect", id);
    return this.accountSafe(
      this.db.prepare("SELECT * FROM accounts WHERE id=?").get(id),
    );
  }
}
