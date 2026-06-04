/**
 * E2E encryption for 1:1 DM text using NaCl box (X25519 + XSalsa20-Poly1305).
 *
 * - Private key is generated once per device, stored in SecureStore.
 * - Public key is uploaded to backend so peers can fetch it.
 * - Ciphertext envelope: `e2e:v1:<nonce_b64>:<box_b64>` (text-only).
 * - When sending, we encrypt TWO copies (one for recipient, one for self)
 *   and concatenate with `|` so the sender can also read the message back.
 *
 * Failure mode: if either side has no key, we fall back to plaintext (so the
 * app keeps working). UI marks E2E messages with a small lock badge.
 */
import nacl from "tweetnacl";
import { decodeBase64, encodeBase64, decodeUTF8, encodeUTF8 } from "tweetnacl-util";
import { storage } from "@/src/utils/storage";
import { api } from "@/src/api/client";

const PRIV_KEY = "atlas:e2e:priv";
const PUB_KEY = "atlas:e2e:pub";
const PREFIX = "e2e:v1:";

let cachedPriv: Uint8Array | null = null;
let cachedPub: Uint8Array | null = null;

export async function ensureKeyPair(): Promise<{ pub: Uint8Array; priv: Uint8Array }> {
  if (cachedPriv && cachedPub) return { priv: cachedPriv, pub: cachedPub };
  let priv64 = await storage.secureGet(PRIV_KEY);
  let pub64 = await storage.secureGet(PUB_KEY);
  if (!priv64 || !pub64) {
    const kp = nacl.box.keyPair();
    priv64 = encodeBase64(kp.secretKey);
    pub64 = encodeBase64(kp.publicKey);
    await storage.secureSet(PRIV_KEY, priv64);
    await storage.secureSet(PUB_KEY, pub64);
  }
  cachedPriv = decodeBase64(priv64);
  cachedPub = decodeBase64(pub64);
  // Best-effort: publish our public key so peers can encrypt to us.
  try { await api.uploadE2EKey(pub64); } catch {}
  return { priv: cachedPriv, pub: cachedPub };
}

export async function getPeerPublicKey(userId: string): Promise<Uint8Array | null> {
  try {
    const { public_key } = await api.getUserE2EKey(userId);
    return public_key ? decodeBase64(public_key) : null;
  } catch { return null; }
}

export async function encryptForPeer(
  plain: string,
  peerPub: Uint8Array,
): Promise<string> {
  const { priv, pub } = await ensureKeyPair();
  const mkBox = (peer: Uint8Array) => {
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const box = nacl.box(decodeUTF8(plain), nonce, peer, priv);
    return `${encodeBase64(nonce)}.${encodeBase64(box)}`;
  };
  // Encrypt for both peer AND self (so we can re-read our own messages).
  return `${PREFIX}${mkBox(peerPub)}|${mkBox(pub)}`;
}

export function isE2E(value: string): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export async function tryDecrypt(value: string, peerPub: Uint8Array | null): Promise<string | null> {
  if (!isE2E(value)) return null;
  const { priv } = await ensureKeyPair();
  const body = value.slice(PREFIX.length);
  const parts = body.split("|");
  // Try each envelope; one of them is for us.
  const peers: Uint8Array[] = [];
  if (peerPub) peers.push(peerPub);
  if (cachedPub) peers.push(cachedPub);
  for (const part of parts) {
    const [n, c] = part.split(".");
    if (!n || !c) continue;
    try {
      const nonce = decodeBase64(n);
      const cipher = decodeBase64(c);
      for (const peer of peers) {
        const opened = nacl.box.open(cipher, nonce, peer, priv);
        if (opened) return encodeUTF8(opened);
      }
    } catch {}
  }
  return null;
}
