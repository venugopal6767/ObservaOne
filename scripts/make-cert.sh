#!/bin/sh
# Creates a self-signed HTTPS certificate for Nginx.
# Production: put your own certificate (from your CA) in nginx/certs/server.crt and
# its key in nginx/certs/server.key - this script then leaves them alone.
#
# Names on the certificate (agents check them, so the address agents use must be one of them):
#   - SERVER_NAME from .env, when it is set to something other than localhost
#   - this server's own IPv4 addresses (Docker bridges left out)
#   - on AWS EC2: the public IPv4 address (from the instance metadata service)
#   - localhost and 127.0.0.1
# Runs with the host network (see docker-compose.yml) so it can see the server's real addresses.
#
# An existing self-signed certificate made by this script is re-created only when it covers
# nothing but localhost (the old default) or does not cover SERVER_NAME. Agents installed against
# the old certificate must then be installed again (its fingerprint changes).
set -eu
DIR="${CERT_DIR:-/certs}"
CERT="$DIR/server.crt"
KEY="$DIR/server.key"
NAME="${SERVER_NAME:-localhost}"
is_ip() { echo "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; }
is_loop() { case "$1" in localhost|127.*|::1) return 0 ;; *) return 1 ;; esac; }

# ---- addresses of this server ----
host_ips() {
  command -v ip >/dev/null 2>&1 || return 0
  ip -4 -o addr show scope global 2>/dev/null \
    | awk '$2 !~ /^(docker|br-|veth|cni|flannel|cali|virbr|kube|tun|wg)/ { split($4, a, "/"); print a[1] }'
}
# AWS EC2 public IPv4 through IMDSv2 (busybox nc; a short timeout so other clouds and laptops are not slowed down)
aws_public_ip() {
  command -v nc >/dev/null 2>&1 || return 0
  tok=$(printf 'PUT /latest/api/token HTTP/1.0\r\nHost: 169.254.169.254\r\nX-aws-ec2-metadata-token-ttl-seconds: 60\r\n\r\n' \
    | nc -w 2 169.254.169.254 80 2>/dev/null | tr -d '\r' | sed '1,/^$/d') || return 0
  [ -n "$tok" ] || return 0
  printf 'GET /latest/meta-data/public-ipv4 HTTP/1.0\r\nHost: 169.254.169.254\r\nX-aws-ec2-metadata-token: %s\r\n\r\n' "$tok" \
    | nc -w 2 169.254.169.254 80 2>/dev/null | tr -d '\r' | awk 'NR==1 && $2 != "200" { exit } f { print } /^$/ { f = 1 }' | grep -E '^[0-9.]+$' || true
}

NAMES=""
add() { for n in "$@"; do [ -n "$n" ] || continue; case " $NAMES " in *" $n "*) ;; *) NAMES="$NAMES $n" ;; esac; done; }
is_loop "$NAME" || add "$NAME"
add $(aws_public_ip) $(host_ips) localhost 127.0.0.1
NAMES="${NAMES# }"

# ---- keep, or re-create, an existing certificate ----
if [ -s "$CERT" ] && [ -s "$KEY" ]; then
  subj=$(openssl x509 -in "$CERT" -noout -subject -nameopt compat 2>/dev/null || true)
  iss=$(openssl x509 -in "$CERT" -noout -issuer -nameopt compat 2>/dev/null || true)
  if [ "${subj#subject=}" != "${iss#issuer=}" ] || ! echo "$subj" | grep -q 'O=Monitoring'; then
    echo "certs-init: your own certificate is in place, leaving it alone"
    exit 0
  fi
  old=$(openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr ',' '\n' | sed 's/^ *//; s/^DNS://; s/^IP Address://' | grep -v '^$' || true)
  only_loop=1
  for n in $old; do is_loop "$n" || only_loop=0; done
  want_ok=1
  if ! is_loop "$NAME"; then echo "$old" | grep -qx "$NAME" || want_ok=0; fi
  if [ "$only_loop" = 0 ] && [ "$want_ok" = 1 ]; then
    echo "certs-init: certificate already present for: $(echo $old)"
    exit 0
  fi
  echo "certs-init: re-creating the self-signed certificate (old one covered only: $(echo $old))"
  echo "certs-init: agents installed with the old certificate must be installed again"
  add $old
fi

# ---- create ----
SAN=""
for n in $NAMES; do
  if is_ip "$n"; then e="IP:$n"; else e="DNS:$n"; fi
  SAN="${SAN:+$SAN,}$e"
done
CN=$(echo "$NAMES" | awk '{ print $1 }')

openssl req -x509 -newkey rsa:3072 -sha256 -days 825 -nodes \
  -keyout "$KEY" -out "$CERT" \
  -subj "/CN=${CN}/O=Monitoring" \
  -addext "subjectAltName=${SAN}" \
  -addext "extendedKeyUsage=serverAuth"
chmod 600 "$KEY" 2>/dev/null || true
chmod 644 "$CERT" 2>/dev/null || true
echo "certs-init: self-signed certificate created for: ${NAMES}"
