import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import { DomainError } from "./errors.js";
import {
  FINANCIAL_CHAIN_ID,
  type EscrowTerms,
  type FinancialAction,
  type SafeCall,
} from "./finance-types.js";

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((x) => !/^0x0{40}$/.test(x))
  .transform((x) => x.toLowerCase() as Address);
export const hashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((x) => x.toLowerCase() as Hex);
export const unitsSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((x) => BigInt(x) < 2n ** 256n);
export const positiveUnitsSchema = unitsSchema.refine((x) => BigInt(x) > 0n);
export const termsComponents = [
  { name: "nonce", type: "bytes32" },
  { name: "buyer", type: "address" },
  { name: "provider", type: "address" },
  { name: "providerOwner", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "acceptBy", type: "uint64" },
  { name: "completeBy", type: "uint64" },
  { name: "reviewPeriod", type: "uint64" },
] as const;
export const escrowAbi = [
  ...parseAbi([
    "function USDG() view returns (address)",
    "function maxPayment() view returns (uint256)",
    "function tokenDecimals() view returns (uint8)",
    "function paused() view returns (bool)",
    "function totalObligations() view returns (uint256)",
    "function hasRole(bytes32 role,address account) view returns (bool)",
    "function configureSpending(bool enabled,uint64 expiresAt,uint256 perTransaction,uint256 perDay)",
    "function spendingPolicies(address wallet) view returns (bool enabled,uint64 expiresAt,uint256 perTransaction,uint256 perDay)",
    "function dailySpend(address wallet,uint256 day) view returns (uint256)",
    "function accept(bytes32 id)",
    "function submitResult(bytes32 id,bytes32 resultHash)",
    "function acceptResult(bytes32 id)",
    "function dispute(bytes32 id)",
    "function refund(bytes32 id)",
    "function releaseAfterWindow(bytes32 id)",
    "event InvocationFunded(bytes32 indexed invocationId,address indexed buyer,address indexed provider,uint256 amount)",
    "event InvocationAccepted(bytes32 indexed invocationId)",
    "event ResultSubmitted(bytes32 indexed invocationId,bytes32 resultHash,uint64 reviewBy)",
    "event InvocationReleased(bytes32 indexed invocationId,address indexed provider,uint256 amount)",
    "event InvocationRefunded(bytes32 indexed invocationId,address indexed buyer,uint256 amount)",
    "event DisputeOpened(bytes32 indexed invocationId)",
    "event DisputeResolved(bytes32 indexed invocationId,bool released)",
  ]),
  ...["fund", "fundWithSession"].map(
    (name) =>
      ({
        type: "function",
        name,
        stateMutability: "nonpayable",
        inputs: [{ name: "terms", type: "tuple", components: termsComponents }],
        outputs: [],
      }) as const,
  ),
  {
    type: "function",
    name: "getInvocation",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "invocation",
        type: "tuple",
        components: [
          { name: "terms", type: "tuple", components: termsComponents },
          { name: "state", type: "uint8" },
          { name: "resultHash", type: "bytes32" },
          { name: "reviewBy", type: "uint64" },
        ],
      },
    ],
  },
] as const;
export function decimalToUnits(value: string, decimals: number): string {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)
  )
    throw new DomainError("Invalid decimal token amount.", "INVALID_AMOUNT");
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new DomainError("Amount exceeds token precision.", "INVALID_AMOUNT");
  return unitsSchema.parse(
    (
      BigInt(whole) * 10n ** BigInt(decimals) +
      BigInt(fraction.padEnd(decimals, "0") || "0")
    ).toString(),
  );
}
export function contractTerms(t: EscrowTerms) {
  return {
    ...t,
    amount: BigInt(t.amount),
    acceptBy: BigInt(t.acceptBy),
    completeBy: BigInt(t.completeBy),
    reviewPeriod: BigInt(t.reviewPeriod),
  };
}
export function escrowInvocationId(escrow: Address, t: EscrowTerms): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "tuple", components: termsComponents },
      ],
      [BigInt(FINANCIAL_CHAIN_ID), escrow, contractTerms(t)],
    ),
  );
}
export function escrowCall(
  escrow: Address,
  action: FinancialAction,
  id: Hex,
  t: EscrowTerms,
  autonomous: boolean,
  resultHash?: Hex | null,
): SafeCall {
  let data: Hex;
  if (action === "fund")
    data = encodeFunctionData({
      abi: escrowAbi,
      functionName: autonomous ? "fundWithSession" : "fund",
      args: [contractTerms(t)],
    });
  else if (action === "submit") {
    if (!resultHash)
      throw new DomainError("A persisted result is required.", "INVALID_STATE");
    data = encodeFunctionData({
      abi: escrowAbi,
      functionName: "submitResult",
      args: [id, resultHash],
    });
  } else
    data = encodeFunctionData({
      abi: escrowAbi,
      functionName: action === "release" ? "acceptResult" : action,
      args: [id],
    });
  return { to: escrow, data, value: "0x0" };
}
