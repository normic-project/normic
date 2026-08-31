import {
  createPublicClient,
  http,
  erc20Abi,
  decodeEventLog,
  decodeFunctionData,
  keccak256,
  toHex,
  zeroHash,
  type PublicClient,
} from "viem";
import {
  CANONICAL_USDG,
  DomainError,
  escrowAbi,
  addressSchema,
  hashSchema,
  decimalToUnits,
  type FinancialChainPort,
  type FinanceCapabilities,
  type EvmAddress,
  type EvmHash,
  type SafeCall,
  type VerifiedEscrowEvent,
  type TokenMetadata,
  type WalletBalances,
} from "@normic/core";

export class RobinhoodFinancialChain implements FinancialChainPort {
  readonly client: PublicClient | null;
  constructor(private readonly env: Record<string, string | undefined> = {}) {
    const rpc = env.ROBINHOOD_RPC_URL;
    if (rpc) {
      const url = new URL(rpc);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        (env.NODE_ENV === "production" &&
          url.hostname === "rpc.mainnet.chain.robinhood.com")
      )
        throw new Error(
          "A dedicated HTTPS Robinhood production RPC is required.",
        );
    }
    this.client = rpc
      ? createPublicClient({
          transport: http(rpc, { retryCount: 0, timeout: 10_000 }),
        })
      : null;
  }
  private deploymentConfigurationMissing() {
    const required = [
      "ROBINHOOD_RPC_URL",
      "NORMIC_ESCROW_ADDRESS",
      "NORMIC_ESCROW_RUNTIME_HASH",
      "MAX_SERVICE_PAYMENT_USDG",
      "ADMIN_ADDRESS",
      "DISPUTE_RESOLVER_ADDRESS",
      "NORMIC_ESCROW_DEPLOYMENT_BLOCK",
    ];
    return required.filter((k) => !this.env[k]);
  }
  capabilities(): FinanceCapabilities {
    const missing = this.deploymentConfigurationMissing();
    if (this.env.NORMIC_FINANCIAL_EXECUTION_ENABLED !== "true")
      missing.push("NORMIC_FINANCIAL_EXECUTION_ENABLED=true");
    if (
      this.env.NODE_ENV === "production" &&
      this.env.NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED !== "true"
    )
      missing.push("NORMIC_OWNER_FINANCIAL_AUTHORIZATION_ENABLED=true");
    const escrow = addressSchema.safeParse(this.env.NORMIC_ESCROW_ADDRESS);
    return {
      state: missing.length ? "blocked" : "ready",
      missing,
      chainId: 4663,
      escrow: escrow.success ? escrow.data : null,
      autonomousExecution: missing.length === 0,
      gasSponsorship: false,
    };
  }
  private rpc() {
    if (!this.client)
      throw new DomainError(
        "Robinhood production RPC is not configured.",
        "FINANCIAL_UNAVAILABLE",
      );
    return this.client;
  }
  async validateChain() {
    if ((await this.rpc().getChainId()) !== 4663)
      throw new DomainError(
        "Wrong chain: Robinhood Mainnet (4663) is required.",
        "FINANCIAL_UNAVAILABLE",
      );
  }
  async validateToken(): Promise<TokenMetadata> {
    await this.validateChain();
    const rpc = this.rpc(),
      b = await rpc.getBlock({ blockTag: "finalized" });
    const code = await rpc.getCode({
      address: CANONICAL_USDG,
      blockNumber: b.number,
    });
    if (!code || code === "0x")
      throw new Error("Canonical USDG bytecode is unavailable.");
    const [decimals, symbol] = await Promise.all([
      rpc.readContract({
        address: CANONICAL_USDG,
        abi: erc20Abi,
        functionName: "decimals",
        blockNumber: b.number,
      }),
      rpc.readContract({
        address: CANONICAL_USDG,
        abi: erc20Abi,
        functionName: "symbol",
        blockNumber: b.number,
      }),
      rpc.readContract({
        address: CANONICAL_USDG,
        abi: erc20Abi,
        functionName: "totalSupply",
        blockNumber: b.number,
      }),
    ]);
    if (symbol !== "USDG" || decimals > 36)
      throw new Error("Unexpected canonical USDG metadata.");
    return {
      address: CANONICAL_USDG,
      chainId: 4663,
      decimals,
      symbol,
      blockNumber: b.number.toString(),
      source: "robinhood-mainnet-rpc/finalized",
    };
  }
  async validateEscrow(options: { requireExecution?: boolean } = {}) {
    const missing =
      options.requireExecution === false
        ? this.deploymentConfigurationMissing()
        : this.capabilities().missing;
    if (missing.length)
      throw new DomainError(
        "Financial execution is blocked by missing deployment configuration.",
        "FINANCIAL_UNAVAILABLE",
      );
    const address = addressSchema.parse(this.env.NORMIC_ESCROW_ADDRESS),
      hash = hashSchema.parse(this.env.NORMIC_ESCROW_RUNTIME_HASH);
    const token = await this.validateToken(),
      rpc = this.rpc();
    const code = await rpc.getCode({ address, blockTag: "finalized" });
    if (!code || keccak256(code) !== hash)
      throw new Error("Escrow runtime bytecode is not the pinned deployment.");
    const [usdg, max, paused, admin, resolver] = await Promise.all([
      rpc.readContract({ address, abi: escrowAbi, functionName: "USDG" }),
      rpc.readContract({ address, abi: escrowAbi, functionName: "maxPayment" }),
      rpc.readContract({ address, abi: escrowAbi, functionName: "paused" }),
      rpc.readContract({
        address,
        abi: escrowAbi,
        functionName: "hasRole",
        args: [zeroHash, addressSchema.parse(this.env.ADMIN_ADDRESS)],
      }),
      rpc.readContract({
        address,
        abi: escrowAbi,
        functionName: "hasRole",
        args: [
          keccak256(toHex("RESOLVER_ROLE")),
          addressSchema.parse(this.env.DISPUTE_RESOLVER_ADDRESS),
        ],
      }),
    ]);
    if (
      String(usdg).toLowerCase() !== CANONICAL_USDG.toLowerCase() ||
      BigInt(String(max)) !==
        BigInt(
          decimalToUnits(this.env.MAX_SERVICE_PAYMENT_USDG!, token.decimals),
        ) ||
      !admin ||
      !resolver
    )
      throw new Error("Escrow deployment configuration mismatch.");
    // Pause is enforced by the contract per selector; refunds must remain possible.
    void paused;
    return { address, maxPayment: String(max) };
  }
  async balances(wallet: EvmAddress): Promise<WalletBalances> {
    const token = await this.validateToken(),
      rpc = this.rpc(),
      b = await rpc.getBlock({ blockNumber: BigInt(token.blockNumber) });
    const [eth, usdg] = await Promise.all([
      rpc.getBalance({ address: wallet, blockNumber: b.number }),
      rpc.readContract({
        address: CANONICAL_USDG,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet],
        blockNumber: b.number,
      }),
    ]);
    return {
      state: "available",
      wallet,
      chainId: 4663,
      blockNumber: b.number.toString(),
      blockHash: b.hash,
      timestamp: new Date(Number(b.timestamp) * 1000).toISOString(),
      source: token.source,
      eth: {
        units: eth.toString(),
        decimals: 18,
        symbol: "ETH",
        tokenAddress: null,
      },
      usdg: {
        units: usdg.toString(),
        decimals: token.decimals,
        symbol: "USDG",
        tokenAddress: CANONICAL_USDG,
      },
    };
  }
  async allowance(wallet: EvmAddress) {
    const e = await this.validateEscrow();
    return (
      await this.rpc().readContract({
        address: CANONICAL_USDG,
        abi: erc20Abi,
        functionName: "allowance",
        args: [wallet, e.address],
      })
    ).toString();
  }
  async simulate(from: EvmAddress, calls: SafeCall[], amount: string) {
    const escrow = await this.validateEscrow();
    if (calls.length !== 1)
      throw new Error("Only one escrow operation can be simulated.");
    for (const call of calls) {
      if (
        call.to.toLowerCase() !== escrow.address.toLowerCase() ||
        call.value !== "0x0"
      )
        throw new Error("Unapproved transaction destination or native value.");
      const decoded = decodeFunctionData({ abi: escrowAbi, data: call.data });
      if (
        ![
          "fund",
          "fundWithSession",
          "accept",
          "submitResult",
          "acceptResult",
          "dispute",
          "refund",
        ].includes(decoded.functionName)
      )
        throw new Error("Unapproved escrow selector.");
      if (
        BigInt(amount) > 0n &&
        BigInt((await this.balances(from)).usdg.units) < BigInt(amount)
      )
        throw new Error("Insufficient canonical USDG.");
      await this.rpc().call({
        account: from,
        to: call.to,
        data: call.data,
        value: 0n,
        blockTag: "latest",
      });
    }
    await this.validateChain();
  }
  async verifyWalletSignature(
    address: EvmAddress,
    message: string,
    signature: EvmHash,
  ) {
    await this.validateChain();
    return this.rpc().verifyMessage({ address, message, signature });
  }
  async verifyCheckpoint(block: string, hash: EvmHash) {
    await this.validateChain();
    if (
      (await this.rpc().getBlock({ blockNumber: BigInt(block) })).hash !== hash
    )
      throw new Error(
        "Finalized checkpoint changed. Indexing halted; investigate the RPC and canonical chain.",
      );
  }
  async verifyReceipt(hash: EvmHash): Promise<VerifiedEscrowEvent[]> {
    const escrow = await this.validateEscrow(),
      rpc = this.rpc(),
      receipt = await rpc.getTransactionReceipt({
        hash: hashSchema.parse(hash),
      });
    const final = await rpc.getBlock({ blockTag: "finalized" });
    if (receipt.status !== "success" || receipt.blockNumber > final.number)
      throw new DomainError(
        "Transaction is reverted or not finalized yet.",
        "PAYMENT_NOT_FINALIZED",
      );
    const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash)
      throw new Error("Receipt is not canonical.");
    const events: VerifiedEscrowEvent[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== escrow.address.toLowerCase()) continue;
      let decoded;
      try {
        decoded = decodeEventLog({
          abi: escrowAbi,
          data: log.data,
          topics: log.topics,
          strict: true,
        });
      } catch {
        continue;
      }
      const args = decoded.args as Record<string, unknown>,
        id = hashSchema.parse(args.invocationId);
      const invocation = (await rpc.readContract({
        address: escrow.address,
        abi: escrowAbi,
        functionName: "getInvocation",
        args: [id],
        blockNumber: block.number,
      })) as {
        terms: {
          nonce: EvmHash;
          buyer: EvmAddress;
          provider: EvmAddress;
          providerOwner: EvmAddress;
          amount: bigint;
          acceptBy: bigint;
          completeBy: bigint;
          reviewPeriod: bigint;
        };
        resultHash: EvmHash;
      };
      const t = invocation.terms;
      if (args.amount !== undefined && String(args.amount) !== String(t.amount))
        throw new Error("Escrow event amount mismatch.");
      for (const field of ["buyer", "provider"] as const)
        if (
          args[field] &&
          String(args[field]).toLowerCase() !== t[field].toLowerCase()
        )
          throw new Error("Escrow event party mismatch.");
      events.push({
        chainId: 4663,
        transactionHash: receipt.transactionHash,
        logIndex: log.logIndex,
        blockNumber: block.number.toString(),
        blockHash: block.hash,
        contractAddress: escrow.address,
        invocationId: id,
        name: decoded.eventName as VerifiedEscrowEvent["name"],
        terms: {
          nonce: t.nonce,
          buyer: t.buyer.toLowerCase() as EvmAddress,
          provider: t.provider.toLowerCase() as EvmAddress,
          providerOwner: t.providerOwner.toLowerCase() as EvmAddress,
          amount: t.amount.toString(),
          acceptBy: t.acceptBy.toString(),
          completeBy: t.completeBy.toString(),
          reviewPeriod: t.reviewPeriod.toString(),
        },
        resultHash:
          decoded.eventName === "ResultSubmitted"
            ? hashSchema.parse(args.resultHash)
            : null,
        observedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
      });
    }
    return events.sort((a, b) => a.logIndex - b.logIndex);
  }
  async finalizedEvents(fromBlock: string, limit: number) {
    const escrow = await this.validateEscrow(),
      rpc = this.rpc(),
      final = await rpc.getBlock({ blockTag: "finalized" });
    const from = BigInt(fromBlock),
      end = from + BigInt(Math.min(250, Math.max(1, limit))) - 1n,
      through = end < final.number ? end : final.number;
    const logs =
      from <= through
        ? await rpc.getLogs({
            address: escrow.address,
            fromBlock: from,
            toBlock: through,
          })
        : [];
    const events: VerifiedEscrowEvent[] = [];
    for (const hash of new Set(logs.map((l) => l.transactionHash)))
      events.push(...(await this.verifyReceipt(hash)));
    const block = await rpc.getBlock({ blockNumber: through });
    return { events, throughBlock: through.toString(), blockHash: block.hash };
  }
  async incomingTransfers(wallet: EvmAddress, from: string, to: string) {
    if (BigInt(from) > BigInt(to)) return [];
    await this.validateToken();
    const logs = await this.rpc().getContractEvents({
      address: CANONICAL_USDG,
      abi: erc20Abi,
      eventName: "Transfer",
      args: { to: wallet },
      fromBlock: BigInt(from),
      toBlock: BigInt(to),
      strict: true,
    });
    return logs.map((l) => ({
      transactionHash: l.transactionHash,
      logIndex: l.logIndex,
      from: l.args.from.toLowerCase() as EvmAddress,
      units: l.args.value.toString(),
      blockNumber: l.blockNumber.toString(),
      blockHash: l.blockHash,
    }));
  }
}
