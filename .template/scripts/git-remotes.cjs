const { execFileSync } = require("node:child_process");

// The official repository and legacy distribution points are never a project's origin.
// Compare normalized repository identities so SSH and HTTPS clones are treated alike.
const templateRepositories = Object.freeze([
  "https://github.ibm.com/client-engineering-dach/agentic-cen-starter.git",
  "https://github.com/IBM/agentic-cen-starter.git",
  "https://github.com/felixpahlke/cen-starter.git",
]);
const defaultTemplateRepository = templateRepositories[1];

function normalizeRepositoryUrl(value) {
  if (!value) return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  const scp = trimmed.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp && !trimmed.includes("://")) {
    return `${scp[1].toLowerCase()}/${cleanPath(scp[2])}`;
  }

  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname.toLowerCase()}/${cleanPath(parsed.pathname)}`;
  } catch {
    return null;
  }
}

function cleanPath(value) {
  return value
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

const templateIdentities = new Set(templateRepositories.map(normalizeRepositoryUrl));

function isTemplateRepository(value) {
  const identity = normalizeRepositoryUrl(value);
  return identity !== null && templateIdentities.has(identity);
}

function preferredTemplateRepository() {
  return defaultTemplateRepository;
}

function git(cwd, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    const detail = error.stderr?.toString().trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

function configureProjectRemotes({ cwd, log = console.log }) {
  const origin = git(cwd, ["remote", "get-url", "origin"], { allowFailure: true });
  const upstream = git(cwd, ["remote", "get-url", "upstream"], { allowFailure: true });
  const originIsTemplate = isTemplateRepository(origin);
  const upstreamIsTemplate = isTemplateRepository(upstream);
  const branch = git(cwd, ["branch", "--show-current"], { allowFailure: true });
  const trackedRemote = branch
    ? git(cwd, ["config", "--get", `branch.${branch}.remote`], { allowFailure: true })
    : null;

  // Refuse before making changes: an unrelated `upstream` must not be replaced silently.
  if (upstream && !upstreamIsTemplate) {
    throw new Error(
      'Remote "upstream" does not point to a recognized CEN Starter repository.\n' +
        "Rename that remote or set it to the starter repository, then rerun bootstrap.",
    );
  }

  if (originIsTemplate) {
    if (upstreamIsTemplate) {
      git(cwd, ["remote", "remove", "origin"]);
      log("✓ Removed the duplicate template origin.");
    } else {
      git(cwd, ["remote", "rename", "origin", "upstream"]);
      log("✓ Moved the template remote from origin to upstream.");
    }
  } else if (!upstream) {
    const templateUrl = preferredTemplateRepository();
    git(cwd, ["remote", "add", "upstream", templateUrl]);
    log(`✓ Added the template as upstream (${templateUrl}).`);
  }

  // Migrate recognized legacy clones too, regardless of where the project is hosted.
  git(cwd, ["remote", "set-url", "upstream", defaultTemplateRepository]);

  // An invalid push URL makes even an explicit `git push upstream` fail. Replacing all
  // existing push URLs prevents a second configured URL from remaining usable.
  git(cwd, ["config", "--unset-all", "remote.upstream.pushurl"], { allowFailure: true });
  git(cwd, ["config", "--add", "remote.upstream.pushurl", "DISABLED"]);

  if (
    branch &&
    (trackedRemote === "upstream" || (originIsTemplate && trackedRemote === "origin"))
  ) {
    git(cwd, ["branch", "--unset-upstream"], { allowFailure: true });
  }

  // Bare pushes always target the project's origin. Before publication that remote is
  // deliberately absent, so an accidental push fails instead of reaching the template.
  git(cwd, ["config", "remote.pushDefault", "origin"]);

  const finalOrigin = git(cwd, ["remote", "get-url", "origin"], { allowFailure: true });
  const finalUpstream = git(cwd, ["remote", "get-url", "upstream"], { allowFailure: true });
  const upstreamPush = git(cwd, ["remote", "get-url", "--push", "upstream"], {
    allowFailure: true,
  });
  const finalTrackedRemote = branch
    ? git(cwd, ["config", "--get", `branch.${branch}.remote`], { allowFailure: true })
    : null;

  if (isTemplateRepository(finalOrigin)) {
    throw new Error('Bootstrap safety check failed: "origin" still points to the template.');
  }
  if (!isTemplateRepository(finalUpstream)) {
    throw new Error('Bootstrap safety check failed: "upstream" is not the template.');
  }
  if (upstreamPush !== "DISABLED") {
    throw new Error('Bootstrap safety check failed: pushes to "upstream" are still enabled.');
  }
  if (finalTrackedRemote === "upstream") {
    throw new Error('Bootstrap safety check failed: the current branch still tracks "upstream".');
  }

  log("✓ Template updates are fetch-only through upstream; origin is reserved for this project.");
  if (!finalOrigin)
    log("  No project origin exists yet; setup will offer to create one after finalization.");

  return { origin: finalOrigin, upstream: finalUpstream };
}

module.exports = {
  configureProjectRemotes,
  isTemplateRepository,
  normalizeRepositoryUrl,
  preferredTemplateRepository,
  templateRepositories,
};
