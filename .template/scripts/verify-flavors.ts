import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

type FlavorManifest = {
  name: string;
  combinesWith?: string[];
};

type Preset = { id: string; flavors: string[] };

const root = process.cwd();
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const ignoredDirectories = new Set([".git", ".codex", "coverage", "dist", "node_modules"]);
const ignoredFiles = new Set([".env", ".env.production"]);

async function main() {
  const variants = await flavorVariants(onlyFilter());
  const presets = await readPresets();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "cen-flavor-check-"));
  let failed = false;

  try {
    for (const names of variants) {
      const label = names.length ? names.join(" + ") : "base";
      const workspace = path.join(temporaryRoot, names.length ? names.join("--") : "cen-starter");
      console.log(`\n=== Verifying ${label} ===`);
      await copySource(workspace);

      try {
        run("git", ["init", "--quiet"], workspace);
        run("git", ["config", "user.name", "CEN Flavor Check"], workspace);
        run("git", ["config", "user.email", "flavor-check@local"], workspace);
        commit(workspace, "Pristine template");
        run(pnpm, ["install", "--frozen-lockfile"], workspace);
        if (!names.length) {
          expectFailure(
            pnpm,
            ["flavor", "finalize"],
            workspace,
            "Refusing to finalize before `pnpm bootstrap`",
          );
          expectFailure(
            pnpm,
            ["bootstrap", "--flavors", "none"],
            workspace,
            "Choose an app name",
            "\n",
          );
          expectFailure(pnpm, ["db:generate"], workspace, "setup mode");
        }

        const preset = presets.find((candidate) => sameFlavors(candidate.flavors, names));
        const selection = preset
          ? ["--preset", preset.id]
          : ["--flavors", names.length ? names.join(",") : "none"];
        run(
          pnpm,
          [
            "bootstrap",
            // Never bootstrap with the template's own name: a dev machine that has run
            // `pnpm dev` in this checkout owns cen-starter_* Docker volumes, and
            // bootstrap's stale-volume guard would (correctly) refuse.
            "--name",
            names.length ? `flavor-check-${label.replaceAll(" + ", "-")}` : "flavor-check-base",
            ...selection,
          ],
          workspace,
        );
        await assertBrandApplied(workspace);
        await assertCarbonToaster(workspace, names);
        const stagedSkills = await skillNames(
          path.join(workspace, ".template/scaffold/agent-skills"),
        );
        if (!stagedSkills.length)
          throw new Error(`${label} left no post-setup skills to activate.`);
        for (const skill of stagedSkills) {
          const dir = path.join(workspace, ".template/scaffold/agent-skills", skill);
          if (await exists(path.join(dir, "SKILL.md"))) {
            throw new Error(
              `Staged skill "${skill}" ships a plain SKILL.md — skill scanners can discover it pre-setup; name it SKILL.staged.md.`,
            );
          }
          if (!(await exists(path.join(dir, "SKILL.staged.md")))) {
            throw new Error(`Staged skill "${skill}" has no SKILL.staged.md.`);
          }
        }

        run(pnpm, ["verify"], workspace);
        run(pnpm, ["test:template"], workspace);
        commit(workspace, `Configure ${label}`);
        run(pnpm, ["flavor", "finalize"], workspace);
        await assertFinalized(workspace, stagedSkills);
        await verifyResourceMaterialization(workspace, names);
      } catch (error) {
        failed = true;
        console.error(`Failed workspace retained at ${workspace}`);
        throw error;
      }

      await rm(workspace, { recursive: true, force: true });
    }
  } finally {
    if (!failed) await rm(temporaryRoot, { recursive: true, force: true });
  }

  console.log(`\nVerified ${variants.length} flavor variants.`);
}

