import { readFile, readdir, writeFile } from "node:fs/promises";
import { getAddress, getContractAddress } from "viem";

export async function reconcileDeploymentAttempts({
  directory,
  chainId,
  deployer,
  nonce,
  creationCodeHash,
  read,
  now = Date.now,
}) {
  const normalizedDeployer = getAddress(deployer);
  const files = await readdir(directory).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const markerNeedle = `attempt-${chainId}-${normalizedDeployer.toLowerCase()}-`;
  const markers = [];
  for (const name of files.filter(
    (name) => name.includes(markerNeedle) && name.endsWith(".json"),
  )) {
    let marker;
    try {
      marker = JSON.parse(await readFile(`${directory}/${name}`, "utf8"));
    } catch {
      throw new Error("A deployment attempt marker is unreadable.");
    }
    if (marker.status !== "BROADCASTING_OR_UNKNOWN") continue;
    if (
      marker.chainId !== chainId ||
      getAddress(marker.deployer) !== normalizedDeployer ||
      marker.nonce !== nonce ||
      marker.creationCodeHash !== creationCodeHash
    )
      throw new Error(
        "An unresolved deployment attempt does not match preflight.",
      );
    markers.push(name);
  }
  if (markers.length === 0) return { reconciled: false, markers: [] };

  const [latestNonce, pendingNonce] = await Promise.all([
    read.getTransactionCount({
      address: normalizedDeployer,
      blockTag: "latest",
    }),
    read.getTransactionCount({
      address: normalizedDeployer,
      blockTag: "pending",
    }),
  ]);
  const predictedContractAddress = getContractAddress({
    from: normalizedDeployer,
    nonce: BigInt(nonce),
  });
  const code = await read.getCode({ address: predictedContractAddress });
  if (
    latestNonce !== nonce ||
    pendingNonce !== nonce ||
    (code != null && code !== "0x")
  )
    throw new Error(
      "An existing deployment attempt cannot be safely reconciled as not accepted.",
    );

  const reconciliationPath = `${directory}/reconciliation-${chainId}-${normalizedDeployer.toLowerCase()}-${nonce}-${now()}.json`;
  await writeFile(
    reconciliationPath,
    JSON.stringify(
      {
        status: "RECONCILED_NOT_ACCEPTED",
        chainId,
        deployer: normalizedDeployer,
        nonce,
        creationCodeHash,
        latestNonce,
        pendingNonce,
        predictedContractAddress,
        codePresent: false,
        markers: markers.sort(),
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  return { reconciled: true, markers, reconciliationPath };
}
