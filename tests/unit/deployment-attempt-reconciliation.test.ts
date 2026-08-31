import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: mock.readFile,
  readdir: mock.readdir,
  writeFile: mock.writeFile,
}));

import { reconcileDeploymentAttempts } from "../../packages/contracts/scripts/attempt-reconciliation.mjs";

const deployer = "0x1111111111111111111111111111111111111111";
const creationCodeHash = `0x${"ab".repeat(32)}`;
const markerName = `attempt-4663-${deployer}-0.json`;
const marker = {
  status: "BROADCASTING_OR_UNKNOWN",
  chainId: 4663,
  deployer,
  nonce: 0,
  creationCodeHash,
};

beforeEach(() => {
  vi.resetAllMocks();
  mock.readdir.mockResolvedValue([markerName]);
  mock.readFile.mockResolvedValue(JSON.stringify(marker));
});

describe("deployment attempt reconciliation", () => {
  it("preserves unresolved markers and writes durable not-accepted evidence", async () => {
    const read = {
      getTransactionCount: vi
        .fn()
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0),
      getCode: vi.fn().mockResolvedValue(undefined),
    };
    const result = await reconcileDeploymentAttempts({
      directory: "/test/deployments",
      chainId: 4663,
      deployer,
      nonce: 0,
      creationCodeHash,
      read,
      now: () => 1234,
    });
    expect(result).toMatchObject({ reconciled: true, markers: [markerName] });
    expect(mock.writeFile).toHaveBeenCalledWith(
      `/test/deployments/reconciliation-4663-${deployer}-0-1234.json`,
      expect.stringContaining('"status": "RECONCILED_NOT_ACCEPTED"'),
      { flag: "wx" },
    );
  });

  it.each([
    [1, 1, undefined],
    [0, 1, undefined],
    [0, 0, "0x6000"],
  ])(
    "blocks retry when latest=%i pending=%i code=%s",
    async (latest, pending, code) => {
      const read = {
        getTransactionCount: vi
          .fn()
          .mockResolvedValueOnce(latest)
          .mockResolvedValueOnce(pending),
        getCode: vi.fn().mockResolvedValue(code),
      };
      await expect(
        reconcileDeploymentAttempts({
          directory: "/test/deployments",
          chainId: 4663,
          deployer,
          nonce: 0,
          creationCodeHash,
          read,
        }),
      ).rejects.toThrow("cannot be safely reconciled");
      expect(mock.writeFile).not.toHaveBeenCalled();
    },
  );

  it("blocks an unresolved marker for different deployment bytes", async () => {
    mock.readFile.mockResolvedValue(
      JSON.stringify({ ...marker, creationCodeHash: `0x${"cd".repeat(32)}` }),
    );
    await expect(
      reconcileDeploymentAttempts({
        directory: "/test/deployments",
        chainId: 4663,
        deployer,
        nonce: 0,
        creationCodeHash,
        read: {},
      }),
    ).rejects.toThrow("does not match preflight");
    expect(mock.writeFile).not.toHaveBeenCalled();
  });

  it("does nothing when no unresolved marker exists", async () => {
    mock.readdir.mockResolvedValue([]);
    await expect(
      reconcileDeploymentAttempts({
        directory: "/test/deployments",
        chainId: 4663,
        deployer,
        nonce: 0,
        creationCodeHash,
        read: {},
      }),
    ).resolves.toEqual({ reconciled: false, markers: [] });
    expect(mock.writeFile).not.toHaveBeenCalled();
  });
});
