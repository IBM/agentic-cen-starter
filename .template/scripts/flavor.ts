import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

const FindEdit = z
  .object({ file: z.string().min(1), find: z.string().min(1), replace: z.string() })
  .strict();
const YamlEdit = z.object({ file: z.string().min(1), removeYamlKey: z.string().min(1) }).strict();
const ManifestSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    conflicts: z.array(z.string()),
    combinesWith: z.array(z.string()).optional(),
    requires: z.array(z.string()),
    delete: z.array(z.string()),
    overlay: z.string().min(1).optional(),
    edits: z.array(z.union([FindEdit, YamlEdit])).optional(),
    packageJson: z
      .record(
        z.string(),
        z
          .object({
            add: z.record(z.string(), z.string()).optional(),
            remove: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .optional(),
    verify: z.array(z.string()),
  })
  .strict();

type JsonObject = Record<string, unknown>;
type Manifest = z.infer<typeof ManifestSchema>;
type Edit = NonNullable<Manifest["edits"]>[number];
type PackagePatches = NonNullable<Manifest["packageJson"]>;
type OverlayDeleteMatcher = { flavor: string; matcher: RegExp };
type PackagePatchValidation = { packages: Map<string, string>; skipped: Set<string> };
type FlavorPlan = {
  name: string;
  manifest: Manifest;
  composing: boolean;
  deletes: string[];
  overlay: string | null;
  comboOverlays: string[];
  packages: Map<string, string>;
  skippedPackagePatches: Set<string>;
  overlayDeleteMatchers: OverlayDeleteMatcher[];
};

const root = process.cwd();
const flavorsDir = path.join(root, ".template/flavors");
const skippedDirs = new Set([".git", "node_modules"]);

async function main() {
  const [command, ...names] = process.argv.slice(2);
  if (command === "list") return list();
  if (command === "apply" && names.length) return apply(names);
  if (command === "finalize") return finalize();
  throw new Error(
    "Usage: pnpm flavor list | pnpm flavor apply <name> [<name>...] | pnpm flavor finalize",
  );
}

async function list() {
  const applied = getCen(await readJson("package.json")).flavors;
  for (const manifest of await allManifests()) {
    const marker = applied.includes(manifest.name) ? " (applied)" : "";
    const combines = manifest.combinesWith?.length
      ? ` (combines with: ${manifest.combinesWith.join(", ")})`
      : "";
    console.log(`${manifest.name}${marker} - ${manifest.description}${combines}`);
  }
}

async function apply(names: string[]) {
  rejectDuplicateNames(names);
  const initialCen = getCen(await readJson("package.json"));
  if (initialCen.finalized) {
    throw new Error("Refusing to apply a flavor after cen.finalized is true.");
  }
  for (const name of names) {
    if (initialCen.flavors.includes(name)) throw new Error(`Flavor "${name}" is already applied.`);
  }
  const requestedManifests = await requestedManifestsFor(names);
  await validateFlavorSequence(initialCen.flavors, requestedManifests);

  const verifyCommands: string[] = [];
  let appliedAny = false;
  for (const name of names) {
    try {
      const plan = await prepareFlavor(name);
      await applyFlavorPlan(plan);
      addVerifyCommands(verifyCommands, plan.manifest.verify);
      appliedAny = true;
    } catch (error) {
      if (appliedAny) throw withResetHint(error);
      throw error;
    }
  }

  try {
    run("pnpm install --no-frozen-lockfile");
    for (const command of verifyCommands) run(command);
  } catch (error) {
    const subject =
      names.length === 1
        ? `Flavor "${names[0]}" was`
        : `Flavors ${names.map((applied) => `"${applied}"`).join(", ")} were`;
    console.error(
      `${subject} applied, but install or verification failed. ` +
        'Inspect the tree, or reset with "git checkout . && git clean -fd".',
    );
    throw error;
  }
}

async function prepareFlavor(name: string): Promise<FlavorPlan> {
  const manifest = await readManifest(name);
  const cen = getCen(await readJson("package.json"));
  if (cen.finalized) throw new Error("Refusing to apply a flavor after cen.finalized is true.");
  if (cen.flavors.includes(name)) throw new Error(`Flavor "${name}" is already applied.`);
  for (const required of manifest.requires) {
    if (!cen.flavors.includes(required))
      throw new Error(`Flavor "${name}" requires "${required}".`);
  }
  const composing = isComposing(manifest, cen.flavors);
  const applied = await appliedManifests(cen.flavors);
  validateCompatibility(manifest, cen.flavors, applied);

  const deletes = await resolveDeletes(manifest.delete, composing);
  const overlay = await validateOverlay(name, manifest.overlay);
  const comboOverlays = await validateComboOverlays(name, manifest.combinesWith ?? [], cen.flavors);
  await validateEdits(manifest.edits ?? []);
  const packageValidation = await validatePackagePatches(manifest.packageJson ?? {}, composing);

  return {
    name,
    manifest,
    composing,
    deletes,
    overlay,
    comboOverlays,
    packages: packageValidation.packages,
    skippedPackagePatches: packageValidation.skipped,
    overlayDeleteMatchers: overlayDeleteMatchers(applied),
  };
}

async function applyFlavorPlan(plan: FlavorPlan) {
  for (const target of plan.deletes) await rm(abs(target), { recursive: true, force: true });
  if (plan.overlay) await copyOverlay(plan.overlay, root, plan.overlayDeleteMatchers);
  for (const comboOverlay of plan.comboOverlays) {
    await copyOverlay(comboOverlay, root, plan.overlayDeleteMatchers);
  }
  await applyEdits(plan.manifest.edits ?? []);
  await applyPackagePatches(
    plan.manifest.packageJson ?? {},
    plan.packages,
    plan.skippedPackagePatches,
    plan.composing,
  );
  await preserveComposeProjectName();
  await warnOnEnvExampleDrift(plan.manifest.edits ?? []);
  await recordFlavor(plan.name);
}

// Overlays ship the template's compose `name:`; a bootstrap-renamed project must keep its own.
async function preserveComposeProjectName() {
  const compose = abs("docker-compose.yml");
  if (!(await exists(compose))) return;
  const pkgName = (await readJson("package.json")).name;
  if (typeof pkgName !== "string" || !pkgName) return;
  const text = await readFile(compose, "utf8");
  const next = text.replace(/^name: .+$/m, `name: ${pkgName}`);
  if (next !== text) await writeFile(compose, next);
}

async function warnOnEnvExampleDrift(edits: Edit[]) {
  if (!edits.some((edit) => edit.file === ".env.example")) return;
  if (!(await exists(abs(".env")))) return;
  console.log(
    "note: this flavor changed .env.example, but your existing .env was not modified — " +
      "compare the two and update .env (required variables changed).",
  );
}

async function finalize() {
  const pkg = await readJson("package.json");
  getCen(pkg);
  const metadata = objectAt(pkg, "cen");
  if (metadata.bootstrapped !== true) {
    throw new Error("Refusing to finalize before `pnpm bootstrap` completes successfully.");
  }

  const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (status.trim()) throw new Error("Refusing to finalize with a dirty git working tree.");

  console.log("Verifying the configured project before finalization...");
  run("pnpm verify");

  const hadBootstrap = await exists(abs(".template/scripts/bootstrap.ts"));
  await rm(abs(".agents/skills/setup"), { recursive: true, force: true });
  await rm(abs(".agents/skills/template-maintenance"), { recursive: true, force: true });
  await installProjectAgentsFile();
  await activateStagedSkills();
  // Everything else that is setup-only lives under .template/ — one deletion strips it all.
  await rm(abs(".template"), { recursive: true, force: true });

  const scripts = objectAt(pkg, "scripts");
  delete scripts.flavor;
  delete scripts.typecheck;
  delete scripts["verify:flavors"];
  delete scripts["test:template"];
  if (hadBootstrap) delete scripts.bootstrap;
  const dbGenerate = scripts["db:generate"];
  if (typeof dbGenerate === "string") {
    scripts["db:generate"] = dbGenerate.replace("node .template/scripts/guard-setup.mjs && ", "");
  }
  metadata.finalized = true;
  await writeJson("package.json", pkg);
  await removeEmptyScriptsDir();
}

// The root AGENTS.md is only the setup gate; the project's working guide ships staged.
async function installProjectAgentsFile() {
  const staged = abs(".template/scaffold/AGENTS.md");
  if (await exists(staged)) await rename(staged, abs("AGENTS.md"));
}

async function activateStagedSkills() {
  const staged = abs(".template/scaffold/agent-skills");
  if (!(await exists(staged))) return;

  const active = abs(".agents/skills");
  await mkdir(active, { recursive: true });
  const entries = (await readdir(staged, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  for (const entry of entries) {
    if (await exists(path.join(active, entry.name))) {
      throw new Error(`Refusing to overwrite active skill: .agents/skills/${entry.name}`);
    }
  }
  for (const entry of entries) {
    const destination = path.join(active, entry.name);
    await rename(path.join(staged, entry.name), destination);
    // Staged skills are inert `SKILL.staged.md` files (not `SKILL.md`, so skill scanners
    // cannot discover them pre-setup; still `.md`, so editors highlight them).
    const inert = path.join(destination, "SKILL.staged.md");
    if (await exists(inert)) await rename(inert, path.join(destination, "SKILL.md"));
  }

  await removeEmptyDirectory(staged);
  await removeEmptyDirectory(abs(".template/scaffold"));
}

async function allManifests() {
  if (!(await exists(flavorsDir))) return [];
  const entries = await readdir(flavorsDir, { withFileTypes: true });
  const manifests = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map((entry) => readManifest(entry.name)),
  );
  return manifests.sort((left, right) => left.name.localeCompare(right.name));
}

async function appliedManifests(names: string[]) {
  const manifests: Manifest[] = [];
  for (const name of names) {
    if (await exists(path.join(flavorsDir, name, "manifest.json"))) {
      manifests.push(await readManifest(name));
    }
  }
  return manifests;
}

async function requestedManifestsFor(names: string[]) {
  const manifests: Manifest[] = [];
  for (const name of names) manifests.push(await readManifest(name));
  return manifests;
}

async function validateFlavorSequence(
  initialAppliedNames: string[],
  requestedManifests: Manifest[],
) {
  const simulatedNames = [...initialAppliedNames];
  const simulatedManifests = await appliedManifests(simulatedNames);
  for (const manifest of requestedManifests) {
    for (const required of manifest.requires) {
      if (!simulatedNames.includes(required)) {
        throw new Error(`Flavor "${manifest.name}" requires "${required}".`);
      }
    }
    validateCompatibility(manifest, simulatedNames, simulatedManifests);
    simulatedNames.push(manifest.name);
    simulatedManifests.push(manifest);
  }
}

async function readManifest(name: string) {
  const manifest = ManifestSchema.parse(
    await readJson(path.join(flavorsDir, name, "manifest.json")),
  );
  if (manifest.name !== name) {
    throw new Error(`Manifest name "${manifest.name}" must match .template/flavors/${name}.`);
  }
  return manifest;
}

function rejectDuplicateNames(names: string[]) {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`Flavor "${name}" was specified more than once.`);
    seen.add(name);
  }
}