async function assertCarbonToaster(workspace: string, names: string[]) {
  if (!names.includes("carbon")) return;

  const frontendPackage = JSON.parse(
    await readFile(path.join(workspace, "frontend/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  if (frontendPackage.dependencies?.sonner) {
    throw new Error("Carbon output must remove the Sonner dependency.");
  }

  const toaster = await readFile(
    path.join(workspace, "frontend/src/components/toaster.tsx"),
    "utf8",
  );
  if (!toaster.includes("ToastNotification") || toaster.includes('from "sonner"')) {
    throw new Error("Carbon output must render Carbon ToastNotification components.");
  }
}

// Executable verification of the add-resource skill: materialize its reference
// implementation in the finalized project exactly as the skill instructs (copy map +
// registration edits), then prove the result compiles, migrates, tests, and builds.
// This is what keeps the skill's assets from drifting away from the live architecture.
async function verifyResourceMaterialization(workspace: string, names: string[]) {
  const skill = path.join(workspace, ".agents/skills/add-resource");
  const skillExists = await exists(skill);
  const expectSkill = !names.includes("no-database");

  if (!expectSkill) {
    if (skillExists) {
      throw new Error("no-database variants must not ship the add-resource skill.");
    }
    console.log("add-resource skill correctly absent; skipping materialization.");
    return;
  }
  if (!skillExists) throw new Error("Finalized project is missing the add-resource skill.");

  const assets = path.join(skill, "assets/projects");
  const hasFrontend = await exists(path.join(workspace, "frontend"));
  const shadcnPage = path.join(assets, "frontend/shadcn/projects.tsx");
  const carbonPage = path.join(assets, "frontend/carbon/projects.tsx");
  const hasShadcn = await exists(shadcnPage);
  const hasCarbon = await exists(carbonPage);

  if (!hasFrontend && (hasShadcn || hasCarbon)) {
    throw new Error("Backend-only project still ships frontend skill assets.");
  }
  if (hasFrontend && hasShadcn === hasCarbon) {
    throw new Error(
      `Expected exactly one frontend asset variant, found shadcn=${hasShadcn} carbon=${hasCarbon}.`,
    );
  }

  console.log("Materializing the projects resource from the add-resource skill...");
  await placeAsset(assets, "shared/projects.ts", workspace, "shared/src/schemas/projects.ts");
  await placeAsset(
    assets,
    "backend/db/projects.ts",
    workspace,
    "backend/src/db/schema/projects.ts",
  );
  await placeAsset(
    assets,
    "backend/routes/projects.ts",
    workspace,
    "backend/src/routes/projects.ts",
  );
  await placeAsset(
    assets,
    "backend/routes/projects.test.ts",
    workspace,
    "backend/src/routes/projects.test.ts",
  );
  if (hasFrontend) {
    await placeAsset(
      assets,
      hasCarbon ? "frontend/carbon/projects.tsx" : "frontend/shadcn/projects.tsx",
      workspace,
      "frontend/src/routes/_layout/projects.tsx",
    );
  }

  // The registration edits the skill prescribes, applied as exact-match anchors so drift
  // in the base files fails loudly here instead of silently in a generated project.
  await appendLine(workspace, "shared/src/index.ts", 'export * from "./schemas/projects";');
  await appendLine(workspace, "backend/src/db/schema/index.ts", 'export * from "./projects";');
  await editAnchored(
    workspace,
    "backend/src/index.ts",
    'import { healthRoute } from "./routes/health";\n',
    'import { healthRoute } from "./routes/health";\nimport { projectsRoute } from "./routes/projects";\n',
  );
  await editAnchored(
    workspace,
    "backend/src/index.ts",
    '.route("/health", healthRoute)',
    '.route("/health", healthRoute).route("/projects", projectsRoute)',
  );

  // What the skill tells agents to do when formatting complains: pnpm fix.
  run(pnpm, ["fix"], workspace);

  run(pnpm, ["db:generate"], workspace);
  const migrations = path.join(workspace, "backend/src/db/migrations");
  const generated = (await readdir(migrations)).filter((file) => file.endsWith(".sql"));
  const migrationSql = await Promise.all(
    generated.map((file) => readFile(path.join(migrations, file), "utf8")),
  );
  if (!migrationSql.some((sql) => sql.includes('CREATE TABLE "project"'))) {
    throw new Error("db:generate did not produce a migration creating the project table.");
  }

  if (hasFrontend) {
    // Regenerates routeTree.gen.ts through the supported tooling; typecheck needs it.
    run(pnpm, ["--filter", "@cen/frontend", "build"], workspace);
    const routeTree = await readFile(path.join(workspace, "frontend/src/routeTree.gen.ts"), "utf8");
    if (!routeTree.includes("/_layout/projects")) {
      throw new Error("Route tree regeneration did not pick up the projects page.");
    }
  }

  run(pnpm, ["verify"], workspace);
  console.log("add-resource materialization verified.");
}

// Bootstrap rewrites the visible "CEN Starter" brand to the project's display name — in
// the working tree and the flavor overlays. Any app file still carrying it would ship
// the template's name in a generated project's UI (headers, tab title, API docs, Dex).
async function assertBrandApplied(workspace: string) {
  const extensions = new Set([".ts", ".tsx", ".html", ".yaml", ".yml"]);
  for (const dir of ["frontend", "backend", "shared", "deploy", "dev", ".template/flavors"]) {
    const entries = await readdir(path.join(workspace, dir), {
      recursive: true,
      withFileTypes: true,
    }).catch(() => null);
    if (!entries) continue;
    for (const entry of entries) {
      if (!entry.isFile() || !extensions.has(path.extname(entry.name))) continue;
      const file = path.join(entry.parentPath, entry.name);
      const relative = path.relative(workspace, file);
      if (relative.split(path.sep).some((part) => ignoredDirectories.has(part))) continue;
      if ((await readFile(file, "utf8")).includes("CEN Starter")) {
        throw new Error(`Bootstrap left the template brand "CEN Starter" in ${relative}.`);
      }
    }
  }
}

async function placeAsset(assets: string, asset: string, workspace: string, destination: string) {
  const source = path.join(assets, asset);
  if (!(await exists(source))) throw new Error(`Skill asset missing: ${asset}`);
  const content = await readFile(source, "utf8");
  const newline = content.indexOf("\n");
  const firstLine = newline === -1 ? content : content.slice(0, newline);
  if (!firstLine.startsWith("// @ts-nocheck — skill asset")) {
    throw new Error(`Skill asset ${asset} is missing its @ts-nocheck marker line.`);
  }
  const target = path.join(workspace, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content.slice(newline + 1));
}

async function appendLine(workspace: string, relative: string, line: string) {
  const file = path.join(workspace, relative);
  const content = await readFile(file, "utf8");
  await writeFile(file, `${content}${line}\n`);
}

async function editAnchored(workspace: string, relative: string, find: string, replace: string) {
  const file = path.join(workspace, relative);
  const content = await readFile(file, "utf8");
  if (!content.includes(find)) {
    throw new Error(`Anchor not found in ${relative}: ${JSON.stringify(find)}`);
  }
  await writeFile(file, content.replace(find, replace));
}

function onlyFilter() {
  const index = process.argv.indexOf("--only");
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value) throw new Error("--only requires a comma-separated list, e.g. --only base,carbon");
  return new Set(value.split(","));
}

async function flavorVariants(only: Set<string> | null) {
  const available = await readManifests();
  const names = new Set(available.map((manifest) => manifest.name));
  const variants = [[], ...available.map((manifest) => [manifest.name])];

  for (const manifest of available) {
    for (const combined of manifest.combinesWith ?? []) {
      if (!names.has(combined)) {
        throw new Error(`Flavor "${manifest.name}" combines with unknown flavor "${combined}".`);
      }
      variants.push([combined, manifest.name]);
    }
  }

  if (!only) return variants;
  const selected = variants.filter((variant) => only.has(variant.join("+") || "base"));
  if (selected.length !== only.size) {
    const known = variants.map((variant) => variant.join("+") || "base").join(", ");
    throw new Error(`--only matched ${selected.length} of ${only.size} variants; known: ${known}`);
  }
  return selected;
}

async function skillNames(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function assertFinalized(workspace: string, stagedSkills: string[]) {
  for (const relative of [
    ".template",
    ".agents/skills/setup",
    ".agents/skills/template-maintenance",
  ]) {
    if (await exists(path.join(workspace, relative))) {
      throw new Error(`Finalization did not remove ${relative}.`);
    }
  }

  for (const skill of stagedSkills) {
    if (!(await exists(path.join(workspace, ".agents/skills", skill, "SKILL.md")))) {
      throw new Error(`Finalization did not activate skill "${skill}".`);
    }
    if (await exists(path.join(workspace, ".agents/skills", skill, "SKILL.staged.md"))) {
      throw new Error(`Finalization left skill "${skill}" staged as SKILL.staged.md.`);
    }
  }

  const agents = await readFile(path.join(workspace, "AGENTS.md"), "utf8");
  if (agents.includes("not set up yet")) {
    throw new Error("Finalization did not install the project AGENTS.md.");
  }

  const pkg = JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8"));
  if (pkg.cen?.bootstrapped !== true || pkg.cen?.finalized !== true) {
    throw new Error("Finalization did not persist the bootstrap/finalized markers.");
  }
}

async function readManifests() {
  const flavorsDirectory = path.join(root, ".template/flavors");
  const entries = await readdir(flavorsDirectory, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  return Promise.all(
    directories.map(async (directory): Promise<FlavorManifest> => {
      const file = path.join(flavorsDirectory, directory.name, "manifest.json");
      const manifest = JSON.parse(await readFile(file, "utf8")) as FlavorManifest;
      if (manifest.name !== directory.name) {
        throw new Error(
          `Manifest name "${manifest.name}" must match .template/flavors/${directory.name}.`,
        );
      }
      if (
        manifest.combinesWith !== undefined &&
        (!Array.isArray(manifest.combinesWith) ||
          !manifest.combinesWith.every((name) => typeof name === "string"))
      ) {
        throw new Error(`Manifest combinesWith must be a string array: ${file}`);
      }
      return manifest;
    }),
  );
}

async function readPresets(): Promise<Preset[]> {
  const catalog = JSON.parse(await readFile(path.join(root, ".template/presets.json"), "utf8")) as {
    presets?: Preset[];
  };
  if (!Array.isArray(catalog.presets)) throw new Error("Preset catalog has no presets array.");
  return catalog.presets;
}

function sameFlavors(left: string[], right: string[]) {
  return left.length === right.length && left.every((flavor, index) => flavor === right[index]);
}

async function copySource(target: string) {
  await cp(root, target, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      if (!relative) return true;
      const parts = relative.split(path.sep);
      if (parts.some((part) => ignoredDirectories.has(part))) return false;
      if (parts.length === 1 && ignoredFiles.has(relative)) return false;
      return !relative.endsWith(".local");
    },
  });
}

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, CI: "true" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}.`);
  }
}

function expectFailure(
  command: string,
  args: string[],
  cwd: string,
  expected: string,
  input?: string,
) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, CI: "true" },
    encoding: "utf8",
    input,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0 || !output.includes(expected)) {
    throw new Error(
      `${command} ${args.join(" ")} should fail with ${JSON.stringify(expected)}.\n${output}`,
    );
  }
}

function commit(cwd: string, message: string) {
  run("git", ["add", "-A"], cwd);
  run("git", ["commit", "--quiet", "--no-verify", "-m", message], cwd);
}

async function exists(file: string) {
  return stat(file)
    .then(() => true)
    .catch(() => false);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
