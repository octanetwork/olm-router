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
    const { password, ...safe } = user;
    return { ...safe, settings: JSON.parse(safe.settings) };
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
      .prepare("SELECT * FROM api_keys WHERE hash=?")
      .get(digest(token));
    if (!k) return null;
    const user = this.user(k.user_id);
    return user ? { ...k, user } : null;
  }
  createKey(user, name) {
    requireThat(
      typeof name === "string" && name.trim().length > 0 && name.length <= 80,
      400,
      "Укажите название ключа",
    );
    requireThat(
      this.db
        .prepare("SELECT count(*) AS n FROM api_keys WHERE user_id=?")
        .get(user.id).n < 30,
      400,
      "Не больше 30 ключей",
    );
    const key = "olm_live_" + secret();
    const id = secret();
    this.db
      .prepare("INSERT INTO api_keys VALUES(?,?,?,?,?,?)")
      .run(id, digest(key), user.id, name, key.slice(0, 17), Date.now());
    this.audit(user.id, "key.create", id);
    return { id, key, name };
  }
  transfer(actor, targetId, amount, reason) {
    requireThat(
      Number.isSafeInteger(amount) && amount > 0 && amount <= 1e12,
      400,
      "Неверное количество credits",
    );
    requireThat(
      typeof reason === "string" &&
        reason.trim().length > 0 &&
        reason.length <= 200,
      400,
      "Укажите причину",
    );
    this.transaction(() => {
      const target = this.user(targetId);
      requireThat(
        target && this.canManage(actor, target) && target.id !== actor.id,
        403,
        "Нет доступа к пользователю",
      );
      requireThat(
        target.balance <= 1e15 - amount,
        400,
        "Превышен предел баланса",
      );
      if (actor.role !== "superadmin") {
        const n = this.db
          .prepare(
            "UPDATE users SET balance=balance-? WHERE id=? AND balance>=?",
          )
          .run(amount, actor.id, amount);
        requireThat(n.changes === 1, 402, "Недостаточно credits в бюджете");
        this.ledger(actor.id, actor.id, -amount, reason);
      }
      this.db
        .prepare("UPDATE users SET balance=balance+? WHERE id=?")
        .run(amount, targetId);
      this.ledger(targetId, actor.id, amount, reason);
      this.audit(actor.id, "credits.transfer", targetId);
    });
  }
  ledger(userId, actor, amount, reason) {
    this.db
      .prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?)")
      .run(secret(), userId, actor, amount, reason, Date.now());
  }
  reserve(userId, amount, id) {
    this.transaction(() => {
      const r = this.db
        .prepare(
          "UPDATE users SET balance=balance-? WHERE id=? AND enabled=1 AND balance>=?",
        )
        .run(amount, userId, amount);
      requireThat(r.changes === 1, 402, "Недостаточно credits");
      this.db
        .prepare("INSERT INTO reservations VALUES(?,?,?,?)")
        .run(id, userId, amount, Date.now());
    });
  }
  settle(id, cost, usage) {
    this.transaction(() => {
      const r = this.db
        .prepare("SELECT * FROM reservations WHERE id=?")
        .get(id);
      if (!r) return;
      requireThat(
        Number.isSafeInteger(cost) && cost >= 0 && cost <= r.amount,
        500,
        "Расход превысил резерв",
      );
      this.db
        .prepare("UPDATE users SET balance=balance+? WHERE id=?")
        .run(r.amount - cost, r.user_id);
      if (cost) this.ledger(r.user_id, null, -cost, "inference:" + id);
      if (usage) {
        this.db
          .prepare(
            "UPDATE usage SET input=?,output=?,credits=?,state=? WHERE id=?",
          )
          .run(usage.input, usage.output, cost, usage.state, id);
      }
      this.db.prepare("DELETE FROM reservations WHERE id=?").run(id);
    });
  }
  accountSafe(a) {
    const [name, domain] = a.email.split("@");
    const { credentials, email, ...rest } = a;
    return {
      ...rest,
      email: `**${name.slice(-4)}@${domain}`,
      quota: a.quota ? JSON.parse(a.quota) : null,
    };
  }
  accountCredentials(a) {
    return { ...a, ...this.unseal(a.credentials) };
  }
  saveAccount(userId, data) {
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
    const id = old?.id || secret();
    this.db
      .prepare(
        "INSERT INTO accounts(id,user_id,email,credentials) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET credentials=excluded.credentials, enabled=1",
      )
      .run(id, userId, data.email, this.seal(data));
    this.audit(userId, "account.connect", id);
    return this.accountSafe(
      this.db.prepare("SELECT * FROM accounts WHERE id=?").get(id),
    );
  }
}
