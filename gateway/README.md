# ObservaOne Gateway

For a site (a data centre, a branch, a customer network) whose servers cannot reach the central ObservaOne, or
where you want one controlled exit instead of every server talking out.

```
 site servers (agents) ──HTTPS──▶  ObservaOne Gateway  ──HTTPS (one connection out)──▶  central ObservaOne
                                   relays everything,
                                   keeps data while the link is down
```

| Agent request | Link up | Link down |
|---|---|---|
| enrollment, actions, diagnostics, settings | relayed | 503, the agent retries |
| heartbeat | relayed | answered by the gateway (last answer from the centre, no actions); the latest heartbeat per agent is replayed later with the time it was received |
| metrics | relayed | spooled on disk (default 1 GB / 2 h), replayed oldest first |
| `/agent/install.sh`, binaries | from the centre, cached | the cached copy |

The centre still checks every credential, payload and label: the gateway decides nothing. Only uploads from
credentials the centre accepted in the last 24 hours are spooled. A gateway of a tenant relays only that tenant's agents.

## Set up

1. Central ObservaOne: **Settings → Gateways → Add gateway**. Copy the token (shown once).
2. On the gateway machine (Docker), from a copy of this repository:
   ```bash
   cd gateway && cp .env.example .env    # set GATEWAY_UPSTREAM, GATEWAY_TOKEN, SERVER_NAME
   docker compose up -d --build
   curl -sk https://localhost/healthz    # {"ok":true,"upstream":"up",...}
   ```
3. Install agents in the site against the gateway, pinning the gateway's certificate:
   ```bash
   FP=$(openssl x509 -in gateway/certs/server.crt -outform DER | sha256sum | cut -d' ' -f1)   # on the gateway
   curl -fsSLk https://GATEWAY/agent/install.sh -o observaone-install.sh                      # on each server
   sudo bash observaone-install.sh --server https://GATEWAY --ca-sha256 $FP
   ```
   Create the enrollment token in the central ObservaOne as usual. The agent shows up there with "via gateway".

Firewall: site servers → gateway TCP 443; gateway → centre TCP 443. Nothing inbound to the site.

Limits: pull mode does not go through a gateway (Prometheus must reach the agent). The spool is bounded by
`GATEWAY_SPOOL_MB` and `GATEWAY_SPOOL_HOURS` (oldest dropped first; the centre accepts samples up to 2 h late).
