import { readFileSync } from "fs";
import * as fs from "fs";
import path from "path";
import BitcoinCore from "bitcoin-core";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// ── Load regtest.json ───────────────────────────────────────────────────────────
interface RegtestConfig {
  network: "regtest" | "signet";
  host: string;
  port: number;
  username: string;
  password: string;
  wallet: string;
}

const cfgPath = path.join(__dirname, "configs", "regtest.json");
const rawCfg = readFileSync(cfgPath, "utf8");
const cfg: RegtestConfig = JSON.parse(rawCfg);

// ── Initialize base RPC client ─────────────────────────────────────────────────
const baseClient = new BitcoinCore({
  host: `http://${cfg.host}:${cfg.port}`,
  username: cfg.username,
  password: cfg.password,
});

// Helper to run any RPC command
async function rpc<T>(client: BitcoinCore, method: string, ...params: any[]): Promise<T> {
  return client.command(method, ...params) as Promise<T>;
}

async function loadOrCreateWallet(name: string): Promise<BitcoinCore> {
  try {
    const wallets = await rpc<string[]>(baseClient, "listwallets");
    if (wallets.includes(name)) {
      console.log(`Wallet "${name}" is already loaded.`);
    } else {
      try {
        await rpc(baseClient, "loadwallet", name);
        console.log(`Loaded existing wallet "${name}".`);
      } catch (loadError: any) {
        try {
          await rpc(baseClient, "createwallet", name, false);
          console.log(`Created new wallet "${name}".`);
        } catch (createError: any) {
          if (createError.code === -4 && createError.message.includes("Database already exists")) {
            await rpc(baseClient, "loadwallet", name);
            console.log(`Loaded existing wallet "${name}" after database conflict.`);
          } else {
            throw createError;
          }
        }
      }
    }
  } catch (error: any) {
    console.error(`Error managing wallet "${name}":`, error.message);
    throw error;
  }
  
  return new BitcoinCore({
    host: `http://${cfg.host}:${cfg.port}`,
    username: cfg.username,
    password: cfg.password,
    wallet: name,
  });
}

async function mine(client: BitcoinCore, blocks: number) {
  const addr = await rpc<string>(client, "getnewaddress");
  return rpc<string[]>(baseClient, "generatetoaddress", blocks, addr);
}

