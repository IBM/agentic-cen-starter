const PEM_HEADER = "-----BEGIN CERTIFICATE-----";

// An env file holds one line per value, so the CA arrives either base64-encoded or as PEM with
// literal \n escapes. Leading noise (a CLI banner printed ahead of the PEM) is trimmed off.
export function readCaCert(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  const decoded = value.includes(PEM_HEADER)
    ? value.replace(/\\n/g, "\n")
    : Buffer.from(value, "base64").toString("utf8");
  const start = decoded.indexOf(PEM_HEADER);

  if (start < 0) {
    throw new Error("DATABASE_CA_CERT does not contain a PEM certificate");
  }
  return decoded.slice(start);
}
