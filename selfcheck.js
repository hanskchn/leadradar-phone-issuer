import {
  importKeyBundle,
  importPublicKeyB64,
  makeCompact,
  verifyCompact,
  normalizeMachineCode,
} from "./signer.js";

const TEST = {
  passphrase: "selfcheck-2026",
  machine: "A1B2-C3D4-E5F6-7890",
  expiry: "2026-12-31T23:59:59+08:00",
  features: "full",
  expectedSig:
    "OcJTQF1ChknOGFODpqUzyWGCVeg1KHX4ORFmy2tQf5wULww08/hxd4DJ9WsZK07KplzRvtWUyWECTbzsPYSZEDeozdm+G7xsf/KQsN6gt650NyHkIetDBjBsATEhlZzExhC5qlcsuPGhQqvCcgUW6CXLSQ5jtaTc5MiyLT0ZkvbbUlYWxeQd02RDzsSDGE7N7YmZanhmonLNWnTyxbGHQESXh3+joKd5qYojKIO0ByK6VDd+PNlL0+xsv3OpZflUPy6TKaX45njAS+X22tc8WN6dVBH0eQ9DsIKeLLxvacT1aWnVPWsW4lhrLKv1e+ebX8CitVH+oq93cHEtfxUf5Q==",
  publicKeyB64:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnfMA1e49E/W8sdLu8N/JbaWcSDfIFXYTA5wqKlY5nEKTRtrJYlQasSM7H0RCg91UzEaNQfHARaRadCR6S3DcM7ugjjxkU+TSEIQKwZGYXJCFcilgj19Erzoczq5gpBAmFo9SKxs85ZfZztLxWE/Ut2DADTLUt4LzluiAdp6xWXtakmgLrTRUHGDd19ChEENkTylBkpLZb2W7nZ+bn8REsiOFY+Qwh4soTJnr0XkmKrGDDdCDwIl0S/91YK8HtLUJOsgLNMZTx+FxC61TvLUatPXk1PxLQZRh3auUG+Oq13jKjHgSXLtEYYRwsH01EMCihoRzkTBxwdvGuE6+4PO1qQIDAQAB",
};

const rows = new Map();
const el = (id) => document.getElementById(id);

function statusIcon(status) {
  return { ok: "✓", fail: "✗", warn: "!", pending: "…" }[status] || "…";
}

function upsert(id, label, status, detail = "") {
  rows.set(id, { label, status, detail });
  const ul = el("results");
  let li = ul.querySelector(`[data-row="${id}"]`);
  if (!li) {
    li = document.createElement("li");
    li.dataset.row = id;
    li.innerHTML = '<span class="icon"></span><span><span class="label"></span><div class="detail"></div></span>';
    ul.appendChild(li);
  }
  const icon = li.querySelector(".icon");
  icon.className = `icon ${status}`;
  icon.textContent = statusIcon(status);
  li.querySelector(".label").textContent = label;
  li.querySelector(".detail").textContent = detail;
  summarize();
}

function summarize() {
  const values = [...rows.values()];
  const ok = values.filter((r) => r.status === "ok").length;
  const fail = values.filter((r) => r.status === "fail").length;
  const manualIds = ["file", "clipboard"];
  const pendingManual = manualIds.filter((id) => !rows.has(id) || rows.get(id).status !== "ok").length;
  el("summary").textContent =
    `自动项 ${ok} 通过 / ${fail} 失败 · 手测项 ${pendingManual ? `${pendingManual} 项待完成` : "全部通过"}`;
}

function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

function updateBadges() {
  const secure = !!window.isSecureContext;
  const subtle = !!globalThis.crypto?.subtle;
  const standalone = isStandalone();
  const set = (id, text, good) => {
    const node = el(id);
    node.textContent = `${text} ${good ? "✓" : "✗"}`;
    node.className = `badge ${good ? "good" : "bad"}`;
  };
  set("bSecure", "安全上下文", secure);
  set("bCrypto", "WebCrypto", subtle);
  set("bStandalone", "独立窗口", standalone);
}

