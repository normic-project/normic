import { spawn } from "node:child_process";
const mode = process.argv[2];
if (!["both", "web", "mcp"].includes(mode))
  throw new Error("Expected web, mcp, or both.");
if (process.env.NODE_ENV === "production")
  throw new Error(
    "Use production start commands for a production environment.",
  );
if (mode === "both" && !process.env.DATABASE_URL?.trim())
  throw new Error(
    "Set DATABASE_URL to run web and MCP together. PGlite supports only one local runtime at a time.",
  );
const env = { ...process.env, NODE_ENV: "development" };
const children = [];
if (mode !== "mcp")
  children.push(
    spawn(
      process.execPath,
      [
        "apps/web/node_modules/next/dist/bin/next",
        "dev",
        "apps/web",
        "--port",
        process.env.WEB_PORT ?? "3000",
      ],
      { env, stdio: "inherit", windowsHide: true },
    ),
  );
if (mode !== "web")
  children.push(
    spawn(
      process.execPath,
      ["--import", "tsx", "--watch", "apps/mcp/src/index.ts"],
      { env, stdio: "inherit", windowsHide: true },
    ),
  );
const stop = () => {
  for (const child of children) child.kill();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
for (const child of children)
  child.once("exit", (code) => {
    if (code) {
      stop();
      process.exitCode = code;
    }
  });
