import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";
import type * as Viem from "../../packages/contracts/node_modules/viem/_esm/index.js";

const mock = vi.hoisted(() => ({
  get: vi.fn(),
  remoteSign: vi.fn(),
  parseTransaction: vi.fn(),
  recoverTransactionAddress: vi.fn(),
  client: vi.fn(),
  read: {
    getChainId: vi.fn(),
    getCode: vi.fn(),
    readContract: vi.fn(),
    call: vi.fn(),
    estimateGas: vi.fn(),
    estimateFeesPerGas: vi.fn(),
    getBalance: vi.fn(),
    getTransactionCount: vi.fn(),
  },
  walletClient: vi.fn(),
  send: vi.fn(),
  write: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn(),
  compile: vi.fn(),
}));
vi.mock(
  "../../packages/contracts/node_modules/@privy-io/node/index.mjs",
  () => ({
    PrivyClient: class {
      constructor(options: unknown) {
        mock.client(options);
      }
      wallets() {
        return {
          get: mock.get,
          ethereum: () => ({ signTransaction: mock.remoteSign }),
        };
      }
    },
  }),
);
vi.mock(
  "../../packages/contracts/node_modules/viem/_esm/index.js",
  async (original) => ({
    ...(await original<typeof Viem>()),
    parseTransaction: mock.parseTransaction,
    recoverTransactionAddress: mock.recoverTransactionAddress,
    createPublicClient: () => mock.read,
    createWalletClient: (options: unknown) => {
      mock.walletClient(options);
      return { sendTransaction: mock.send };
    },
  }),
);
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof FsPromises>()),
  writeFile: mock.write,
  readFile: mock.readFile,
  readdir: mock.readdir,
  mkdir: mock.mkdir,
}));
vi.mock("../../packages/contracts/scripts/compile.mjs", () => ({
  compile: mock.compile,
}));

import { main } from "../../packages/contracts/scripts/deploy.mjs";
import { getPrivyDeployer } from "../../packages/contracts/scripts/privy-deployer.mjs";