function updateOfflineBar() {
  el("offlineBar").classList.toggle("show", !navigator.onLine);
}

async function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("issuer-selfcheck", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readonly");
    const req = tx.objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function runEnv() {
  const secure = !!window.isSecureContext;
  const subtle = !!globalThis.crypto?.subtle;
  const standalone = isStandalone();
  if (!secure || !subtle) {
    upsert("env", "环境", "fail", `isSecureContext=${secure}, crypto.subtle=${subtle}`);
    return false;
  }
  upsert(
    "env",
    "环境",
    "ok",
    `${standalone ? "独立窗口" : "浏览器标签页"} · ${navigator.userAgent}`,
  );
  return true;
}

async function runCrypto() {
  const started = performance.now();
  try {
    const mc = normalizeMachineCode(TEST.machine);
    if (!mc.valid) throw new Error("机器码样本校验失败");
    const resp = await fetch("./test-phone-keys.json", { cache: "no-store" });
    if (!resp.ok) throw new Error(`取测试钥匙包失败 HTTP ${resp.status}`);
    const bundle = await resp.json();
    const keys = await importKeyBundle(bundle, TEST.passphrase);
    const code = await makeCompact(keys.leadradar, TEST.machine, TEST.expiry, TEST.features);
    const sig = code.split("|")[3];
    if (sig !== TEST.expectedSig) throw new Error("签名与 PC 上 Python 样本不一致");
    const pub = await importPublicKeyB64(TEST.publicKeyB64);
    if (!(await verifyCompact(pub, code))) throw new Error("公钥验签失败");
    let wrongRejected = false;
    try {
      await importKeyBundle(bundle, "wrong-passphrase");
    } catch {
      wrongRejected = true;
    }
    if (!wrongRejected) throw new Error("错误口令没有被拒绝");
    upsert(
      "crypto",
      "加密签名",
      "ok",
      `与 PC 样本逐字一致 · 错口令已拒绝 · ${Math.round(performance.now() - started)} ms`,
    );
    return true;
  } catch (e) {
    upsert("crypto", "加密签名", "fail", String(e?.message || e));
    return false;
  }
}

async function runStorage() {
  try {
    const lsKey = "issuer-selfcheck.lastRun";
    const prevLs = localStorage.getItem(lsKey);
    localStorage.setItem(lsKey, new Date().toISOString());
    const prevIdb = await idbGet("lastRun");
    await idbPut("lastRun", new Date().toISOString());
    let persisted = "未知";
    if (navigator.storage?.persisted) {
      persisted = (await navigator.storage.persisted()) ? "持久" : "非持久";
    }
    upsert(
      "storage",
      "本地存储",
      "ok",
      `localStorage ${prevLs ? "有上次记录" : "首次写入"} · IndexedDB ${prevIdb ? "有上次记录" : "首次写入"} · ${persisted}`,
    );
    return true;
  } catch (e) {
    upsert("storage", "本地存储", "fail", String(e?.message || e));
    return false;
  }
}

async function runServiceWorker() {
  try {
    if (!("serviceWorker" in navigator)) throw new Error("浏览器不支持 service worker");
    await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    await navigator.serviceWorker.ready;
    const names = (await caches.keys()).filter((n) => n.startsWith("issuer-selfcheck-"));
    let cached = false;
    if (names.length) {
      const cache = await caches.open(names[0]);
      cached = !!(await cache.match("./test-phone-keys.json"));
    }
    const detail = `${navigator.onLine ? "在线" : "已断网"} · 缓存 ${names.join(",") || "无"} · 测试钥匙包${cached ? "已缓存" : "未缓存"}`;
    upsert("sw", "离线缓存", cached ? "ok" : "warn", detail);
    el("swResult").textContent = detail;
    return cached;
  } catch (e) {
    upsert("sw", "离线缓存", "fail", String(e?.message || e));
    el("swResult").textContent = `失败：${e?.message || e}`;
    return false;
  }
}

async function runAll() {
  const btn = el("runAll");
  btn.disabled = true;
  btn.textContent = "自检中…";
  rows.clear();
  el("results").innerHTML = "";
  el("summary").textContent = "";
  await runEnv();
  await runCrypto();
  await runStorage();
  await runServiceWorker();
  updateBadges();
  btn.disabled = false;
  btn.textContent = "重新自检";
}

const CLIP_TOKEN = "issuer-clipboard-test-ok";

async function copyText(text) {
  if (!navigator.clipboard?.writeText) throw new Error("没有 navigator.clipboard");
  await navigator.clipboard.writeText(text);
}

async function readText() {
  if (!navigator.clipboard?.readText) throw new Error("没有 navigator.clipboard.readText");
  return navigator.clipboard.readText();
}

el("runAll").addEventListener("click", runAll);

el("clipWrite").addEventListener("click", async () => {
  try {
    await copyText(CLIP_TOKEN);
    el("clipResult").textContent = "已写入。切到备忘录粘贴能看到，就说明写入可用。";
  } catch (e) {
    el("clipResult").textContent = `写入失败：${e?.message || e}`;
  }
});

el("clipRead").addEventListener("click", async () => {
  try {
    const text = await readText();
    const ok = text === CLIP_TOKEN;
    el("clipResult").textContent = ok ? "读回与写入一致 ✓" : `读回内容不一致：${text.slice(0, 24)}`;
    upsert("clipboard", "剪贴板", ok ? "ok" : "fail", ok ? "读写一致" : "内容不一致");
  } catch (e) {
    el("clipResult").textContent = `读回失败（Safari 可能弹出粘贴权限）：${e?.message || e}`;
    upsert("clipboard", "剪贴板", "warn", "写入可用；读回受限，手动粘贴验证即可");
  }
});

el("keyFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  el("fileResult").textContent = "读取中…";
  try {
    const bundle = JSON.parse(await file.text());
    if (Object.keys(bundle.keys || {}).length !== 1) {
      throw new Error("这看起来是真钥匙包；自检页只认测试钥匙包，请点顶部「返回签发器」导入");
    }
    const keys = await importKeyBundle(bundle, TEST.passphrase);
    const code = await makeCompact(keys.leadradar, TEST.machine, TEST.expiry, TEST.features);
    const ok = code.split("|")[3] === TEST.expectedSig;
    el("fileResult").textContent = ok
      ? `文件导入 + 解密 + 签名一致 ✓（${file.name}）`
      : "签名不一致 ✗（文件内容不对？）";
    upsert("file", "文件导入", ok ? "ok" : "fail", file.name);
  } catch (e) {
    const reason = String(e?.message || e);
    const hint = reason.includes("口令不对")
      ? "（自检页只认 test-phone-keys.json；真钥匙包请点顶部「返回签发器」导入）"
      : "";
    el("fileResult").textContent = `失败：${reason}${hint}`;
    upsert("file", "文件导入", "fail", reason);
  }
});

el("copyDiag").addEventListener("click", async () => {
  const lines = [
    `[手机签发器自检] ${new Date().toISOString()}`,
    `地址: ${location.href}`,
    `独立窗口: ${isStandalone()}`,
    `安全上下文: ${!!window.isSecureContext}`,
    `断网: ${!navigator.onLine}`,
    `UA: ${navigator.userAgent}`,
    "结果:",
    ...[...rows.entries()].map(([id, r]) => `- ${id} ${r.label}: ${r.status} ${r.detail}`),
  ];
  try {
    await copyText(lines.join("\n"));
    el("summary").textContent += " · 诊断结果已复制";
  } catch (e) {
    el("summary").textContent = `诊断复制失败：${e?.message || e}`;
  }
});

window.addEventListener("online", updateOfflineBar);
window.addEventListener("offline", updateOfflineBar);

updateBadges();
updateOfflineBar();
upsert("env", "环境", "pending", "点「一键自检」开始");