/**
 * VPN detection and environment configuration.
 *
 * Detects Walmart corporate VPN connectivity at startup and configures
 * proxy, certificate, and OAuth environment variables so the server
 * (and all child processes it spawns) work seamlessly on and off VPN.
 *
 * Environment variable overrides:
 *   FORCE_VPN_MODE=1         — skip detection, assume on-VPN
 *   FORCE_OFF_VPN=1          — skip detection, assume off-VPN
 *   VPN_DETECTION_TIMEOUT=5  — curl timeout in seconds (default 5)
 *   WALMART_CERT_PATH        — override certificate file location
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const VPN_CHECK_URL = "https://dxsensei-api.walmart.com/health";
const PROXY_URL = "http://proxy-intlho.wal-mart.com:8080";
const NO_PROXY_LIST =
  "localhost,127.0.0.1,.walmart.net,.prod.walmart.com,.qa.walmart.com," +
  ".cloud.walmart.com,.homeoffice.wal-mart.com,.cld.samsclub.com," +
  ".walmartlabs.com,.wmt,.local,.bfd.walmart.com,.gecwalmart.com," +
  ".walmart.com,wmlink";

const CERT_SEARCH_PATHS = [
  join(homedir(), ".walmart/certs/walmart-root-ca.cer"),
  "/usr/local/share/walmart/certs/walmart-root-ca.cer",
  "/opt/homebrew/share/walmart/certs/walmart-root-ca.cer",
];

const OAUTH_PATHS = [
  join(homedir(), ".wibey/.oauth_access_token_stage.json"),
  join(homedir(), ".wibey/.oauth_access_token.json"),
];

/** Current VPN state — exported so /api/health and /api/vpn can read it. */
export const vpnState = {
  detected: false,
  forced: /** @type {string|null} */ (null), // "on" | "off" | null
  certPath: /** @type {string|null} */ (null),
  certValid: false,
  proxy: /** @type {string|null} */ (null),
  oauthLoaded: false,
  lastCheck: /** @type {string|null} */ (null),
};

/**
 * Probe VPN connectivity by hitting an internal Walmart endpoint.
 * Returns true if the endpoint is reachable within the timeout.
 */