// Isolated test values only; all provider calls, signing and submission are mocked.
const address = "0x1111111111111111111111111111111111111111";
const env = {
  PRIVY_APP_ID: "test-app",
  PRIVY_APP_SECRET: "test-only-secret",
  PRIVY_DEPLOYER_WALLET_ID: "test-deployer-wallet",
  DEPLOYER_ADDRESS: address,
  ROBINHOOD_RPC_URL: "https://rpc.example.test",
  ADMIN_ADDRESS: "0x2222222222222222222222222222222222222222",
  DISPUTE_RESOLVER_ADDRESS: "0x3333333333333333333333333333333333333333",
  ADMIN_DELAY_SECONDS: "3600",
  MAX_SERVICE_PAYMENT_USDG: "1.000001",
  NORMIC_FINANCIAL_EXECUTION_ENABLED: "false",
  NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED: "false",
  NORMIC_TRADING_EXECUTION_ENABLED: "false",
  NORMIC_AUTONOMOUS_FINANCIAL_EXECUTION_ENABLED: "false",
};
const wallet = {
  id: env.PRIVY_DEPLOYER_WALLET_ID,
  address,
  chain_type: "ethereum",
  imported_at: null,
  exported_at: null,
  archived_at: null,
  owner_id: null,
};
const argv = process.argv;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("UNEXPECTED_NETWORK");
    }),
  );
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv("DEPLOYER_RPC_URL", undefined);
  process.argv = [argv[0], "test-runner"];
  mock.get.mockResolvedValue({ ...wallet });
  mock.remoteSign.mockResolvedValue({ signed_transaction: "0xdeadbeef" });
  mock.parseTransaction.mockReturnValue({
    type: "eip1559",
    chainId: 4663,
    nonce: 0,
    data: "0x6000",
    value: 0n,
    maxPriorityFeePerGas: 0n,
  });
  mock.recoverTransactionAddress.mockResolvedValue(address);
  mock.read.getChainId.mockResolvedValue(4663);
  mock.read.getCode.mockResolvedValue("0x6000");
  mock.read.readContract.mockImplementation(
    async ({ functionName }) =>
      ({ decimals: 6, symbol: "USDG", totalSupply: 1000000n })[
        functionName as "decimals"
      ],
  );
  mock.read.call.mockResolvedValue({ data: "0x6000" });
  mock.read.estimateGas.mockResolvedValue(1000000n);
  mock.read.estimateFeesPerGas.mockResolvedValue({
    maxFeePerGas: 200000000n,
    maxPriorityFeePerGas: 0n,
  });
  mock.read.getBalance.mockResolvedValue(1000000000000000n);
  mock.read.getTransactionCount.mockResolvedValue(0);
  mock.readdir.mockResolvedValue([]);
  mock.send.mockRejectedValue(new Error("MOCK_SUBMISSION_STOP"));
  mock.compile.mockResolvedValue({
    contracts: {
      "NormicServiceEscrow.sol": {
        NormicServiceEscrow: {
          abi: [
            {
              type: "constructor",
              stateMutability: "nonpayable",
              inputs: [
                { name: "admin", type: "address" },
                { name: "resolver", type: "address" },
                { name: "adminDelay", type: "uint48" },
                { name: "maximum", type: "uint256" },
              ],
            },
          ],
          evm: { bytecode: { object: "6000" } },
        },
      },
    },
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  process.argv = argv;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isolated Privy escrow deployment signer", () => {
  it("dry-runs using wallet metadata, chain simulation and gas estimation without signing", async () => {
    await main();
    expect(mock.get).toHaveBeenCalledWith(env.PRIVY_DEPLOYER_WALLET_ID);
    expect(mock.read.call).toHaveBeenCalledOnce();
    expect(mock.read.estimateGas).toHaveBeenCalledOnce();
    expect(mock.read.estimateFeesPerGas).toHaveBeenCalledWith({
      type: "eip1559",
    });
    expect(mock.read.getCode).toHaveBeenCalledWith({
      address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    });
    expect(mock.remoteSign).not.toHaveBeenCalled();
    expect(mock.walletClient).not.toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();
    expect(mock.write).not.toHaveBeenCalled();
    expect(mock.client).toHaveBeenCalledWith(
      expect.objectContaining({ logLevel: "off", maxRetries: 0 }),
    );
  });

  it.each([
    { address: env.ADMIN_ADDRESS },
    { id: "another-wallet" },
    { chain_type: "solana" },
    { exported_at: 1 },
    { imported_at: 1 },
    { archived_at: 1 },
    { owner_id: "owner-quorum" },
    { display_name: "Normic USDG session signer" },
    { external_id: "normic_company_1" },
  ])(
    "rejects an unsuitable or mismatched deployer wallet: %j",
    async (change) => {
      mock.get.mockResolvedValue({ ...wallet, ...change });
      await expect(getPrivyDeployer(env)).rejects.toThrow("binding");
      expect(mock.remoteSign).not.toHaveBeenCalled();
    },
  );

  it("fails closed on Privy rejection and never uses a node-managed signer", async () => {
    mock.get.mockRejectedValue(new Error("PRIVY_DENIED"));
    await expect(main()).rejects.toThrow("PRIVY_DENIED");
    expect(mock.walletClient).not.toHaveBeenCalled();
  });

  it("requires the explicit gate even to construct a signing account", async () => {
    const deployer = await getPrivyDeployer(env);
    expect(() =>
      deployer.accountForDeployment("0x6000", mock.read, false),
    ).toThrow("--broadcast");
    expect(mock.remoteSign).not.toHaveBeenCalled();
  });

  it.each([
    "NORMIC_FINANCIAL_EXECUTION_ENABLED",
    "NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED",
    "NORMIC_TRADING_EXECUTION_ENABLED",
    "NORMIC_AUTONOMOUS_FINANCIAL_EXECUTION_ENABLED",
  ])("requires %s to stay explicitly false", async (flag) => {
    for (const value of ["true", undefined]) {
      await expect(getPrivyDeployer({ ...env, [flag]: value })).rejects.toThrow(
        "flags false",
      );
    }
    expect(mock.client).not.toHaveBeenCalled();
  });

  it("preserves chain, canonical-token, cap, and disabled-flag checks", async () => {
    mock.read.getChainId.mockResolvedValueOnce(1);
    await expect(main()).rejects.toThrow("Wrong deployment chain");
    mock.read.getCode.mockResolvedValueOnce(undefined);
    await expect(main()).rejects.toThrow("Canonical token code missing");
    vi.stubEnv("MAX_SERVICE_PAYMENT_USDG", "0.0000001");
    await expect(main()).rejects.toThrow("precision");
    vi.stubEnv("NORMIC_FINANCIAL_EXECUTION_ENABLED", "true");
    await expect(main()).rejects.toThrow("flags false");
    expect(mock.remoteSign).not.toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();
  });

  it("fails before account construction when maximum gas cost exceeds balance", async () => {
    mock.read.getBalance.mockResolvedValueOnce(1n);
    await expect(main()).rejects.toThrow("maximum deployment gas cost");
    expect(mock.walletClient).not.toHaveBeenCalled();
    expect(mock.remoteSign).not.toHaveBeenCalled();
    expect(mock.write).not.toHaveBeenCalled();
  });

  it("binds signing to deployment bytes, zero value, and chain 4663", async () => {
    const deployer = await getPrivyDeployer(env);
    const account = deployer.accountForDeployment("0x6000", mock.read, true);
    for (const invalid of [
      { chainId: 1 },
      { data: "0x6001" },
      { to: address },
      { value: 1n },
      { authorizationList: [] },
    ])
      await expect(
        account.signTransaction({ chainId: 4663, data: "0x6000", ...invalid }),
      ).rejects.toThrow("Unexpected");
    expect(mock.remoteSign).not.toHaveBeenCalled();
    await expect(
      account.signTransaction({
        chainId: 4663,
        data: "0x6000",
        value: 0n,
        nonce: 0,
        maxPriorityFeePerGas: 0n,
      }),
    ).resolves.toBe("0xdeadbeef");
    expect(mock.remoteSign).toHaveBeenCalledWith(env.PRIVY_DEPLOYER_WALLET_ID, {
      params: {
        transaction: {
          type: 2,
          chain_id: 4663,
          data: "0x6000",
          value: "0x0",
          nonce: 0,
          max_priority_fee_per_gas: "0x0",
        },
      },
    });
    expect(mock.parseTransaction).toHaveBeenCalledWith("0xdeadbeef");
    expect(mock.recoverTransactionAddress).toHaveBeenCalledWith({
      serializedTransaction: "0xdeadbeef",
    });
    expect(mock.get).toHaveBeenCalledTimes(2);
    await expect(account.signMessage({ message: "denied" })).rejects.toThrow(
      "Deployment-only",
    );
  });

  it("rejects a signed envelope that does not match the validated deployment", async () => {
    const deployer = await getPrivyDeployer(env);
    const account = deployer.accountForDeployment("0x6000", mock.read, true);
    mock.parseTransaction.mockReturnValueOnce({
      type: "eip1559",
      chainId: 1,
      nonce: 0,
      data: "0x6000",
      value: 0n,
      maxPriorityFeePerGas: 0n,
    });
    await expect(
      account.signTransaction({
        chainId: 4663,
        data: "0x6000",
        value: 0n,
        nonce: 0,
        maxPriorityFeePerGas: 0n,
      }),
    ).rejects.toThrow("failed validation");
  });

  it("rechecks wallet binding, chain and disabled flags immediately before signing", async () => {
    const deployer = await getPrivyDeployer(env);
    const account = deployer.accountForDeployment("0x6000", mock.read, true);
    mock.get.mockResolvedValueOnce({ ...wallet, address: env.ADMIN_ADDRESS });
    await expect(
      account.signTransaction({ chainId: 4663, data: "0x6000" }),
    ).rejects.toThrow("binding");
    mock.read.getChainId.mockResolvedValueOnce(1);
    await expect(
      account.signTransaction({ chainId: 4663, data: "0x6000" }),
    ).rejects.toThrow("chain");
    env.NORMIC_TRADING_EXECUTION_ENABLED = "true";
    try {
      await expect(
        account.signTransaction({ chainId: 4663, data: "0x6000" }),
      ).rejects.toThrow("flags false");
    } finally {
      env.NORMIC_TRADING_EXECUTION_ENABLED = "false";
    }
    expect(mock.remoteSign).not.toHaveBeenCalled();
  });

  it("uses the ordinary RPC and chain-bound Privy account only after the gate and durable marker", async () => {
    process.argv.push("--broadcast");
    await expect(main()).rejects.toThrow("transport failed");
    expect(mock.walletClient).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: expect.objectContaining({
          id: 4663,
          rpcUrls: { default: { http: [env.ROBINHOOD_RPC_URL] } },
        }),
        account: expect.objectContaining({ address, type: "local" }),
      }),
    );
    expect(mock.write).toHaveBeenCalledWith(
      expect.stringContaining("attempt-4663-"),
      expect.any(String),
      { flag: "wx" },
    );
    expect(mock.write.mock.invocationCallOrder[0]).toBeLessThan(
      mock.send.mock.invocationCallOrder[0],
    );
    expect(mock.send).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 4663,
        nonce: 0,
        gas: 1000000n,
        maxFeePerGas: 200000000n,
        maxPriorityFeePerGas: 0n,
        type: "eip1559",
        value: 0n,
      }),
    );
  });

  it("does not submit again if a deployment attempt marker already exists", async () => {
    process.argv.push("--broadcast");
    mock.write.mockRejectedValueOnce(new Error("EEXIST"));
    await expect(main()).rejects.toThrow("EEXIST");
    expect(mock.send).not.toHaveBeenCalled();
    expect(mock.remoteSign).not.toHaveBeenCalled();
  });
});
