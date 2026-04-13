# NGINX Plus - Pattern-Based Rate Limiting & Greylisting

A production-ready NGINX Plus configuration that:

- **Identifies clients** by a fingerprint of IP + User-Agent + Bearer token
- **Rate-limits per client per URI pattern** (scheme + FQDN + URI + HTTP method)
- **Greylists offending clients** for a configurable duration, responding with HTTP 429
- **Auto-expires** greylist entries — no cron job needed (NGINX Plus `keyval` TTL)
- **Load-balances** HTTP/HTTPS upstreams

For a native C implementation of this module (compatible with both NGINX open source and NGINX Plus) see [https://github.com/fabriziofiorucci/ngx_http_greylist_module](https://github.com/fabriziofiorucci/ngx_http_greylist_module)

## Architecture

```
                  ┌─────────────────────────────────────────────────────┐
  Client ─────────▶  NGINX Plus                                        │
                  │                                                     │
                  │  1. Compute fingerprint  (IP | UA-hash | Token-hash)│
                  │         │                                           │
                  │  2. Check keyval greylist ──── HIT ──▶ 429         │
                  │         │ MISS                                      │
                  │  3. Apply limit_req (per pattern, per client)       │
                  │         │ OK              │ EXCEEDED                │
                  │         │                 ▼                         │
                  │         │       Write greylist keyval (TTL)         │
                  │         │                 │                         │
                  │         │       ◀── 429 ──┘                        │
                  │         │ OK                                        │
                  │  4. proxy_pass ──────────▶  Upstream pool          │
                  └─────────────────────────────────────────────────────┘
```

### Key NGINX Plus features used

| Feature | Purpose |
|---|---|
| `keyval_zone` with `timeout` | Greylist store with automatic TTL expiry |
| `keyval` | Per-request lookup and write of greylist entries |
| NJS (`ngx_http_js_module`) | Fingerprint computation, greylist read/write logic |
| `auth_request` | Non-blocking greylist check as a subrequest |
| `limit_req_zone` / `limit_req` | Precise per-client, per-pattern rate limiting |
| `upstream` with `zone` | Live upstream stats via NGINX Plus API |

---

## Prerequisites

- **NGINX Plus** R24+ (for NJS 0.7+ and keyval with state persistence)
- The following dynamic modules must be present:
  - `ngx_http_js_module.so` (NJS — bundled with NGINX Plus)
  - `ngx_http_auth_request_module` (compiled in by default)
- Writable directory for keyval state: `/var/lib/nginx/`

---

## File Structure

```
/etc/nginx/
├── nginx.conf                   # Worker settings, loads NJS module
├── conf.d/
│   ├── greylist_core.conf       # NJS wiring, keyval zones  [edit rarely]
│   ├── greylist_rules.conf      # Rate rules and durations  [edit here]
│   ├── upstreams.conf           # Upstream server pools
│   └── vhost.conf               # Server / location blocks
└── njs/
    └── greylist.js              # NJS module (fingerprint + greylist logic)
```

## File Contents

### `nginx.conf`

```nginx
# ============================================================
# NGINX Plus — Main configuration
# ============================================================

# NJS dynamic module — MUST be loaded before the http{} block
load_module modules/ngx_http_js_module.so;

user  nginx;
worker_processes  auto;
worker_rlimit_nofile  65535;

error_log  /var/log/nginx/error.log  warn;
pid        /var/run/nginx.pid;

events {
    worker_connections  4096;
    use  epoll;
    multi_accept  on;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    # Include client fingerprint and greylist status in every log line
    log_format  main  '$remote_addr [$time_local] "$request" $status '
                      'rt=$request_time fp="$client_fingerprint" '
                      'gl_entry="$greylist_entry"';

    access_log  /var/log/nginx/access.log  main;

    sendfile        on;
    tcp_nopush      on;
    tcp_nodelay     on;
    keepalive_timeout  65;
    server_tokens  off;

    include /etc/nginx/conf.d/*.conf;
}
```

### `conf.d/greylist_core.conf`

```nginx
# ============================================================
# NGINX Plus — Greylisting core
# NJS wiring, keyval zones, client fingerprint variable
#
# Edit rarely — infrastructure only.
# To add/modify rules, edit greylist_rules.conf.
# ============================================================

# ── NJS ──────────────────────────────────────────────────────────────────
js_path   "/etc/nginx/njs/";
js_import  greylist from greylist.js;

# Computed once per request via NJS (lazy / cached).
# Format: "<IP>|<ua-fnv32>|<token-fnv32>"
js_set $client_fingerprint  greylist.clientFingerprint;

# ── Keyval zone (NGINX Plus) ──────────────────────────────────────────────
#
#  zone=greylist:16m   — 16 MB of shared memory (~650 k entries)
#  timeout=3600s       — Safety GC: entries older than 1 h are purged
#                        regardless of stored expiry timestamp.
#                        Set to your maximum possible greylist duration.
#  state=...           — Persist entries across NGINX reloads/restarts.
#
# Stored value format: Unix epoch timestamp (string) at which the
# greylist entry expires.  The NJS logic compares this to Date.now()
# so different patterns can have different effective durations even
# within a single zone.
keyval_zone  zone=greylist:16m
             timeout=3600s
             state=/var/lib/nginx/greylist.json;

# The lookup variable.  For every request, NGINX evaluates
# $client_fingerprint and looks it up in the greylist zone.
# The result (expiry epoch string, or "") is stored in $greylist_entry.
keyval  $client_fingerprint  $greylist_entry  zone=greylist;
```

### `conf.d/greylist_rules.conf`

```nginx
# ============================================================
# NGINX Plus — Rate-limit rules and greylist durations
#
# HOW TO ADD A NEW RULE
# ─────────────────────
# 1.  Add an entry to the $greylist_duration map:
#         "<PATTERN>"   <seconds>;
#
# 2.  Add a $rl_key_rN map block:
#         matching requests  → $client_fingerprint  (tracked)
#         non-matching       → ""                   (not tracked)
#
# 3.  Add a limit_req_zone for the new map variable:
#         limit_req_zone  $rl_key_rN  zone=rl_rN:<mem>  rate=<R>r/[sm];
#
# 4.  Add a limit_req line in conf.d/vhost.conf → location /:
#         limit_req  zone=rl_rN  burst=<B>  nodelay;
#
# PATTERN SYNTAX
# ──────────────
# Map key:  "$request_method:$scheme://$host$request_uri"
# Use case-insensitive extended regex (~*).
# Examples:
#   "~*^POST:https?://api\.example\.com/auth/login(\?.*)?$"
#   "~*^GET:https?://[^/]+/api/search"          # any hostname
#   "~*^(POST|PUT):https?://api\.example\.com/upload"
# ============================================================

# ── Greylist duration per pattern (seconds) ──────────────────────────────
# First match wins.  Used by addToGreylist() in NJS to compute expiry.
map "$request_method:$scheme://$host$request_uri" $greylist_duration {

    # R1 — brute-force login protection            → 120 s
    "~*^POST:https?://[^/]+/auth/login(\?.*)?$"       120;

    # R2 — search / scraping protection            → 60 s
    "~*^GET:https?://[^/]+/api/search"                 60;

    # R3 — destructive admin operations            → 300 s
    "~*^DELETE:https?://[^/]+/api/admin"              300;

    # Default (applies to any rule not listed above)
    default                                            60;
}

# ── RULE R1: POST /auth/login  — 5 req/s per client ──────────────────────
map "$request_method:$scheme://$host$request_uri" $rl_key_r1 {
    "~*^POST:https?://[^/]+/auth/login(\?.*)?$"       $client_fingerprint;
    default                                           "";
}
limit_req_zone  $rl_key_r1  zone=rl_r1:10m  rate=5r/s;

# ── RULE R2: GET /api/search* — 30 req/min per client ────────────────────
map "$request_method:$scheme://$host$request_uri" $rl_key_r2 {
    "~*^GET:https?://[^/]+/api/search"                $client_fingerprint;
    default                                           "";
}
limit_req_zone  $rl_key_r2  zone=rl_r2:10m  rate=30r/m;

# ── RULE R3: DELETE /api/admin/* — 2 req/min per client ──────────────────
map "$request_method:$scheme://$host$request_uri" $rl_key_r3 {
    "~*^DELETE:https?://[^/]+/api/admin"              $client_fingerprint;
    default                                           "";
}
limit_req_zone  $rl_key_r3  zone=rl_r3:10m  rate=2r/m;
```

### `conf.d/upstreams.conf`

```nginx
# ============================================================
# NGINX Plus — Upstream pools
# ============================================================

upstream backend {
    zone backend 64k;       # Shared-memory zone: enables live stats/API

    server 127.0.0.1:30080 weight=1 max_fails=3 fail_timeout=30s;

    keepalive          32;       # Pool of idle upstream connections
    keepalive_requests 1000;
    keepalive_timeout  60s;
}

server {
    listen 127.0.0.1:30080;

    location / {
        return 200 "User-Agent: $http_user_agent\nURI: $uri\n";
    }
}
```

### `conf.d/vhost.conf`

```nginx
# ============================================================
# NGINX Plus — Virtual hosts
# ============================================================

# ── HTTP → HTTPS redirect ─────────────────────────────────────────────────
server {
    listen 80 default_server;
    server_name _;
    return 301 https://$host$request_uri;
}

# ── HTTPS main server ─────────────────────────────────────────────────────
server {
    listen      443 ssl;
    http2       on;
    server_name api.example.com;

    # ── TLS ──────────────────────────────────────────────────────────────
    ssl_certificate      /etc/nginx/ssl/server.crt;
    ssl_certificate_key  /etc/nginx/ssl/server.key;
    ssl_protocols        TLSv1.2 TLSv1.3;
    ssl_ciphers          ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers  off;
    ssl_session_cache    shared:SSL:10m;
    ssl_session_timeout  1d;

    # ── NGINX Plus Management API (internal only) ─────────────────────────
    # Exposes live metrics, upstream management, and keyval read/write.
    # In production: restrict to a separate management listener/port.
    location /api/ {
        api write=on;
        allow 127.0.0.1;
        deny  all;
    }

    # ── INTERNAL: greylist status check (auth_request sub-handler) ────────
    # Returns 200 (pass) or 403 (greylisted → triggers error_page below).
    location = /_greylist_check {
        internal;
        js_content greylist.checkGreylist;
    }

    # ── NAMED: client was ALREADY greylisted (auth_request returned 403) ──
    location @already_greylisted {
        js_content greylist.denyGreylisted;
    }

    # ── NAMED: rate limit just exceeded → add to greylist ─────────────────
    # Reached via: limit_req_status 429 → error_page 429.
    # Writes greylist entry with per-pattern TTL, then returns 429.
    #
    # Note on loop safety: NGINX sets an internal "error_page in progress"
    # flag when processing error_page directives.  Any 429 returned by this
    # named location's js_content handler is sent directly to the client
    # without re-triggering error_page 429 (NGINX built-in recursion guard).
    location @trigger_greylist {
        js_content greylist.addToGreylist;
    }

    # ── Main application proxy ────────────────────────────────────────────
    location / {

        # ── Step 1: Greylist check ────────────────────────────────────────
        # auth_request fires a subrequest to /_greylist_check.
        # On 403 → route to @already_greylisted → 429 to client.
        auth_request  /_greylist_check;
        error_page 403 = @already_greylisted;

        # ── Step 2: Per-pattern, per-client rate limiting ─────────────────
        # Add one limit_req line per rule in greylist_rules.conf.
        #
        # When $rl_key_rN is "" (pattern didn't match), the zone is a no-op
        # for that request — no tracking, no limiting.
        #
        # burst   — extra slots before hard rejection (tune per endpoint)
        # nodelay — reject immediately rather than queue excess requests
        limit_req  zone=rl_r1  burst=5   nodelay;
        limit_req  zone=rl_r2  burst=10  nodelay;
        limit_req  zone=rl_r3  burst=2   nodelay;

        limit_req_status  429;              # Use 429 for all rate-limit hits
        error_page   429  = @trigger_greylist;

        # ── Step 3: Proxy to upstream ─────────────────────────────────────
        proxy_pass              http://backend;
        proxy_http_version      1.1;
        proxy_set_header        Host               $host;
        proxy_set_header        X-Real-IP          $remote_addr;
        proxy_set_header        X-Forwarded-For    $proxy_add_x_forwarded_for;
        proxy_set_header        X-Forwarded-Proto  $scheme;
        proxy_set_header        Connection         "";
        proxy_connect_timeout   5s;
        proxy_send_timeout      30s;
        proxy_read_timeout      30s;
    }
}
```

### `njs/greylist.js`

```javascript
/**
 * greylist.js — NGINX Plus Greylisting (NJS module)
 *
 * Exported functions (referenced in nginx config):
 *
 *   clientFingerprint(r)  — js_set handler
 *                           Returns a stable compact client identifier.
 *
 *   checkGreylist(r)      — js_content handler (used by auth_request)
 *                           HTTP 200: client is NOT greylisted → proceed.
 *                           HTTP 403: client IS greylisted     → block.
 *
 *   addToGreylist(r)      — js_content handler (error_page 429)
 *                           Writes expiry timestamp to keyval, returns 429.
 *
 *   denyGreylisted(r)     — js_content handler (error_page 403)
 *                           Already-greylisted response with Retry-After.
 *
 * Requires: NGINX Plus R24+ with NJS 0.7+ (ES module support)
 */

'use strict';

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * FNV-1a 32-bit hash — pure JS, no imports needed.
 * Used to compact User-Agent and Bearer token strings into fixed-width keys,
 * preventing unbounded memory growth in the keyval zone.
 */
function fnv1a32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/** Extract Bearer token value from an Authorization header, or ''. */
function bearerToken(authHeader) {
    const m = /^Bearer\s+(\S+)/i.exec(authHeader || '');
    return m ? m[1] : '';
}

// ── Exported handlers ─────────────────────────────────────────────────────

/**
 * js_set handler — compute client fingerprint.
 *
 * Returns the string:  "<IP>|<ua-hash>|<token-hash>"
 *
 * - IP is kept raw for auditability.
 * - User-Agent and Bearer token are hashed (FNV-1a 32-bit) to keep
 *   keyval keys short regardless of how long those strings are.
 * - If no Bearer token is present the token hash is the hash of "",
 *   so unauthenticated clients are still fingerprinted by IP + UA.
 *
 * This function is called lazily and cached by NGINX for the lifetime
 * of the request (and any subrequests that share the same parent).
 */
function clientFingerprint(r) {
    const ip    = r.remoteAddress                              || '0.0.0.0';
    const ua    = r.headersIn['User-Agent']                    || '';
    const token = bearerToken(r.headersIn['Authorization']     || '');
    return `${ip}|${fnv1a32(ua)}|${fnv1a32(token)}`;
}

/**
 * auth_request check handler.
 *
 * Reads $greylist_entry — the keyval value for the current client
 * fingerprint (an expiry epoch string, or "" if not listed).
 *
 * Returns:
 *   HTTP 200 — client is not greylisted (or entry has already expired)
 *   HTTP 403 — client is actively greylisted
 */
function checkGreylist(r) {
    const entry = r.variables['greylist_entry'];

    if (entry) {
        const expiry = parseInt(entry, 10);
        const now    = Math.floor(Date.now() / 1000);

        if (!isNaN(expiry) && now < expiry) {
            // Client is actively greylisted.
            // 403 triggers: error_page 403 = @already_greylisted → denyGreylisted()
            r.return(403);
            return;
        }
        // Timestamp in zone but already past → stale entry, allow.
        // The keyval zone timeout will GC it eventually.
    }

    r.return(200);
}

/**
 * error_page 429 handler — rate limit exceeded.
 *
 * Called when limit_req_zone rejects a request (limit_req_status 429).
 *
 * 1. Reads $greylist_duration (populated by map in greylist_rules.conf).
 * 2. Computes expiry = now + duration.
 * 3. Writes expiry to $greylist_entry → persisted in the keyval zone
 *    under the key $client_fingerprint.
 * 4. Returns 429 with Retry-After header and JSON body.
 *
 * The keyval write (step 3) is the mechanism that actually greylists
 * the client — subsequent requests will find the entry in checkGreylist()
 * and be denied for the configured duration.
 */
function addToGreylist(r) {
    const duration = parseInt(r.variables['greylist_duration'], 10) || 60;
    const expiry   = Math.floor(Date.now() / 1000) + duration;

    // Keyval write: greylist[$client_fingerprint] = String(expiry)
    // NGINX Plus keyval variables are writable; this persists the entry
    // in shared memory and (if state= is configured) to disk.
    r.variables['greylist_entry'] = String(expiry);

    r.headersOut['Content-Type']  = 'application/json; charset=utf-8';
    r.headersOut['Retry-After']   = String(duration);
    r.headersOut['X-Greylisted']  = '1';

    r.return(429, JSON.stringify({
        error:       'Too Many Requests',
        message:     'Rate limit exceeded. Client has been temporarily greylisted.',
        retry_after:  duration
    }));
}

/**
 * error_page 403 handler — client already in greylist.
 *
 * Called after checkGreylist() returns 403, via:
 *   error_page 403 = @already_greylisted
 *
 * Reads the current keyval entry to report accurate remaining seconds
 * in the Retry-After header.
 */
function denyGreylisted(r) {
    const entry     = r.variables['greylist_entry'];
    const expiry    = entry ? parseInt(entry, 10) : 0;
    const now       = Math.floor(Date.now() / 1000);
    const remaining = Math.max(0, expiry - now);

    r.headersOut['Content-Type']  = 'application/json; charset=utf-8';
    r.headersOut['Retry-After']   = String(remaining);
    r.headersOut['X-Greylisted']  = '1';

    r.return(429, JSON.stringify({
        error:       'Too Many Requests',
        message:     'Client is temporarily greylisted.',
        retry_after:  remaining
    }));
}

export default { clientFingerprint, checkGreylist, addToGreylist, denyGreylisted };
```

## How to Run

### Option A — Standalone NGINX Plus

```bash
# 1. Install files
sudo mkdir -p /etc/nginx/conf.d /etc/nginx/njs /etc/nginx/ssl /var/lib/nginx

# Copy each file to its location as shown above, then:

# 2. Generate a self-signed cert for testing (replace with real certs in prod)
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/server.key \
  -out    /etc/nginx/ssl/server.crt \
  -subj   "/CN=api.example.com"

# 3. Set correct ownership on the keyval state dir
sudo chown nginx:nginx /var/lib/nginx

# 4. Validate configuration
sudo nginx -t

# 5. Start / reload
sudo systemctl start  nginx   # first start
sudo nginx -s reload          # subsequent config changes
```

### Option B — Docker Compose

**`docker-compose.yml`**

```yaml
version: "3.9"

services:
  nginx-plus:
    image: private-registry.nginx.com/nginx-plus/base:latest
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./conf.d:/etc/nginx/conf.d:ro
      - ./njs:/etc/nginx/njs:ro
      - ./ssl:/etc/nginx/ssl:ro
      - greylist_state:/var/lib/nginx
    restart: unless-stopped

  backend1:
    image: hashicorp/http-echo
    command: ["-text=backend-1"]
    expose: ["5678"]

  backend2:
    image: hashicorp/http-echo
    command: ["-text=backend-2"]
    expose: ["5678"]

  backend3:
    image: hashicorp/http-echo
    command: ["-text=backend-3"]
    expose: ["5678"]

volumes:
  greylist_state:
```

> **Note:** NGINX Plus requires a valid subscription license.  
> Pull the image using your NGINX Plus JWT credentials:
> ```bash
> docker login private-registry.nginx.com \
>   --username=$(cat nginx-repo.jwt) --password=none
> ```

```bash
# Update upstreams.conf with Docker Compose service names:
# server backend1:5678;   server backend2:5678;   server backend3:5678;

docker compose up --build
```

## How to Configure Rules

### Anatomy of a rule

Each rule has **four parts** spread across `greylist_rules.conf` and `vhost.conf`:

```
┌─ greylist_rules.conf ──────────────────────────────────────────────────┐
│                                                                        │
│  1. Duration entry in $greylist_duration map                           │
│     "~*^POST:.../auth/login"   120;   ← greylist for 120 seconds       │
│                                                                        │
│  2. Selector map ($rl_key_rN)                                          │
│     matching requests  → $client_fingerprint  (count this client)      │
│     everything else    → ""                   (ignore)                 │
│                                                                        │
│  3. limit_req_zone                                                     │
│     limit_req_zone $rl_key_r1 zone=rl_r1:10m rate=5r/s;                │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

┌─ vhost.conf / location / ──────────────────────────────────────────────┐
│                                                                        │
│  4. limit_req directive                                                │
│     limit_req zone=rl_r1 burst=5 nodelay;                              │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### Example: add a rule for `PUT /api/items/*` at 10 req/min → greylist 90 s

**Step 1–3** — add to `greylist_rules.conf`:

```nginx
# In $greylist_duration map — add before `default`:
"~*^PUT:https?://[^/]+/api/items"    90;

# New selector map:
map "$request_method:$scheme://$host$request_uri" $rl_key_r4 {
    "~*^PUT:https?://[^/]+/api/items"    $client_fingerprint;
    default                              "";
}
limit_req_zone  $rl_key_r4  zone=rl_r4:10m  rate=10r/m;
```

**Step 4** — add to `vhost.conf` inside `location /`:

```nginx
limit_req  zone=rl_r4  burst=3  nodelay;
```

**Reload:**

```bash
sudo nginx -s reload
```

## Managing the Greylist

The NGINX Plus REST API lets you inspect and manipulate the greylist at runtime — no reload needed.

### View all greylisted clients

```bash
curl -ks https://127.0.0.1/api/9/http/keyvals/greylist | jq .
```

```json
{
  "10.0.0.5|a1b2c3d4|00000000": "1743345600",
  "10.0.0.9|deadbeef|cafebabe": "1743346200"
}
```

The values are Unix timestamps (epoch seconds) of when the entry expires.

### Remove a specific client from the greylist immediately

```bash
curl -ks -X PATCH https://127.0.0.1/api/9/http/keyvals/greylist \
  -H "Content-Type: application/json" \
  -d '{"10.0.0.5|a1b2c3d4|00000000": null}'
```

### Purge the entire greylist

```bash
curl -ks -X DELETE https://127.0.0.1/api/9/http/keyvals/greylist
```

### Manually greylist a client for 300 seconds

```bash
# Compute expiry = now + 300
EXPIRY=$(( $(date +%s) + 300 ))
FINGERPRINT="10.0.0.99|a1b2c3d4|00000000"

curl -ks -X POST https://127.0.0.1/api/9/http/keyvals/greylist \
  -H "Content-Type: application/json" \
  -d "{\"${FINGERPRINT}\": \"${EXPIRY}\"}"
```

> The API version in the path (`/api/9/`) matches your NGINX Plus version.
> Check `/api/` for available versions.

## Testing

### 1. Basic health check

```bash
curl -k https://api.example.com/health
```

### 2. Trigger rate limiting on the login endpoint

```bash
# Fire 10 POST requests in rapid succession — the 6th should get greylisted
for i in $(seq 1 10); do
  echo -n "Request $i: "
  curl -s -o /dev/null -w "%{http_code}\n" -k \
    -X POST https://api.example.com/auth/login \
    -H "User-Agent: TestClient/1.0" \
    -H "Authorization: Bearer test-token-abc" \
    -d '{"user":"test","pass":"test"}'
done
```

Expected output:

```
Request 1: 200
Request 2: 200
...
Request 6: 429    ← greylisted now
Request 7: 429    ← still greylisted
...
```

### 3. Verify greylist entry was created

```bash
curl -ks https://127.0.0.1/api/9/http/keyvals/greylist | jq .
```

### 4. Verify Retry-After header

```bash
curl -s -D - -o /dev/null -k \
  -X POST https://api.example.com/auth/login \
  -H "User-Agent: TestClient/1.0" \
  -H "Authorization: Bearer test-token-abc" | grep -i retry-after
```

### 5. Verify different fingerprints are tracked separately

```bash
# Different UA → different fingerprint → separate rate limit counter
curl -s -o /dev/null -w "%{http_code}\n" -k \
  -X POST https://api.example.com/auth/login \
  -H "User-Agent: DifferentClient/2.0" \
  -H "Authorization: Bearer other-token"
# → 200 (fresh counter for this fingerprint)
```

## How Auto-Expiry Works

The greylist entry expires automatically through two independent mechanisms:

```
  Time ──────────────────────────────────────────────────────────▶
  t=0                        t=expiry              t=zone_timeout

  ┌────────────────────────────┐
  │  Entry in keyval zone      │  ← Written by addToGreylist()
  └────────────────────────────┘
         ↑                    ↑
   checkGreylist()       NJS: now >= expiry
   returns 403           checkGreylist() returns 200
   (active block)        (logical expiry — entry
                          may still be in zone memory
                          but has no effect)
                                                   ↑
                                         keyval zone timeout
                                         (GC: memory reclaimed)
```

1. **Logical expiry** — NJS compares `Date.now()` to the stored epoch. Once the timestamp is in the past, `checkGreylist()` returns 200 and the client is allowed through.  No restart or API call needed.

2. **Memory GC** — The `keyval_zone timeout=3600s` directive causes NGINX Plus to evict any entry older than the timeout, reclaiming shared memory.

## Troubleshooting

| Symptom | Check |
|---|---|
| `nginx -t` fails with unknown directive `keyval` | NGINX Plus not installed, or missing `load_module ngx_http_js_module.so` |
| `nginx -t` fails with unknown directive `js_import` | NJS module not loaded — verify `load_module` is before `http{}` |
| All requests get 429 immediately | Check `$client_fingerprint` is computed correctly; inspect keyval via API |
| Greylist entries never expire | Verify `timeout=` in `keyval_zone`; check NJS timestamp comparison |
| `state=` file permission denied | `chown nginx:nginx /var/lib/nginx` |
| `error_page 429` seems to loop | Confirm NGINX Plus version ≥ R24; NJS `r.return()` in a named location does not re-trigger `error_page` due to NGINX's built-in recursion guard |
| Rate limits apply to all URIs, not just matched ones | Verify the `default ""` entry in each `$rl_key_rN` map is present |

### Enable debug logging for NJS

```nginx
error_log /var/log/nginx/error.log debug;
```

Add `ngx.log(ngx.INFO, ...)` calls inside the NJS functions to trace execution:

```javascript
function checkGreylist(r) {
    ngx.log(ngx.INFO, `greylist check: fp=${r.variables['client_fingerprint']} entry=${r.variables['greylist_entry']}`);
    // ...
}
```
