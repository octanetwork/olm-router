import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const LOCAL_ACCOUNTS_FILE = path.resolve(process.env.DATA_DIR || "./data", "accounts.json");
const CLAUDE_ANTIGRAVITY_ACCOUNTS = path.join(HOME, ".config", "claude-antigravity", "accounts.json");
const OPENCODE_ACCOUNTS_FILE = path.join(HOME, ".config", "opencode", "antigravity-accounts.json");

export class AccountManager {
  constructor() {
    this.ensureDataDir();
  }

  ensureDataDir() {
    const dir = path.dirname(LOCAL_ACCOUNTS_FILE);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (_) {}
    }
  }

  loadAccounts() {
    // 1. Try local data file
    try {
      if (fs.existsSync(LOCAL_ACCOUNTS_FILE)) {
        const raw = fs.readFileSync(LOCAL_ACCOUNTS_FILE, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.account || parsed.accounts)) {
          return {
            account: parsed.account || (parsed.accounts && parsed.accounts[0]),
            accounts: parsed.accounts || (parsed.account ? [parsed.account] : [])
          };
        }
      }
    } catch (e) {
      console.warn("[AccountManager] Error reading local accounts:", e.message);
    }

    // 2. Try claude-antigravity accounts
    try {
      if (fs.existsSync(CLAUDE_ANTIGRAVITY_ACCOUNTS)) {
        const raw = fs.readFileSync(CLAUDE_ANTIGRAVITY_ACCOUNTS, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.account || parsed.accounts)) {
          return {
            account: parsed.account || (parsed.accounts && parsed.accounts[0]),
            accounts: parsed.accounts || (parsed.account ? [parsed.account] : [])
          };
        }
      }
    } catch (_) {}

    // 3. Try opencode accounts
    try {
      if (fs.existsSync(OPENCODE_ACCOUNTS_FILE)) {
        const raw = fs.readFileSync(OPENCODE_ACCOUNTS_FILE, "utf8");
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : (parsed.accounts || []);
        if (list.length > 0) {
          return {
            account: list[0],
            accounts: list
          };
        }
      }
    } catch (_) {}

    return { account: null, accounts: [] };
  }

  saveAccount(newAccount) {
    this.ensureDataDir();
    const current = this.loadAccounts();
    const existingIndex = current.accounts.findIndex(a => a.email === newAccount.email);
    if (existingIndex >= 0) {
      current.accounts[existingIndex] = { ...current.accounts[existingIndex], ...newAccount };
    } else {
      current.accounts.push(newAccount);
    }
    current.account = newAccount;

    fs.writeFileSync(LOCAL_ACCOUNTS_FILE, JSON.stringify(current, null, 2), "utf8");
    return current;
  }

  setActiveAccount(email) {
    const current = this.loadAccounts();
    const found = current.accounts.find(a => a.email === email);
    if (found) {
      current.account = found;
      fs.writeFileSync(LOCAL_ACCOUNTS_FILE, JSON.stringify(current, null, 2), "utf8");
      return found;
    }
    return null;
  }
}

export const accountManager = new AccountManager();
