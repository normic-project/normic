import { lstat, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
for (const name of ["core", "db", "sdk", "chains", "markets", "payments"]) {
  const directory = resolve(root, "packages", name, "dist");
  if (directory !== join(resolve(root), "packages", name, "dist"))
    throw new Error("Unexpected build output path.");
  const stat = await lstat(directory).catch(() => null);
  if (stat?.isSymbolicLink())
    throw new Error("Refusing to clean linked build outputs.");
  if (stat) await rm(directory, { recursive: true, force: true });
}
