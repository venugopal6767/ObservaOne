#!/bin/sh
# Creates a self-signed HTTPS certificate for Nginx, only if none exists.
# Production: put your own certificate (from your CA) in nginx/certs/server.crt and
# its key in nginx/certs/server.key - this script then leaves them alone.
set -eu
CERT=/certs/server.crt
KEY=/certs/server.key
NAME="${SERVER_NAME:-localhost}"

if [ -s "$CERT" ] && [ -s "$KEY" ]; then
  echo "certs-init: certificate already present, skipping"
  exit 0
fi

# Put the name in the right SAN field (IP address or DNS name)
if echo "$NAME" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  SAN="IP:${NAME},DNS:localhost,IP:127.0.0.1"
else
  SAN="DNS:${NAME},DNS:localhost,IP:127.0.0.1"
fi

openssl req -x509 -newkey rsa:3072 -sha256 -days 825 -nodes \
  -keyout "$KEY" -out "$CERT" \
  -subj "/CN=${NAME}/O=Monitoring" \
  -addext "subjectAltName=${SAN}" \
  -addext "extendedKeyUsage=serverAuth"
chmod 600 "$KEY" 2>/dev/null || true
chmod 644 "$CERT" 2>/dev/null || true
echo "certs-init: self-signed certificate created for ${NAME}"
