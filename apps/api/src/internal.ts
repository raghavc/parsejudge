/**
 * Requests the Worker makes to its own API on a user's behalf (MCP tools, signed upload URLs).
 * The token is random per isolate and never leaves it, so a client cannot forge the header.
 */
let token: string | undefined;
// Workers forbid random values at global scope, so the token is made on first use.
const isolateToken = () => {
  token ??= crypto.randomUUID();
  return token;
};

export const INTERNAL_HEADER = "x-parsejudge-internal";

export const internalHeader = (userId: string) => `${isolateToken()}:${userId}`;

export const internalUser = (value: string | undefined): string | null => {
  const prefix = `${isolateToken()}:`;
  const userId = value?.startsWith(prefix) ? value.slice(prefix.length) : "";
  return userId === "" ? null : userId;
};
