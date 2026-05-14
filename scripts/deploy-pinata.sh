#!/bin/bash
set -e

# Pinata Upload Script using official CLI
DIST_DIR="./dist"
PIN_NAME="ipfs-universe"

if [ -z "$PINATA_JWT" ]; then
  echo "Error: PINATA_JWT is not set"
  exit 1
fi

# Install Pinata CLI
echo "Installing Pinata CLI..."
curl -fsSL https://cli.pinata.cloud/install | bash
export PATH="$HOME/.local/share/pinata:$PATH"

# Auth
echo "Authenticating..."
pinata auth --jwt "$PINATA_JWT"

# Upload
echo "Uploading $DIST_DIR..."
# Capture output and filter for CID
OUTPUT=$(pinata upload "$DIST_DIR" --name "$PIN_NAME")
echo "Full Output: $OUTPUT"

CID=$(echo "$OUTPUT" | grep -oE "Qm[a-zA-Z0-9]{44}|b[a-z2-7]{58}" | head -n 1)

if [ -z "$CID" ]; then
  echo "Error: CID not found in output"
  exit 1
fi

echo "Successfully uploaded. CID: $CID"
echo "cid=$CID" >> "$GITHUB_OUTPUT"
