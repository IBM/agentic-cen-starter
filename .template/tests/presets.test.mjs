import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const catalog = JSON.parse(await readFile(path.join(root, ".template/presets.json"), "utf8"));

test("preset catalog is complete and internally valid", async () => {
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.presets.length, 7);

  const ids = catalog.presets.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length, "preset ids must be unique");
  assert.ok(ids.includes(catalog.defaultPreset), "defaultPreset must name a preset");

  const available = new Set(
    (await readdir(path.join(root, ".template/flavors"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  for (const preset of catalog.presets) {
    assert.match(preset.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(preset.label);
    assert.ok(preset.description);
    for (const flavor of preset.flavors) {
      assert.ok(available.has(flavor), `${preset.id} references unknown flavor ${flavor}`);
    }
  }
});
