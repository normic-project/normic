export async function requireIsolatedSmokeRuntime(origin) {
  const url = new URL(origin);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error(
      "Mutation smoke tests may only run against a loopback test server.",
    );
  if (process.env.NODE_ENV !== "test" || !process.env.NORMIC_TEST_RUN_ID)
    throw new Error(
      "Use pnpm smoke:isolated. Mutation smoke fixtures must never enter a development or production database.",
    );
  const response = await fetch(`${url.origin}/health`);
  const health = await response.json();
  if (
    health.environment !== "test" ||
    health.testRunId !== process.env.NORMIC_TEST_RUN_ID
  )
    throw new Error("The target is not this isolated test runtime.");
}
