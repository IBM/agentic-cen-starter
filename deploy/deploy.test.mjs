import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("autodeploy uses gh + SSH and verifies namespace webhook access", async (t) => {
  const fixture = await createFixture(t);
  const result = runDeploy(fixture);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Added a read-only OpenShift deploy key/);
  assert.match(result.output, /Verified GitHub can reach the OpenShift webhook endpoint/);
  assert.match(result.output, /Autodeploy: git push to main/);

  const manifests = await readFile(fixture.manifests, "utf8");
  assert.match(manifests, /kind: RoleBinding/);
  assert.match(manifests, /name: system:webhook/);
  assert.match(manifests, /name: system:unauthenticated/);
  assert.match(manifests, /uri: "git@github\.ibm\.com:example\/todo-app\.git"/);

  const ocLog = await readFile(fixture.ocLog, "utf8");
  assert.match(ocLog, /--type=kubernetes\.io\/ssh-auth/);
  assert.doesNotMatch(ocLog, /kubernetes\.io\/basic-auth/);
  const privateKeyPath = ocLog.match(/--from-file=ssh-privatekey=([^\s]+)/)?.[1];
  assert.ok(privateKeyPath, "the OpenShift SSH secret should come from a temporary key file");
  await assert.rejects(access(privateKeyPath), "the temporary private key should be removed");

  const ghLog = await readFile(fixture.ghLog, "utf8");
  assert.match(ghLog, /repos\/example\/todo-app\/keys/);
  assert.match(ghLog, /repos\/example\/todo-app\/hooks\/42\/pings/);
  assert.match(ghLog, /repos\/example\/todo-app\/hooks\/42\/deliveries/);

  const appEnv = await readFile(fixture.appEnv, "utf8");
  assert.doesNotMatch(appEnv, /legacy-token-must-not-reach-the-app/);
  assert.doesNotMatch(appEnv, /cloud-key-must-not-reach-the-app/);

  assert.match(ocLog, /rollout restart -n test-project deploy\/cen-starter/);
  assert.match(ocLog, /rollout status -n test-project deploy\/cen-starter --timeout=15m/);
  assert.match(ocLog, /get endpoints cen-starter/);
});

test("autodeploy stops before mutation when gh is not authenticated", async (t) => {
  const fixture = await createFixture(t, { ghAuthenticated: false });
  const result = runDeploy(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.output, /gh auth login --hostname github\.ibm\.com --web/);

  const ocLog = await readFile(fixture.ocLog, "utf8");
  assert.doesNotMatch(ocLog, /\b(create|apply|set|start-build)\b/);
});

test("autodeploy keeps the initial deploy usable when webhook RBAC is unavailable", async (t) => {
  const fixture = await createFixture(t, { webhookRbacDenied: true });
  const result = runDeploy(fixture);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /GitHub push automation is inactive/);
  assert.match(result.output, /Autodeploy: inactive/);

  const ghLog = await readFile(fixture.ghLog, "utf8");
  assert.doesNotMatch(ghLog, /\/hooks/);

  const ocLog = await readFile(fixture.ocLog, "utf8");
  assert.match(ocLog, /start-build -n test-project cen-starter/);
});

test("autodeploy reuses an existing webhook RoleBinding without fresh bind rights", async (t) => {
  const fixture = await createFixture(t, {
    webhookRbacDenied: true,
    webhookRbacExists: true,
  });
  const result = runDeploy(fixture);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Autodeploy: git push to main now builds and deploys automatically/);

  const ocLog = await readFile(fixture.ocLog, "utf8");
  assert.match(ocLog, /get rolebinding cen-starter-webhook -n test-project/);
  assert.doesNotMatch(ocLog, /auth can-i/);
});

test("autodeploy validates and deploys a configured source branch", async (t) => {
  const fixture = await createFixture(t);
  const result = runDeploy(fixture, ["--branch", "release/2026-08"]);

  assert.equal(result.status, 0, result.output);
  const manifests = await readFile(fixture.manifests, "utf8");
  assert.match(manifests, /ref: "release\/2026-08"/);
  assert.match(result.output, /git push to release\/2026-08/);
});