function validateCompatibility(
  manifest: Manifest,
  appliedNames: string[],
  appliedManifests: Manifest[],
) {
  const appliedByName = new Map(appliedManifests.map((applied) => [applied.name, applied]));
  for (const appliedName of appliedNames) {
    const applied = appliedByName.get(appliedName);
    if (manifest.combinesWith?.includes(appliedName)) continue;
    if (applied?.combinesWith?.includes(manifest.name)) {
      throw new Error(
        `Flavor "${applied.name}" composes on top of "${manifest.name}" - ` +
          `apply them as: pnpm flavor apply ${manifest.name} ${applied.name} ` +
          '(reset first with "git checkout . && git clean -fd" if needed).',
      );
    }
    if (manifest.conflicts.includes(appliedName)) {
      throw new Error(`Flavor "${manifest.name}" conflicts with "${appliedName}".`);
    }
    if (applied?.conflicts.includes(manifest.name)) {
      throw new Error(
        `Flavor "${manifest.name}" conflicts with already-applied "${applied.name}".`,
      );
    }
  }
}

function isComposing(manifest: Manifest, appliedNames: string[]) {
  return manifest.combinesWith?.some((combined) => appliedNames.includes(combined)) ?? false;
}

async function resolveDeletes(patterns: string[], composing = false) {
  const paths = await repoPaths();
  const targets = new Set<string>();
  for (const pattern of patterns) {
    const safePattern = safe(pattern);
    const matcher = globRegExp(safePattern);
    const matches = new Set(paths.filter((candidate) => matcher.test(candidate)));
    if (safePattern.endsWith("/**")) {
      const base = safePattern.slice(0, -3).replace(/\/$/, "");
      if (base && (await exists(abs(base)))) matches.add(base);
    }
    if (!matches.size) {
      if (composing) {
        console.log(`delete skipped (nothing left to delete): ${pattern}`);
        continue;
      }
      throw new Error(`Delete pattern matched nothing: ${pattern}`);
    }
    for (const match of matches) targets.add(match);
  }
  return [...targets].sort((left, right) => left.length - right.length);
}

