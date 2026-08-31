import { execFileSync, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

// Post-clone bootstrap (run as `pnpm bootstrap`, or by create-cen-app). One-time by design:
// refuses to run twice and is deleted by `pnpm flavor finalize`.
// ("setup" would shadow pnpm's own builtin `pnpm setup` command — don't rename it back.)
// Usage: pnpm bootstrap [--name <project-name>] [--brand <display-name>]
//                       [--preset <id> | --flavors <a,b|none>]

const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const { resolveContainerEngine } = require("../../scripts/container-engine.cjs") as {
  resolveContainerEngine(options?: { required?: boolean }): "docker" | "podman" | undefined;
};

const args = process.argv.slice(2);
type Preset = { id: string; label: string; description: string; flavors: string[] };
type PresetCatalog = { schemaVersion: number; defaultPreset: string; presets: Preset[] };

function flag(name: string) {
  const index = args.indexOf(`--${name}`);
  return index !== -1 ? args[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function run(command: string, argv: string[], opts: { allowFail?: boolean } = {}) {
  const result = spawnSync(command, argv, { cwd: root, stdio: "inherit" });
  if (result.status !== 0 && !opts.allowFail) fail(`${command} ${argv.join(" ")} failed.`);
  return result.status === 0;
}

function titleCase(value: string) {
  return value
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function kebabCase(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tryGit(argv: string[]) {
  try {
    return execFileSync("git", argv, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const catalog = JSON.parse(
    await readFile(path.join(root, ".template/presets.json"), "utf8"),
  ) as PresetCatalog;

  if (args.includes("--list-presets")) {
    if (args.includes("--json")) console.log(JSON.stringify(catalog, null, 2));
    else {
      for (const preset of catalog.presets) {
        const marker = preset.id === catalog.defaultPreset ? " (default)" : "";
        console.log(`${preset.id}${marker}\n  ${preset.label}\n  ${preset.description}`);
      }
    }
    return;
  }

  // --- refuse to run twice -----------------------------------------------
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  if (pkg.cen?.finalized) fail("This project is finalized — setup no longer applies.");
  if (pkg.cen?.bootstrapped) fail("Bootstrap already ran here. Continue with `pnpm dev`.");

  // --- preflight ----------------------------------------------------------
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) fail(`Node ≥ 22 required (found ${process.versions.node}). Use nvm or mise.`);
  if (spawnSync("pnpm", ["--version"], { stdio: "ignore" }).status !== 0) {
    fail("pnpm not found. Enable it with `corepack enable` and re-run.");
  }
  try {
    process.loadEnvFile(path.join(root, ".env"));
  } catch {
    // A fresh clone does not have .env yet; auto-detection remains the default.
  }
  const containerEngine = resolveContainerEngine({ required: false });
  if (!containerEngine) {
    console.warn(
      "⚠ Docker or Podman is not ready. The default stack needs a container engine for\n" +
        "  the dev database — start one and ensure its Compose provider is installed\n" +
        "  before `pnpm dev` (not needed if you apply the no-database flavor).",
    );
  }

  // Answers come from readline's async iterator, not question(): with piped stdin,
  // question() drops lines that arrive while no question is pending, silently answering
  // later questions wrong. The iterator queues every line, and EOF fails loudly.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator]();
  async function ask(prompt: string): Promise<string> {
    process.stdout.write(prompt);
    const next = await lines.next();
    if (next.done) {
      fail(
        "Input ended before the setup questions were answered — for non-interactive use pass --name and --flavors.",
      );
    }
    return next.value;
  }

  // --- app name -------------------------------------------------------------
  // The display name ("CEN Starter" in the layout headers, tab title, API docs title,
  // Dex login screen) is the question; the package name is derived from it. Flags stay
  // authoritative for agents and scripts. After bootstrap the brand lives as plain
  // strings in the app code — rebrand later by editing those.
  let name = flag("name");
  let brand = flag("brand")?.trim();
  if (!name) {
    const directoryName = path.basename(root);
    const suggestion = directoryName === "cen-starter" ? "" : titleCase(directoryName);
    const prompt = suggestion
      ? `App name [${suggestion}]: `
      : "App name (what users should see in the header — this is only the template): ";
    const answer = (await ask(prompt)).trim();
    if (!answer && !suggestion) {
      fail('Choose an app name, or pass `--name <project-name> [--brand "<Display Name>"]`.');
    }
    brand ||= answer || suggestion;
    name = kebabCase(brand);
  }
  brand ||= titleCase(name);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    fail(`"${name}" is not a valid package name (lowercase letters, digits, ".", "_", "-").`);
  }
  if (/[<>"&\\`]/.test(brand) || brand.includes(": ")) {
    fail(`--brand "${brand}" contains characters that would break the rewritten files.`);
  }

  // Stale container volumes from an earlier project with the same Compose project name would be
  // silently reused by `compose up` — Postgres then holds foreign tables and
  // `db:migrate` hangs without an error. Catch the collision while the name is still cheap
  // to change.
  if (containerEngine) {
    try {
      const volumes = execFileSync(containerEngine, ["volume", "ls", "--format", "{{.Name}}"], {
        encoding: "utf8",
      })
        .split("\n")
        .filter((volume) => volume.startsWith(`${name}_`));
      if (volumes.length) {
        fail(
          `Container volume(s) from a previous project named "${name}" exist: ${volumes.join(", ")}.\n` +
            `  Reusing them makes database migrations hang on stale data. Either confirm with\n` +
            `  the user and wipe the old project's data:\n` +
            `    ${containerEngine} compose -p ${name} down -v\n` +
            `  or re-run bootstrap with a different --name.`,
        );
      }
    } catch {
      // volume listing failed — don't block bootstrap on it
    }
  }

  pkg.name = name;
  const composePath = path.join(root, "docker-compose.yml");
  try {
    const compose = await readFile(composePath, "utf8");
    await writeFile(composePath, compose.replace(/^name: .*$/m, `name: ${name}`));
  } catch {
    // no compose file (flavored away) — fine
  }

  // --- remotes: template stays reachable as `upstream` ---------------------
  const origin = tryGit(["remote", "get-url", "origin"]);
  if (origin && tryGit(["remote", "get-url", "upstream"]) === null) {
    tryGit(["remote", "rename", "origin", "upstream"]);
    tryGit(["remote", "set-url", "--push", "upstream", "DISABLED"]);
    const branch = tryGit(["branch", "--show-current"]);
    if (branch && tryGit(["config", "--get", `branch.${branch}.remote`]) === "upstream") {
      tryGit(["branch", "--unset-upstream"]);
    }
    console.log(`✓ Kept the template as fetch-only remote upstream;`);
    console.log("  add your project's own repo as origin when you have one.");
  }

  // --- flavors (optional here; the agent-guided interview is the main path) -
  // Humans and create-cen-app share the closed preset catalog. Free-form flavor lists stay
  // available for agents and maintenance scripts.
  const presetArg = flag("preset");
  const flavorsArg = flag("flavors");
  if (presetArg !== undefined && flavorsArg !== undefined) {
    fail("Pass either --preset or --flavors, not both.");
  }
  let chosen: string[] = [];
  let available: string[] = [];
  try {
    const entries = await readdir(path.join(root, ".template/flavors"), { withFileTypes: true });
    available = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // .template/flavors/ gone — nothing to offer
  }
  if (presetArg !== undefined) {
    const preset = catalog.presets.find((candidate) => candidate.id === presetArg);
    if (!preset) {
      fail(
        `Unknown preset "${presetArg}". Available: ${catalog.presets.map((item) => item.id).join(", ")}`,
      );
    }
    chosen = preset.flavors;
  } else if (flavorsArg !== undefined) {
    chosen = flavorsArg === "none" ? [] : flavorsArg.split(",").map((f) => f.trim());
    const unknown = chosen.filter((f) => !available.includes(f));
    if (unknown.length)
      fail(`Unknown flavor(s): ${unknown.join(", ")}. Available: ${available.join(", ")}`);
  } else if (available.length) {
    const menu = catalog.presets.filter((p) => p.flavors.every((f) => available.includes(f)));
    console.log("\nWhich setup do you want?");
    for (const [i, preset] of menu.entries()) console.log(`  ${i + 1}) ${preset.label}`);
    console.log("Tip: or let your AI agent walk you through it (it reads .agents/skills/setup/).");
    let picked: string[] | undefined;
    while (picked === undefined) {
      const defaultIndex = menu.findIndex((preset) => preset.id === catalog.defaultPreset);
      const choice = defaultIndex === -1 ? 1 : defaultIndex + 1;
      const answer = (await ask(`Choice [${choice}]: `)).trim();
      const index = answer === "" ? choice : Number(answer);
      const preset = Number.isInteger(index) ? menu[index - 1] : undefined;
      if (preset) picked = preset.flavors;
      else console.log(`Enter a number between 1 and ${menu.length}.`);
    }
    chosen = picked;
  }

  rl.close();

  // Write the project name before flavors so overlaid compose files preserve it. The
  // bootstrapped marker is deliberately written only after every step succeeds.
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`✓ Project renamed to "${name}"`);
  await applyBrand(brand);

  if (chosen.length) {
    console.log(`\nApplying flavors: ${chosen.join(", ")}`);
    run("pnpm", ["flavor", "apply", ...chosen]);
  }

  // --- .env ----------------------------------------------------------------
  try {
    await copyFile(
      path.join(root, ".env.example"),
      path.join(root, ".env"),
      constants.COPYFILE_EXCL,
    );
    console.log("✓ Created .env from .env.example");
  } catch {
    console.log("• .env already exists — left untouched");
  }

  const configuredPkg = JSON.parse(await readFile(pkgPath, "utf8"));
  await writeFile(
    pkgPath,
    `${JSON.stringify(
      { ...configuredPkg, cen: { ...configuredPkg.cen, bootstrapped: true } },
      null,
      2,
    )}\n`,
  );
  console.log("✓ Bootstrap complete");

  // --- done -----------------------------------------------------------------
  console.log(`
Next steps:
  pnpm dev          # validate ports, then start the configured local stack
  pnpm verify       # full configured-project baseline

Working with an AI agent? Point it at this repo — AGENTS.md routes it through the
remaining setup steps (verify, approve, finalize) before adding your first resource.`);
}

// Rewrite the template's visible brand to the project's display name — in the working
// tree AND the flavor overlays, so flavors applied now or later carry the project's
// name regardless of ordering. .template/ is deleted at finalize, so rewriting overlay
// sources is safe.
async function applyBrand(brand: string) {
  if (brand === "CEN Starter") return;
  const extensions = new Set([".ts", ".tsx", ".html", ".yaml", ".yml"]);
  const skip = new Set(["node_modules", "dist", "coverage"]);
  let count = 0;
  for (const dir of ["frontend", "backend", "shared", "deploy", "dev", ".template/flavors"]) {
    const entries = await readdir(path.join(root, dir), {
      recursive: true,
      withFileTypes: true,
    }).catch(() => null);
    if (!entries) continue; // flavored away — fine
    for (const entry of entries) {
      if (!entry.isFile() || !extensions.has(path.extname(entry.name))) continue;
      const file = path.join(entry.parentPath, entry.name);
      const parts = path.relative(root, file).split(path.sep);
      if (parts.some((part) => skip.has(part))) continue;
      const text = await readFile(file, "utf8");
      if (!text.includes("CEN Starter")) continue;
      await writeFile(file, text.replaceAll("CEN Starter", brand));
      count += 1;
    }
  }
  console.log(`✓ App name set to "${brand}" (${count} file${count === 1 ? "" : "s"})`);
}

main();
