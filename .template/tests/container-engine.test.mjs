import assert from "node:assert/strict";
import test from "node:test";
import containerEngine from "../../scripts/container-engine.cjs";

const { resolveContainerEngine } = containerEngine;

test("prefers a ready Docker engine in auto mode", () => {
  assert.equal(resolveContainerEngine({ probe: () => true }), "docker");
});

test("falls back to Podman when Docker is unavailable", () => {
  const probe = (engine) => engine === "podman";
  assert.equal(resolveContainerEngine({ probe }), "podman");
});

test("falls back to Podman when Docker has no Compose provider", () => {
  const probe = (engine, args) => engine === "podman" || args[0] === "info";
  assert.equal(resolveContainerEngine({ probe }), "podman");
});

test("honors an explicit engine selection", () => {
  const calls = [];
  const probe = (engine, args) => {
    calls.push([engine, args]);
    return true;
  };
  assert.equal(
    resolveContainerEngine({ env: { CEN_CONTAINER_ENGINE: "podman" }, probe }),
    "podman",
  );
  assert.deepEqual(calls, [
    ["podman", ["info"]],
    ["podman", ["compose", "version"]],
  ]);
});

test("allows an absent engine when containers are not required", () => {
  assert.equal(resolveContainerEngine({ probe: () => false, required: false }), undefined);
});

test("rejects an invalid engine selection", () => {
  assert.throws(
    () => resolveContainerEngine({ env: { CEN_CONTAINER_ENGINE: "containerd" } }),
    /must be auto, docker, or podman/,
  );
});