test("Code Engine fresh deploy targets explicitly and reconciles health settings", async (t) => {
  const fixture = await createCodeEngineFixture(t);
  const result = spawnSync(
    "bash",
    ["deploy/ce-deploy.sh", "-p", "test-project", "-g", "engagement", "--region", "eu-de"],
    {
      cwd: fixture.directory,
      encoding: "utf8",
      env: {
        ...process.env,
        MOCK_STATE: fixture.state,
        PATH: `${fixture.bin}:${process.env.PATH}`,
      },
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.equal(result.status, 0, output);
  assert.match(
    output,
    /Application: https:\/\/cen-starter(?:-oauth-proxy)?\.test\.eu-de\.codeengine\.appdomain\.cloud/,
  );

  const log = await readFile(fixture.ibmcloudLog, "utf8");
  const ceScript = await readFile(path.join(fixture.directory, "deploy/ce-deploy.sh"), "utf8");
  const visibility = ceScript.includes('APP_VISIBILITY="project"') ? "project" : "public";
  assert.match(log, /target -g engagement/);
  assert.match(log, /target -r eu-de/);
  assert.match(log, /ce project create --name test-project --wait --wait-timeout 600/);
  assert.match(log, /ce project select --name test-project/);
  assert.match(log, /ce application create .*--port http1:8080/);
  assert.match(log, new RegExp(`--visibility ${visibility}`));
  assert.match(log, /--probe-live path=\/api\/health/);
  assert.match(log, /--probe-live initial-delay=10/);
  assert.match(log, /--probe-live interval=10/);
  assert.match(log, /--probe-ready path=\/api\/health/);
  assert.match(log, /--build-timeout 1800/);
  assert.match(log, /--wait-timeout 3000/);
  if (ceScript.includes("DATABASE_URL is missing")) {
    // The database preflight runs when DATABASE_URL is validated (skipped here:
    // the fixture has no backend workspace with dependencies installed).
    assert.match(output, /Skipping the database preflight/);
  }

  const appEnv = await readFile(fixture.appEnv, "utf8");
  assert.doesNotMatch(appEnv, /cloud-key-must-not-reach-the-app/);
  assert.match(
    appEnv,
    /(?:BETTER_AUTH_URL=https:\/\/cen-starter\.test\.eu-de\.codeengine\.appdomain\.cloud|OAUTH2_PROXY_REDIRECT_URL=https:\/\/cen-starter-oauth-proxy\.test\.eu-de\.codeengine\.appdomain\.cloud\/oauth2\/callback)/,
  );

  if (ceScript.includes("private_application_url")) {
    // Two separate CE apps: the proxy upstream must be cluster-local from the very first
    // secret write - localhost:8080 in the secret means 502s whenever a deploy is cut short.
    assert.match(
      appEnv,
      /OAUTH2_PROXY_UPSTREAMS=http:\/\/cen-starter\.test\.svc\.cluster\.local\//,
    );
    assert.doesNotMatch(appEnv, /OAUTH2_PROXY_UPSTREAMS=http:\/\/localhost/);
  }
  if (visibility === "project") {
    assert.match(
      log,
      /ce application (?:create|update) --name cen-starter-oauth-proxy .*--argument=--pass-host-header=false/,
    );
  }
  assert.match(
    log,
    /ce application update --name cen-starter(?:-oauth-proxy)? --wait --wait-timeout 600/,
  );
});

test("Code Engine names the application after the bootstrapped project", async (t) => {
  const fixture = await createCodeEngineFixture(t);
  // `pnpm bootstrap` writes the project name here; the deploy scripts must pick it up
  // (sanitized for Code Engine: dots and underscores become hyphens).
  await writeFile(
    path.join(fixture.directory, "package.json"),
    JSON.stringify({ name: "todo-app_2.x" }),
  );

  const result = spawnSync("bash", ["deploy/ce-deploy.sh", "-p", "test-project"], {
    cwd: fixture.directory,
    encoding: "utf8",
    env: { ...process.env, MOCK_STATE: fixture.state, PATH: `${fixture.bin}:${process.env.PATH}` },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.equal(result.status, 0, output);
  const log = await readFile(fixture.ibmcloudLog, "utf8");
  assert.match(log, /ce application (?:create|update) --name todo-app-2-x /);
  assert.doesNotMatch(log, /--name cen-starter(\s|$)/);
  assert.match(
    output,
    /Application: https:\/\/todo-app-2-x(?:-oauth-proxy)?\.test\.eu-de\.codeengine\.appdomain\.cloud/,
  );
});

test("Code Engine rollout failure prints status, logs, and guidance", async (t) => {
  const fixture = await createCodeEngineFixture(t);
  await writeFile(path.join(fixture.state, "app-create-fails"), "");

  const result = spawnSync("bash", ["deploy/ce-deploy.sh", "-p", "test-project"], {
    cwd: fixture.directory,
    encoding: "utf8",
    env: { ...process.env, MOCK_STATE: fixture.state, PATH: `${fixture.bin}:${process.env.PATH}` },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.notEqual(result.status, 0, output);
  assert.match(output, /did not become ready/);
  // The container logs are surfaced so the failure cause is visible without extra commands.
  assert.match(output, /relation "todo" already exists/);
  assert.match(output, /rerun \.\/deploy\/ce-deploy\.sh/);
});

test("Code Engine watchdog stops a crash-looping rollout instead of waiting it out", async (t) => {
  const fixture = await createCodeEngineFixture(t);
  await writeFile(path.join(fixture.state, "app-crashloop"), "");

  const started = Date.now();
  const result = spawnSync("bash", ["deploy/ce-deploy.sh", "-p", "test-project"], {
    cwd: fixture.directory,
    encoding: "utf8",
    env: {
      ...process.env,
      CE_DEPLOY_ROLLOUT_CHECK_SECONDS: "2",
      MOCK_STATE: fixture.state,
      PATH: `${fixture.bin}:${process.env.PATH}`,
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.notEqual(result.status, 0, output);
  assert.match(output, /crash-looping/);
  assert.match(output, /relation "todo" already exists/);
  // Caught via BackOff events within seconds, not by the rollout wait timeout.
  assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started}ms`);
});

test("Code Engine creates a private production env template before cloud access", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cen-ce-env-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });

  await cp(path.join(root, "deploy"), path.join(directory, "deploy"), { recursive: true });
  await cp(
    path.join(root, ".env.production.example"),
    path.join(directory, ".env.production.example"),
  );

  const result = spawnSync("bash", ["deploy/ce-deploy.sh", "-p", "test-project"], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /created \.env\.production from \.env\.production\.example/);
  assert.equal((await stat(path.join(directory, ".env.production"))).mode & 0o777, 0o600);
});

test("Code Engine refuses an IBM Cloud Databases URL without a CA or an explicit opt-out", async (t) => {
  // The no-database flavor removes the DATABASE_URL handling this preflight lives in.
  const ceScript = await readFile(path.join(root, "deploy/ce-deploy.sh"), "utf8");
  if (!ceScript.includes("DATABASE_CA_CERT")) {
    t.skip("flavor has no database");
    return;
  }

  const fixture = await createCodeEngineFixture(t);
  await writeFile(
    path.join(fixture.directory, ".env.production"),
    [
      "DATABASE_URL=postgres://app:password@host.databases.appdomain.cloud:32000/ibmclouddb?sslmode=verify-full",
      "DATABASE_CA_CERT=",
      "OAUTH2_PROXY_OIDC_ISSUER_URL=https://auth.example.test/oidc",
      "OAUTH2_PROXY_CLIENT_ID=test-client-id",
      "OAUTH2_PROXY_CLIENT_SECRET=test-client-secret",
      "BETTER_AUTH_SECRET=test-secret-with-at-least-32-characters",
      "BETTER_AUTH_URL=https://cen-starter.example.com",
      "export IAM_API_KEY=cloud-key-must-not-reach-the-app",
      "",
    ].join("\n"),
  );

  const result = spawnSync("bash", ["deploy/ce-deploy.sh", "-p", "test-project"], {
    cwd: fixture.directory,
    encoding: "utf8",
    env: { ...process.env, MOCK_STATE: fixture.state, PATH: `${fixture.bin}:${process.env.PATH}` },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /DATABASE_CA_CERT is empty/);
  assert.match(output, /deployment-cacert/);
  assert.match(output, /no-verify/);
  assert.doesNotMatch(await readFile(fixture.ibmcloudLog, "utf8"), /ce application/);
});

test("Code Engine accepts an IBM Cloud Databases URL once a CA is configured", async (t) => {
  // The no-database flavor removes the DATABASE_URL handling this preflight lives in.
  const ceScript = await readFile(path.join(root, "deploy/ce-deploy.sh"), "utf8");
  if (!ceScript.includes("DATABASE_CA_CERT")) {
    t.skip("flavor has no database");
    return;
  }

  const fixture = await createCodeEngineFixture(t);
  await writeFile(
    path.join(fixture.directory, ".env.production"),
    [
      "DATABASE_URL=postgres://app:password@host.databases.appdomain.cloud:32000/ibmclouddb?sslmode=verify-full",
      "DATABASE_CA_CERT=cGxhY2Vob2xkZXI=",
      "OAUTH2_PROXY_OIDC_ISSUER_URL=https://auth.example.test/oidc",
      "OAUTH2_PROXY_CLIENT_ID=test-client-id",
      "OAUTH2_PROXY_CLIENT_SECRET=test-client-secret",
      "BETTER_AUTH_SECRET=test-secret-with-at-least-32-characters",
      "BETTER_AUTH_URL=https://cen-starter.example.com",
      "export IAM_API_KEY=cloud-key-must-not-reach-the-app",
      "",
    ].join("\n"),
  );

  const result = spawnSync("bash", ["deploy/ce-deploy.sh", "-p", "test-project"], {
    cwd: fixture.directory,
    encoding: "utf8",
    env: { ...process.env, MOCK_STATE: fixture.state, PATH: `${fixture.bin}:${process.env.PATH}` },
  });

  assert.equal(result.status, 0, `${result.stdout ?? ""}${result.stderr ?? ""}`);
  assert.match(await readFile(fixture.appEnv, "utf8"), /DATABASE_CA_CERT=cGxhY2Vob2xkZXI=/);
});

test("Code Engine derives oauth2-proxy values from an App ID credentials file", async (t) => {
  // Only the oauth-proxy flavor ships the helper.
  try {
    await access(path.join(root, "deploy/idp-credentials.mjs"));
  } catch {
    t.skip("flavor has no App ID credentials helper");
    return;
  }

  const fixture = await createCodeEngineFixture(t);
  await writeFile(
    path.join(fixture.directory, ".env.production"),
    [
      "DATABASE_URL=postgres://app:password@postgres.example:5432/app",
      "OAUTH2_PROXY_OIDC_ISSUER_URL=https://idp.example.com/oidc",
      "OAUTH2_PROXY_PROVIDER=oidc",
      "OAUTH2_PROXY_CLIENT_ID=replace-with-client-id",
      "OAUTH2_PROXY_CLIENT_SECRET=replace-with-client-secret",
      "export IAM_API_KEY=cloud-key-must-not-reach-the-app",
      "",
    ].join("\n"),
  );
  await mkdir(path.join(fixture.directory, ".secrets"));
  await writeFile(
    path.join(fixture.directory, ".secrets/idp-credentials.json"),
    JSON.stringify({
      clientId: "client-id-from-file",
      secret: "secret-value-from-file",
      oAuthServerUrl: "https://eu-de.appid.cloud.ibm.com/oauth/v4/tenant-from-file",
      type: "regularwebapp",
    }),
  );

  const result = spawnSync("bash", ["deploy/ce-deploy.sh", "-p", "test-project"], {
    cwd: fixture.directory,
    encoding: "utf8",
    env: { ...process.env, MOCK_STATE: fixture.state, PATH: `${fixture.bin}:${process.env.PATH}` },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.equal(result.status, 0, output);
  const appEnv = await readFile(fixture.appEnv, "utf8");
  assert.match(appEnv, /OAUTH2_PROXY_CLIENT_ID=client-id-from-file/);
  assert.match(appEnv, /OAUTH2_PROXY_CLIENT_SECRET=secret-value-from-file/);
  assert.match(
    appEnv,
    /OAUTH2_PROXY_OIDC_ISSUER_URL=https:\/\/eu-de\.appid\.cloud\.ibm\.com\/oauth\/v4\/tenant-from-file/,
  );
  // The secret must reach the app secret and nothing else.
  assert.doesNotMatch(output, /secret-value-from-file/);
  assert.match(output, /OAUTH2_PROXY_CLIENT_SECRET=<from \.secrets\/idp-credentials\.json>/);
});

test("Code Engine refuses to deploy example-value OAuth credentials", async (t) => {
  try {
    await access(path.join(root, "deploy/idp-credentials.mjs"));
  } catch {
    t.skip("flavor has no App ID credentials helper");
    return;
  }

  const fixture = await createCodeEngineFixture(t);
  await writeFile(
    path.join(fixture.directory, ".env.production"),
    [
      "DATABASE_URL=postgres://app:password@postgres.example:5432/app",
      "OAUTH2_PROXY_OIDC_ISSUER_URL=https://idp.example.com/oidc",
      "OAUTH2_PROXY_PROVIDER=oidc",
      "OAUTH2_PROXY_CLIENT_ID=replace-with-client-id",
      "OAUTH2_PROXY_CLIENT_SECRET=replace-with-client-secret",
      "export IAM_API_KEY=cloud-key-must-not-reach-the-app",
      "",
    ].join("\n"),
  );

  const result = spawnSync("bash", ["deploy/ce-deploy.sh", "-p", "test-project"], {
    cwd: fixture.directory,
    encoding: "utf8",
    env: { ...process.env, MOCK_STATE: fixture.state, PATH: `${fixture.bin}:${process.env.PATH}` },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /still the example value/);
  assert.match(output, /\.secrets\/idp-credentials\.json/);
  // The refusal creates the empty file so the user only has to paste into it.
  const created = await stat(path.join(fixture.directory, ".secrets/idp-credentials.json"));
  assert.equal(created.size, 0);
});

test("Code Engine rejects an App ID credentials file for the wrong registration type", async (t) => {
  try {
    await access(path.join(root, "deploy/idp-credentials.mjs"));
  } catch {
    t.skip("flavor has no App ID credentials helper");
    return;
  }

  const fixture = await createCodeEngineFixture(t);
  await mkdir(path.join(fixture.directory, ".secrets"));
  await writeFile(
    path.join(fixture.directory, ".secrets/idp-credentials.json"),
    JSON.stringify({ clientId: "spa-client", type: "singlepageapp" }),
  );

  const result = spawnSync("bash", ["deploy/ce-deploy.sh", "-p", "test-project"], {
    cwd: fixture.directory,
    encoding: "utf8",
    env: { ...process.env, MOCK_STATE: fixture.state, PATH: `${fixture.bin}:${process.env.PATH}` },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /Regular web application/);
});

test("Code Engine preflight reports every problem in one run", async (t) => {
  const ceScript = await readFile(path.join(root, "deploy/ce-deploy.sh"), "utf8");
  if (!ceScript.includes("validate_production_env")) {
    t.skip("flavor has no production env validation");
    return;
  }

  const fixture = await createCodeEngineFixture(t);
  await writeFile(
    path.join(fixture.directory, ".env.production"),
    [
      "DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE?sslmode=no-verify",
      "OAUTH2_PROXY_OIDC_ISSUER_URL=https://idp.example.com/oidc",
      "OAUTH2_PROXY_CLIENT_ID=replace-with-client-id",
      "OAUTH2_PROXY_CLIENT_SECRET=replace-with-client-secret",
      "",
    ].join("\n"),
  );

  const result = spawnSync("bash", ["deploy/ce-deploy.sh", "-p", "test-project"], {
    cwd: fixture.directory,
    encoding: "utf8",
    env: {
      ...process.env,
      IBMCLOUD_API_KEY: "",
      MOCK_STATE: fixture.state,
      PATH: `${fixture.bin}:${process.env.PATH}`,
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /is not ready to deploy/);
  if (ceScript.includes("DATABASE_URL is missing")) {
    assert.match(output, /1\. DATABASE_URL is missing or still the example value/);
  } else {
    // The no-database flavor validates its API_KEY instead.
    assert.match(output, /1\. API_KEY is missing or still the example value/);
  }
  assert.match(output, /create-deploy-key\.sh/);
  // preflight runs before any cloud interaction
  assert.doesNotMatch(await readFile(fixture.ibmcloudLog, "utf8"), /ce (project|application)/);
  // On the oauth flavor the preflight also creates the empty credentials file to paste into.
  if (ceScript.includes(".secrets/idp-credentials.json")) {
    const created = await stat(path.join(fixture.directory, ".secrets/idp-credentials.json"));
    assert.equal(created.size, 0);
  }
});

test("Code Engine first run creates the env file and still lists every problem", async (t) => {
  const ceScript = await readFile(path.join(root, "deploy/ce-deploy.sh"), "utf8");
  if (!ceScript.includes("validate_production_env")) {
    t.skip("flavor has no production env validation");
    return;
  }

  const fixture = await createCodeEngineFixture(t);
  const { rm } = await import("node:fs/promises");
  await rm(path.join(fixture.directory, ".env.production"));
  await cp(
    path.join(root, ".env.production.example"),
    path.join(fixture.directory, ".env.production.example"),
  );

  const result = spawnSync("bash", ["deploy/ce-deploy.sh", "-p", "test-project"], {
    cwd: fixture.directory,
    encoding: "utf8",
    env: {
      ...process.env,
      IBMCLOUD_API_KEY: "",
      MOCK_STATE: fixture.state,
      PATH: `${fixture.bin}:${process.env.PATH}`,
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  // The very first run must not stop at "created the file, rerun": it creates the env file
  // AND reports the complete list of values to fill in, before any cloud interaction.
  assert.notEqual(result.status, 0);
  assert.match(output, /created \.env\.production from \.env\.production\.example/);
  assert.match(output, /is not ready to deploy/);
  await access(path.join(fixture.directory, ".env.production"));
  assert.doesNotMatch(await readFile(fixture.ibmcloudLog, "utf8"), /ce (project|application)/);
});

test("create-deploy-key stores the key without displaying it", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cen-deploy-key-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  await cp(
    path.join(root, "deploy/create-deploy-key.sh"),
    path.join(directory, "deploy/create-deploy-key.sh"),
  );
  // Running the key script before the first deploy must not leave a template-less env file.
  await cp(
    path.join(root, ".env.production.example"),
    path.join(directory, ".env.production.example"),
  );

  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await writeExecutable(
    path.join(bin, "ibmcloud"),
    [
      "#!/usr/bin/env bash",
      'if [[ "$1" == account ]]; then exit 0; fi',
      'if [[ "$1 $2" == "iam api-key-create" ]]; then',
      '  file=""',
      '  while (($#)); do if [[ "$1" == --file ]]; then file="$2"; fi; shift; done',
      '  printf \'%s\' \'{"apikey":"secret-key-value-123"}\' > "$file"',
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );

  const result = spawnSync("bash", ["deploy/create-deploy-key.sh", "test-key"], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.equal(result.status, 0, output);
  const env = await readFile(path.join(directory, ".env.production"), "utf8");
  assert.match(env, /IAM_API_KEY=secret-key-value-123/);
  assert.doesNotMatch(output, /secret-key-value-123/);
  assert.equal((await stat(path.join(directory, ".env.production"))).mode & 0o777, 0o600);
  // The example template must survive: the file starts as a copy of the example,
  // with the key added, so the user still has every placeholder to fill in.
  // (Every flavor's example has comment lines; a key-only file has none.)
  assert.match(env, /^#/m);

  // Rerunning must not mint another key: same script, same mock, key already stored.
  const rerun = spawnSync("bash", ["deploy/create-deploy-key.sh", "test-key"], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, IBMCLOUD_API_KEY: "", PATH: `${bin}:${process.env.PATH}` },
  });
  const rerunOutput = `${rerun.stdout ?? ""}${rerun.stderr ?? ""}`;
  assert.equal(rerun.status, 0, rerunOutput);
  assert.match(rerunOutput, /already stored/);
  assert.doesNotMatch(rerunOutput, /secret-key-value-123/);
  const envAfterRerun = await readFile(path.join(directory, ".env.production"), "utf8");
  assert.equal(envAfterRerun, env);
  assert.equal(envAfterRerun.match(/^IAM_API_KEY=/gm).length, 1);
});

test("Code Engine redeploys reuse the cookie secret verbatim", async (t) => {
  const ceScript = await readFile(path.join(root, "deploy/ce-deploy.sh"), "utf8");
  if (!ceScript.includes("read_code_engine_secret_key")) {
    t.skip("flavor does not reuse a cookie secret");
    return;
  }

  const fixture = await createCodeEngineFixture(t);
  const run = () =>
    spawnSync("bash", ["deploy/ce-deploy.sh", "-p", "test-project"], {
      cwd: fixture.directory,
      encoding: "utf8",
      env: {
        ...process.env,
        MOCK_STATE: fixture.state,
        PATH: `${fixture.bin}:${process.env.PATH}`,
      },
    });

  const first = run();
  assert.equal(first.status, 0, `${first.stdout ?? ""}${first.stderr ?? ""}`);
  const firstSecret = (await readFile(fixture.appEnv, "utf8")).match(
    /^OAUTH2_PROXY_COOKIE_SECRET=(.+)$/m,
  )?.[1];
  assert.ok(firstSecret, "first deploy should generate a cookie secret");

  const second = run();
  const output = `${second.stdout ?? ""}${second.stderr ?? ""}`;
  assert.equal(second.status, 0, output);
  assert.match(output, /reusing existing OAUTH2_PROXY_COOKIE_SECRET/);
  const secondSecret = (await readFile(fixture.appEnv, "utf8")).match(
    /^OAUTH2_PROXY_COOKIE_SECRET=(.+)$/m,
  )?.[1];
  // The CE CLI returns secret values already decoded; decoding again would corrupt the
  // reused secret into binary garbage and crashloop oauth2-proxy on every redeploy.
  assert.equal(secondSecret, firstSecret);
});

test("Code Engine update reuses credentials and fully reconciles the application", async (t) => {
  const fixture = await createCodeEngineFixture(t, { existing: true, includeApiKey: false });
  const result = spawnSync("bash", ["deploy/ce-deploy.sh", "-p", "test-project"], {
    cwd: fixture.directory,
    encoding: "utf8",
    env: {
      ...process.env,
      IBMCLOUD_API_KEY: "",
      MOCK_STATE: fixture.state,
      PATH: `${fixture.bin}:${process.env.PATH}`,
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /Reusing Code Engine registry secret/);

  const log = await readFile(fixture.ibmcloudLog, "utf8");
  const ceScript = await readFile(path.join(fixture.directory, "deploy/ce-deploy.sh"), "utf8");
  const visibility = ceScript.includes('APP_VISIBILITY="project"') ? "project" : "public";
  assert.doesNotMatch(log, /ce project create/);
  assert.doesNotMatch(log, /ce registry (create|update)/);
  assert.match(log, /ce project select --name test-project/);
  assert.match(log, /ce application update .*--env-from-secret app-env/);
  assert.match(log, /ce application update .*--max-scale 4/);
  assert.match(log, /ce application update .*--probe-live path=\/api\/health/);
  assert.match(log, new RegExp(`ce application update .*--visibility ${visibility}`));
});

async function createFixture(
  t,
  { ghAuthenticated = true, webhookRbacDenied = false, webhookRbacExists = false } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cen-deploy-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });

  await cp(path.join(root, "deploy"), path.join(directory, "deploy"), {
    recursive: true,
    filter(source) {
      return !source.endsWith("deploy.test.mjs");
    },
  });
  await writeFile(
    path.join(directory, ".env.production"),
    [
      "DATABASE_URL=postgres://app:password@postgres.example:5432/app",
      "BETTER_AUTH_SECRET=test-secret-with-at-least-32-characters",
      "BETTER_AUTH_URL=https://cen-starter.example.com",
      "GITHUB_TOKEN=legacy-token-must-not-reach-the-app",
      "export IAM_API_KEY=cloud-key-must-not-reach-the-app",
      "",
    ].join("\n"),
  );

  const bin = path.join(directory, "bin");
  const state = path.join(directory, "state");
  await mkdir(bin);
  await mkdir(state);

  const fixture = {
    appEnv: path.join(state, "app-env"),
    bin,
    directory,
    ghAuthenticated,
    ghLog: path.join(state, "gh.log"),
    manifests: path.join(state, "manifests.yaml"),
    ocLog: path.join(state, "oc.log"),
    state,
    webhookRbacDenied,
  };
  await Promise.all([
    writeExecutable(path.join(bin, "git"), gitMock),
    writeExecutable(path.join(bin, "gh"), ghMock),
    writeExecutable(path.join(bin, "oc"), ocMock),
    writeFile(fixture.ghLog, ""),
    writeFile(fixture.manifests, ""),
    writeFile(fixture.ocLog, ""),
  ]);
  if (webhookRbacExists) {
    await writeFile(path.join(state, "webhook-rolebinding-exists"), "");
  }
  return fixture;
}

async function createCodeEngineFixture(t, { existing = false, includeApiKey = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cen-ce-deploy-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });

  await cp(path.join(root, "deploy"), path.join(directory, "deploy"), {
    recursive: true,
    filter(source) {
      return !source.endsWith("deploy.test.mjs");
    },
  });
  await writeFile(
    path.join(directory, ".env.production"),
    [
      "DATABASE_URL=postgres://app:password@postgres.example:5432/app",
      "API_KEY=test-api-key-for-the-no-database-flavor",
      "BETTER_AUTH_SECRET=test-secret-with-at-least-32-characters",
      "BETTER_AUTH_URL=https://cen-starter.example.com",
      "OAUTH2_PROXY_OIDC_ISSUER_URL=https://auth.example.test/oidc",
      "OAUTH2_PROXY_CLIENT_ID=test-client-id",
      "OAUTH2_PROXY_CLIENT_SECRET=test-client-secret",
      ...(includeApiKey ? ["export IAM_API_KEY=cloud-key-must-not-reach-the-app"] : []),
      "",
    ].join("\n"),
  );

  const bin = path.join(directory, "bin");
  const state = path.join(directory, "state");
  await mkdir(bin);
  await mkdir(state);

  const fixture = {
    appEnv: path.join(state, "app-env"),
    bin,
    directory,
    ibmcloudLog: path.join(state, "ibmcloud.log"),
    state,
  };
  await Promise.all([
    writeExecutable(path.join(bin, "ibmcloud"), ibmcloudMock),
    writeFile(fixture.ibmcloudLog, ""),
  ]);
  if (existing) {
    await Promise.all([
      writeFile(path.join(state, "project-created"), ""),
      writeFile(path.join(state, "registry-created"), ""),
      writeFile(path.join(state, "secret-created"), ""),
      writeFile(path.join(state, "app-created"), ""),
      writeFile(path.join(state, "proxy-created"), ""),
    ]);
  }
  return fixture;
}

function runDeploy(fixture, extraArgs = []) {
  const result = spawnSync(
    "bash",
    ["deploy/deploy.sh", "-n", "test-project", "--autodeploy", ...extraArgs],
    {
      cwd: fixture.directory,
      encoding: "utf8",
      env: {
        ...process.env,
        GH_AUTHENTICATED: fixture.ghAuthenticated ? "true" : "false",
        MOCK_STATE: fixture.state,
        MOCK_WEBHOOK_RBAC_DENIED: fixture.webhookRbacDenied ? "true" : "false",
        PATH: `${fixture.bin}:${process.env.PATH}`,
      },
    },
  );
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    status: result.status,
  };
}

async function writeExecutable(file, content) {
  await writeFile(file, content);
  await chmod(file, 0o755);
}

const gitMock = String.raw`#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "remote get-url origin") printf '%s\n' 'https://github.ibm.com/example/todo-app.git' ;;
  "ls-remote --exit-code origin refs/heads/"*)
    printf '%s\n' '0123456789012345678901234567890123456789	refs/heads/main'
    ;;
  *) printf 'unexpected git call: %s\n' "$*" >&2; exit 1 ;;
esac
`;

const ghMock = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_STATE/gh.log"

if [[ "$*" == auth\ status* ]]; then
  [[ "$GH_AUTHENTICATED" == true ]]
  exit
fi

if [[ "$*" == *'/keys'* ]]; then
  exit 0
fi

if [[ "$*" == *'/deliveries?'* ]]; then
  if [[ -f "$MOCK_STATE/pinged" ]]; then printf '101\t200\n'; fi
  exit 0
fi

if [[ "$*" == *'/pings'* ]]; then
  : > "$MOCK_STATE/pinged"
  exit 0
fi

if [[ "$*" == *'--method POST'* && "$*" == *'/hooks '* ]]; then
  printf '42\n'
  exit 0
fi

if [[ "$*" == *'/hooks'* ]]; then
  printf '[[]]\n'
  exit 0
fi

printf 'unexpected gh call: %s\n' "$*" >&2
exit 1
`;

const ocMock = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_STATE/oc.log"

if [[ "$*" == "whoami" ]]; then printf 'test-user\n'; exit 0; fi
if [[ "$*" == "whoami --show-server" ]]; then
  printf 'https://api.openshift.example:6443\n'
  exit 0
fi
if [[ "$*" == "get namespace test-project" ]]; then exit 0; fi

if [[ "$1" == auth && "$2" == can-i ]]; then
  if [[ "$MOCK_WEBHOOK_RBAC_DENIED" == true && "$*" == *'bind clusterroles'* ]]; then
    printf 'no\n'
  else
    printf 'yes\n'
  fi
  exit 0
fi

if [[ "$1" == get && "$2" == rolebinding ]]; then
  [[ -f "$MOCK_STATE/webhook-rolebinding-exists" ]]
  exit
fi

if [[ "$1" == get && "$2" == secret ]]; then exit 1; fi

if [[ "$1" == get && "$2" == deployment && "$*" == *'.spec.template.spec.containers'* ]]; then
  printf 'image-registry.openshift-image-registry.svc:5000/test-project/cen-starter@sha256:0123456789abcdef\n'
  exit 0
fi

if [[ "$1" == get && "$2" == endpoints ]]; then printf '10.0.0.42\n'; exit 0; fi

if [[ "$1" == get && "$2" == route ]]; then
  if [[ "$*" == *'.spec.host'* ]]; then printf 'todo.test.example\n'; fi
  if [[ "$*" == *'.spec.tls.termination'* ]]; then printf 'edge\n'; fi
  exit 0
fi

if [[ "$1" == get && "$*" == *'build/'* && "$*" == *'.status.phase'* ]]; then
  printf 'Complete\n'
  exit 0
fi

if [[ "$1" == create && "$2" == secret ]]; then
  for argument in "$@"; do
    if [[ "$argument" == --from-env-file=* ]]; then
      env_file=$(printf '%s' "$argument" | cut -d= -f2-)
      cp "$env_file" "$MOCK_STATE/app-env"
    fi
  done
  printf '%s\n' 'apiVersion: v1' 'kind: Secret'
  exit 0
fi

if [[ "$1" == apply ]]; then
  if [[ "$*" == *' -f -'* ]]; then cat >> "$MOCK_STATE/manifests.yaml"; fi
  exit 0
fi

if [[ "$1" == start-build ]]; then
  printf 'build.build.openshift.io/cen-starter-1\n'
  exit 0
fi

if [[ "$1" == set || "$1" == rollout ]]; then exit 0; fi

printf 'unexpected oc call: %s\n' "$*" >&2
exit 1
`;

const ibmcloudMock = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_STATE/ibmcloud.log"

if [[ "$*" == plugin\ show\ * ]]; then exit 0; fi
if [[ "$*" == "account show" ]]; then exit 0; fi
if [[ "$1" == target ]]; then exit 0; fi

if [[ "$*" == "ce project current --output json" ]]; then
  printf '{"name":"test-project","kube_config_context":"test","domain":"eu-de.codeengine.appdomain.cloud"}\n'
  exit 0
fi
if [[ "$*" == "ce project get --name test-project" ]]; then
  [[ -f "$MOCK_STATE/project-created" ]]
  exit
fi
if [[ "$*" == ce\ project\ create* ]]; then : > "$MOCK_STATE/project-created"; exit 0; fi
if [[ "$*" == ce\ project\ select* ]]; then exit 0; fi
if [[ "$*" == "ce project current" ]]; then printf 'Subdomain: test\n'; exit 0; fi

if [[ "$*" == "cr region-set global" ]]; then exit 0; fi
if [[ "$*" == "cr namespace-list" ]]; then printf 'Name\n'; exit 0; fi
if [[ "$*" == cr\ namespace-add* ]]; then exit 0; fi

if [[ "$*" == ce\ registry\ get* ]]; then
  [[ -f "$MOCK_STATE/registry-created" ]]
  exit
fi
if [[ "$*" == ce\ registry\ create* || "$*" == ce\ registry\ update* ]]; then
  : > "$MOCK_STATE/registry-created"
  exit 0
fi

if [[ "$*" == "ce secret get --name app-env --output yaml" ]]; then
  # The real CLI prints data: values already DECODED (plaintext), not base64 like raw k8s.
  if [[ -f "$MOCK_STATE/secret-created" && -f "$MOCK_STATE/app-env" ]]; then
    printf 'data:\n'
    sed -n 's/^\(export \)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)=\(.*\)$/  \2: \3/p' "$MOCK_STATE/app-env"
    exit 0
  fi
  exit 1
fi
if [[ "$*" == ce\ secret\ get* ]]; then
  [[ -f "$MOCK_STATE/secret-created" ]]
  exit
fi
if [[ "$*" == ce\ secret\ create* || "$*" == ce\ secret\ update* ]]; then
  capture_next=false
  for argument in "$@"; do
    if [[ "$argument" == --from-env-file ]]; then capture_next=true; continue; fi
    if [[ "$capture_next" == true ]]; then cp "$argument" "$MOCK_STATE/app-env"; break; fi
  done
  : > "$MOCK_STATE/secret-created"
  exit 0
fi

if [[ "$*" == ce\ application\ events\ * ]]; then
  # Real CLI output is localized, but the Kubernetes 'BackOff' reason is locale-stable.
  if [[ -f "$MOCK_STATE/app-crashloop" && -f "$MOCK_STATE/app-created" ]]; then
    printf 'Warning  BackOff  1m  kubelet  Back-off restarting failed container user-container in pod %s-00002-deployment-abc123\n' "$5"
  fi
  exit 0
fi
if [[ "$*" == ce\ application\ logs\ * ]]; then
  printf 'database migrations starting\ndatabase migrations failed DrizzleQueryError\ncause: error: relation "todo" already exists\n'
  exit 0
fi

if [[ "$*" == ce\ application\ get\ --name\ * ]]; then
  app_name="$5"
  marker="app-created"
  if [[ "$app_name" == *-oauth-proxy ]]; then marker="proxy-created"; fi
  if [[ "$*" == *"--output json" ]]; then
    if [[ -f "$MOCK_STATE/app-crashloop" && -f "$MOCK_STATE/$marker" ]]; then
      printf '{"status":{"latestCreatedRevisionName":"%s-00002"}}\n' "$app_name"
    else
      printf '{}\n'
    fi
    exit 0
  fi
  if [[ "$*" == *"--output url" ]]; then
    if [[ -f "$MOCK_STATE/$marker" ]]; then
      printf 'https://%s.test.eu-de.codeengine.appdomain.cloud\n' "$app_name"
      exit 0
    fi
    exit 1
  fi
  [[ -f "$MOCK_STATE/$marker" ]]
  exit
fi
if [[ "$*" == ce\ application\ create* ]]; then
  if [[ "$*" == *-oauth-proxy* ]]; then
    : > "$MOCK_STATE/proxy-created"
  else
    if [[ -f "$MOCK_STATE/app-create-fails" ]]; then exit 1; fi
    : > "$MOCK_STATE/app-created"
    # Simulate a rollout wait that never returns because the revision crash-loops;
    # exec keeps the pipe in one process so killing the mock releases it.
    if [[ -f "$MOCK_STATE/app-crashloop" ]]; then exec sleep 8; fi
  fi
  exit 0
fi
if [[ "$*" == ce\ application\ update* ]]; then
  if [[ "$*" == *-oauth-proxy* ]]; then : > "$MOCK_STATE/proxy-created"; fi
  exit 0
fi

printf 'unexpected ibmcloud call: %s\n' "$*" >&2
exit 1
`;
