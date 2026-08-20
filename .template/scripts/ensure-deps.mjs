// Template commands (pnpm flavor / pnpm bootstrap) run through tsx, a devDependency — but
// agents reach for them straight after cloning, before anyone said "pnpm install". Install
// on demand instead of failing with "tsx: command not found".
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tsxBin = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));

if (!existsSync(tsxBin) && !existsSync(`${tsxBin}.cmd`)) {
  console.log("Dependencies are not installed yet — running pnpm install first.");
  const result = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["install"], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error("pnpm install failed; fix that first, then rerun this command.");
    process.exit(result.status ?? 1);
  }
}
