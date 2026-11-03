import {
  importKeyBundle,
  makeCompact,
  normalizeMachineCode,
  isoFromNowDays,
  isoLocalEndOfDay,
} from "./signer.js";

const PRODUCTS = {
  leadradar: "商机雷达",
  workbench: "私信工作台",
  jieliuguanjia: "截流管家",
};
const PRODUCT_ORDER = ["leadradar", "workbench", "jieliuguanjia"];
const LOCK_MS = 10 * 60 * 1000;
const DB_NAME = "issuer-app";
const DB_VERSION = 1;

let bundle = null;
let keys = null;
let selectedProduct = "leadradar";
let durationMode = "days";
let durationDays = 30;
let lastActivity = Date.now();
let hiddenAt = 0;
let dbPromise = null;
let toastTimer = 0;

const $ = (id) => document.getElementById(id);

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtLocal(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

function toast(text) {
  const node = $("toast");
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 2200);
}

function updateOfflineBar() {
  $("offlineBar").classList.toggle("show", !navigator.onLine);
}

function updatePhoneTime() {
  $("phoneTime").textContent = `本机时间 ${fmtLocal(new Date())}`;
}

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const handle = req.result;
        if (!handle.objectStoreNames.contains("kv")) handle.createObjectStore("kv");
        if (!handle.objectStoreNames.contains("issues")) {
          handle.createObjectStore("issues", { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function kvGet(key) {
  const handle = await db();
  return new Promise((resolve, reject) => {
    const tx = handle.transaction("kv", "readonly");
    const req = tx.objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function kvPut(key, value) {
  const handle = await db();
  return new Promise((resolve, reject) => {
    const tx = handle.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function kvDelete(key) {
  const handle = await db();
  return new Promise((resolve, reject) => {
    const tx = handle.transaction("kv", "readwrite");
    tx.objectStore("kv").delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function addIssue(record) {
  const handle = await db();
  return new Promise((resolve, reject) => {
    const tx = handle.transaction("issues", "readwrite");
    const req = tx.objectStore("issues").add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function allIssues() {
  const handle = await db();
  return new Promise((resolve, reject) => {
    const tx = handle.transaction("issues", "readonly");
    const req = tx.objectStore("issues").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function deleteIssue(id) {
  const handle = await db();
  return new Promise((resolve, reject) => {
    const tx = handle.transaction("issues", "readwrite");
    tx.objectStore("issues").delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("浏览器不支持复制");
}

async function copyAction(text, okText) {
  try {
    await copyText(text);
    toast(okText);
  } catch (e) {
    toast(`复制失败：${e.message}`);
  }
}

function bundleInfoText(loaded) {
  const names = Object.keys(loaded.keys || {}).map((p) => PRODUCTS[p] || p).join("、");
  const created = loaded.created_at ? fmtLocal(new Date(loaded.created_at)) : "未知";
  return `钥匙包：${names} · 生成于 ${created}`;
}

function renderLock(message = "") {
  $("lockScreen").hidden = false;
  $("appScreen").hidden = true;
  $("lockBtn").hidden = true;
  $("lockState").textContent = "已锁定";
  const hasBundle = !!bundle;
  $("lockTitle").textContent = hasBundle ? "输入口令解锁" : "首次使用：导入钥匙包";
  $("lockHint").textContent = hasBundle
    ? "口令只用于本机解密，不落盘；10 分钟无操作自动锁定。"
    : "在 PC 上生成 phone-keys.json 后，发到手机「文件」再导入。";
  $("importRow").hidden = hasBundle;
  $("unlockRow").hidden = !hasBundle;
  $("bundleInfo").textContent = hasBundle ? bundleInfoText(bundle) : "";
  $("lockMsg").textContent = message;
  $("passphrase").value = "";
}

async function unlock() {
  if (!bundle) return;
  const passphrase = $("passphrase").value;
  if (!passphrase) {
    $("lockMsg").textContent = "请输入口令";
    return;
  }
  const btn = $("unlockBtn");
  btn.disabled = true;
  btn.textContent = "解锁中…";
  try {
    keys = await importKeyBundle(bundle, passphrase);
    $("passphrase").value = "";
    enterApp();
  } catch (e) {
    $("lockMsg").textContent = `解锁失败：${e.message}`;
    $("passphrase").value = "";
  } finally {
    btn.disabled = false;
    btn.textContent = "解锁";
  }
}

function lock() {
  keys = null;
  $("resultBox").hidden = true;
  $("resultCode").value = "";
  $("issueMsg").textContent = "";
  $("machine").value = "";
  $("machineMsg").textContent = "";
  $("history").innerHTML = "";
  $("settingsMsg").textContent = "";
  $("bundleFile").value = "";
  renderLock();
}

function buildProductChips() {
  const available = PRODUCT_ORDER.filter((p) => keys && keys[p]);
  const box = $("productChips");
  box.innerHTML = "";
  if (!available.length) {
    $("issueMsg").textContent = "钥匙包里没有可用产品";
    return;
  }
  if (!available.includes(selectedProduct)) selectedProduct = available[0];
  for (const product of available) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `chip${product === selectedProduct ? " active" : ""}`;
    btn.textContent = PRODUCTS[product] || product;
    btn.addEventListener("click", () => {
      selectedProduct = product;
      buildProductChips();
    });
    box.appendChild(btn);
  }
}

function buildDurationChips() {
  const box = $("durationChips");
  box.innerHTML = "";
  const add = (label, active, onClick) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `chip${active ? " active" : ""}`;
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    box.appendChild(btn);
  };
  for (const days of [7, 30, 90, 365]) {
    add(`${days} 天`, durationMode === "days" && durationDays === days, () => {
      durationMode = "days";
      durationDays = days;
      refreshDuration();
    });
  }
  add("自定义", durationMode === "custom", () => {
    durationMode = "custom";
    refreshDuration();
  });
  add("指定日期", durationMode === "date", () => {
    durationMode = "date";
    refreshDuration();
  });
}

function refreshDuration() {
  $("customDaysRow").hidden = durationMode !== "custom";
  $("dateRow").hidden = durationMode !== "date";
  if (durationMode === "date" && !$("expiryDate").value) {
    const d = new Date(Date.now() + 30 * 86400000);
    $("expiryDate").value = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  buildDurationChips();
  updateExpiryPreview();
}

function computeExpiry() {
  if (durationMode === "date") {
    const value = $("expiryDate").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split("-").map(Number);
    const iso = isoLocalEndOfDay(year, month, day);
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return { iso, date };
  }
  const days = durationMode === "custom" ? Number($("customDays").value) : durationDays;
  if (!Number.isInteger(days) || days <= 0 || days > 3650) return null;
  const iso = isoFromNowDays(days);
  return { iso, date: new Date(iso) };
}

function updateExpiryPreview() {
  const info = computeExpiry();
  const node = $("expiryPreview");
  if (!info) {
    node.textContent = "有效期设置无效";
    node.classList.add("bad");
    return;
  }
  if (info.date.getTime() <= Date.now()) {
    node.textContent = `到期时间已过（${fmtLocal(info.date)}），请重新选择`;
    node.classList.add("bad");
    return;
  }
  node.textContent = `有效期至 ${fmtLocal(info.date)}（本机时间）`;
  node.classList.remove("bad");
}

async function saveIssue({ product, machine, expiry, features, code }) {
  const issued_at = new Date().toISOString();
  const record = {
    product,
    machine,
    expiry,
    features,
    code,
    issued_at,
    ledger_line: JSON.stringify({ product, issued_at, code }),
  };
  await addIssue(record);
}

async function renderHistory() {
  const list = $("history");
  list.innerHTML = "";
  let issues = [];
  try {
    issues = (await allIssues()).sort((a, b) => b.id - a.id);
  } catch {
    issues = [];
  }
  const now = Date.now();
  for (const record of issues.slice(0, 50)) {
    const li = document.createElement("li");
    li.className = "issue";

    const top = document.createElement("div");
    top.className = "issue-top";
    top.textContent = `${fmtLocal(new Date(record.issued_at))} · ${PRODUCTS[record.product] || record.product} · ${record.machine}`;

    const sub = document.createElement("div");
    sub.className = "issue-sub";
    const expired = new Date(record.expiry).getTime() <= now;
    sub.textContent = `至 ${fmtLocal(new Date(record.expiry))} · ${expired ? "已过期" : "有效"}`;

    const row = document.createElement("div");
    row.className = "row";
    const copyCode = document.createElement("button");
    copyCode.type = "button";
    copyCode.textContent = "复制码";
    copyCode.addEventListener("click", () => copyAction(record.code, "激活码已复制"));
    const copyLine = document.createElement("button");
    copyLine.type = "button";
    copyLine.textContent = "复制补记";
    copyLine.addEventListener("click", () => copyAction(record.ledger_line, "补记已复制"));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost";
    remove.textContent = "删除记录";
    remove.addEventListener("click", async () => {
      if (!confirm("删除这条本机记录？已签出的激活码不受影响。")) return;
      try {
        await deleteIssue(record.id);
        await renderHistory();
        toast("记录已删除");
      } catch (e) {
        toast(`删除失败：${e.message}`);
      }
    });
    row.append(copyCode, copyLine, remove);

    li.append(top, sub, row);
    list.appendChild(li);
  }
  $("historyMsg").textContent = issues.length
    ? `共 ${issues.length} 条 · 只在这台手机上；PC 台账用「复制全部补记」导入`
    : "还没有签发记录";
}

async function issue() {
  if (!keys) {
    renderLock("请先解锁");
    return;
  }
  const mc = normalizeMachineCode($("machine").value);
  if (!mc.valid) {
    $("machineMsg").textContent = "机器码格式不对：应形如 A1B2-C3D4-E5F6-7890";
    $("machine").focus();
    return;
  }
  $("machine").value = mc.value;
  const info = computeExpiry();
  if (!info) {
    $("issueMsg").textContent = "有效期设置无效";
    return;
  }
  if (info.date.getTime() <= Date.now()) {
    $("issueMsg").textContent = "到期时间已经过去，请重新选择";
    return;
  }
  const key = keys[selectedProduct];
  if (!key) {
    $("issueMsg").textContent = "这个产品的钥匙不在钥匙包里";
    return;
  }
  const btn = $("issueBtn");
  btn.disabled = true;
  btn.textContent = "生成中…";
  $("issueMsg").textContent = "";
  try {
    const code = await makeCompact(key, mc.value, info.iso, "full");
    $("resultBox").hidden = false;
    $("resultCode").value = code;
    $("issueMsg").textContent = `已生成 · 到期 ${fmtLocal(info.date)} · 已记入本机记录`;
    await saveIssue({
      product: selectedProduct,
      machine: mc.value,
      expiry: info.iso,
      features: "full",
      code,
    });
    await renderHistory();
    try {
      await copyText(code);
      toast("激活码已复制");
    } catch {
      toast("已生成，点「复制激活码」");
    }
  } catch (e) {
    $("issueMsg").textContent = `生成失败：${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "生成激活码";
  }
}

function enterApp() {
  $("lockScreen").hidden = true;
  $("appScreen").hidden = false;
  $("lockBtn").hidden = false;
  $("lockState").textContent = "已解锁";
  $("lockMsg").textContent = "";
  buildProductChips();
  refreshDuration();
  renderHistory();
  updatePhoneTime();
  lastActivity = Date.now();
}

async function importBundleFile(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || parsed.version !== 1 || !parsed.keys || !Object.keys(parsed.keys).length) {
      throw new Error("不是有效的钥匙包");
    }
    await kvPut("bundle", parsed);
    bundle = parsed;
    keys = null;
    renderLock("钥匙包已导入，请输入口令解锁");
    toast("钥匙包已导入");
  } catch (e) {
    renderLock(`导入失败：${e.message}`);
  }
}

function touch() {
  lastActivity = Date.now();
}

$("unlockBtn").addEventListener("click", unlock);
$("passphrase").addEventListener("keydown", (event) => {
  if (event.key === "Enter") unlock();
});
$("lockBtn").addEventListener("click", lock);
$("issueBtn").addEventListener("click", issue);
$("copyCode").addEventListener("click", () => copyAction($("resultCode").value, "激活码已复制"));
$("pasteBtn").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    const mc = normalizeMachineCode(text);
    $("machine").value = mc.value || text.trim();
    $("machineMsg").textContent = mc.valid ? "" : "剪贴板里不是机器码格式";
  } catch {
    $("machine").focus();
    $("machineMsg").textContent = "读剪贴板失败，请长按输入框手动粘贴";
  }
});
$("machine").addEventListener("input", () => {
  const node = $("machine");
  node.value = node.value.toUpperCase().replace(/\s+/g, "");
  $("machineMsg").textContent = "";
});
$("machine").addEventListener("blur", () => {
  const raw = $("machine").value.trim();
  if (!raw) {
    $("machineMsg").textContent = "";
    return;
  }
  const mc = normalizeMachineCode(raw);
  $("machine").value = mc.value || raw;
  $("machineMsg").textContent = mc.valid ? "" : "机器码应为 4 组十六进制，如 A1B2-C3D4-E5F6-7890";
});
$("customDays").addEventListener("input", updateExpiryPreview);
$("expiryDate").addEventListener("change", updateExpiryPreview);

$("importBtn").addEventListener("click", () => $("bundleFile").click());
$("changeBundle").addEventListener("click", () => $("bundleFile").click());
$("bundleFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) await importBundleFile(file);
});

$("deleteBundle").addEventListener("click", async () => {
  if (!confirm("删除本机钥匙包？本机签发记录会保留。删除后要重新导入才能签。")) return;
  try {
    await kvDelete("bundle");
    bundle = null;
    lock();
    renderLock("钥匙包已删除，请重新导入");
  } catch (e) {
    $("settingsMsg").textContent = `删除失败：${e.message}`;
  }
});

$("copyLedger").addEventListener("click", async () => {
  let issues = [];
  try {
    issues = (await allIssues()).sort((a, b) => a.id - b.id);
  } catch {
    issues = [];
  }
  if (!issues.length) {
    toast("还没有可复制的补记");
    return;
  }
  await copyAction(issues.map((r) => r.ledger_line).join("\n"), `已复制 ${issues.length} 条补记`);
});

document.addEventListener("pointerdown", touch, { passive: true });
document.addEventListener("keydown", touch);
document.addEventListener("input", touch);
window.addEventListener("online", updateOfflineBar);
window.addEventListener("offline", updateOfflineBar);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    return;
  }
  if (keys && hiddenAt && Date.now() - hiddenAt > LOCK_MS) {
    lock();
    toast("已自动锁定");
  } else {
    lastActivity = Date.now();
    updatePhoneTime();
  }
  hiddenAt = 0;
});

setInterval(() => {
  if (keys && Date.now() - lastActivity > LOCK_MS) {
    lock();
    toast("已自动锁定");
  }
}, 15000);
setInterval(updatePhoneTime, 30000);

(async function init() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
  }
  try {
    bundle = await kvGet("bundle");
  } catch {
    bundle = null;
  }
  renderLock();
  updateOfflineBar();
  updatePhoneTime();
})();