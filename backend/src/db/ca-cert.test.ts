import { describe, expect, it } from "vitest";
import { readCaCert } from "./ca-cert";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

describe("readCaCert", () => {
  it("treats empty and blank values as unconfigured", () => {
    expect(readCaCert(undefined)).toBeUndefined();
    expect(readCaCert("")).toBeUndefined();
    expect(readCaCert("   ")).toBeUndefined();
  });

  it("decodes base64, which is what the documented export command produces", () => {
    expect(readCaCert(Buffer.from(PEM).toString("base64"))).toBe(PEM);
  });

  it("accepts PEM pasted as a single line with escaped newlines", () => {
    expect(readCaCert(PEM.replace(/\n/g, "\\n"))).toBe(PEM);
  });

  it("drops CLI output printed ahead of the certificate", () => {
    const noisy = Buffer.from(`Retrieving certificate...\nOK\n${PEM}`).toString("base64");
    expect(readCaCert(noisy)).toBe(PEM);
  });

  it("rejects a value that decodes to something other than a certificate", () => {
    expect(() => readCaCert("bm90LWEtY2VydA==")).toThrow(/does not contain a PEM certificate/);
  });
});
