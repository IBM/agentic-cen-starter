import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

const API_KEY = "test-api-key-with-at-least-32-characters";

/** A tiny app behind requireApiKey, built against the given API_KEY setting. */
async function appWith(apiKey: string | undefined) {
  vi.resetModules();
  vi.doMock("../env", () => ({ env: { API_KEY: apiKey } }));
  const { requireApiKey } = await import("./api-key");
  return new Hono().use(requireApiKey).get("/", (c) => c.json(c.get("client")));
}

afterEach(() => {
  vi.doUnmock("../env");
});

describe("requireApiKey", () => {
  it("accepts the key as x-api-key", async () => {
    const app = await appWith(API_KEY);
    const response = await app.request("/", { headers: { "x-api-key": API_KEY } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "api-key" });
  });

  it("accepts the key as a Bearer token", async () => {
    const app = await appWith(API_KEY);
    const response = await app.request("/", { headers: { authorization: `Bearer ${API_KEY}` } });
    expect(response.status).toBe(200);
  });

  it("rejects a missing or wrong key", async () => {
    const app = await appWith(API_KEY);
    expect((await app.request("/")).status).toBe(401);
    expect((await app.request("/", { headers: { "x-api-key": "wrong" } })).status).toBe(401);
  });

  it("rejects every request while API_KEY is unset", async () => {
    const app = await appWith(undefined);
    const response = await app.request("/", { headers: { "x-api-key": API_KEY } });
    expect(response.status).toBe(401);
  });
});
