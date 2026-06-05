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

// ── Passphrase-protected key backup (multi-device restore) ───────────────────
// Stretch a passphrase into a 32-byte secretbox key (iterated SHA-512 → 32 B).
function deriveKey(passphrase: string, salt: Uint8Array): Uint8Array {
  let h = nacl.hash(new Uint8Array([...decodeUTF8(passphrase), ...salt]));
  for (let i = 0; i < 20000; i++) h = nacl.hash(h);
  return h.slice(0, nacl.secretbox.keyLength);
}

/** Encrypt our private key with `passphrase` and upload the opaque blob. */
export async function backupKey(passphrase: string): Promise<void> {
  const { priv } = await ensureKeyPair();
  const salt = nacl.randomBytes(16);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const key = deriveKey(passphrase, salt);
  const box = nacl.secretbox(priv, nonce, key);
  const blob = JSON.stringify({
    v: 1, salt: encodeBase64(salt), nonce: encodeBase64(nonce), box: encodeBase64(box),
  });
  await api.uploadE2EBackup(blob);
}

/** Fetch the backup, decrypt with `passphrase`, and install the key on this
 *  device (so old end-to-end messages become readable again). */
export async function restoreKey(passphrase: string): Promise<boolean> {
  const { blob } = await api.getE2EBackup();
  if (!blob) throw new Error("No backup found");
  const { salt, nonce, box } = JSON.parse(blob);
  const key = deriveKey(passphrase, decodeBase64(salt));
  const priv = nacl.secretbox.open(decodeBase64(box), decodeBase64(nonce), key);
  if (!priv) throw new Error("Wrong passphrase");
  const kp = nacl.box.keyPair.fromSecretKey(priv);
  await storage.secureSet(PRIV_KEY, encodeBase64(kp.secretKey));
  await storage.secureSet(PUB_KEY, encodeBase64(kp.publicKey));
  cachedPriv = kp.secretKey;
  cachedPub = kp.publicKey;
  try { await api.uploadE2EKey(encodeBase64(kp.publicKey)); } catch {}
  return true;
}

export async function hasBackup(): Promise<boolean> {
  try { return (await api.getE2EBackup()).has_backup; } catch { return false; }
}

/** Seal `plain` to every recipient (and to self, so we can re-read it). Works
 *  for DMs (one recipient) and group chats (many). */
export async function encryptForRecipients(
  plain: string,
  recipientPubs: Uint8Array[],
): Promise<string> {
  const { priv, pub } = await ensureKeyPair();
  const mkBox = (peer: Uint8Array) => {
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const box = nacl.box(decodeUTF8(plain), nonce, peer, priv);
    return `${encodeBase64(nonce)}.${encodeBase64(box)}`;
  };
  const seen = new Set<string>();
  const boxes: string[] = [];
  for (const p of [...recipientPubs, pub]) {
    const k = encodeBase64(p);
    if (seen.has(k)) continue;     // de-dup (self may already be in the list)
    seen.add(k);
    boxes.push(mkBox(p));
  }
  return `${PREFIX}${boxes.join("|")}`;
}

export async function encryptForPeer(plain: string, peerPub: Uint8Array): Promise<string> {
  return encryptForRecipients(plain, [peerPub]);
}

export function isE2E(value: string): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

// ── Binary payloads (media / voice / files) — hybrid encryption ──────────────
// The blob is sealed ONCE with a random symmetric key (secretbox); that key is
// then sealed to each recipient (and self) with box. Efficient for groups.
const MEDIA_PREFIX = "e2eb:v1:";

export function isE2EMedia(value: string): boolean {
  return typeof value === "string" && value.startsWith(MEDIA_PREFIX);
}

export async function encryptDataForRecipients(
  dataUri: string,
  recipientPubs: Uint8Array[],
): Promise<string> {
  const { priv, pub } = await ensureKeyPair();
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(decodeUTF8(dataUri), nonce, key);
  const sealKey = (peer: Uint8Array) => {
    const kn = nacl.randomBytes(nacl.box.nonceLength);
    const kb = nacl.box(key, kn, peer, priv);
    return `${encodeBase64(kn)}.${encodeBase64(kb)}`;
  };
  const seen = new Set<string>();
  const envs: string[] = [];
  for (const p of [...recipientPubs, pub]) {
    const k = encodeBase64(p);
    if (seen.has(k)) continue;
    seen.add(k);
    envs.push(sealKey(p));
  }
  return `${MEDIA_PREFIX}${encodeBase64(nonce)}:${encodeBase64(ct)}~${envs.join("|")}`;
}

export async function decryptData(value: string, senderPub: Uint8Array | null): Promise<string | null> {
  if (!isE2EMedia(value)) return null;
  const { priv } = await ensureKeyPair();
  const body = value.slice(MEDIA_PREFIX.length);
  const [head, envPart] = body.split("~");
  if (!head || !envPart) return null;
  const [nB, ctB] = head.split(":");
  if (!nB || !ctB) return null;
  const peers: Uint8Array[] = [];
  if (senderPub) peers.push(senderPub);
  if (cachedPub) peers.push(cachedPub);
  for (const env of envPart.split("|")) {
    const [kn, kb] = env.split(".");
    if (!kn || !kb) continue;
    try {
      const key = (() => {
        for (const peer of peers) {
          const k = nacl.box.open(decodeBase64(kb), decodeBase64(kn), peer, priv);
          if (k) return k;
        }
        return null;
      })();
      if (key) {
        const data = nacl.secretbox.open(decodeBase64(ctB), decodeBase64(nB), key);
        if (data) return encodeUTF8(data);
      }
    } catch {}
  }
  return null;
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
