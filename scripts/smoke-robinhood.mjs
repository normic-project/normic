import { RobinhoodMarketDataProvider } from "@normic/markets";
import { RobinhoodChainProvider, ROBINHOOD_MAINNET } from "@normic/chains";
const provider = new RobinhoodMarketDataProvider({ enabled: true });
const assets = await provider.listStockTokens();
if (assets.state === "unavailable" || !assets.data?.length)
  throw new Error(
    `Robinhood assets smoke failed: ${assets.error ?? "empty response"}`,
  );
const active =
  assets.data.find((asset) => asset.status.toLowerCase().includes("active")) ??
  assets.data[0];
const price = await provider.getStockPrice(active.tokenSymbol);
if (!price.data || price.state === "unavailable")
  throw new Error(
    `Robinhood price smoke failed for ${active.tokenSymbol}: ${price.error}`,
  );
const actions = await provider.listCorporateActions();
if (!actions.data)
  throw new Error(`Robinhood corporate action smoke failed: ${actions.error}`);
const chain = new RobinhoodChainProvider(
  true,
  process.env.ROBINHOOD_RPC_URL || ROBINHOOD_MAINNET.publicRpcUrl,
);
const height = await chain.getBlockNumber();
const block = await chain.getBlock(height.data);
if (!block.data) throw new Error("Robinhood mainnet block is unavailable.");
const deployment = active.deployments.find(
  (item) => Number(item.chainId) === 4663,
);
if (
  !deployment ||
  (await chain.getCode(deployment.contractAddress)).data === "0x"
)
  throw new Error(
    "The Stock Token contract could not be validated on mainnet.",
  );
const transactionHash = Array.isArray(block.data.transactions)
  ? block.data.transactions[0]
  : undefined;
if (
  typeof transactionHash === "string" &&
  !(await chain.getTransaction(transactionHash)).data
)
  throw new Error("Mainnet transaction read failed.");
console.log(
  `Robinhood mainnet read-only smoke passed: ${assets.data.length} assets, ${active.tokenSymbol} price ${price.state}, ${actions.data.length} corporate actions, block ${height.data}, and deployed contract bytecode. No transaction was broadcast.`,
);