async function validateOverlay(name: string, overlay?: string) {
  if (!overlay) return null;
  const source = path.join(flavorsDir, name, safe(overlay));
  const info = await stat(source).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Overlay must be a directory: ${overlay}`);
  await rejectSymlinks(source);
  return source;
}

async function validateComboOverlays(name: string, combinesWith: string[], appliedNames: string[]) {
  const overlays: string[] = [];
  for (const combined of combinesWith) {
    if (!appliedNames.includes(combined)) continue;
    const source = path.join(flavorsDir, name, "combo", safe(combined));
    const info = await stat(source).catch(() => null);
    if (!info) continue;
    if (!info.isDirectory()) {
      throw new Error(
        `Combo overlay must be a directory: .template/flavors/${name}/combo/${combined}`,
      );
    }
    await rejectSymlinks(source);
    overlays.push(source);
  }
  return overlays;
}

async function validateEdits(edits: Edit[]) {
  for (const edit of edits) {
    const text = await readFile(abs(edit.file), "utf8");
    if ("find" in edit) {
      const count = occurrences(text, edit.find);
      if (count !== 1) {
        throw new Error(
          `Edit anchor in ${edit.file} matched ${count} times; expected exactly once.`,
        );
      }
    } else if (!yamlRange(text.split("\n"), edit.removeYamlKey.split("."))) {
      throw new Error(`YAML key "${edit.removeYamlKey}" was not found in ${edit.file}.`);
    }
  }
}

async function validatePackagePatches(
  patches: PackagePatches,
  composing = false,
): Promise<PackagePatchValidation> {
  const packages = await workspacePackages();
  const skipped = new Set<string>();
  for (const name of Object.keys(patches)) {
    if (!packages.has(name)) {
      if (composing) {
        console.log(`package patch skipped (package removed by an earlier flavor): ${name}`);
        skipped.add(name);
        continue;
      }
      throw new Error(`Workspace package not found: ${name}`);
    }
  }
  return { packages, skipped };
}

async function applyEdits(edits: Edit[]) {
  for (const edit of edits) {
    const file = abs(edit.file);
    const text = await readFile(file, "utf8");
    if ("find" in edit) {
      await writeFile(file, text.replace(edit.find, edit.replace));
      continue;
    }
    const next = removeYamlKey(text, edit.removeYamlKey.split("."));
    if (next === null) throw new Error(`YAML key "${edit.removeYamlKey}" was not found.`);
    await writeFile(file, next);
  }
}

async function applyPackagePatches(
  patches: PackagePatches,
  packages: Map<string, string>,
  skippedPackagePatches = new Set<string>(),
  composing = false,
) {
  for (const [name, patch] of Object.entries(patches)) {
    if (skippedPackagePatches.has(name)) continue;
    const file = packages.get(name);
    if (!file || !(await exists(file))) {
      if (composing) {
        console.log(`package patch skipped (package removed by an earlier flavor): ${name}`);
        continue;
      }
      throw new Error(`Workspace package not found: ${name}`);
    }
    const pkg = await readJson(file);
    for (const dependency of patch.remove ?? []) removeDependency(pkg, dependency);
    const additions = patch.add ?? {};
    if (Object.keys(additions).length) Object.assign(objectAt(pkg, "dependencies"), additions);
    await writeJson(file, pkg);
  }
}

async function workspacePackages() {
  const packages = new Map<string, string>();
  for (const file of await packageFiles("")) {
    const pkg = await readJson(file);
    if (typeof pkg.name === "string") packages.set(pkg.name, absolute(file));
  }
  return packages;
}

async function packageFiles(relativeDir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(abs(relativeDir), { withFileTypes: true })) {
    const relative = posix(path.join(relativeDir, entry.name));
    if (entry.isDirectory() && !skippedDirs.has(entry.name) && entry.name !== ".template") {
      files.push(...(await packageFiles(relative)));
    } else if (entry.isFile() && entry.name === "package.json") {
      files.push(relative);
    }
  }
  return files;
}

async function recordFlavor(name: string) {
  const pkg = await readJson("package.json");
  getCen(pkg).flavors.push(name);
  await writeJson("package.json", pkg);
}

function overlayDeleteMatchers(manifests: Manifest[]) {
  const matchers: OverlayDeleteMatcher[] = [];
  for (const manifest of manifests) {
    for (const pattern of manifest.delete) {
      matchers.push({ flavor: manifest.name, matcher: globRegExp(safe(pattern)) });
    }
  }
  return matchers;
}

function addVerifyCommands(commands: string[], next: string[]) {
  const seen = new Set(commands);
  for (const command of next) {
    if (seen.has(command)) continue;
    commands.push(command);
    seen.add(command);
  }
}

function withResetHint(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("git checkout . && git clean -fd")) return new Error(message);
  return new Error(
    `${message}\nReset with "git checkout . && git clean -fd" if needed before retrying.`,
  );
}

function getCen(pkg: JsonObject) {
  const cen = objectAt(pkg, "cen");
  const flavors = cen.flavors;
  if (!Array.isArray(flavors) || !flavors.every((flavor) => typeof flavor === "string")) {
    throw new Error('package.json field "cen.flavors" must be a string array.');
  }
  if (typeof cen.finalized !== "boolean") {
    throw new Error('package.json field "cen.finalized" must be a boolean.');
  }
  return { flavors, finalized: cen.finalized };
}

function removeDependency(pkg: JsonObject, dependency: string) {
  for (const key of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const section = pkg[key];
    if (isObject(section)) delete section[dependency];
  }
}

async function repoPaths(relativeDir = ""): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(abs(relativeDir), { withFileTypes: true })) {
    if (skippedDirs.has(entry.name)) continue;
    const relative = posix(path.join(relativeDir, entry.name));
    paths.push(relative);
    if (entry.isDirectory()) paths.push(...(await repoPaths(relative)));
  }
  return paths;
}

async function rejectSymlinks(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Overlay contains a symlink: ${entry.name}`);
    if (entry.isDirectory()) await rejectSymlinks(path.join(directory, entry.name));
  }
}

