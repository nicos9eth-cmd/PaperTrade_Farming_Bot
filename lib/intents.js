'use strict';

// Signed intents for Papertrade's relayer, in the same format as the official frontend.

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const api = require('./api');

const CHAIN_ID = 999;
const EXCHANGE = '0x6cd5661646289FB6E65EA5C032310fDEd797D0a2';
const DOMAIN = { name: 'String', version: '1', chainId: CHAIN_ID, verifyingContract: EXCHANGE };
const INTENT_ID_PREFIX = ethers.keccak256(ethers.toUtf8Bytes('papertrade:intent-id:v2'));
const DEADLINE_SECONDS = 3600;
const KEY_TTL_SECONDS = 30 * 24 * 3600;
const KEY_FILE = path.join(__dirname, '..', '.session-key.json');

const TYPES = {
  RegisterSessionKey: [
    { name: 'user', type: 'address' },
    { name: 'key', type: 'address' },
    { name: 'expiry', type: 'uint64' },
    { name: 'feeAddress', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
  OpenPosition: [
    { name: 'user', type: 'address' },
    { name: 'instrumentId', type: 'uint32' },
    { name: 'isLong', type: 'bool' },
    { name: 'size', type: 'uint128' },
    { name: 'leverage', type: 'uint32' },
    { name: 'useDebt', type: 'bool' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
  Close: [
    { name: 'user', type: 'address' },
    { name: 'positionIds', type: 'uint256[]' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
};

const deadline = (seconds = DEADLINE_SECONDS) => BigInt(Math.floor(Date.now() / 1000) + seconds);

// Client-chosen nonces: a random 24-bit base shifted by one byte, then counted up.
let nextNonce = null;
function takeNonce() {
  if (nextNonce === null) nextNonce = (BigInt(ethers.hexlify(ethers.randomBytes(3))) || 1n) * 256n;
  return nextNonce++;
}

function wireValue(type, value) {
  if (type === 'uint256[]') return value.map((v) => BigInt(v).toString());
  if (type.startsWith('uint')) return BigInt(value).toString();
  if (type === 'address' || type.startsWith('bytes')) return value.toLowerCase();
  return value;
}

// Wire payload for a typed message and its signature, plus the intent id the relayer must echo.
function pack(type, message, signature) {
  const types = { [type]: TYPES[type] };
  const digest = ethers.TypedDataEncoder.hash(DOMAIN, types, message);
  const signer = ethers.recoverAddress(digest, signature).toLowerCase();
  const sig = ethers.Signature.from(signature);
  const signed = {};
  for (const { name, type: t } of TYPES[type]) signed[name] = wireValue(t, message[name]);
  Object.assign(signed, { v: String(sig.v), r: sig.r.toLowerCase(), s: sig.s.toLowerCase() });
  return { signed, signer, intentId: ethers.keccak256(ethers.concat([INTENT_ID_PREFIX, digest, signer])) };
}

// JSON typed data for a browser wallet (eth_signTypedData_v4).
function typedData(type, message) {
  const types = { [type]: TYPES[type] };
  const payload = JSON.parse(
    JSON.stringify(ethers.TypedDataEncoder.getPayload(DOMAIN, types, message), (k, v) => (typeof v === 'bigint' ? v.toString() : v))
  );
  payload.domain.chainId = CHAIN_ID;
  return payload;
}

async function submit(action, packed, build) {
  let res;
  try {
    res = await api.request(api.PT_HOST, '/intents', { action, signed: packed.signed }, build ? { 'X-Papertrade-Build': build } : {}, 35000);
  } catch (e) {
    // Accepted (2xx) but with a body the bot cannot read: treat it as accepted, not as a refusal.
    if (e.status >= 200 && e.status < 300) return { idMismatch: false };
    const p = e.payload || {};
    const err = new Error(`${action} refusé : ${p.message || p.code || p.error || e.message}${p.reason ? ` (${p.reason})` : ''}`);
    err.code = p.code || p.error || null;
    err.reason = p.reason || null;
    err.status = e.status;
    throw err;
  }
  if (res.error || res.ok === false) {
    const err = new Error(`${action} refusé : ${res.message || res.code || res.error}`);
    err.code = res.code || res.error;
    throw err;
  }
  // The relayer accepted the order. The id formula is reverse-engineered, so a different id is
  // flagged rather than treated as a failure (which would make the bot resend an accepted order).
  res.idMismatch = res.intentId !== packed.intentId;
  return res;
}

// The saved key, or null if there is none or the file is unreadable.
function loadKey() {
  try {
    const k = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    return { ...k, wallet: new ethers.Wallet(k.privateKey) };
  } catch (e) {
    return null;
  }
}

// A fresh key kept in memory only; saveKey writes it once the relayer has accepted its registration.
function newKey(user) {
  const w = ethers.Wallet.createRandom();
  return { user: user.toLowerCase(), address: w.address.toLowerCase(), privateKey: w.privateKey, expiry: Math.floor(Date.now() / 1000) + KEY_TTL_SECONDS, wallet: w };
}

function saveKey(key) {
  const { wallet, ...stored } = key;
  const tmp = KEY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 2));
  fs.renameSync(tmp, KEY_FILE);
}

function registerMessage(key) {
  return { user: key.user, key: key.address, expiry: BigInt(key.expiry), feeAddress: ethers.ZeroAddress, nonce: takeNonce(), deadline: deadline() };
}

async function signWithKey(key, type, message) {
  const signature = await key.wallet.signTypedData(DOMAIN, { [type]: TYPES[type] }, message);
  return pack(type, message, signature);
}

async function openPosition(key, build, { instrumentId, isLong, marginRaw, leverage, deadlineSeconds }) {
  const message = { user: key.user, instrumentId, isLong, size: marginRaw, leverage, useDebt: false, nonce: takeNonce(), deadline: deadline(deadlineSeconds) };
  return submit('openPosition', await signWithKey(key, 'OpenPosition', message), build);
}

async function closePositions(key, build, positionIds) {
  const message = { user: key.user, positionIds: positionIds.map(BigInt), nonce: takeNonce(), deadline: deadline() };
  return submit('closePositions', await signWithKey(key, 'Close', message), build);
}

module.exports = { CHAIN_ID, DOMAIN, TYPES, KEY_FILE, loadKey, newKey, saveKey, registerMessage, typedData, pack, submit, openPosition, closePositions };
