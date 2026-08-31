import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
} from "../../packages/contracts/node_modules/@privy-io/node/index.mjs";
import { formatViemTransaction } from "../../packages/contracts/node_modules/@privy-io/node/viem.mjs";
import {
  formatDeploymentTransaction,
  signingErrorDiagnostic,
  signingRequestDiagnostic,
} from "../../packages/contracts/scripts/privy-deployer.mjs";

// Pure serialization/diagnostic tests: never instantiate a client or call a signer.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("UNEXPECTED_NETWORK");
    }),
  );
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const transaction = {
  type: "eip1559" as const,
  chainId: 4663,
  nonce: 0,
  data: "0x6000" as const,
  value: 0n,
  gas: 1000000n,
  maxFeePerGas: 1000000000n,
  maxPriorityFeePerGas: 0n,
};

describe("Privy deployment transaction serialization (no signing)", () => {
  it("reproduces the installed SDK's zero-field omission", () => {
    // Deliberately audits the locked SDK, so an upgrade prompts removal/review of the workaround.
    const upstream = formatViemTransaction(transaction);
    expect(upstream).not.toHaveProperty("nonce");
    expect(upstream).not.toHaveProperty("value");
    expect(upstream).not.toHaveProperty("max_priority_fee_per_gas");
  });

  it("preserves nonce zero, zero tip, and zero value in the actual SDK wire shape", () => {
    expect(formatDeploymentTransaction(transaction)).toEqual({
      type: 2,
      chain_id: 4663,
      nonce: 0,
      data: "0x6000",
      value: "0x0",
      gas_limit: "0xf4240",
      max_fee_per_gas: "0x3b9aca00",
      max_priority_fee_per_gas: "0x0",
    });
  });

  it.each([
    ["value", "value"],
    ["gas", "gas_limit"],
    ["gasPrice", "gas_price"],
    ["maxFeePerGas", "max_fee_per_gas"],
    ["maxPriorityFeePerGas", "max_priority_fee_per_gas"],
  ])(
    "preserves zero for %s without inventing absent quantities",
    (input, output) => {
      expect(
        formatDeploymentTransaction({ chainId: 4663, [input]: 0n }),
      ).toEqual({
        type: 2,
        chain_id: 4663,
        [output]: "0x0",
      });
    },
  );

  it("does not add absent fields, mutate the input, or lose integer precision", () => {
    const input = Object.freeze({
      type: "legacy",
      chainId: 4663,
      nonce: 1,
      gasPrice: 9007199254740993n,
    });
    expect(formatDeploymentTransaction(input)).toEqual({
      type: 0,
      chain_id: 4663,
      nonce: 1,
      gas_price: "0x20000000000001",
    });
    expect(input.gasPrice).toBe(9007199254740993n);
  });
});

describe("sanitized deployment signing diagnostics", () => {
  it("logs only safe field-presence facts, not payloads, wallet IDs, or credentials", () => {
    const output = signingRequestDiagnostic({
      ...formatDeploymentTransaction(transaction),
      data: "TEST_ONLY_SENSITIVE_PAYLOAD",
      walletId: "TEST_ONLY_WALLET_ID",
      authorization: "TEST_ONLY_AUTHORIZATION",
      signed_transaction: "TEST_ONLY_SIGNED_BYTES",
    });
    expect(output).toEqual({
      event: "PRIVY_DEPLOYMENT_SIGN_REQUEST",
      method: "eth_signTransaction",
      chain4663: true,
      contractCreation: true,
      noncePresent: true,
      nonceZero: true,
      gasLimitPresent: true,
      maxFeePerGasPresent: true,
      maxPriorityFeePerGasPresent: true,
      maxPriorityFeePerGasZero: true,
      valueZero: true,
    });
    expect(JSON.stringify(output)).not.toContain("TEST_ONLY");
  });

  it.each([
    [400, "BadRequestError"],
    [401, "AuthenticationError"],
    [403, "PermissionDeniedError"],
    [422, "UnprocessableEntityError"],
    [429, "RateLimitError"],
    [500, "InternalServerError"],
  ])(
    "retains HTTP %i classification without provider error details",
    (status, type) => {
      const error = APIError.generate(
        status,
        { message: "TEST_ONLY_SECRET", signed_transaction: "TEST_ONLY_BYTES" },
        "TEST_ONLY_RPC_URL",
        new Headers({ authorization: "TEST_ONLY_TOKEN" }),
      );
      expect(signingErrorDiagnostic(error)).toEqual({
        event: "PRIVY_DEPLOYMENT_SIGN_FAILED",
        method: "eth_signTransaction",
        errorType: type,
        httpStatus: status,
      });
      expect(JSON.stringify(signingErrorDiagnostic(error))).not.toContain(
        "TEST_ONLY",
      );
    },
  );

  it("distinguishes a timeout from credentials rejection without disclosing causes", () => {
    expect(
      signingErrorDiagnostic(
        new APIConnectionTimeoutError({
          message: "TEST_ONLY_RPC_URL",
        }),
      ),
    ).toMatchObject({
      errorType: "APIConnectionTimeoutError",
      httpStatus: null,
    });
    expect(
      signingErrorDiagnostic(
        new APIConnectionError({
          message: "TEST_ONLY_SECRET",
          cause: new Error("TEST_ONLY_TOKEN"),
        }),
      ),
    ).toMatchObject({ errorType: "APIConnectionError", httpStatus: null });
  });

  it("never prints unknown error names, nonnumeric status, headers, bodies, or stacks", () => {
    const diagnostic = signingErrorDiagnostic({
      constructor: { name: "TEST_ONLY_SECRET" },
      status: "TEST_ONLY_SECRET",
      message: "TEST_ONLY_SECRET",
      headers: { authorization: "TEST_ONLY_TOKEN" },
      cause: new Error("TEST_ONLY_RPC_URL"),
      stack: "TEST_ONLY_BYTES",
      error: { signed_transaction: "TEST_ONLY_BYTES" },
    });
    expect(diagnostic).toMatchObject({
      errorType: "UNCLASSIFIED",
      httpStatus: null,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("TEST_ONLY");
    expect(signingErrorDiagnostic(null)).toMatchObject({
      errorType: "UNCLASSIFIED",
      httpStatus: null,
    });
  });
});