async function copyOverlay(
  source: string,
  target: string,
  deleteMatchers: OverlayDeleteMatcher[] = [],
) {
  const info = await stat(source);
  if (info.isDirectory()) {
    for (const entry of await readdir(source)) {
      await copyOverlay(path.join(source, entry), path.join(target, entry), deleteMatchers);
    }
    return;
  }

  const destination = posix(path.relative(root, target));
  const deletedBy = deleteMatchers.find(({ matcher }) => matcher.test(destination));
  if (deletedBy) {
    console.log(`overlay skipped (deleted by "${deletedBy.flavor}"): ${destination}`);
    return;
  }

  await mkdir(path.dirname(target), { recursive: true });
  // Destinations under .template/ are staged material (e.g. skill assets), not live code:
  // they keep their @ts-nocheck header until someone copies them into the app.
  if (!/\.(ts|tsx)$/.test(source) || destination.startsWith(".template/")) {
    await cp(source, target, { force: true });
    return;
  }

  await writeFile(target, stripOverlayTsNoCheck(await readFile(source, "utf8")));
}

function stripOverlayTsNoCheck(text: string) {
  const newline = text.indexOf("\n");
  const firstLine = newline === -1 ? text : text.slice(0, newline);
  if (!firstLine.startsWith("// @ts-nocheck")) return text;
  return newline === -1 ? "" : text.slice(newline + 1);
}

