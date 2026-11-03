// 手机签发页共用签名模块(浏览器与 Node 共用; 无第三方依赖)
// 与 Python licensing/keys.py 的 payload_bytes / make_activation_code 同构:
//   payload = `${machine}|${expiry}|${features}`, RSA PKCS#1 v1.5 + SHA-256。

const MACHINE_RE = /^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/;

export function b64ToBytes(b64) {
  const bin = atob(String(b64 || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function payloadBytes(machine, expiryIso, features = "full") {
  return new TextEncoder().encode(`${machine}|${expiryIso}|${features}`);
}

export async function importKeyBundle(bundle, passphrase) {
  if (!bundle || bundle.version !== 1) throw new Error("钥匙包版本不支持");
  const kdf = bundle.kdf || {};
  if (kdf.name !== "PBKDF2-SHA256" || kdf.hash !== "SHA-256") {
    throw new Error("钥匙包 KDF 不支持");
  }
  const iterations = Number(kdf.iterations);
  if (!Number.isInteger(iterations) || iterations < 100000) {
    throw new Error("钥匙包迭代次数异常");
  }
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64ToBytes(kdf.salt), iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const keys = {};
  for (const [product, entry] of Object.entries(bundle.keys || {})) {
    let der;
    try {
      der = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: b64ToBytes(entry.iv),
          additionalData: new TextEncoder().encode(product),
        },
        aesKey,
        b64ToBytes(entry.data),
      );
    } catch {
      throw new Error("口令不对或钥匙包被篡改");
    }
    keys[product] = await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  if (!Object.keys(keys).length) throw new Error("钥匙包里没有可用私钥");
  return keys;
}

export async function signPayload(privateKey, payload) {
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, payload);
  return bytesToB64(new Uint8Array(sig));
}

export async function makeCompact(privateKey, machine, expiryIso, features = "full") {
  const sig = await signPayload(privateKey, payloadBytes(machine, expiryIso, features));
  return `${machine}|${expiryIso}|${features}|${sig}`;
}

export async function importPublicKeyB64(spkiB64) {
  return crypto.subtle.importKey(
    "spki",
    b64ToBytes(spkiB64),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

export async function verifyCompact(publicKey, compact) {
  const parts = String(compact || "").split("|");
  if (parts.length !== 4 || parts.some((p) => !p)) return false;
  const [machine, expiry, features, sig] = parts;
  return crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    publicKey,
    b64ToBytes(sig),
    payloadBytes(machine, expiry, features),
  );
}

export function normalizeMachineCode(input) {
  let value = String(input || "").toUpperCase().replace(/\s+/g, "");
  if (/^[0-9A-F]{16}$/.test(value)) value = value.match(/.{4}/g).join("-");
  return { value, valid: MACHINE_RE.test(value) };
}

export function isValidMachineCode(input) {
  return normalizeMachineCode(input).valid;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function offsetSuffix(date) {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

export function isoSecondsUtc(date = new Date()) {
  return (
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}` +
    `T${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}+00:00`
  );
}

export function isoFromNowDays(days, now = new Date()) {
  return isoSecondsUtc(new Date(now.getTime() + days * 86400000));
}

// 纯日期按手机本地时区的当天末尾(与 licensing/issuer.py 的 _parse_expire_at 同口径)
export function isoLocalEndOfDay(year, month, day) {
  const date = new Date(year, month - 1, day, 23, 59, 59);
  return `${year}-${pad2(month)}-${pad2(day)}T23:59:59${offsetSuffix(date)}`;
}