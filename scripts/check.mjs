import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.m?js$/.test(name))
      execFileSync(process.execPath, ["--check", p], { stdio: "inherit" });
  }
}
walk("src");
walk("scripts");
walk("test");
console.log("Syntax checks passed");
