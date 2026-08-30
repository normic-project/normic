const VIEM_ERROR_TYPES = new Set([
  "TransactionExecutionError",
  "HttpRequestError",
  "ResponseBodyTooLargeError",
  "RpcRequestError",
  "SocketClosedError",
  "TimeoutError",
  "ParseRpcError",
  "InvalidRequestRpcError",
  "MethodNotFoundRpcError",
  "InvalidParamsRpcError",
  "InternalRpcError",
  "InvalidInputRpcError",
  "ResourceNotFoundRpcError",
  "ResourceUnavailableRpcError",
  "TransactionRejectedRpcError",
  "MethodNotSupportedRpcError",
  "LimitExceededRpcError",
  "JsonRpcVersionUnsupportedError",
  "UnknownRpcError",
  "ExecutionRevertedError",
  "FeeCapTooHighError",
  "FeeCapTooLowError",
  "NonceTooHighError",
  "NonceTooLowError",
  "NonceMaxValueError",
  "InsufficientFundsError",
  "IntrinsicGasTooHighError",
  "IntrinsicGasTooLowError",
  "TransactionTypeNotSupportedError",
  "TipAboveFeeCapError",
  "UnknownNodeError",
  "Eip1559FeesNotSupportedError",
  "MaxFeePerGasTooLowError",
  "ChainMismatchError",
]);

function getErrorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (
    current &&
    typeof current === "object" &&
    !seen.has(current) &&
    chain.length < 12
  ) {
    chain.push(current);
    seen.add(current);
    current = current.cause;
  }
  return chain;
}

function safeShortMessage(chain) {
  for (const error of chain) {
    if (!VIEM_ERROR_TYPES.has(error.name)) continue;
    if (typeof error.shortMessage !== "string") continue;
    const message = error.shortMessage.replace(/\s+/g, " ").trim();
    if (!message || message.length > 240) continue;
    if (
      /https?:\/\/|authorization|bearer|api[-_ ]?key|private[-_ ]?key|credential|secret|signed[_ -]?transaction|request body|0x[0-9a-f]{16,}/i.test(
        message,
      )
    )
      continue;
    return message;
  }
  return null;
}

export function createTransportDiagnosticTrace() {
  const state = {
    ethSendRawTransaction: false,
    httpStatus: null,
  };
  return {
    state,
    onFetchRequest(_request, init) {
      try {
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
        state.ethSendRawTransaction = Array.isArray(body)
          ? body.some((entry) => entry?.method === "eth_sendRawTransaction")
          : body?.method === "eth_sendRawTransaction";
      } catch {
        state.ethSendRawTransaction = false;
      }
    },
    onFetchResponse(response) {
      if (
        state.ethSendRawTransaction &&
        Number.isInteger(response?.status) &&
        response.status >= 100 &&
        response.status <= 599
      )
        state.httpStatus = response.status;
    },
  };
}

export function transportErrorDiagnostic(error, trace = {}) {
  const chain = getErrorChain(error);
  const errorTypes = [
    ...new Set(
      chain
        .map((entry) => entry.name)
        .filter((name) => VIEM_ERROR_TYPES.has(name)),
    ),
  ];
  const rpcErrorCode = chain
    .map((entry) => entry.code)
    .find((code) => Number.isInteger(code));
  const errorHttpStatus = chain
    .map((entry) => entry.status)
    .find(
      (status) => Number.isInteger(status) && status >= 100 && status <= 599,
    );
  const ethSendRawTransaction =
    trace.ethSendRawTransaction === true ||
    chain.some((entry) => entry.body?.method === "eth_sendRawTransaction");
  const httpStatus =
    Number.isInteger(trace.httpStatus) &&
    trace.httpStatus >= 100 &&
    trace.httpStatus <= 599
      ? trace.httpStatus
      : errorHttpStatus;

  return {
    event: "DEPLOYMENT_TRANSPORT_FAILED",
    phase: ethSendRawTransaction
      ? "ETH_SEND_RAW_TRANSACTION"
      : "PREPARATION_SIGNING_OR_TRANSPORT_UNVERIFIED",
    ethSendRawTransaction,
    rpcMethod: ethSendRawTransaction ? "eth_sendRawTransaction" : "UNVERIFIED",
    viemErrorClass: errorTypes[0] ?? "UNCLASSIFIED",
    viemErrorChain: errorTypes,
    rpcErrorCode: rpcErrorCode ?? null,
    httpStatus: httpStatus ?? null,
    shortMessage: safeShortMessage(chain),
  };
}
