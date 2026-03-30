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