function removeYamlKey(text: string, keyPath: string[]) {
  const finalNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (finalNewline) lines.pop();
  const range = yamlRange(lines, keyPath);
  if (!range) return null;
  lines.splice(range.start, range.end - range.start);
  return `${lines.join("\n")}${finalNewline ? "\n" : ""}`;
}

function yamlRange(lines: string[], keyPath: string[]) {
  let start = 0;
  let end = lines.length;
  let parentIndent = -1;
  let found: { start: number; end: number } | null = null;
  for (const key of keyPath.filter(Boolean)) {
    const indent = parentIndent < 0 ? 0 : childIndent(lines, start, end, parentIndent);
    if (indent === null) return null;
    const keyLine = findYamlKey(lines, start, end, indent, key);
    if (keyLine === null) return null;
    found = { start: keyLine, end: yamlBlockEnd(lines, keyLine, end, indent) };
    start = keyLine + 1;
    end = found.end;
    parentIndent = indent;
  }
  return found;
}

function childIndent(lines: string[], start: number, end: number, parentIndent: number) {
  let indent: number | null = null;
  for (let index = start; index < end; index += 1) {
    const current = yamlIndent(lines[index] ?? "");
    if (current !== null && current > parentIndent) indent = Math.min(indent ?? current, current);
  }
  return indent;
}

