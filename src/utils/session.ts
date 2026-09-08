/**
 * Sessions are keyed by connection id; a second database opened on the same
 * connection (PostgreSQL, SQL Server) lives under `<id>@<database>`. Tabs and
 * tree nodes carry the session key, so anything that needs the connection
 * itself goes through `connectionIdOf`.
 */
export const sessionKey = (connectionId: string, database?: string | null) => (database ? `${connectionId}@${database}` : connectionId);

export const connectionIdOf = (key: string) => {
  const i = key.indexOf("@");
  return i < 0 ? key : key.slice(0, i);
};

export const databaseOf = (key: string): string | undefined => {
  const i = key.indexOf("@");
  return i < 0 ? undefined : key.slice(i + 1);
};
