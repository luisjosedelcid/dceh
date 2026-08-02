// Shared WebAuthn helpers for Face ID / Touch ID / security key registration
// and verification, backed by @simplewebauthn/server.
//
// Relying-party config:
//   RP_ID   = hostname (no scheme, no port). Prod: 'www.dceholdings.app'
//             or 'dceholdings.app'. Set via env RP_ID or falls back to the
//             request Host header.
//   RP_NAME = 'DCE Holdings'
//   ORIGIN  = 'https://www.dceholdings.app' (also falls back to Origin header)
//
// Challenges live in admin_webauthn_challenges for ~5 min. Consumed on verify.

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const RP_NAME = 'DCE Holdings';

function getRpId(req) {
  if (process.env.RP_ID) return process.env.RP_ID;
  // Fall back to the request host (strip port if any)
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  return host || 'localhost';
}

function getExpectedOrigin(req) {
  if (process.env.RP_ORIGIN) return process.env.RP_ORIGIN;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// base64url helpers (no padding). @simplewebauthn accepts base64url strings.
function toB64Url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64Url(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

module.exports = {
  RP_NAME,
  getRpId,
  getExpectedOrigin,
  toB64Url,
  fromB64Url,
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};