function findYamlKey(lines: string[], start: number, end: number, indent: number, key: string) {
  const pattern = new RegExp(`^ {${indent}}${escapeRegExp(key)}\\s*:`);
  for (let index = start; index < end; index += 1) {
    if (pattern.test(lines[index] ?? "")) return index;
  }
  return null;
}

function yamlBlockEnd(lines: string[], start: number, limit: number, indent: number) {
  for (let index = start + 1; index < limit; index += 1) {
    const current = yamlIndent(lines[index] ?? "");
    if (current !== null && current <= indent) return index;
  }
  return limit;
}

function yamlIndent(line: string) {
  if (!line.trim() || line.trimStart().startsWith("#")) return null;
  return line.match(/^ */)?.[0].length ?? 0;
}

async function readJson(file: string): Promise<JsonObject> {
  const parsed = JSON.parse(await readFile(absolute(file), "utf8")) as unknown;
  if (!isObject(parsed)) throw new Error(`Expected JSON object in ${file}`);
  return parsed;
}

async function writeJson(file: string, value: JsonObject) {
  await writeFile(absolute(file), `${JSON.stringify(value, null, 2)}\n`);
}

function objectAt(parent: JsonObject, key: string) {
  if (isObject(parent[key])) return parent[key];
  const created: JsonObject = {};
  parent[key] = created;
  return created;
}

function globRegExp(pattern: string) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += escapeRegExp(char ?? "");
  }
  return new RegExp(`${source}$`);
}

function safe(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    parts.includes("..") ||
    normalized.includes("\0")
  ) {
    throw new Error(`Unsafe relative path: ${value}`);
  }
  return normalized;
}

function abs(relative: string) {
  return path.join(root, safe(relative || "."));
}

function absolute(file: string) {
  return path.isAbsolute(file) ? file : abs(file);
}

function posix(file: string) {
  return file.split(path.sep).join("/");
}

function escapeRegExp(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function occurrences(text: string, find: string) {
  return text.split(find).length - 1;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(file: string) {
  return stat(file)
    .then(() => true)
    .catch(() => false);
}

async function removeEmptyScriptsDir() {
  await removeEmptyDirectory(abs("scripts"));
}

async function removeEmptyDirectory(directory: string) {
  try {
    if (!(await readdir(directory)).length) await rm(directory, { recursive: true });
  } catch {
    return;
  }
}

function run(command: string) {
  const result = spawnSync(command, { cwd: root, shell: true, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Command failed: ${command}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
