import { readFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import solc from "solc";
const root = fileURLToPath(new URL("../", import.meta.url));
export async function compile(includeFixtures = false) {
  const sources = {
    "NormicServiceEscrow.sol": {
      content: await readFile(
        resolve(root, "src/NormicServiceEscrow.sol"),
        "utf8",
      ),
    },
  };
  if (includeFixtures)
    sources["TestUSDG.sol"] = {
      content: await readFile(resolve(root, "test/TestUSDG.sol"), "utf8"),
    };
  const input = {
    language: "Solidity",
    sources,
    settings: {
      evmVersion: "shanghai",
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "*": [
            "abi",
            "evm.bytecode.object",
            "evm.deployedBytecode.object",
            "evm.deployedBytecode.immutableReferences",
            "metadata",
          ],
        },
      },
    },
  };
  const output = JSON.parse(
    solc.compile(JSON.stringify(input), {
      import: (path) => {
        if (!path.startsWith("@openzeppelin/contracts/") || path.includes(".."))
          return { error: "Import not allowed" };
        try {
          const content = readFileSync(
            resolve(root, "node_modules", path),
            "utf8",
          );
          input.sources[path] = { content };
          return { contents: content };
        } catch {
          return { error: "Missing dependency" };
        }
      },
    }),
  );
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length)
    throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  return {
    input,
    contracts: output.contracts,
    compilerVersion: solc.version(),
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await compile();
  await mkdir(resolve(root, "artifacts"), { recursive: true });
  await writeFile(
    resolve(root, "artifacts/NormicServiceEscrow.json"),
    JSON.stringify(
      {
        ...result.contracts["NormicServiceEscrow.sol"].NormicServiceEscrow,
        compilerVersion: result.compilerVersion,
        standardInput: result.input,
      },
      null,
      2,
    ),
  );
  console.log(
    "Compiled non-upgradeable NormicServiceEscrow. No deployment performed.",
  );
}
