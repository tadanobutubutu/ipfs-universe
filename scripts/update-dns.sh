#!/bin/bash
set -e

# Cloudflare DNS Update Script
DOMAIN="ipfsuniverse.xyz"
DNSLINK_NAME="_dnslink.$DOMAIN"
APEX_NAME="$DOMAIN"
IPFS_GATEWAY="cloudflare-ipfs.com"

if [ -z "$CLOUDFLARE_API_TOKEN" ] || [ -z "$CLOUDFLARE_ZONE_ID" ]; then
  echo "Error: Cloudflare credentials not set"
  exit 1
fi

if [ -z "$CID" ]; then
  echo "Error: CID is not set"
  exit 1
fi

echo "Updating DNSLink for $DOMAIN to /ipfs/$CID"

# 1. Update _dnslink TXT record
RECORD_ID=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records?name=$DNSLINK_NAME" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" | jq -r .result[0].id)

if [ "$RECORD_ID" != "null" ] && [ "$RECORD_ID" != "" ]; then
  echo "Updating existing DNSLink record $RECORD_ID"
  curl -X PATCH "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records/$RECORD_ID" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"type\":\"TXT\",\"name\":\"_dnslink\",\"content\":\"dnslink=/ipfs/$CID\",\"ttl\":1}"
else
  echo "Creating new DNSLink record"
  curl -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"type\":\"TXT\",\"name\":\"_dnslink\",\"content\":\"dnslink=/ipfs/$CID\",\"ttl\":1}"
fi

# 2. Ensure APEX domain points to IPFS Gateway (using CNAME flattening or A record)
# Cloudflare allows CNAME on APEX.
RECORD_ID=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records?name=$APEX_NAME&type=CNAME" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" | jq -r .result[0].id)

if [ "$RECORD_ID" != "null" ] && [ "$RECORD_ID" != "" ]; then
  echo "Updating existing APEX CNAME record $RECORD_ID"
  curl -X PATCH "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records/$RECORD_ID" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"type\":\"CNAME\",\"name\":\"$APEX_NAME\",\"content\":\"$IPFS_GATEWAY\",\"proxied\":true}"
else
  echo "Creating new APEX CNAME record"
  # If there's an A record, we might need to delete it first, but let's try creating CNAME.
  # Note: Apex CNAME is only possible on some DNS providers, but Cloudflare supports it (CNAME flattening).
  curl -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"type\":\"CNAME\",\"name\":\"$APEX_NAME\",\"content\":\"$IPFS_GATEWAY\",\"proxied\":true}"
fi

echo "DNS Update complete."
