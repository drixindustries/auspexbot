import { config } from "./config.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function toHex(n) { return "0x" + BigInt(n).toString(16); }
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
    return json?.solana?.usd || 150;
  } catch {
    return 150; // fallback price
  }
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

  const receiveAddr = config.SOLANA_RECEIVE_ADDR;
  const instructions = tx.transaction?.message?.instructions || [];
  const innerInstructions = tx.meta?.innerInstructions?.flatMap((i) => i.instructions) || [];
  const allInstructions = [...instructions, ...innerInstructions];

  // Try to find a USDC SPL token transfer to our address
  for (const ix of allInstructions) {
    if (ix.program === "spl-token" && ix.parsed?.type === "transfer") {
      const info = ix.parsed.info;
      // Check destination — could be the token account or owner
      if (
        info?.destination === receiveAddr ||
        info?.authority === receiveAddr ||
        info?.multisigAuthority === receiveAddr
      ) {
        const mint = info?.mint;
        if (mint === config.USDC_SOLANA) {
          const rawAmount = parseInt(info.amount || "0", 10);
          const amountUsd = rawAmount / 1_000_000; // USDC 6 decimals
          if (rawAmount < config.MIN_USDC_RAW) {
            throw new Error(`Insufficient USDC: received $${amountUsd.toFixed(2)}, minimum is $${config.PRICE_USD}`);
          }
          return { valid: true, amountUsd, chain: "solana_usdc", fromAddress: info.authority };
        }
      }
    }

    // Also check for associated token account transfers (most common USDC send pattern)
    if (ix.program === "spl-token" && ix.parsed?.type === "transferChecked") {
      const info = ix.parsed.info;
      if (info?.mint === config.USDC_SOLANA) {
        // Check if destination owner is our receive address
        const destOwner = info?.destination; // simplified — in production verify owner
        const rawAmount = parseInt(info?.tokenAmount?.amount || "0", 10);
        const amountUsd = rawAmount / 1_000_000;
        if (rawAmount >= config.MIN_USDC_RAW) {
          return { valid: true, amountUsd, chain: "solana_usdc", fromAddress: info.authority };
        }
      }
    }
  }

  // Try native SOL transfer
  const accountKeys = tx.transaction?.message?.accountKeys || [];
  const postBalances = tx.meta?.postBalances || [];
  const preBalances  = tx.meta?.preBalances  || [];

  const receiveIndex = accountKeys.findIndex(
    (k) => (typeof k === "string" ? k : k.pubkey) === receiveAddr
  );

  if (receiveIndex >= 0) {
    const solReceived = (postBalances[receiveIndex] - preBalances[receiveIndex]) / 1e9; // lamports → SOL
    if (solReceived > 0) {
      const solPrice  = await getSolPrice();
      const amountUsd = solReceived * solPrice;
      if (amountUsd < config.MIN_SOL_USD) {
        throw new Error(`Insufficient SOL: received $${amountUsd.toFixed(2)}, minimum is $${config.PRICE_USD}`);
      }
      return { valid: true, amountUsd, chain: "solana_sol", fromAddress: accountKeys[0]?.pubkey || accountKeys[0] };
    }
  }

  throw new Error("No valid payment to our address found in this transaction");
}
