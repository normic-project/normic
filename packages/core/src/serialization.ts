const dateFields = new Set([
  "createdAt",
  "updatedAt",
  "acceptedAt",
  "processingAt",
  "completedAt",
  "expiresAt",
  "revokedAt",
  "lastUsedAt",
  "postedAt",
]);
const opaqueFields = new Set([
  "input",
  "output",
  "inputSchema",
  "outputSchema",
  "metadata",
  "tradingCapabilities",
  "details",
]);

/** Restore domain dates from JSON without modifying user-authored payloads. */
export function hydrateDomainDates<T>(value: unknown): T {
  if (Array.isArray(value))
    return value.map((item) => hydrateDomainDates(item)) as T;
  if (!value || typeof value !== "object" || value instanceof Date)
    return value as T;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (opaqueFields.has(key)) return [key, item];
      if (
        dateFields.has(key) &&
        typeof item === "string" &&
        Number.isFinite(Date.parse(item))
      )
        return [key, new Date(item)];
      return [key, hydrateDomainDates(item)];
    }),
  ) as T;
}
