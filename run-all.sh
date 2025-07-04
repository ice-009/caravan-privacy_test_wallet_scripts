#!/usr/bin/env bash
set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────
DATADIR="/Users/ice-009/Desktop/bitcoin_alt_datadir"
RPCPORT=18444
RPCUSER="alice"
RPCPASSWORD="password"
CLI="bitcoin-cli -regtest -datadir=$DATADIR -rpcport=$RPCPORT -rpcuser=$RPCUSER -rpcpassword=$RPCPASSWORD"

# ─── Wallet list ─────────────────────────────────────────────────
WALLETS=(
  miner_wallet
  privacy_good_signer_1
  privacy_good_signer_2
  privacy_bad_signer_1
  privacy_bad_signer_2
  waste_heavy_signer_1
  waste_heavy_signer_2
)

# ─── Helper: Is wallet loaded? ───────────────────────────────────
wallet_loaded() {
  $CLI listwallets | grep -q "\"$1\""
}

# ─── 1. Create or load all wallets ───────────────────────────────
for W in "${WALLETS[@]}"; do
  WALLET_DIR="$DATADIR/regtest/wallets/$W"
  if ! wallet_loaded "$W"; then
    if [ -d "$WALLET_DIR" ]; then
      echo "[*] Loading existing wallet: $W"
      $CLI loadwallet "$W" >/dev/null
    else
      echo "[*] Creating new wallet: $W"
      $CLI createwallet "$W" >/dev/null
    fi
  else
    echo "[*] Wallet already loaded: $W"
  fi
done

# ─── 2. Fund miner_wallet by mining 101 blocks ───────────────────
echo "[*] Mining 101 blocks to fund 'miner_wallet'..."
MINER_ADDR=$($CLI -rpcwallet=miner_wallet getnewaddress)
$CLI -rpcwallet=miner_wallet generatetoaddress 101 "$MINER_ADDR" >/dev/null

# ─── 3. Generate fresh addresses for each signer ────────────────
echo "[*] Generating funding addresses for signer wallets..."
ADDR_GOOD1=$($CLI -rpcwallet=privacy_good_signer_1 getnewaddress)
ADDR_GOOD2=$($CLI -rpcwallet=privacy_good_signer_2 getnewaddress)
ADDR_BAD1=$($CLI -rpcwallet=privacy_bad_signer_1 getnewaddress)
ADDR_BAD2=$($CLI -rpcwallet=privacy_bad_signer_2 getnewaddress)
ADDR_WASTE1=$($CLI -rpcwallet=waste_heavy_signer_1 getnewaddress)
ADDR_WASTE2=$($CLI -rpcwallet=waste_heavy_signer_2 getnewaddress)

# ─── 4. Send 50 BTC to each signer from miner_wallet ─────────────
for TARGET in \
  "privacy_good_signer_1 $ADDR_GOOD1" \
  "privacy_good_signer_2 $ADDR_GOOD2" \
  "privacy_bad_signer_1  $ADDR_BAD1" \
  "privacy_bad_signer_2  $ADDR_BAD2" \
  "waste_heavy_signer_1 $ADDR_WASTE1" \
  "waste_heavy_signer_2 $ADDR_WASTE2"
do
  read WALLET ADDR <<< "$TARGET"
  echo "[*] Sending 50 BTC to $WALLET..."
  $CLI -rpcwallet=miner_wallet sendtoaddress "$ADDR" 50 >/dev/null
done

# ─── 5. Mine 1 block to confirm all funding txs ──────────────────
echo "[*] Mining 1 block to confirm funding..."
CONFIRM_ADDR=$($CLI -rpcwallet=miner_wallet getnewaddress)
$CLI -rpcwallet=miner_wallet generatetoaddress 1 "$CONFIRM_ADDR" >/dev/null

echo "[✔] All four signer wallets funded with 50 BTC each."


npx ts-node index.ts   