#!/usr/bin/env bash
set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────
DATADIR="/Users/ice-009/.bitcoin"
RPCPORT=18443
RPCUSER="alice"
RPCPASSWORD="password"
CLI="bitcoin-cli -regtest -datadir=$DATADIR -rpcport=$RPCPORT -rpcuser=$RPCUSER -rpcpassword=$RPCPASSWORD"

# ─── Wallet list ─────────────────────────────────────────────────
WALLETS=( miner_wallet privacy_good_signer_1 privacy_good_signer_2 privacy_bad_signer_1 privacy_bad_signer_2 waste_heavy_signer_1 waste_heavy_signer_2 )

wallet_loaded() { $CLI listwallets | grep -q "\"$1\""; }

# 1. Create or load wallets
# Replace the wallet creation section with this:
for W in "${WALLETS[@]}"; do
  WALLET_DIR="$DATADIR/regtest/$W"
  if wallet_loaded "$W"; then
    echo "[*] Wallet already loaded: $W"
  else
    if [ -d "$WALLET_DIR" ]; then
      echo "[*] Loading existing wallet: $W"
      # Try to load, if it fails, remove and recreate
      if ! $CLI loadwallet "$W" >/dev/null 2>&1; then
        echo "[*] Failed to load $W, removing and recreating..."
        rm -rf "$WALLET_DIR"
        $CLI createwallet "$W" >/dev/null
      fi
    else
      echo "[*] Creating new wallet: $W"
      $CLI createwallet "$W" >/dev/null
    fi
  fi
done

# 2. Mine initial blocks to fund miner wallet
echo "[*] Mining 110 blocks to fund 'miner_wallet'..."
MINER_ADDR=$($CLI -rpcwallet=miner_wallet getnewaddress)
$CLI -rpcwallet=miner_wallet generatetoaddress 110 "$MINER_ADDR" >/dev/null

# 3. Wait and rescan to ensure wallet recognizes coinbase transactions
echo "[*] Waiting for wallet to recognize coinbase transactions..."
sleep 3
$CLI -rpcwallet=miner_wallet rescanblockchain >/dev/null
sleep 1

# 4. Check miner balance
MINER_BALANCE=$($CLI -rpcwallet=miner_wallet getbalance)
echo "[*] Miner wallet balance: $MINER_BALANCE BTC"

# 5. Generate addresses for funding
echo "[*] Generating funding addresses for signer wallets..."
ADDRS=()
for W in privacy_good_signer_1 privacy_good_signer_2 privacy_bad_signer_1 privacy_bad_signer_2 waste_heavy_signer_1 waste_heavy_signer_2; do
  ADDRS+=("$W $($CLI -rpcwallet=$W getnewaddress)")
done

# 6. Send 10 BTC to each signer wallet
for T in "${ADDRS[@]}"; do
  read WALLET ADDR <<< "$T"
  echo "[*] Sending 10 BTC to $WALLET..."
  $CLI -rpcwallet=miner_wallet sendtoaddress "$ADDR" 14 >/dev/null
done

# 7. Mine one more block to confirm transactions
echo "[*] Mining 1 block to confirm funding..."
CONFIRM_ADDR=$($CLI -rpcwallet=miner_wallet getnewaddress)
$CLI -rpcwallet=miner_wallet generatetoaddress 1 "$CONFIRM_ADDR" >/dev/null

echo "[✔] All six signer wallets funded with 10 BTC each."


npx 