import test from "node:test";
import assert from "node:assert/strict";
import ganache from "ganache";
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  keccak256,
  toHex,
  zeroAddress,
} from "viem";
import { compile } from "../scripts/compile.mjs";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const compiled = await compile(true);
const escrow =
  compiled.contracts["NormicServiceEscrow.sol"].NormicServiceEscrow;
const token = compiled.contracts["TestUSDG.sol"].TestUSDG;
async function fixture(chainId = 4663) {
  const rpc = ganache.provider({
    chain: { chainId, hardfork: "shanghai" },
    logging: { quiet: true },
    wallet: { totalAccounts: 6 },
  });
  const transport = custom(rpc),
    read = createPublicClient({ transport }),
    wallet = createWalletClient({ transport }),
    accounts = await wallet.getAddresses();
  const [admin, resolver, buyer, provider, owner, stranger] = accounts;
  await rpc.request({
    method: "evm_setAccountCode",
    params: [USDG, `0x${token.evm.deployedBytecode.object}`],
  });
  const write = async (address, abi, name, args = [], account = buyer) => {
    const hash = await wallet.writeContract({
      account,
      chain: null,
      address,
      abi,
      functionName: name,
      args,
      gas: 6_000_000n,
    });
    const r = await read.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("Reverted");
    return r;
  };
  const deploy = async () => {
    const hash = await wallet.deployContract({
      account: admin,
      chain: null,
      abi: escrow.abi,
      bytecode: `0x${escrow.evm.bytecode.object}`,
      args: [admin, resolver, 3600, 100_000_000n],
      gas: 7_000_000n,
    });
    const r = await read.waitForTransactionReceipt({ hash });
    if (r.status !== "success")
      throw new Error("Wrong chain or invalid deployment");
    return r.contractAddress;
  };
  if (chainId !== 4663) return { rpc, deploy };
  const address = await deploy();
  await write(USDG, token.abi, "mint", [buyer, 10_000_000_000n]);
  await write(USDG, token.abi, "approve", [address, 10_000_000_000n]);
  const call = (name, args = [], account = buyer) =>
    write(address, escrow.abi, name, args, account);
  const get = (name, args = []) =>
    read.readContract({ address, abi: escrow.abi, functionName: name, args });
  let nonce = 0;
  const terms = async (extra = {}) => {
    const now = (await read.getBlock()).timestamp;
    return {
      nonce: keccak256(toHex(String(++nonce))),
      buyer,
      provider,
      providerOwner: owner,
      amount: 5_000_000n,
      acceptBy: now + 100n,
      completeBy: now + 200n,
      reviewPeriod: 100n,
      ...extra,
    };
  };
  const fund = async (extra = {}) => {
    const t = await terms(extra),
      id = await get("invocationId", [t]);
    await call("fund", [t]);
    return { t, id };
  };
  const advance = async (seconds) => {
    await rpc.request({ method: "evm_increaseTime", params: [seconds] });
    await rpc.request({ method: "evm_mine", params: [] });
  };
  const invariant = async () =>
    assert.equal(
      await read.readContract({
        address: USDG,
        abi: token.abi,
        functionName: "balanceOf",
        args: [address],
      }),
      await get("totalObligations"),
    );
  const submitted = async () => {
    const i = await fund();
    await call("accept", [i.id], provider);
    await call(
      "submitResult",
      [i.id, keccak256(toHex("opaque salted result"))],
      provider,
    );
    return i;
  };
  return {
    rpc,
    read,
    write,
    accounts,
    admin,
    resolver,
    buyer,
    provider,
    owner,
    stranger,
    address,
    call,
    get,
    terms,
    fund,
    advance,
    invariant,
    submitted,
  };
}
test("USDG escrow lifecycle, authorization, invariants and seeded amount fuzz", async (t) => {
  const f = await fixture();
  try {
    await t.test(
      "fund, accept, submit, release and prevent terminal replays",
      async () => {
        const { id, t: terms } = await f.submitted();
        await f.invariant();
        await assert.rejects(f.call("acceptResult", [id], f.stranger));
        await f.call("acceptResult", [id]);
        await f.invariant();
        assert.equal((await f.get("getInvocation", [id])).state, 5);
        await assert.rejects(f.call("acceptResult", [id]));
        await assert.rejects(f.call("refund", [id]));
        await assert.rejects(f.call("fund", [terms]));
      },
    );
    await t.test(
      "unaccepted timeout refunds and unauthorized refund denial",
      async () => {
        const { id } = await f.fund();
        await assert.rejects(f.call("refund", [id]));
        await f.advance(101);
        await assert.rejects(f.call("refund", [id], f.stranger));
        await f.call("refund", [id]);
        await assert.rejects(f.call("refund", [id]));
        await f.invariant();
      },
    );
    await t.test("accepted timeout refund", async () => {
      const { id } = await f.fund();
      await f.call("accept", [id], f.provider);
      await f.advance(201);
      await f.call("refund", [id]);
      await f.invariant();
    });
    await t.test(
      "permissionless release only after review window",
      async () => {
        const { id } = await f.submitted();
        await assert.rejects(f.call("releaseAfterWindow", [id], f.stranger));
        await f.advance(101);
        await f.call("releaseAfterWindow", [id], f.stranger);
        await f.invariant();
      },
    );
    await t.test(
      "dispute freezes funds; explicit resolver can refund or release",
      async () => {
        for (const release of [false, true]) {
          const { id } = await f.submitted();
          await f.call("dispute", [id]);
          await f.advance(101);
          await assert.rejects(f.call("releaseAfterWindow", [id]));
          await assert.rejects(f.call("refund", [id]));
          await assert.rejects(
            f.call("resolveDispute", [id, release], f.stranger),
          );
          await f.call("resolveDispute", [id, release], f.resolver);
          await f.invariant();
        }
      },
    );
    await t.test(
      "zero, over-cap, self-funding, unauthorized buyer and duplicate IDs",
      async () => {
        for (const extra of [
          { amount: 0n },
          { amount: 100_000_001n },
          { provider: f.buyer },
          { providerOwner: f.buyer },
          { buyer: zeroAddress },
        ])
          await assert.rejects(f.fund(extra));
        const terms = await f.terms();
        await assert.rejects(f.call("fund", [terms], f.stranger));
        const { id, t: funded } = await f.fund();
        await assert.rejects(f.call("fund", [funded]));
        await f.advance(101);
        await f.call("refund", [id]);
        await f.invariant();
      },
    );
    await t.test(
      "reentrant token callback cannot fund recursively",
      async () => {
        const terms = await f.terms();
        await f.write(USDG, token.abi, "attack", [
          f.address,
          encodeFunctionData({
            abi: escrow.abi,
            functionName: "fund",
            args: [terms],
          }),
        ]);
        await f.call("fund", [terms]);
        assert.equal(
          await f.read.readContract({
            address: USDG,
            abi: token.abi,
            functionName: "attackBlocked",
          }),
          true,
        );
        await f.write(USDG, token.abi, "attack", [zeroAddress, "0x"]);
        await f.advance(101);
        await f.call("refund", [await f.get("invocationId", [terms])]);
        await f.invariant();
      },
    );
    await t.test(
      "paused funding fails; timeout refund remains possible",
      async () => {
        const { id } = await f.fund();
        await f.call("pause", [], f.admin);
        await assert.rejects(f.fund());
        await f.advance(101);
        await f.call("refund", [id]);
        await f.call("unpause", [], f.admin);
        await f.invariant();
      },
    );
    await t.test(
      "session expiry and onchain per-operation/day caps",
      async () => {
        const now = (await f.read.getBlock()).timestamp;
        await assert.rejects(f.call("fundWithSession", [await f.terms()]));
        await f.call("configureSpending", [
          true,
          now + 500n,
          6_000_000n,
          6_000_000n,
        ]);
        const terms = await f.terms();
        await f.call("fundWithSession", [terms]);
        await assert.rejects(f.call("fundWithSession", [await f.terms()]));
        await f.advance(501);
        await assert.rejects(f.call("fundWithSession", [await f.terms()]));
        await f.call("refund", [await f.get("invocationId", [terms])]);
        await f.invariant();
      },
    );
    await t.test(
      "seeded fuzz: 32 bounded amounts preserve unsettled obligations",
      async () => {
        let seed = 0x12345678;
        for (let i = 0; i < 32; i++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const { id } = await f.fund({
            amount: BigInt((seed % 100_000_000) + 1),
          });
          await f.invariant();
          await f.advance(101);
          await f.call("refund", [id]);
          await f.invariant();
        }
      },
    );
    await t.test(
      "canonical token is fixed; unsolicited donation is quarantined surplus",
      async () => {
        assert.equal((await f.get("USDG")).toLowerCase(), USDG.toLowerCase());
        assert.equal(
          escrow.abi.find((x) => x.name === "fund").inputs.length,
          1,
        );
        await f.write(USDG, token.abi, "transfer", [f.address, 1n]);
        const balance = await f.read.readContract({
          address: USDG,
          abi: token.abi,
          functionName: "balanceOf",
          args: [f.address],
        });
        assert.equal(balance, (await f.get("totalObligations")) + 1n);
      },
    );
  } finally {
    await f.rpc.disconnect();
  }
});
test("deployment rejects a different chain", async () => {
  const f = await fixture(1);
  try {
    await assert.rejects(f.deploy());
  } finally {
    await f.rpc.disconnect();
  }
});
