import { describe, expect, it } from "vitest";
import {
  recoverTransactionAddress,
  serializeTransaction,
} from "../../packages/contracts/node_modules/viem/_esm/index.js";
import { validateSignedDeploymentTransaction } from "../../packages/contracts/scripts/privy-deployer.mjs";

const transaction = {
  type: "eip1559" as const,
  chainId: 4663,
  nonce: 0,
  data: "0x6000" as const,
  value: 0n,
  gas: 2_500_000n,
  maxFeePerGas: 220_000_000n,
  maxPriorityFeePerGas: 0n,
};
const signature = {
  r: `0x${"01".padStart(64, "0")}` as const,
  s: `0x${"02".padStart(64, "0")}` as const,
  yParity: 0,
} as const;

describe("signed deployment validation", () => {
  it("accepts canonical RLP zero priority fee after Viem parses it as omitted", async () => {
    const signed = serializeTransaction(transaction, signature);
    const recovered = await recoverTransactionAddress({
      serializedTransaction: signed,
    });
    await expect(
      validateSignedDeploymentTransaction(signed, transaction, recovered),
    ).resolves.toMatchObject({
      event: "PRIVY_DEPLOYMENT_SIGNED_TRANSACTION_VALIDATED",
      chain4663: true,
      feesMatch: true,
      signerMatch: true,
    });
  });

  it("still rejects a nonzero priority-fee mismatch", async () => {
    const signed = serializeTransaction(
      { ...transaction, maxPriorityFeePerGas: 1n },
      signature,
    );
    const recovered = await recoverTransactionAddress({
      serializedTransaction: signed,
    });
    await expect(
      validateSignedDeploymentTransaction(signed, transaction, recovered),
    ).rejects.toMatchObject({ reason: "MAX_PRIORITY_FEE_MISMATCH" });
  });
});
