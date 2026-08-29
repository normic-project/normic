import { CANONICAL_USDG } from "@normic/core";
import { RobinhoodFinancialChain } from "@normic/payments";
// Read-only verification. Public mainnet RPC is explicitly local diagnostics only.
const chain = new RobinhoodFinancialChain({
  ...process.env,
  ROBINHOOD_RPC_URL:
    process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
  NODE_ENV: "development",
});
try {
  const token = await chain.validateToken();
  const balances = await chain.balances(CANONICAL_USDG);
  console.log(
    JSON.stringify(
      {
        status: "PASS",
        purpose:
          "Read-only canonical token validation; balance probe targets the token contract, not a Normic company wallet.",
        token,
        balances,
        mainnetWrites: 0,
      },
      null,
      2,
    ),
  );
} catch {
  console.error(
    "Canonical USDG mainnet read verification unavailable. No balances fabricated.",
  );
  process.exitCode = 1;
}
