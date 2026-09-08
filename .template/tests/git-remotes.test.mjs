import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import remotes from "../scripts/git-remotes.cjs";

const {
  configureProjectRemotes,
  isTemplateRepository,
  normalizeRepositoryUrl,
  templateRepositories,
} = remotes;

function git(cwd, args, allowFailure = false) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

async function repository() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "cen-remotes-test-"));
  git(cwd, ["init", "--quiet", "--initial-branch", "main"]);
  git(cwd, ["config", "user.name", "CEN Remote Test"]);
  git(cwd, ["config", "user.email", "remote-test@local"]);
  await writeFile(path.join(cwd, "README.md"), "test\n");
  git(cwd, ["add", "README.md"]);
  git(cwd, ["commit", "--quiet", "-m", "Initial"]);
  return cwd;
}

function track(cwd, remote) {
  git(cwd, ["config", "branch.main.remote", remote]);
  git(cwd, ["config", "branch.main.merge", "refs/heads/main"]);
}

function remoteUrl(cwd, name, push = false) {
  return git(cwd, ["remote", "get-url", ...(push ? ["--push"] : []), name], true);
}

test("normalizes SSH and HTTPS forms to the same repository identity", () => {
  assert.equal(
    normalizeRepositoryUrl("git@github.ibm.com:client-engineering-dach/agentic-cen-starter.git"),
    "github.ibm.com/client-engineering-dach/agentic-cen-starter",
  );
  assert.ok(isTemplateRepository("git@github.com:IBM/agentic-cen-starter.git"));
  assert.ok(isTemplateRepository("ssh://git@github.com/felixpahlke/cen-starter.git"));
});

test("moves a cloned template origin to fetch-only upstream", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, ["remote", "add", "origin", templateRepositories[0]]);
  track(cwd, "origin");

  configureProjectRemotes({ cwd, log() {} });

  assert.equal(remoteUrl(cwd, "origin"), null);
  assert.equal(remoteUrl(cwd, "upstream"), templateRepositories[0]);
  assert.equal(remoteUrl(cwd, "upstream", true), "DISABLED");
  assert.equal(git(cwd, ["config", "--get", "branch.main.remote"], true), null);
  assert.equal(git(cwd, ["config", "--get", "remote.pushDefault"]), "origin");
});

test("keeps a project origin and adds the matching template upstream", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const project = "git@github.ibm.com:example/my-app.git";
  git(cwd, ["remote", "add", "origin", project]);
  track(cwd, "origin");

  configureProjectRemotes({ cwd, log() {} });

  assert.equal(remoteUrl(cwd, "origin"), project);
  assert.equal(remoteUrl(cwd, "upstream"), templateRepositories[0]);
  assert.equal(remoteUrl(cwd, "upstream", true), "DISABLED");
  assert.equal(git(cwd, ["config", "--get", "branch.main.remote"]), "origin");
});

test("keeps an existing project origin and recognized template upstream", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const project = "https://github.com/example/my-app.git";
  git(cwd, ["remote", "add", "origin", project]);
  git(cwd, ["remote", "add", "upstream", templateRepositories[1]]);
  git(cwd, ["remote", "set-url", "--add", "--push", "upstream", templateRepositories[1]]);
  git(cwd, ["remote", "set-url", "--add", "--push", "upstream", "https://example.com/unsafe.git"]);

  configureProjectRemotes({ cwd, log() {} });

  assert.equal(remoteUrl(cwd, "origin"), project);
  assert.equal(remoteUrl(cwd, "upstream"), templateRepositories[1]);
  assert.deepEqual(git(cwd, ["config", "--get-all", "remote.upstream.pushurl"]).split("\n"), [
    "DISABLED",
  ]);
});

test("removes a duplicate template origin when upstream already exists", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, ["remote", "add", "origin", templateRepositories[0]]);
  git(cwd, ["remote", "add", "upstream", templateRepositories[1]]);
  track(cwd, "origin");

  configureProjectRemotes({ cwd, log() {} });

  assert.equal(remoteUrl(cwd, "origin"), null);
  assert.equal(remoteUrl(cwd, "upstream"), templateRepositories[1]);
  assert.equal(remoteUrl(cwd, "upstream", true), "DISABLED");
  assert.equal(git(cwd, ["config", "--get", "branch.main.remote"], true), null);
});

test("adds a public upstream when a copied checkout has no remotes", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  configureProjectRemotes({ cwd, log() {} });

  assert.equal(remoteUrl(cwd, "origin"), null);
  assert.equal(remoteUrl(cwd, "upstream"), templateRepositories[1]);
  assert.equal(remoteUrl(cwd, "upstream", true), "DISABLED");
});

test("refuses to replace an unrelated upstream", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const project = "https://github.com/example/my-app.git";
  const unrelated = "https://github.com/example/shared-library.git";
  git(cwd, ["remote", "add", "origin", project]);
  git(cwd, ["remote", "add", "upstream", unrelated]);

  assert.throws(
    () => configureProjectRemotes({ cwd, log() {} }),
    /does not point to a recognized CEN Starter repository/,
  );
  assert.equal(remoteUrl(cwd, "origin"), project);
  assert.equal(remoteUrl(cwd, "upstream"), unrelated);
});