async function syncWallet(client: BitcoinCore) {
  // Get current blockchain height
  const blockchainInfo = await rpc<any>(baseClient, "getblockchaininfo");
  const currentHeight = blockchainInfo.blocks;
  
  // Wait for wallet to catch up
  let walletHeight = 0;
  let attempts = 0;
  const maxAttempts = 10;
  
  while (walletHeight < currentHeight && attempts < maxAttempts) {
    try {
      const walletInfo = await rpc<any>(client, "getwalletinfo");
      walletHeight = walletInfo.txcount > 0 ? walletInfo.last_processed_block : 0;
      
      if (walletHeight < currentHeight) {
        console.log(`⏳ Wallet syncing... (${walletHeight}/${currentHeight})`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (e) {
      console.log("Wallet info not available yet, waiting...");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    attempts++;
  }
  
  if (walletHeight < currentHeight) {
    console.log("⚠️ Wallet couldn't fully sync, forcing rescan");
    await rpc(client, "rescanblockchain");
  }
}

// ── Multisig Wallet Creation ──────────────────────────────────────────────────
async function createMultisigWallet(walletName: string): Promise<BitcoinCore> {
  const walletCl = await loadOrCreateWallet(walletName);
  
  // Mine initial blocks
  console.log(`⛏️ Mining initial blocks for ${walletName}...`);
  await mine(walletCl, 101);
  
  // Wait for wallet to detect mined coins
  await syncWallet(walletCl);
  
  // Mine more blocks to mature coins
  console.log("⏳ Waiting for coin maturation...");
  await mine(walletCl, 100);
  await syncWallet(walletCl);

  // Check balance
  const balance = await rpc<any>(walletCl, "getbalance");
  console.log("Balance check after mining...", balance);
  console.log(`💰 Wallet ${walletName} balance: ${balance} BTC`);
  
  if (balance < 50) {
    throw new Error(`Insufficient balance after mining: ${balance} BTC`);
  }
  
  return walletCl;
}

async function setupMultisig(walletCl: BitcoinCore, walletName: string) {
  // Generate signer keys
  const signerKeys = [];
  for (let i = 0; i < 3; i++) {
    const key = await rpc<string>(walletCl, "getnewaddress", "", "bech32");
    const pubkey = await rpc<any>(walletCl, "getaddressinfo", key).then(info => info.pubkey);
    signerKeys.push(pubkey);
  }

  // Create multisig address
  const multisigRes = await rpc<any>(walletCl, "createmultisig", 2, signerKeys);
  const multisigAddress = multisigRes.address;

  // Fund the multisig address
  console.log(`💸 Funding multisig with 10 BTC...`);
  await rpc<string>(walletCl, "sendtoaddress", multisigAddress, 10);
  await mine(walletCl, 1);
  await syncWallet(walletCl);

  return { multisigAddress, signerKeys };
}

async function saveCaravanConfig(walletName: string, signerKeys: string[]) {
  const caravanConfig = {
    name: `${walletName} Multisig`,
    addressType: "P2WSH",
    network: "regtest",
    quorum: {
      requiredSigners: 2,
      totalSigners: 3
    },
    extendedPublicKeys: signerKeys.map((pubkey, i) => ({
      name: `Signer ${i+1}`,
      xpub: pubkey,
      bip32Path: "m/84'/0'/0'",
      xfp: "00000000",
      method: "text"
    })),
    startingAddressIndex: 0
  };

  const configPath = path.join(__dirname, `${walletName}_caravan.json`);
  fs.writeFileSync(configPath, JSON.stringify(caravanConfig, null, 2));
  console.log(`💾 Caravan config saved to ${configPath}`);
  return configPath;
}

// ── Scenario Implementations ──────────────────────────────────────────────────

/** 1) Waste‑heavy: 100 tiny UTXOs */
async function wasteHeavy() {
  const walletName = "waste_heavy";
  console.log(`🏁 Starting ${walletName} scenario`);
  
  const walletCl = await createMultisigWallet(walletName);
  const { signerKeys } = await setupMultisig(walletCl, walletName);
  
  // Generate 100 small UTXOs
  console.log("🧩 Creating 100 small UTXOs...");
  const target = await rpc<string>(walletCl, "getnewaddress");
  for (let i = 0; i < 100; i++) {
    await rpc<string>(walletCl, "sendtoaddress", target, 0.0001);
    if ((i + 1) % 10 === 0) console.log(`   Created ${i + 1}/100 UTXOs`);
  }
  
  await mine(walletCl, 1);
  await syncWallet(walletCl);
  
  await saveCaravanConfig(walletName, signerKeys);
  console.log("🧨 waste-heavy multisig created");
}

/** 2) Privacy‑good: no reuse, no mixing */
async function privacyGood() {
  const walletName = "receiver_wallet1";
  console.log(`🏁 Starting ${walletName} scenario`);
  
  const walletCl = await createMultisigWallet(walletName);
  const { signerKeys } = await setupMultisig(walletCl, walletName);
  
  // Create 10 clean transactions
  console.log("✨ Creating 10 clean transactions...");
  for (let i = 0; i < 10; i++) {
    const addr = await rpc<string>(walletCl, "getnewaddress");
    await rpc<string>(walletCl, "sendtoaddress", addr, 1.0);
    await mine(walletCl, 1);
    await syncWallet(walletCl);
    console.log(`   Transaction ${i + 1}/10 confirmed`);
  }
  
  await saveCaravanConfig(walletName, signerKeys);
  console.log("✅ privacy-good multisig created");
}

/** 3) Privacy‑moderate: some mixing but no reuse */
async function privacyModerate() {
  const walletName = "privacy_moderate_multisig";
  console.log(`🏁 Starting ${walletName} scenario`);
  
  const walletCl = await createMultisigWallet(walletName);
  const { signerKeys } = await setupMultisig(walletCl, walletName);
  
  // Create transactions to single address
  console.log("🔄 Creating transactions for mixing...");
  const target = await rpc<string>(walletCl, "getnewaddress");
  for (let i = 0; i < 5; i++) {
    await rpc<string>(walletCl, "sendtoaddress", target, 2.0);
    console.log(`   Sent 2.0 BTC to mix address (${i + 1}/5)`);
  }
  
  await mine(walletCl, 1);
  await syncWallet(walletCl);

  // Mix UTXOs
  console.log("🔀 Mixing UTXOs...");
  const utxos = await rpc<any[]>(walletCl, "listunspent", 1);
  if (utxos.length === 0) {
    console.warn("No UTXOs found for mixing");
    return;
  }
  
  console.log(`   Found ${utxos.length} UTXOs to mix`);
  const inputs = utxos.map(u => ({ txid: u.txid, vout: u.vout }));
  const mixAddr = await rpc<string>(walletCl, "getnewaddress");
  const total = utxos.reduce((sum, u) => sum + u.amount, 0);
  const outputAmount = Number((total - 0.0001).toFixed(8));
  
  if (outputAmount <= 0) {
    console.warn("Not enough funds for mixing after fees");
    return;
  }
  
  const raw = await rpc<string>(walletCl, "createrawtransaction", inputs, { [mixAddr]: outputAmount });
  const signed = await rpc<any>(walletCl, "signrawtransactionwithwallet", raw);
  await rpc<string>(walletCl, "sendrawtransaction", signed.hex);
  
  await mine(walletCl, 1);
  await syncWallet(walletCl);

  await saveCaravanConfig(walletName, signerKeys);
  console.log("🤝 privacy-moderate multisig created");
}

/** 4) Privacy‑bad: mixing + address reuse */
async function privacyBad() {
  const walletName = "privacy_bad_multisig";
  console.log(`🏁 Starting ${walletName} scenario`);
  
  const walletCl = await createMultisigWallet(walletName);
  const { signerKeys } = await setupMultisig(walletCl, walletName);
  
  // Reuse same address multiple times
  console.log("♻️ Reusing address for multiple transactions...");
  const reused = await rpc<string>(walletCl, "getnewaddress");
  for (let i = 0; i < 5; i++) {
    await rpc<string>(walletCl, "sendtoaddress", reused, 2.0);
    console.log(`   Sent 2.0 BTC to reused address (${i + 1}/5)`);
  }
  
  await mine(walletCl, 1);
  await syncWallet(walletCl);

  // Mix UTXOs
  console.log("🔀 Mixing UTXOs with reused address...");
  const utxos = await rpc<any[]>(walletCl, "listunspent", 1);
  if (utxos.length === 0) {
    console.warn("No UTXOs found for mixing");
    return;
  }
  
  console.log(`   Found ${utxos.length} UTXOs to mix`);
  const inputs = utxos.map(u => ({ txid: u.txid, vout: u.vout }));
  const mixAddr = await rpc<string>(walletCl, "getnewaddress");
  const total = utxos.reduce((sum, u) => sum + u.amount, 0);
  const outputAmount = Number((total - 0.0001).toFixed(8));
  
  if (outputAmount <= 0) {
    console.warn("Not enough funds for mixing after fees");
    return;
  }
  
  const raw = await rpc<string>(walletCl, "createrawtransaction", inputs, { [mixAddr]: outputAmount });
  const signed = await rpc<any>(walletCl, "signrawtransactionwithwallet", raw);
  await rpc<string>(walletCl, "sendrawtransaction", signed.hex);
  
  await mine(walletCl, 1);
  await syncWallet(walletCl);

  await saveCaravanConfig(walletName, signerKeys);
  console.log("🔓 privacy-bad multisig created");
}

// Update CLI options
const argv = yargs(hideBin(process.argv))
  .option("scenario", {
    alias: "s",
    choices: [
      "waste-heavy", 
      "privacy-good", 
      "privacy-moderate", 
      "privacy-bad", 
      "all"
    ] as const,
    default: "all",
    describe: "Which multisig wallet scenario to create",
  })
  .argv;

// Scenario runner
(async () => {
  try {
    const resolvedArgv = await argv;
    
    if (resolvedArgv.scenario === "waste-heavy" || resolvedArgv.scenario === "all") await wasteHeavy();
    if (resolvedArgv.scenario === "privacy-good"  || resolvedArgv.scenario === "all") await privacyGood();
    if (resolvedArgv.scenario === "privacy-moderate" || resolvedArgv.scenario === "all") await privacyModerate();
    if (resolvedArgv.scenario === "privacy-bad"  || resolvedArgv.scenario === "all") await privacyBad();

    console.log(
      "🎉 Multisig wallets created. Connect Caravan to:",
      `${cfg.network}@${cfg.host}:${cfg.port}`
    );
  } catch (err) {
    console.error("⚠️ Critical Error:", err);
    process.exit(1);
  }
})();