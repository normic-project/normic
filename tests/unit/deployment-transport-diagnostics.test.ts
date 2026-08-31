import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionExecutionError } from "../../packages/contracts/node_modules/viem/_esm/errors/transaction.js";
import {
  HttpRequestError,
  RpcRequestError,
  TimeoutError,
} from "../../packages/contracts/node_modules/viem/_esm/errors/request.js";
import { TransactionRejectedRpcError } from "../../packages/contracts/node_modules/viem/_esm/errors/rpc.js";
import {
  createTransportDiagnosticTrace,
  transportErrorDiagnostic,
} from "../../packages/contracts/scripts/transport-diagnostics.mjs";

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

const rawTransaction = `0x02${"ab".repeat(300)}`;
const rpcUrl = "https://TEST_ONLY_API_KEY.example.test";

describe("sanitized Viem deployment transport diagnostics", () => {
  it("identifies a wrapped eth_sendRawTransaction rejection without leaking its request", () => {
    const request = new RpcRequestError({
      body: { method: "eth_sendRawTransaction", params: [rawTransaction] },
      error: {
        code: -32003,
        message: `TEST_ONLY_SECRET ${rawTransaction}`,
      },
      url: rpcUrl,
    });
    const rejection = new TransactionRejectedRpcError(request);
    const error = new TransactionExecutionError(rejection, {
      chain: { id: 4663, name: "Robinhood Chain Mainnet" },
      data: rawTransaction,
      nonce: 0,
      maxPriorityFeePerGas: 0n,
    });

    const diagnostic = transportErrorDiagnostic(error, {
      ethSendRawTransaction: true,
      httpStatus: 200,
    });
    expect(diagnostic).toEqual({
      event: "DEPLOYMENT_TRANSPORT_FAILED",
      phase: "ETH_SEND_RAW_TRANSACTION",
      ethSendRawTransaction: true,
      rpcMethod: "eth_sendRawTransaction",
      phase: "ETH_SEND_RAW_TRANSACTION",
      ethSendRawTransaction: true,
      viemErrorClass: "TransactionExecutionError",
      viemErrorChain: [
        "TransactionExecutionError",
        "TransactionRejectedRpcError",
        "RpcRequestError",
      ],
      rpcErrorCode: -32003,
      httpStatus: 200,
      shortMessage: "Transaction creation failed.",
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /TEST_ONLY|0x02abab|authorization|api.key/i,
    );
  });

  it("captures HTTP status but never URL, headers, body, or signed bytes", () => {
    const request = new HttpRequestError({
      body: { method: "eth_sendRawTransaction", params: [rawTransaction] },
      details: `TEST_ONLY_SECRET ${rawTransaction}`,
      headers: new Headers({ authorization: "Bearer TEST_ONLY_TOKEN" }),
      status: 403,
      url: rpcUrl,
    });
    const error = new TransactionExecutionError(request, {});

    const diagnostic = transportErrorDiagnostic(error);
    expect(diagnostic).toMatchObject({
      rpcMethod: "eth_sendRawTransaction",
      viemErrorClass: "TransactionExecutionError",
      viemErrorChain: ["TransactionExecutionError", "HttpRequestError"],
      rpcErrorCode: null,
      httpStatus: 403,
      shortMessage: "HTTP request failed.",
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /TEST_ONLY|0x02abab|authorization|bearer|api.key/i,
    );
  });

  it("identifies an eth_sendRawTransaction timeout without exposing its body or URL", () => {
    const error = new TransactionExecutionError(
      new TimeoutError({
        body: { method: "eth_sendRawTransaction", params: [rawTransaction] },
        url: rpcUrl,
      }),
      {},
    );
    expect(
      transportErrorDiagnostic(error, { ethSendRawTransaction: true }),
    ).toEqual({
      event: "DEPLOYMENT_TRANSPORT_FAILED",
      phase: "ETH_SEND_RAW_TRANSACTION",
      ethSendRawTransaction: true,
      rpcMethod: "eth_sendRawTransaction",
      viemErrorClass: "TransactionExecutionError",
      viemErrorChain: ["TransactionExecutionError", "TimeoutError"],
      rpcErrorCode: null,
      httpStatus: null,
      shortMessage: "The request took too long to respond.",
    });
  });

  it("fails closed for unknown error shapes and unsafe short messages", () => {
    const error = {
      name: "TEST_ONLY_SECRET",
      code: "TEST_ONLY_CODE",
      status: "TEST_ONLY_STATUS",
      shortMessage: `Rejected ${rawTransaction} at ${rpcUrl}`,
      body: {
        method: "TEST_ONLY_METHOD",
        authorization: "Bearer TEST_ONLY_TOKEN",
      },
      cause: {
        name: "RpcRequestError",
        code: -32000,
        shortMessage: `Authorization Bearer TEST_ONLY_TOKEN ${rawTransaction}`,
      },
    };
    const diagnostic = transportErrorDiagnostic(error);
    expect(diagnostic).toEqual({
      event: "DEPLOYMENT_TRANSPORT_FAILED",
      phase: "PREPARATION_SIGNING_OR_TRANSPORT_UNVERIFIED",
      ethSendRawTransaction: false,
      rpcMethod: "UNVERIFIED",
      viemErrorClass: "RpcRequestError",
      viemErrorChain: ["RpcRequestError"],
      rpcErrorCode: -32000,
      httpStatus: null,
      shortMessage: null,
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /TEST_ONLY|0x02abab|authorization|bearer|api.key/i,
    );
  });

  it("tracks only the RPC method boolean and HTTP status through Viem HTTP hooks", () => {
    const trace = createTransportDiagnosticTrace();
    trace.onFetchRequest(new Request(rpcUrl), {
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_sendRawTransaction",
        params: [rawTransaction],
      }),
      headers: { authorization: "Bearer TEST_ONLY_TOKEN" },
    });
    trace.onFetchResponse(new Response(null, { status: 200 }));
    expect(trace.state).toEqual({
      ethSendRawTransaction: true,
      httpStatus: 200,
    });
    expect(JSON.stringify(trace.state)).not.toMatch(
      /TEST_ONLY|0x02abab|authorization|bearer|api.key/i,
    );
  });

  it("does not retain malformed or unrelated request bodies", () => {
    const trace = createTransportDiagnosticTrace();
    trace.onFetchRequest(new Request(rpcUrl), {
      body: `TEST_ONLY_SECRET ${rawTransaction}`,
    });
    expect(trace.state).toEqual({
      ethSendRawTransaction: false,
      httpStatus: null,
    });
    trace.onFetchRequest(new Request(rpcUrl), {
      body: JSON.stringify({ method: "eth_chainId", params: [] }),
    });
    expect(trace.state.ethSendRawTransaction).toBe(false);
    expect(JSON.stringify(trace.state)).not.toMatch(/TEST_ONLY|0x02abab/i);
  });

  it("handles cyclic causes with a fixed traversal bound", () => {
    const error: { name: string; cause?: unknown } = {
      name: "TransactionExecutionError",
    };
    error.cause = error;
    expect(transportErrorDiagnostic(error)).toMatchObject({
      viemErrorChain: ["TransactionExecutionError"],
      phase: "PREPARATION_SIGNING_OR_TRANSPORT_UNVERIFIED",
      ethSendRawTransaction: false,
      rpcMethod: "UNVERIFIED",
    });
  });
});
