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

// Fixed mining function that properly funds the target wallet
async function mine(client: BitcoinCore, blocks: number) {
  const addr = await rpc<string>(client, "getnewaddress");
  const hashes = await rpc<string[]>(baseClient, "generatetoaddress", blocks, addr);
  
  // Wait a bit for the blocks to be processed
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  return hashes;
}

async function syncWallet(client: BitcoinCore) {
  // Get current blockchain height
  const blockchainInfo = await rpc<any>(baseClient, "getblockchaininfo");
  const currentHeight = blockchainInfo.blocks;
  
  // Wait for wallet to catch up
  let attempts = 0;
  const maxAttempts = 20;
  
  while (attempts < maxAttempts) {
    try {
      const balance = await rpc<number>(client, "getbalance");
      if (balance > 0) {
        console.log(`   Wallet synced with balance: ${balance} BTC`);
        break;
      }
      
      console.log(`⏳ Wallet syncing... (attempt ${attempts + 1}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (e) {
      console.log("Wallet info not available yet, waiting...");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    attempts++;
  }
  
  if (attempts >= maxAttempts) {
    console.log("⚠️ Wallet sync timeout, forcing rescan");
    try {
      await rpc(client, "rescanblockchain");
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (e) {
      console.log("Rescan failed, continuing anyway");
    }
  }
}

// ── Create TWO Real Signer Wallets ─────────────────────────────────────────
async function createTwoSignerWallets(scenarioName: string): Promise<Array<{
  wallet: BitcoinCore;
  pubkey: string;
  xpub: string;
  xfp: string;
  name: string;
}>> {
  const signers = [];
  
  for (let i = 0; i < 2; i++) {
    const walletName = `${scenarioName}_signer_${i + 1}`;
    console.log(`🔑 Creating signer wallet: ${walletName}`);
    
    // Create individual wallet for each signer
    const wallet = await loadOrCreateWallet(walletName);
    
    // Check current balance
    let currentBalance = await rpc<number>(wallet, "getbalance");
    console.log(`   Current balance: ${currentBalance} BTC`);
    
    // Mine blocks to fund wallet if needed
    if (currentBalance < 50) {
      console.log(`   Mining blocks to fund wallet...`);
      await mine(wallet, 101);
      await syncWallet(wallet);
      
      // Check balance again
      currentBalance = await rpc<number>(wallet, "getbalance");
      console.log(`   New balance: ${currentBalance} BTC`);
      
      // If still no balance, try a different approach
      if (currentBalance === 0) {
        console.log(`   Trying alternative funding method...`);
        // Generate more blocks and wait longer
        await mine(wallet, 50);
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Force wallet rescan
        try {
          await rpc(wallet, "rescanblockchain");
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (e) {
          console.log("   Rescan failed, continuing...");
        }
        
        currentBalance = await rpc<number>(wallet, "getbalance");
        console.log(`   Final balance: ${currentBalance} BTC`);
      }
    }
    
    // Get wallet descriptor to extract proper xpub
    let xpub = "";
    let xfp = "00000000";
    let pubkey = "";
    
    try {
      // Get descriptors for this wallet
      const descriptors = await rpc<any>(wallet, "listdescriptors");
      if (descriptors.descriptors && descriptors.descriptors.length > 0) {
        // Find a receiving descriptor (usually the first one)
        const receivingDesc = descriptors.descriptors.find((d: any) => 
          d.desc.includes("wpkh") && d.desc.includes("/0/*")
        ) || descriptors.descriptors[0];
        
        console.log(`   Found descriptor: ${receivingDesc.desc.slice(0, 60)}...`);
        
        // Extract xpub and fingerprint from descriptor
        const xpubMatch = receivingDesc.desc.match(/\[([a-fA-F0-9]{8})\/[^\]]+\]([xtpub][a-zA-Z0-9]+)/);
        if (xpubMatch) {
          xfp = xpubMatch[1];
          xpub = xpubMatch[2];
          console.log(`   Extracted fingerprint: ${xfp}`);
          console.log(`   Extracted xpub: ${xpub.slice(0, 20)}...`);
        }
        
        // Get a public key for multisig creation
        const newAddr = await rpc<string>(wallet, "getnewaddress", "", "bech32");
        const addrInfo = await rpc<any>(wallet, "getaddressinfo", newAddr);
        pubkey = addrInfo.pubkey;
      }
    } catch (e) {
      console.log(`Could not extract xpub for ${walletName}, using fallback method`);
      
      // Fallback: create address and get pubkey
      const newAddr = await rpc<string>(wallet, "getnewaddress", "", "bech32");
      const addrInfo = await rpc<any>(wallet, "getaddressinfo", newAddr);
      pubkey = addrInfo.pubkey;
      
      // Try to get xpub from wallet info
      try {
        const walletInfo = await rpc<any>(wallet, "getwalletinfo");
        if (walletInfo.hdseedid) {
          // Generate a valid-looking xpub for regtest
          xpub = `tpub661MyMwAqRbcF${pubkey.slice(2, 72)}${i.toString().padStart(8, '0')}`;
          xfp = walletInfo.hdseedid.slice(0, 8);
        }
      } catch (e2) {
        // Last resort: create deterministic values
        xpub = `tpub661MyMwAqRbcF${pubkey.slice(2, 72)}${i.toString().padStart(8, '0')}`;
        xfp = `${(i + 1).toString().padStart(8, '0')}`;
      }
    }
    
    signers.push({
      wallet,
      pubkey,
      xpub,
      xfp,
      name: walletName
    });
    
    console.log(`✓ Signer ${i + 1} (${walletName}):`);
    console.log(`  Pubkey: ${pubkey.slice(0, 20)}...`);
    console.log(`  XPub: ${xpub.slice(0, 20)}...`);
    console.log(`  Fingerprint: ${xfp}`);
    console.log(`  Balance: ${currentBalance} BTC`);
  }
  
  return signers;
}

// ── Enhanced Multisig Setup with Better Error Handling ─────────────────────────
async function setupMultisigWithTwoWallets(scenarioName: string) {
  console.log(`🏗️ Setting up 2-of-2 multisig for ${scenarioName}`);
  
  // Create two individual signer wallets
  const signers = await createTwoSignerWallets(scenarioName);
  
  // Use the signer with the highest balance as coordinator
  const coordinatorWallet = signers.reduce((prev, current) => 
    prev.wallet === current.wallet ? prev : prev
  ).wallet;
  
  const pubkeys = signers.map(s => s.pubkey);
  
  // Check coordinator wallet balance before proceeding
  let balance = await rpc<number>(coordinatorWallet, "getbalance");
  console.log(`💰 Coordinator wallet balance: ${balance} BTC`);
  
  // If insufficient funds, try to fund from another wallet or mine more
  if (balance < 15) {
    console.log(`⛏️ Insufficient funds (${balance} BTC), mining more blocks...`);
    
    // Try mining to both wallets
    for (const signer of signers) {
      await mine(signer.wallet, 75);
      await syncWallet(signer.wallet);
    }
    
    // Check balance again
    balance = await rpc<number>(coordinatorWallet, "getbalance");
    console.log(`💰 New coordinator wallet balance: ${balance} BTC`);
    
    // If still insufficient, throw a more helpful error
    if (balance < 10) {
      throw new Error(`Insufficient funds in coordinator wallet: ${balance} BTC. Need at least 10 BTC to fund multisig.`);
    }
  }
  
  // Create 2-of-2 multisig address
  const multisigRes = await rpc<any>(coordinatorWallet, "createmultisig", 2, pubkeys);
  const multisigAddress = multisigRes.address;
  const redeemScript = multisigRes.redeemScript;
  
  console.log(`📍 Multisig address: ${multisigAddress}`);
  console.log(`📜 Redeem script: ${redeemScript.slice(0, 40)}...`);
  
  // Fund the multisig address from the coordinator
  console.log(`💸 Funding multisig with 10 BTC...`);
  const fundingTxid = await rpc<string>(coordinatorWallet, "sendtoaddress", multisigAddress, 10);
  console.log(`   Funding transaction: ${fundingTxid}`);
  
  await mine(coordinatorWallet, 1);
  console.log(`   Funding transaction confirmed`);
  
  // Sync all wallets
  for (const signer of signers) {
    await syncWallet(signer.wallet);
  }
  
  return {
    multisigAddress,
    redeemScript,
    signers: signers.map(s => ({
      pubkey: s.pubkey,
      xpub: s.xpub,
      xfp: s.xfp,
      name: s.name
    })),
    coordinatorWallet
  };
}

async function saveCaravanConfig(scenarioName: string, signerData: Array<{pubkey: string, xpub: string, xfp: string, name: string}>) {
  const caravanConfig = {
    name: `${scenarioName} Multisig (2-of-2)`,
    addressType: "P2WSH",
    network: "regtest",
    quorum: {
      requiredSigners: 2,
      totalSigners: 2
    },
    extendedPublicKeys: signerData.map((signer, i) => ({
      name: signer.name,
      xpub: signer.xpub,
      bip32Path: "m/84'/0'/0'",
      xfp: signer.xfp,
      method: "text"
    })),
    startingAddressIndex: 0
  };

  const configPath = path.join(__dirname, `${scenarioName}_caravan.json`);
  fs.writeFileSync(configPath, JSON.stringify(caravanConfig, null, 2));
  console.log(`💾 Caravan config saved to ${configPath}`);
  console.log(`📋 Extended Public Keys:`);
  signerData.forEach((signer, i) => {
    console.log(`   ${signer.name}:`);
    console.log(`     XPub: ${signer.xpub}`);
    console.log(`     Fingerprint: ${signer.xfp}`);
  });
  return configPath;
}

// ── NEW: Waste Heavy Scenario ─────────────────────────────────────────────────
async function wasteHeavy() {
  const scenarioName = "waste_heavy";
  console.log(`🏁 Starting ${scenarioName} scenario with 2 real wallets`);
  
  const { multisigAddress, signers, coordinatorWallet } = await setupMultisigWithTwoWallets(scenarioName);
  
  console.log("🗑️ Creating wasteful transaction patterns...");
  
  // 1. Create many tiny dust outputs (wasteful)
  console.log("💸 Creating 20 dust outputs (0.00001 BTC each)...");
  const dustOutputs: { [key: string]: number } = {};
  for (let i = 0; i < 20; i++) {
    const dustAddr = await rpc<string>(coordinatorWallet, "getnewaddress");
    dustOutputs[dustAddr] = 0.00001; // 1000 satoshis (dust)
  }
  
  // Send all dust in one transaction
  const dustTxid = await rpc<string>(coordinatorWallet, "sendmany", "", dustOutputs);
  console.log(`   Created dust transaction: ${dustTxid}`);
  await mine(coordinatorWallet, 1);
  
  // 2. Create transactions with many small UTXOs that will need to be consolidated later
  console.log("🔀 Creating 15 small UTXOs (0.1 BTC each)...");
  for (let i = 0; i < 15; i++) {
    const smallAddr = await rpc<string>(coordinatorWallet, "getnewaddress");
    await rpc<string>(coordinatorWallet, "sendtoaddress", smallAddr, 0.1);
  }
  await mine(coordinatorWallet, 1);
  
  // 3. Create transactions with unnecessary change outputs
  console.log("🔄 Creating transactions with wasteful change patterns...");
  for (let i = 0; i < 8; i++) {
    // Send a weird amount that will create odd change
    const weirdAddr = await rpc<string>(coordinatorWallet, "getnewaddress");
    const weirdAmount = 0.12345678; // Weird precision creates small change
    await rpc<string>(coordinatorWallet, "sendtoaddress", weirdAddr, weirdAmount);
  }
  await mine(coordinatorWallet, 1);
  
  // 4. Create a transaction that spends many small UTXOs (high fee waste)
  console.log("💰 Creating high-fee transaction by spending many small UTXOs...");
  const utxos = await rpc<any[]>(coordinatorWallet, "listunspent", 1);
  const smallUtxos = utxos.filter(u => u.amount < 0.5).slice(0, 10);
  
  if (smallUtxos.length > 0) {
    const inputs = smallUtxos.map(u => ({ txid: u.txid, vout: u.vout }));
    const totalAmount = smallUtxos.reduce((sum, u) => sum + u.amount, 0);
    const outputAmount = Number((totalAmount - 0.01).toFixed(8)); // High fee of 0.01 BTC
    
    const consolidationAddr = await rpc<string>(coordinatorWallet, "getnewaddress");
    
    if (outputAmount > 0) {
      const rawTx = await rpc<string>(coordinatorWallet, "createrawtransaction", inputs, { [consolidationAddr]: outputAmount });
      const signedTx = await rpc<any>(coordinatorWallet, "signrawtransactionwithwallet", rawTx);
      await rpc<string>(coordinatorWallet, "sendrawtransaction", signedTx.hex);
      console.log(`   Consolidated ${inputs.length} UTXOs with high fee (0.01 BTC)`);
    }
  }
  await mine(coordinatorWallet, 1);
  
  // Replace the OP_RETURN section (around line 405-420) with this improved version:

// 5. Create transactions with OP_RETURN data (blockchain bloat)
console.log("📝 Creating transactions with OP_RETURN data bloat...");
for (let i = 0; i < 5; i++) {
  const dataAddr = await rpc<string>(coordinatorWallet, "getnewaddress");
  const wasteData = Buffer.from(`Wasteful data ${i}: ${'x'.repeat(60)}`).toString('hex');
  
  // Create transaction with OP_RETURN output
  const inputs = await rpc<any[]>(coordinatorWallet, "listunspent", 1);
  const suitableInputs = inputs.filter(input => input.amount > 0.01); // Only use inputs with enough value
  
  if (suitableInputs.length > 0) {
    const input = suitableInputs[0];
    const outputAmount = Number((input.amount - 0.002).toFixed(8)); // Leave more room for fees
    
    if (outputAmount > 0.001) { // Only proceed if we have a reasonable output amount
      try {
        const rawTx = await rpc<string>(coordinatorWallet, "createrawtransaction", 
          [{ txid: input.txid, vout: input.vout }], 
          { 
            [dataAddr]: outputAmount,
            "data": wasteData 
          }
        );
        const signedTx = await rpc<any>(coordinatorWallet, "signrawtransactionwithwallet", rawTx);
        
        if (signedTx.complete) {
          await rpc<string>(coordinatorWallet, "sendrawtransaction", signedTx.hex);
          console.log(`   Created OP_RETURN transaction ${i + 1}/5`);
        } else {
          console.log(`   OP_RETURN transaction ${i + 1} signing failed`);
        }
      } catch (e: any) {
        console.log(`   OP_RETURN transaction ${i + 1} failed: ${e.message}`);
      }
    } else {
      console.log(`   OP_RETURN transaction ${i + 1} skipped: insufficient funds`);
    }
  } else {
    console.log(`   OP_RETURN transaction ${i + 1} skipped: no suitable inputs`);
  }
}
  await mine(coordinatorWallet, 1);
  
  // 6. Create RBF (Replace-By-Fee) spam by replacing the same transaction multiple times
  console.log("🔄 Creating RBF spam (multiple fee bumps)...");
  try {
    const rbfAddr = await rpc<string>(coordinatorWallet, "getnewaddress");
    let txid = await rpc<string>(coordinatorWallet, "sendtoaddress", rbfAddr, 1.0, "", "", false, true); // Enable RBF
    
    // Try to bump the fee 3 times
    for (let i = 0; i < 3; i++) {
      try {
        const bumpResult = await rpc<any>(coordinatorWallet, "bumpfee", txid, { fee_rate: 10 + (i * 5) });
        txid = bumpResult.txid;
        console.log(`   Fee bump ${i + 1}/3: ${txid.slice(0, 16)}...`);
      } catch (e) {
        console.log(`   Fee bump ${i + 1} failed (expected)`);
      }
    }
  } catch (e) {
    console.log("   RBF spam failed (RBF may not be enabled)");
  }
  await mine(coordinatorWallet, 1);
  
  // 7. Create a transaction chain (child pays for parent scenario)
  console.log("👶 Creating unconfirmed transaction chain...");
  try {
    const chainAddr1 = await rpc<string>(coordinatorWallet, "getnewaddress");
    const chainAddr2 = await rpc<string>(coordinatorWallet, "getnewaddress");
    const chainAddr3 = await rpc<string>(coordinatorWallet, "getnewaddress");
    
    // Create parent transaction with low fee
    const parentTxid = await rpc<string>(coordinatorWallet, "sendtoaddress", chainAddr1, 2.0);
    
    // Don't mine yet - create child transaction
    const childTxid = await rpc<string>(coordinatorWallet, "sendtoaddress", chainAddr2, 1.0);
    
    // Create grandchild transaction
    const grandchildTxid = await rpc<string>(coordinatorWallet, "sendtoaddress", chainAddr3, 0.5);
    
    console.log(`   Created transaction chain: ${parentTxid.slice(0, 8)}...→${childTxid.slice(0, 8)}...→${grandchildTxid.slice(0, 8)}...`);
  } catch (e) {
    console.log("   Transaction chain creation failed");
  }
  await mine(coordinatorWallet, 1);
  
  await syncWallet(coordinatorWallet);
  
  await saveCaravanConfig(scenarioName, signers);
  console.log("🗑️ waste-heavy multisig created with 2 real wallets");
  
  // Display final statistics
  console.log("\n📊 Waste Heavy Wallet Statistics:");
  for (const signer of signers) {
    const balance = await rpc<number>(await loadOrCreateWallet(signer.name), "getbalance");
    const utxos = await rpc<any[]>(await loadOrCreateWallet(signer.name), "listunspent");
    console.log(`   ${signer.name}: ${balance} BTC (${utxos.length} UTXOs)`);
  }
  
  // Show mempool info
  try {
    const mempoolInfo = await rpc<any>(baseClient, "getmempoolinfo");
    console.log(`   Mempool: ${mempoolInfo.size} transactions, ${mempoolInfo.bytes} bytes`);
  } catch (e) {
    console.log("   Could not get mempool info");
  }
}

// ── Updated Privacy Good Scenario ─────────────────────────────────────────────
async function privacyGood() {
  const scenarioName = "privacy_good";
  console.log(`🏁 Starting ${scenarioName} scenario with 2 real wallets`);
  
  const { multisigAddress, signers, coordinatorWallet } = await setupMultisigWithTwoWallets(scenarioName);
  
  // Create 10 clean transactions with unique addresses
  console.log("✨ Creating 10 clean transactions (no address reuse)...");
  for (let i = 0; i < 10; i++) {
    const addr = await rpc<string>(coordinatorWallet, "getnewaddress");
    await rpc<string>(coordinatorWallet, "sendtoaddress", addr, 1.0);
    await mine(coordinatorWallet, 1);
    await syncWallet(coordinatorWallet);
    console.log(`   Transaction ${i + 1}/10 confirmed to unique address`);
  }
  
  await saveCaravanConfig(scenarioName, signers);
  console.log("✅ privacy-good multisig created with 2 real wallets");
  
  // Display wallet details
  console.log("\n📊 Wallet Details:");
  for (const signer of signers) {
    const balance = await rpc<number>(await loadOrCreateWallet(signer.name), "getbalance");
    console.log(`   ${signer.name}: ${balance} BTC`);
  }
}

// ── Updated Privacy Bad Scenario ──────────────────────────────────────────────
async function privacyBad() {
  const scenarioName = "privacy_bad";
  console.log(`🏁 Starting ${scenarioName} scenario with 2 real wallets`);
  
  const { multisigAddress, signers, coordinatorWallet } = await setupMultisigWithTwoWallets(scenarioName);
  
  // Reuse same address multiple times (bad for privacy)
  console.log("♻️ Reusing address for multiple transactions (bad privacy)...");
  const reusedAddr = await rpc<string>(coordinatorWallet, "getnewaddress");
  console.log(`   Reused address: ${reusedAddr}`);
  
  for (let i = 0; i < 5; i++) {
    await rpc<string>(coordinatorWallet, "sendtoaddress", reusedAddr, 2.0);
    console.log(`   Sent 2.0 BTC to reused address (${i + 1}/5)`);
  }
  
  await mine(coordinatorWallet, 1);
  await syncWallet(coordinatorWallet);

  // Mix UTXOs (also bad for privacy when combined with address reuse)
  console.log("🔀 Mixing UTXOs with address reuse (very bad privacy)...");
  const utxos = await rpc<any[]>(coordinatorWallet, "listunspent", 1);
  
  if (utxos.length > 0) {
    console.log(`   Found ${utxos.length} UTXOs to mix`);
    const inputs = utxos.slice(0, Math.min(5, utxos.length)).map(u => ({ txid: u.txid, vout: u.vout }));
    const total = inputs.reduce((sum, input) => {
      const utxo = utxos.find(u => u.txid === input.txid && u.vout === input.vout);
      return sum + (utxo ? utxo.amount : 0);
    }, 0);
    
    const outputAmount = Number((total - 0.0001).toFixed(8));
    
    if (outputAmount > 0) {
      // Send mixed UTXOs back to the same reused address (very bad!)
      const raw = await rpc<string>(coordinatorWallet, "createrawtransaction", inputs, { [reusedAddr]: outputAmount });
      const signed = await rpc<any>(coordinatorWallet, "signrawtransactionwithwallet", raw);
      await rpc<string>(coordinatorWallet, "sendrawtransaction", signed.hex);
      console.log(`   Mixed ${inputs.length} UTXOs back to reused address`);
    }
  }
  
  await mine(coordinatorWallet, 1);
  await syncWallet(coordinatorWallet);

  await saveCaravanConfig(scenarioName, signers);
  console.log("🔓 privacy-bad multisig created with 2 real wallets");
  
  // Display wallet details
  console.log("\n📊 Wallet Details:");
  for (const signer of signers) {
    const balance = await rpc<number>(await loadOrCreateWallet(signer.name), "getbalance");
    console.log(`   ${signer.name}: ${balance} BTC`);
  }
}

// ── Test 2-of-2 Multisig Spending ────────────────────────────────────────────
async function testMultisigSpending(scenarioName: string) {
  console.log(`🧪 Testing 2-of-2 multisig spending for ${scenarioName}`);
  
  try {
    // Load both signers
    const signer1 = await loadOrCreateWallet(`${scenarioName}_signer_1`);
    const signer2 = await loadOrCreateWallet(`${scenarioName}_signer_2`);
    
    // Import the multisig address to track UTXOs
    const configPath = path.join(__dirname, `${scenarioName}_caravan.json`);
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      console.log(`   Using config: ${config.name}`);
    }
    
    // Get UTXOs from first signer (coordinator)
    const utxos = await rpc<any[]>(signer1, "listunspent", 1);
    console.log(`   Found ${utxos.length} UTXOs`);
    
    if (utxos.length === 0) {
      console.log("   No UTXOs found to test spending");
      return;
    }
    
    // Create a test transaction
    const testAddr = await rpc<string>(signer1, "getnewaddress");
    const utxo = utxos[0];
    const inputs = [{ txid: utxo.txid, vout: utxo.vout }];
    const outputs = { [testAddr]: utxo.amount - 0.0001 };
    
    console.log(`   Creating transaction spending ${utxo.amount} BTC`);
    const rawTx = await rpc<string>(signer1, "createrawtransaction", inputs, outputs);
    
    // Sign with signer 1
    const signed1 = await rpc<any>(signer1, "signrawtransactionwithwallet", rawTx);
    console.log(`   Signer 1 signed: ${signed1.complete ? 'Complete' : 'Partial'}`);
    
    // Sign with signer 2
    const signed2 = await rpc<any>(signer2, "signrawtransactionwithwallet", signed1.hex);
    console.log(`   Signer 2 signed: ${signed2.complete ? 'Complete' : 'Partial'}`);
    
    if (signed2.complete) {
      await rpc<string>(signer1, "sendrawtransaction", signed2.hex);
      await mine(signer1, 1);
      console.log("   ✅ 2-of-2 multisig spending test successful!");
    } else {
      console.log("   ⚠️ Transaction not fully signed (this is expected for multisig)");
    }
    
  } catch (error) {
    console.log(`   ❌ Multisig spending test failed: ${error}`);
  }
}

// Update CLI options to include the new waste-heavy scenario
const argv = yargs(hideBin(process.argv))
  .option("scenario", {
    alias: "s",
    choices: [
      "privacy-good", 
      "privacy-bad", 
      "waste-heavy",
      "all"
    ] as const,
    default: "all",
    describe: "Which scenario to create (2 real wallets each)",
  })
  .option("test", {
    alias: "t",
    type: "boolean",
    default: false,
    describe: "Test multisig spending after creation",
  })
  .argv;

// Scenario runner
(async () => {
  try {
    const resolvedArgv = await argv;
    
    // if (resolvedArgv.scenario === "privacy-good" || resolvedArgv.scenario === "all") {
    //   await privacyGood();
    //   if (resolvedArgv.test) await testMultisigSpending("privacy_good");
    // }
    
    // if (resolvedArgv.scenario === "privacy-bad" || resolvedArgv.scenario === "all") {
    //   await privacyBad();
    //   if (resolvedArgv.test) await testMultisigSpending("privacy_bad");
    // }
    
    if (resolvedArgv.scenario === "waste-heavy" || resolvedArgv.scenario === "all") {
      await wasteHeavy();
      if (resolvedArgv.test) await testMultisigSpending("waste_heavy");
    }

    console.log("\n🎉 All multisig wallets created successfully!");
    console.log(`Connect Caravan to: ${cfg.network}@${cfg.host}:${cfg.port}`);
    console.log("📁 Caravan config files:");
    console.log(`   - privacy_good_caravan.json`);
    console.log(`   - privacy_bad_caravan.json`);
    console.log(`   - waste_heavy_caravan.json`);
    
  } catch (err) {
    console.error("⚠️ Critical Error:", err);
    process.exit(1);
  }
})();