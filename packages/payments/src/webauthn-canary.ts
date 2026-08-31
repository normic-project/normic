import {
  concatHex,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  toFunctionSelector,
} from "viem";
import {
  AllowlistModule,
  HookType,
  NativeTokenLimitModule,
  SingleSignerValidationModule,
  TimeRangeModule,
  getDefaultAllowlistModuleAddress,
  getDefaultNativeTokenLimitModuleAddress,
  getDefaultSingleSignerValidationModuleAddress,
  getDefaultTimeRangeModuleAddress,
  modularAccountAbi,
  serializeHookConfig,
  serializeValidationConfig,
  serializeModuleEntity,
} from "@account-kit/smart-contracts/experimental";
import {
  CANONICAL_USDG,
  PolicyDeniedError,
  addressSchema,
  escrowAbi,
  type EvmAddress,
  type SafeCall,
} from "@normic/core";

export const CANARY_ESCROW =
  "0xda3ea8cd849ff916aa0ee6b1088f151c2fa51c47" as const;
export const CANARY_UNITS = 10_000n;
/** Only allowlisted diagnostic categories; never return provider messages or requests. */
export function canaryGasFailureReason(error: unknown): string {
  let current = error;
  for (let depth = 0; current && depth < 8; depth++) {
    if (typeof current !== "object") break;
    const item = current as {
      status?: unknown;
      name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (item.status === 429) return "RPC_RATE_LIMITED";
    if (item.status === 401 || item.status === 403)
      return "RPC_AUTHENTICATION_FAILED";
    if (typeof item.name === "string" && /timeout|abort/i.test(item.name))
      return "RPC_TIMEOUT";
    if (typeof item.message === "string") {
      if (/AA21|prefund|insufficient funds/i.test(item.message))
        return "INSUFFICIENT_ETH_FOR_ESTIMATION";
      if (/timed out|timeout/i.test(item.message)) return "RPC_TIMEOUT";
    }
    current = item.cause;
  }
  return "OWNER_USEROP_ESTIMATE_UNAVAILABLE";
}
export const canaryChain = defineChain({
  id: 4663,
  name: "Robinhood Chain Mainnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});
const signatures = {
  fund: "fundWithSession((bytes32,address,address,address,uint256,uint64,uint64,uint64))",
  release: "acceptResult(bytes32)",
  accept: "accept(bytes32)",
  submit: "submitResult(bytes32,bytes32)",
};
export function canaryOwnerCalls(input: {
  allowance: bigint;
  preparedAt: number;
  escrow: EvmAddress;
  chainId: number;
  role?: "buyer" | "provider";
}) {
  if (
    input.chainId !== 4663 ||
    input.escrow.toLowerCase() !== CANARY_ESCROW ||
    !Number.isSafeInteger(input.preparedAt) ||
    input.preparedAt < 0 ||
    input.allowance < 0n
  )
    throw new PolicyDeniedError("Invalid canary preparation.");
  const expiry = input.preparedAt + 3600;
  if (input.role === "provider")
    return {
      calls: [] as SafeCall[],
      expiry,
      approvalRequired: false,
      allowanceReductionRequired: false,
    };
  const calls: SafeCall[] = [
    {
      to: CANARY_ESCROW,
      value: "0x0",
      data: encodeFunctionData({
        abi: escrowAbi,
        functionName: "configureSpending",
        args: [true, BigInt(expiry), CANARY_UNITS, CANARY_UNITS],
      }),
    },
  ];
  // A larger existing allowance is NOT silently accepted as a cumulative 0.01 limit.
  // Leave it untouched and require an independent owner reduction before proceeding.
  if (input.allowance < CANARY_UNITS)
    calls.push({
      to: CANONICAL_USDG,
      value: "0x0",
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [CANARY_ESCROW, CANARY_UNITS],
      }),
    });
  return {
    calls,
    expiry,
    approvalRequired: input.allowance < CANARY_UNITS,
    allowanceReductionRequired: input.allowance > CANARY_UNITS,
  };
}

/** Low-level MAv2 session installation, authored by the root only. Does not sign or send.
 * Do not use generic ERC20_TOKEN_TRANSFER: it grants direct approve/transfer selectors.
 * Escrow transferFrom is bounded by exact owner allowance + configureSpending; the
 * Alchemy ERC20 hook additionally caps direct token spending (which the allowlist denies).
 */
export function canarySessionInstall(input: {
  publicKey: EvmAddress;
  wallet: EvmAddress;
  expiry: number;
  preparedAt: number;
  role: "buyer" | "provider";
}) {
  const signer = addressSchema.parse(input.publicKey),
    wallet = addressSchema.parse(input.wallet);
  if (
    signer === wallet ||
    signer === CANARY_ESCROW ||
    signer === CANONICAL_USDG.toLowerCase() ||
    signer === `0x${"0".repeat(40)}` ||
    !Number.isSafeInteger(input.preparedAt) ||
    input.expiry !== input.preparedAt + 3600 ||
    !["buyer", "provider"].includes(input.role)
  )
    throw new PolicyDeniedError("Invalid canary session binding.");
  // Entity zero remains the user's immutable WebAuthn root. Entity one must be
  // checked unused by the adapter before an owner is ever asked to install it.
  const entityId = 1;
  const selectors = (
    input.role === "buyer"
      ? [signatures.fund, signatures.release]
      : [signatures.accept, signatures.submit]
  )
    .map(toFunctionSelector)
    .sort();
  const allowlist = getDefaultAllowlistModuleAddress(canaryChain);
  const native = getDefaultNativeTokenLimitModuleAddress(canaryChain);
  const validationConfig = {
    moduleAddress: getDefaultSingleSignerValidationModuleAddress(canaryChain),
    entityId,
    isGlobal: false,
    isSignatureValidation: false,
    isUserOpValidation: true,
  };
  const hooks = [
    AllowlistModule.buildHook(
      {
        entityId,
        inputs: [
          {
            target: CANARY_ESCROW,
            hasSelectorAllowlist: true,
            hasERC20SpendLimit: false,
            erc20SpendLimit: 0n,
            selectors,
          },
        ],
      },
      allowlist,
    ),
    {
      hookConfig: {
        address: allowlist,
        entityId: 2,
        hookType: HookType.EXECUTION,
        hasPreHooks: true,
        hasPostHooks: false,
      },
      initData: AllowlistModule.encodeOnInstallData({
        entityId: 2,
        inputs: [
          {
            target: CANONICAL_USDG,
            hasSelectorAllowlist: true,
            hasERC20SpendLimit: true,
            erc20SpendLimit: input.role === "buyer" ? CANARY_UNITS : 0n,
            selectors: [],
          },
        ],
      }),
    },
    {
      hookConfig: {
        address: getDefaultTimeRangeModuleAddress(canaryChain),
        entityId,
        hookType: HookType.VALIDATION,
        hasPreHooks: true,
        hasPostHooks: false,
      },
      initData: TimeRangeModule.encodeOnInstallData({
        entityId,
        validAfter: input.preparedAt,
        validUntil: input.expiry,
      }),
    },
    {
      hookConfig: {
        address: native,
        entityId,
        hookType: HookType.EXECUTION,
        hasPreHooks: true,
        hasPostHooks: false,
      },
      initData: NativeTokenLimitModule.encodeOnInstallData({
        entityId,
        spendLimit: 0n,
      }),
    },
  ];
  const data = encodeFunctionData({
    abi: modularAccountAbi,
    functionName: "installValidation",
    args: [
      serializeValidationConfig(validationConfig),
      [
        toFunctionSelector("execute(address,uint256,bytes)"),
        toFunctionSelector("executeBatch((address,uint256,bytes)[])"),
      ],
      SingleSignerValidationModule.encodeOnInstallData({ entityId, signer }),
      hooks.map((h) =>
        concatHex([serializeHookConfig(h.hookConfig), h.initData]),
      ),
    ],
  });
  return {
    call: { to: wallet, data, value: "0x0" } as SafeCall,
    revokeCall: {
      to: wallet,
      value: "0x0",
      data: encodeFunctionData({
        abi: modularAccountAbi,
        functionName: "uninstallValidation",
        args: [
          serializeModuleEntity(validationConfig),
          SingleSignerValidationModule.encodeOnUninstallData({ entityId }),
          // MAv2 uninstalls validation hooks first, then execution hooks; its
          // linked-list sets enumerate each group in reverse installation order.
          [
            TimeRangeModule.encodeOnUninstallData({ entityId }),
            hooks[0]!.initData,
            NativeTokenLimitModule.encodeOnUninstallData({ entityId }),
            hooks[1]!.initData,
          ],
        ],
      }),
    } as SafeCall,
    validationConfig,
    hooks,
    selectors,
    expiry: input.expiry,
    tokenAllowance: (input.role === "buyer" ? CANARY_UNITS : 0n).toString(),
    nativeTransferAllowance: "0",
    rootAuthorizationRequired: true as const,
  };
}

export const CANARY_LIFECYCLE = [
  "buyer:fundWithSession",
  "provider:accept",
  "provider:submitResult",
  "buyer:acceptResult",
  "finalized escrow/USDG receipt verification",
  "indexer and balanced immutable settlement ledger",
  "idempotency/audit verification",
  "owner revoke buyer session",
  "provider owner revoke canary-only session",
] as const;
