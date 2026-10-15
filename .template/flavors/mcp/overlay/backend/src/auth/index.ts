// @ts-nocheck — template overlay; this line is stripped when `pnpm flavor apply` copies the file into place
// The auth seam, API key only: an MCP server is called by agents and other software, not
// by people, so there are no user sessions. Routes use requireApiKey / apiKeyRouter and
// read the caller from `c.get("client")` — never the implementation in ./api-key.
export { type Client, type ClientEnv, getClient, requireApiKey } from "./api-key";