function detectVpn(timeoutSec = 5) {
  return new Promise((resolve) => {
    const proc = spawn("curl", ["-s", "--connect-timeout", String(timeoutSec), VPN_CHECK_URL], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

/** Find the first existing certificate file from well-known paths. */
function findCert() {
  if (process.env.WALMART_CERT_PATH) return process.env.WALMART_CERT_PATH;
  for (const p of CERT_SEARCH_PATHS) {
    if (existsSync(p)) return p;
  }
  return CERT_SEARCH_PATHS[0]; // fallback (will show warning)
}

/** Try to extract access_token from a JSON OAuth token file. */
function loadOAuthToken() {
  for (const p of OAUTH_PATHS) {
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, "utf-8"));
      if (data.access_token) return data.access_token;
    } catch {
      // skip malformed files
    }
  }
  return null;
}

/** Validate that the cert file exists and looks like PEM. */
function validateCert(certPath) {
  if (!existsSync(certPath)) return false;
  try {
    const content = readFileSync(certPath, "utf-8");
    return content.includes("BEGIN CERTIFICATE");
  } catch {
    return false;
  }
}

/**
 * Apply VPN environment variables to `process.env`.
 * Called when on-VPN (detected or forced).
 */
function applyVpnEnv(certPath) {
  process.env.NODE_EXTRA_CA_CERTS = certPath;
  process.env.HTTP_PROXY = PROXY_URL;
  process.env.HTTPS_PROXY = PROXY_URL;
  process.env.NO_PROXY = NO_PROXY_LIST;
  process.env.DISABLE_TELEMETRY = "1";

  const token = loadOAuthToken();
  if (token) {
    process.env.OAUTH_TOKEN = token;
    vpnState.oauthLoaded = true;
  }

  vpnState.proxy = PROXY_URL;
}

/**
 * Clear VPN environment variables from `process.env`.
 * Called when off-VPN (detected or forced).
 */
function clearVpnEnv() {
  delete process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.NO_PROXY;
  delete process.env.DISABLE_TELEMETRY;
  delete process.env.OAUTH_TOKEN;

  vpnState.proxy = null;
  vpnState.oauthLoaded = false;
}

/**
 * Detect VPN status and configure the process environment.
 * Call this before `app.listen()` for deterministic startup.
 *
 * @returns {{ onVpn: boolean, certPath: string|null, certValid: boolean }}
 */
export async function configureVpn() {
  const certPath = findCert();
  const certValid = validateCert(certPath);
  vpnState.certPath = certPath;
  vpnState.certValid = certValid;

  let onVpn = false;

  if (process.env.FORCE_VPN_MODE) {
    onVpn = true;
    vpnState.forced = "on";
    console.log("[vpn] VPN mode forced ON (FORCE_VPN_MODE=1)");
  } else if (process.env.FORCE_OFF_VPN) {
    onVpn = false;
    vpnState.forced = "off";
    console.log("[vpn] VPN mode forced OFF (FORCE_OFF_VPN=1)");
  } else {
    const timeout = Number(process.env.VPN_DETECTION_TIMEOUT) || 5;
    console.log(`[vpn] Detecting VPN connectivity (timeout: ${timeout}s)...`);
    onVpn = await detectVpn(timeout);
    vpnState.forced = null;
    console.log(`[vpn] VPN ${onVpn ? "detected" : "not detected"}`);
  }

  vpnState.detected = onVpn;
  vpnState.lastCheck = new Date().toISOString();

  if (onVpn) {
    applyVpnEnv(certPath);
    if (!certValid) {
      console.warn(`[vpn] Warning: certificate ${existsSync(certPath) ? "invalid format" : "not found"} at ${certPath}`);
      console.warn("[vpn] HTTPS requests to external services may fail.");
    }
  } else {
    clearVpnEnv();
  }

  return { onVpn, certPath: onVpn ? certPath : null, certValid };
}

/**
 * Returns Bun-compatible fetchOptions for the Anthropic SDK when on VPN.
 *
 * Bun's native `fetch()` does NOT read HTTP_PROXY/HTTPS_PROXY env vars,
 * and NODE_EXTRA_CA_CERTS only takes effect at process startup — not when
 * set at runtime by configureVpn(). This function provides the proxy URL
 * and corporate CA certificate directly as Bun fetch options.
 *
 * Usage:
 *   new Anthropic({ ...getAnthropicFetchOptions() })
 *
 * Off-VPN: returns `{}` (no-op spread).
 * On-VPN:  returns `{ fetchOptions: { proxy, tls: { ca } } }`.
 *
 * @returns {object} Options to spread into the Anthropic constructor
 */
export function getAnthropicFetchOptions() {
  if (!vpnState.detected) return {};

  /** @type {Record<string, any>} */
  const fetchOptions = { proxy: PROXY_URL };

  // Load the corporate CA cert so Bun's TLS trusts the proxy's interception cert
  if (vpnState.certPath && vpnState.certValid) {
    try {
      const ca = readFileSync(vpnState.certPath, "utf-8");
      fetchOptions.tls = { ca };
    } catch {
      // cert file unreadable — fall through without tls override
    }
  }

  return { fetchOptions };
}

/**
 * Re-detect VPN and reconfigure environment (for mid-session toggling).
 * Same logic as `configureVpn` but always runs live detection (ignores FORCE_ vars).
 */
export async function reconfigureVpn() {
  const certPath = findCert();
  const certValid = validateCert(certPath);
  vpnState.certPath = certPath;
  vpnState.certValid = certValid;

  const timeout = Number(process.env.VPN_DETECTION_TIMEOUT) || 5;
  const onVpn = await detectVpn(timeout);

  vpnState.detected = onVpn;
  vpnState.forced = null;
  vpnState.lastCheck = new Date().toISOString();

  if (onVpn) {
    applyVpnEnv(certPath);
  } else {
    clearVpnEnv();
  }

  console.log(`[vpn] Reconfigured: VPN ${onVpn ? "detected" : "not detected"}`);
  return { onVpn, certPath: onVpn ? certPath : null, certValid };
}
