#!/bin/bash
set -e

# Pinata Upload Script
DIST_DIR="./dist"
PIN_NAME="ipfs-universe"

if [ -z "$PINATA_JWT" ]; then
  echo "Error: PINATA_JWT is not set"
  exit 1
fi

# Install Pinata CLI if not present
if ! command -v pinata &> /dev/null; then
  echo "Installing Pinata CLI..."
  curl -fsSL https://cli.pinata.cloud/install | bash
  export PATH="$HOME/.local/share/pinata:$PATH"
fi

# Auth
echo "Authenticating with Pinata..."
pinata auth --jwt "$PINATA_JWT"

# Upload
echo "Uploading $DIST_DIR to Pinata..."
# We try to capture the CID from the output.
# The CLI might output JSON or plain text.
OUTPUT=$(pinata upload "$DIST_DIR" --name "$PIN_NAME" 2>&1)
echo "Upload Output: $OUTPUT"

# Extract CID using regex (supports v0 and v1 CIDs)
CID=$(echo "$OUTPUT" | grep -oE "Qm[a-zA-Z0-9]{44}|b[a-z2-7]{58}" | head -n 1)

if [ -z "$CID" ]; then
  echo "Error: Could not find CID in Pinata output"
  exit 1
fi

echo "Successfully uploaded to Pinata. CID: $CID"
echo "cid=$CID" >> "$GITHUB_OUTPUT"
