// TLS cert-fingerprint helpers. brackish pins the server's self-signed cert by SHA-256
// fingerprint rather than trusting a CA chain: the trust anchor is the peer's specific cert,
// delivered as a 64-hex pin in the connect line (we never move the PEM). See skill/server.md.

import { X509Certificate } from 'node:crypto';

const PIN_RE = /^sha256:[0-9a-f]{64}$/;

/** Canonical pin for a cert PEM: `sha256:` + lowercase hex of its SHA-256 (over the DER). */
export function certFingerprint(pem: string): string {
  return normalizePin(new X509Certificate(pem).fingerprint256);
}

/** Normalize any reasonable fingerprint spelling to `sha256:<lowerhex>`. Accepts an optional
 *  `sha256:` prefix and the OpenSSL/Node colon-separated uppercase form (`AB:CD:…`). Throws on
 *  anything that isn't a 256-bit hex digest. */
export function normalizePin(raw: string): string {
  const hex = raw
    .trim()
    .replace(/^sha256:/i, '')
    .replace(/:/g, '')
    .toLowerCase();
  const pin = `sha256:${hex}`;
  if (!PIN_RE.test(pin)) {
    throw new Error(`invalid TLS pin "${raw}" (expected a sha256 fingerprint of 64 hex chars)`);
  }
  return pin;
}
