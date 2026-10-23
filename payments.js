import { config } from "./config.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function parseHexInt(hex) { return parseInt(hex, 16); }

function padAddress(addr) {
  return "0x" + addr.toLowerCase().replace("0x", "").padStart(64, "0");
}

async function rpcBase(method, params) {
  const res = await fetch(config.ALCHEMY_BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Base RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`Base RPC: ${json.error.message}`);
  return json.result;
}

async function getSolPrice() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    );
    const json = await res.json();
    return json?.solana?.usd || null;
  } catch {
    return null; // never guess a price — a stale $150 fallback mis-priced SOL payments
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rejects transactions older than PAYMENT_MAX_AGE_DAYS (or with no timestamp). Exported for tests. */
export function assertRecent(timeMs, now = Date.now()) {
  if (!timeMs) throw new Error("Could not read the transaction time");
  if (now - timeMs > config.PAYMENT_MAX_AGE_DAYS * DAY_MS) {
    throw new Error(`Transaction is older than ${config.PAYMENT_MAX_AGE_DAYS} days — send a new payment`);
  }
}

/**
 * Pure: USDC / SOL received by `owner` in a parsed Solana transaction, from pre/post balances.
 * Works for every transfer shape (transfer, transferChecked, ATA creation, inner instructions) because it
 * reads balances by OWNER rather than trusting instruction fields. Exported for tests.
 */
export function solanaReceived(tx, owner, usdcMint) {
  const meta = tx?.meta || {};
  const sumFor = (list) => (list || [])
    .filter((b) => b.owner === owner && b.mint === usdcMint)
    .reduce((s, b) => s + BigInt(b.uiTokenAmount?.amount || "0"), 0n);
  const usdcRaw = sumFor(meta.postTokenBalances) - sumFor(meta.preTokenBalances);
  const keys = tx?.transaction?.message?.accountKeys || [];
  const idx = keys.findIndex((k) => (typeof k === "string" ? k : k.pubkey) === owner);
  const lamports = idx >= 0 ? (meta.postBalances?.[idx] ?? 0) - (meta.preBalances?.[idx] ?? 0) : 0;
  const signer = keys.find((k) => typeof k === "object" && k.signer);
  return { usdcRaw: usdcRaw > 0n ? Number(usdcRaw) : 0, lamports: Math.max(0, lamports), from: signer ? signer.pubkey : (typeof keys[0] === "string" ? keys[0] : keys[0]?.pubkey) || null };
}

// ── Base USDC verification ─────────────────────────────────────────────────

/**
 * Verifies a Base USDC payment by tx hash.
 * Returns { valid, amountUsd, fromAddress } or throws.
 */
export async function verifyBaseUSDC(txHash) {
  if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new Error("Invalid transaction hash format");
  }

  const tx = await rpcBase("eth_getTransactionByHash", [txHash]);
  if (!tx) throw new Error("Transaction not found");

  // Must be confirmed (have a block number)
  if (!tx.blockNumber) throw new Error("Transaction not yet confirmed — try again in a moment");

  // Must be a USDC contract interaction
  if (tx.to?.toLowerCase() !== config.USDC_BASE.toLowerCase()) {
    throw new Error("Transaction is not a USDC transfer on Base");
  }

  // Must be sent to our receive address
  if (!config.BASE_RECEIVE_ADDR) throw new Error("BASE_RECEIVE_ADDR not configured");

  // Get the transfer log from the receipt
  const receipt = await rpcBase("eth_getTransactionReceipt", [txHash]);
  if (!receipt) throw new Error("Could not fetch transaction receipt");
  if (receipt.status !== "0x1") throw new Error("Transaction failed on-chain");

  // Replay guard: old transfers to the receive address can't be claimed by whoever finds them on-chain.
  const block = await rpcBase("eth_getBlockByNumber", [tx.blockNumber, false]);
  const blockTimeMs = block?.timestamp ? parseHexInt(block.timestamp) * 1000 : null;
  assertRecent(blockTimeMs);

  // Find the Transfer log to our address
  const receiveAddrPadded = padAddress(config.BASE_RECEIVE_ADDR);
  const transferLog = receipt.logs?.find(
    (log) =>
      log.address?.toLowerCase() === config.USDC_BASE.toLowerCase() &&
      log.topics?.[0] === config.TRANSFER_TOPIC &&
      log.topics?.[2]?.toLowerCase() === receiveAddrPadded.toLowerCase()
  );

  if (!transferLog) {
    throw new Error("No USDC transfer to our address found in this transaction");
  }

  // Decode amount from log data (uint256, 6 decimals)
  const rawAmount = parseHexInt(transferLog.data);
  const amountUsd = rawAmount / 1_000_000;

  if (rawAmount < config.MIN_USDC_RAW) {
    throw new Error(`Insufficient payment: received $${amountUsd.toFixed(2)}, minimum is $${config.PRICE_USD}`);
  }

  return {
    valid: true,
    amountUsd,
    fromAddress: tx.from?.toLowerCase(),
    chain: "base",
  };
}

// ── Solana verification ────────────────────────────────────────────────────

/**
 * Verifies a Solana payment (USDC or SOL) by tx signature.
 * Uses Helius API if key is set, otherwise public RPC.
 */
export async function verifySolanaPayment(txSignature) {
  if (!txSignature || txSignature.length < 40) {
    throw new Error("Invalid Solana transaction signature");
  }

  if (!config.SOLANA_RECEIVE_ADDR) throw new Error("SOLANA_RECEIVE_ADDR not configured");

  const rpcUrl = config.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`
    : "https://api.mainnet-beta.solana.com";

  // Fetch the transaction
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "getTransaction",
      params: [txSignature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
    }),
  });

  if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`Solana RPC: ${json.error.message}`);

  const tx = json.result;
  if (!tx) throw new Error("Transaction not found — it may still be processing");

  // Check it's confirmed
  if (!tx.slot) throw new Error("Transaction not yet confirmed");

  if (tx.meta?.err) throw new Error("Transaction failed on-chain");
  assertRecent(tx.blockTime ? tx.blockTime * 1000 : null);

  // The old version accepted ANY transferChecked of >= $9.50 USDC without checking the destination, so
  // any public USDC transfer signature unlocked a subscription. Balances by owner are authoritative.
  const got = solanaReceived(tx, config.SOLANA_RECEIVE_ADDR, config.USDC_SOLANA);
  if (got.usdcRaw > 0) {
    const amountUsd = got.usdcRaw / 1_000_000;
    if (got.usdcRaw < config.MIN_USDC_RAW) {
      throw new Error(`Insufficient USDC: received $${amountUsd.toFixed(2)}, minimum is $${config.PRICE_USD}`);
    }
    return { valid: true, amountUsd, chain: "solana_usdc", fromAddress: got.from };
  }
  if (got.lamports > 0) {
    const solPrice = await getSolPrice();
    if (!solPrice) throw new Error("Could not fetch the SOL price — try again in a minute");
    const amountUsd = (got.lamports / 1e9) * solPrice;
    if (amountUsd < config.MIN_SOL_USD) {
      throw new Error(`Insufficient SOL: received $${amountUsd.toFixed(2)}, minimum is $${config.PRICE_USD}`);
    }
    return { valid: true, amountUsd, chain: "solana_sol", fromAddress: got.from };
  }

  throw new Error("No valid payment to our address found in this transaction");
}
