// ==UserScript==
// @name         Auto Reply Support (Omni Support)
// @namespace    auto-reply-support
// @version      2.9.1
// @description  Tự động trả lời "Hi"/"Chào bạn" cho chat đang ở trạng thái Assigned trên Omni Support
// @match        https://omnisupport.fpt.ai/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// ==/UserScript==

// =====================================================================
// Auto Reply Support — bản userscript (Tampermonkey) của extension v2.9.
// Quy tắc duy nhất: chat nào đang ở trạng thái "Assigned" thì gửi
// "Chào bạn" (tiếng Việt) hoặc "Hi" (tiếng Anh). Chat "Supporting"
// (đã được trả lời) tuyệt đối không bị đụng tới.
//
// Khác bản extension:
//  - Không có Service Worker -> timer chạy trong Web Worker (ít bị Chrome
//    làm chậm khi tab ở nền) + MutationObserver + setInterval dự phòng.
//  - Bật/tắt bằng nút nổi góc dưới-trái trang (hoặc menu Tampermonkey).
//  - Nếu mở nhiều tab Omni Support, chỉ 1 tab được chạy (Web Locks).
// =====================================================================

(function () {
"use strict";

if (window.__crmStop) { try { window.__crmStop(); } catch (e) {} }

const LOG = (...a) => console.log("[CRM EXT]", ...a);

const REPLY = { vi: "Chào bạn", en: "Hi" };

const POLL_MS = 1000;          // content script tự quét mỗi 1s (không phụ thuộc alarm)
const OPEN_SETTLE_MS = 1200;   // chờ UI mở khung chat sau khi click (chỉnh lên nếu UI load chậm)
const SEND_VERIFY_MS = 6000;   // sau khi bấm Send, chờ tối đa 6s để thấy trạng thái đổi khỏi Assigned
const MAX_ATTEMPTS = 2;        // mỗi chat thử tối đa 2 lần, rồi nghỉ 60s mới thử lại
const RETRY_COOLDOWN_MS = 60000;

// --- Độ trễ để không chuyển chat quá nhanh ---
const NEW_CHAT_DELAY_MS = 10000;    // chat phải ở trạng thái Assigned đủ 10s mới bắt đầu xử lý (các chat đếm SONG SONG, không cộng dồn)
const BETWEEN_CHATS_MS = 5000;      // tin 'Hi'/'Xin chào' gửi đi được 5s thì chuyển sang chat chưa trả lời kế tiếp
const POST_SEND_SETTLE_MS = 2000;   // sau khi bấm Send, đứng yên thêm 2s để tin nhắn kịp được ghi nhận

// --- Bảo vệ tin nhắn đang gõ dở của agent ---
const TYPING_GRACE_MS = 4000;          // vừa gõ phím trong 4s gần nhất -> hoãn
const CLICK_GRACE_MS = 2500;           // vừa click chuột trong 2,5s gần nhất -> hoãn (tránh tranh chấp thao tác)
const DRAFT_PROTECT_MS = 2 * 60000;    // tin gõ dở do CHÍNH BẠN gõ trong 2 phút gần nhất -> hoãn

// ---------------------------------------------------------------------
// Timer trong Web Worker: timer của Worker không bị Chrome làm chậm như
// setTimeout/setInterval trong trang khi tab ở nền. Nếu trang chặn Worker
// (CSP) hoặc Worker lỗi thì tự quay về setTimeout thường.
// ---------------------------------------------------------------------
let worker = null;
let sleepSeq = 0;
const pendingSleeps = new Map(); // id -> resolve
let onWorkerTick = null;

function failoverWorker(why) {
  if (!worker) return;
  LOG("Worker timer không dùng được, quay về setTimeout:", why);
  try { worker.terminate(); } catch (e) {}
  worker = null;
  for (const resolve of pendingSleeps.values()) resolve();
  pendingSleeps.clear();
}

try {
  const wsrc = `
    let tickId = null;
    onmessage = (e) => {
      const m = e.data;
      if (m.t === "sleep") setTimeout(() => postMessage({ t: "wake", id: m.id }), m.ms);
      else if (m.t === "tick") { if (tickId) clearInterval(tickId); tickId = setInterval(() => postMessage({ t: "tick" }), m.ms); }
      else if (m.t === "stop") { if (tickId) clearInterval(tickId); tickId = null; }
    };`;
  const url = URL.createObjectURL(new Blob([wsrc], { type: "text/javascript" }));
  worker = new Worker(url);
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.t === "wake") { const r = pendingSleeps.get(m.id); if (r) { pendingSleeps.delete(m.id); r(); } }
    else if (m.t === "tick" && onWorkerTick) onWorkerTick();
  };
  worker.onerror = (e) => failoverWorker(e && e.message);
} catch (e) {
  worker = null;
  LOG("Không tạo được Worker:", e && e.message);
}

function sleep(ms) {
  if (worker) {
    return new Promise((resolve) => {
      const id = ++sleepSeq;
      pendingSleeps.set(id, resolve);
      try { worker.postMessage({ t: "sleep", id, ms }); }
      catch (e) { pendingSleeps.delete(id); setTimeout(resolve, ms); }
    });
  }
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeout = 3000, step = 100) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(step);
  }
  return fn();
}

const txt = (el) => (el.innerText || el.textContent || "");

function isVisible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

// ---------------------------------------------------------------------
// Theo dõi agent đang gõ / thao tác.
// LƯU Ý: document.execCommand("insertText") của chính extension cũng sinh ra sự kiện
// "input" có isTrusted = true, nên isTrusted KHÔNG đủ để phân biệt. Ta dùng thêm cờ
// selfTyping để bỏ qua các sự kiện do extension tự tạo ra khi đang gửi tin.
// ---------------------------------------------------------------------
let lastTypedAt = 0;
let lastTypedEl = null;   // ô soạn tin mà BẠN đã gõ vào
let lastClickAt = 0;
let selfTyping = false;
const COMPOSER = 'textarea, [contenteditable="true"], .ProseMirror';

const onKeyOrInput = (e) => {
  if (!e.isTrusted) return;
  if (selfTyping && e.type === "input") return;            // chữ do extension chèn, không phải bạn gõ
  const t = e.target;
  if (!(t && t.closest && t.closest('input, ' + COMPOSER))) return;
  // Enter = agent vừa gửi tin xong -> không còn "gõ dở"
  if (e.type === "keydown" && e.key === "Enter" && !e.shiftKey) { lastTypedAt = 0; lastTypedEl = null; return; }
  lastTypedAt = Date.now();
  const comp = t.closest(COMPOSER);
  if (comp) lastTypedEl = comp;                            // ô tìm kiếm (input) không tính là tin gõ dở
};
const onMouseDown = (e) => { if (e.isTrusted && !selfTyping) lastClickAt = Date.now(); };

document.addEventListener("keydown", onKeyOrInput, true);
document.addEventListener("input", onKeyOrInput, true);
document.addEventListener("mousedown", onMouseDown, true);

// Bỏ khoảng trắng + ký tự vô hình (editor hay để lại \u200B sau khi gửi)
const cleanText = (v) => (v || "").replace(/[\s\u200B-\u200D\u2060\uFEFF\u00A0]/g, "");

// Chỉ coi là "tin gõ dở" khi chính BẠN đã gõ vào ô đó, còn chữ trong ô, và mới gõ gần đây
function humanDraftPresent() {
  if (!lastTypedEl || !lastTypedEl.isConnected) return false;
  if (Date.now() - lastTypedAt > DRAFT_PROTECT_MS) return false;
  const v = lastTypedEl.tagName === "TEXTAREA" ? lastTypedEl.value : txt(lastTypedEl);
  return cleanText(v).length > 0;
}

// Trả về lý do agent đang bận ("" = rảnh, được phép tự trả lời)
function agentBusy() {
  const now = Date.now();
  if (now - lastTypedAt < TYPING_GRACE_MS) return "bạn đang gõ phím";
  if (now - lastClickAt < CLICK_GRACE_MS) return "bạn vừa thao tác chuột";
  if (humanDraftPresent()) return "bạn đang gõ dở một tin nhắn";
  return "";
}

let lastWaitLog = 0;
function logWait(reason) {
  const now = Date.now();
  if (now - lastWaitLog < 10000) return;
  lastWaitLog = now;
  LOG("Tạm hoãn tự trả lời vì", reason);
}

// ---------------------------------------------------------------------
// Bật/tắt + chọn tab chạy
//  - enabled lưu bằng GM_setValue (nhớ sau khi F5 / mở lại tab).
//  - Web Locks: nếu mở nhiều tab Omni Support thì chỉ 1 tab giữ khóa và
//    được chạy; tab khác tự đứng chờ, khi tab chạy đóng thì tự nhận lại.
// ---------------------------------------------------------------------
const LOCK_NAME = "auto-reply-support-leader";
let enabled = !!GM_getValue("enabled", false);
let isLeader = false;
let releaseLock = null;

function tryLead() {
  if (!enabled || isLeader) return;
  if (!navigator.locks) { isLeader = true; renderUI(); return; }
  navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
    if (!lock) return;
    isLeader = true;
    renderUI();
    return new Promise((res) => {
      releaseLock = () => { isLeader = false; releaseLock = null; res(); renderUI(); };
    });
  }).catch(() => {});
}

function applyEnabled(v) {
  enabled = !!v;
  if (enabled) tryLead();
  else if (releaseLock) releaseLock();
  else isLeader = false;
  renderUI();
}

function setEnabled(v) {
  GM_setValue("enabled", !!v);
  applyEnabled(v);
}

GM_addValueChangeListener("enabled", (name, oldV, newV, remote) => {
  if (remote) applyEnabled(newV);
});

function isActiveTab() { return enabled && isLeader; }

// --- Nút nổi (Shadow DOM để không lẫn vào việc đọc tin nhắn) ---
let uiHost = null, uiBtn = null;
function buildUI() {
  uiHost = document.createElement("div");
  uiHost.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:2147483647;";
  const root = uiHost.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      button{font:600 12px/1 system-ui,sans-serif;border:0;border-radius:999px;padding:8px 12px;
        color:#fff;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);opacity:.9}
      button:hover{opacity:1}
    </style><button type="button"></button>`;
  uiBtn = root.querySelector("button");
  uiBtn.addEventListener("click", () => setEnabled(!enabled));
  document.documentElement.appendChild(uiHost);
  renderUI();
}
function renderUI() {
  if (!uiBtn) return;
  let label, color;
  if (!enabled) { label = "Auto Reply: OFF"; color = "#6b7280"; }
  else if (isLeader) { label = "Auto Reply: ON"; color = "#16a34a"; }
  else { label = "Auto Reply: ON (tab khác đang chạy)"; color = "#d97706"; }
  uiBtn.textContent = label;
  uiBtn.style.background = color;
}
buildUI();
try { GM_registerMenuCommand("Bật/tắt Auto Reply", () => setEnabled(!enabled)); } catch (e) {}
if (enabled) tryLead();

// ---------------------------------------------------------------------
// Đọc danh sách chat
// ---------------------------------------------------------------------
function getChatItems() {
  const selectors = [
    ".message-list-item",
    '[class*="conversation-item"]',
    '[class*="chat-item"]',
    '[class*="message-item"]',
  ];
  for (const sel of selectors) {
    const items = [...document.querySelectorAll(sel)];
    if (items.length) return items;
  }
  return [];
}

// Trạng thái = text THUẦN của một phần tử con (vd "Assigned", "Supporting").
// Lấy phần tử khớp CUỐI CÙNG trong item (badge trạng thái nằm ở dòng cuối),
// và so sánh khớp tuyệt đối — không dò chữ "assigned" trong nội dung tin nhắn.
const STATUS_WORDS = new Set(["assigned", "supporting"]);

function getStatus(item) {
  let found = "";
  for (const el of item.querySelectorAll("*")) {
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join("")
      .trim()
      .toLowerCase();
    if (STATUS_WORDS.has(own)) found = own;
  }
  return found;
}

const isAssigned = (item) => getStatus(item) === "assigned";

function getSenderName(item) {
  const el =
    item.querySelector(".message-list-item__title") ||
    item.querySelector('[class*="title"]') ||
    item.querySelector('[class*="name"]') ||
    item.querySelector("h3, h4, strong, b");
  const t = el && txt(el).trim();
  if (t) return t;
  return txt(item).split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
}

// Key ổn định: tên người gửi + giờ tạo (07:37:21). KHÔNG dùng cả innerText
// vì nó chứa đồng hồ đếm (00:00:32) đổi mỗi giây làm key thay đổi liên tục.
function getKey(item) {
  const realId =
    item.dataset?.id ||
    item.getAttribute("data-conversation-id") ||
    item.getAttribute("data-id");
  if (realId) return realId;
  const time = (txt(item).match(/\d{1,2}:\d{2}:\d{2}/) || [""])[0];
  return `${getSenderName(item)}|${time}`;
}

function findItemByKey(key) {
  return getChatItems().find((it) => getKey(it) === key) || null;
}

// ---------------------------------------------------------------------
// Ngôn ngữ
// ---------------------------------------------------------------------
const VI_REGEX =
  /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;

function getPreviewText(item) {
  const body = item.querySelector(".message-list-item__body");
  if (body) return txt(body).trim();
  const lines = txt(item).split("\n").map((l) => l.trim()).filter((l) => l.length > 1);
  return lines[1] || "";
}

// Một số từ/cụm tiếng Việt KHÔNG dấu hay gặp (khách gõ "cho minh hoi ve may bay"...).
// Chọn thận trọng để không trùng từ tiếng Anh.
const VI_PLAIN_WORDS = new RegExp(
  "\\b(xin chao|chao ban|chao anh|chao chi|chao em|cho minh|cho toi|toi muon|minh muon|" +
  "ve may bay|hanh ly|dat ve|huy ve|doi ve|hoan ve|chuyen bay|cam on|khong|duoc|vang a|" +
  "nhe|the nao|bao nhieu|lam sao|giup|that lac)\\b", "i");

function looksVietnamese(text) {
  if (!text) return false;
  if (VI_REGEX.test(text)) return true;
  const plain = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase();
  return VI_PLAIN_WORDS.test(plain);
}

function scrollParent(el) {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll" || oy === "overlay") return p;
  }
  return null;
}

// Chuỗi KHÔNG phải tin nhắn của khách (tên kênh, ID sender, email, giờ...)
const NOISE = /^(vna_|vna\d{6,}|livechat|\S+@\S+\.\S+$)/i;

// Lấy các tin nhắn của KHÁCH trong khung chat đang mở.
// Không phụ thuộc class: khách ở bên TRÁI, bot/agent ở bên PHẢI, thông báo hệ thống ở GIỮA
// (so với ô nhập tin). Chỉ lấy trong khung CUỘN chứa tin nhắn để loại header, tên khách,
// thanh tab chat ở trên cùng (trước đây các dòng này bị đọc nhầm là tin của khách).
function getCustomerTexts() {
  const input = getInputBox();
  if (!input) return [];
  const box = input.getBoundingClientRect();
  const width = box.right - box.left;
  if (width <= 0) return [];
  const mid = (box.left + box.right) / 2;

  const groups = new Map(); // khung cuộn -> danh sách text
  for (const el of document.querySelectorAll("body *")) {
    if (el === input || input.contains(el) || el.closest(".message-list-item") ||
        el.closest("button")) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ").trim();
    if (own.length < 2 || NOISE.test(own)) continue;
    if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(own)) continue;       // dòng giờ "02/10/2026 08:01"
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.left < box.left - 30 || r.right > box.right + 30) continue; // ngoài khung chat
    if (r.bottom > box.top) continue;                                  // phải ở phía trên ô nhập
    const center = (r.left + r.right) / 2;
    if (center >= mid - 0.12 * width) continue;                        // chỉ lấy bên trái = khách
    const sp = scrollParent(el);
    if (!sp) continue;
    if (!groups.has(sp)) groups.set(sp, []);
    groups.get(sp).push(own);
  }

  // Khung chứa tin nhắn = khung cuộn cao nhất (thanh tab/header nhỏ hơn nhiều)
  let best = null, bestH = -1;
  for (const [sp, list] of groups) {
    const h = sp.getBoundingClientRect().height;
    if (h > bestH) { bestH = h; best = list; }
  }
  return best || [];
}

async function detectLanguage(item) {
  // Chờ tin nhắn của khách hiển thị (tối đa 2s)
  const texts = await waitFor(() => { const t = getCustomerTexts(); return t.length ? t : null; }, 2000, 150);
  if (texts && texts.length) {
    const recent = texts.slice(-5).join(" \n ");
    LOG("Tin nhắn khách:", recent);
    return looksVietnamese(recent) ? "vi" : "en";
  }
  // Không đọc được khung chat -> dùng preview (chỉ dấu tiếng Việt), mặc định Hi
  const fallback = looksVietnamese(getPreviewText(item)) ? "vi" : "en";
  LOG("Không đọc được tin nhắn khách, dùng preview ->", fallback);
  return fallback;
}

// ---------------------------------------------------------------------
// Ô nhập + nút Send (giới hạn trong khung chat, không lấy nhầm ô search)
// ---------------------------------------------------------------------
function getInputBox() {
  const rich = [...document.querySelectorAll(
    '[contenteditable="true"], .ProseMirror, textarea'
  )].filter((el) => isVisible(el) && !el.closest(".message-list-item") && !el.disabled && !el.readOnly);
  if (rich.length) return rich[rich.length - 1];

  const plain = [...document.querySelectorAll('input[type="text"]')].filter(
    (el) => isVisible(el) && !/search|tìm/i.test(el.placeholder || "")
  );
  return plain.length ? plain[plain.length - 1] : null;
}

function isSendButtonLike(b) {
  const text = (b.innerText || "").toLowerCase().trim();
  const cls = (b.className || "").toString().toLowerCase();
  const aria = (b.getAttribute("aria-label") || "").toLowerCase();
  if (text === "send" || aria.includes("send") ||
      cls.includes("send-btn") || cls.includes("send_btn") ||
      cls.includes("reply-editor__send") || cls.includes("submit")) return true;
  const path = b.querySelector("path");
  if (path) {
    const fill = path.getAttribute("fill") || "";
    const d = path.getAttribute("d") || "";
    if (fill === "#0062D6" || d.startsWith("M0.5 9.833")) return true;
  }
  return false;
}

function getSendButton(input) {
  // Đi lên từ ô nhập để chỉ tìm nút trong đúng khung soạn tin
  let lastLevelButtons = null;
  let el = input;
  for (let i = 0; el && i < 8; i++, el = el.parentElement) {
    const btns = [...el.querySelectorAll("button")].filter((b) => isVisible(b) && !b.disabled);
    if (!btns.length) continue;
    const hit = btns.find(isSendButtonLike);
    if (hit) return hit;
    if (!lastLevelButtons) lastLevelButtons = btns;
  }
  if (lastLevelButtons) return lastLevelButtons[lastLevelButtons.length - 1];
  return null;
}

async function sendReply(text) {
  const input = await waitFor(getInputBox, 3000);
  if (!input) { LOG("Không thấy ô nhập tin"); return false; }

  input.focus();
  await sleep(150);

  if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    document.execCommand("selectAll");
    document.execCommand("delete");
    document.execCommand("insertText", false, text);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  const btn = await waitFor(() => getSendButton(input), 2000);
  if (!btn) { LOG("Không thấy nút Send"); return false; }

  btn.click();
  LOG("Đã bấm Send:", text);
  return true;
}

// ---------------------------------------------------------------------
// Xử lý 1 chat Assigned
// ---------------------------------------------------------------------
const handled = new Set();
const attempts = new Map(); // key -> { n, last }

function canTry(key) {
  if (handled.has(key)) return false;
  const rec = attempts.get(key);
  if (!rec) return true;
  if (rec.n < MAX_ATTEMPTS) return true;
  if (Date.now() - rec.last > RETRY_COOLDOWN_MS) { attempts.delete(key); return true; }
  return false;
}

async function handleAssigned(item) {
  const key = getKey(item);
  const rec = attempts.get(key) || { n: 0, last: 0 };
  rec.n++; rec.last = Date.now();
  attempts.set(key, rec);

  LOG(`Chat Assigned: ${key} | lần thử ${rec.n}`);

  item.click();
  await sleep(OPEN_SETTLE_MS);

  // Kiểm tra lại ngay trước khi gửi: nếu chat không còn Assigned
  // (agent đã trả lời tay / đã đổi trạng thái) thì KHÔNG gửi.
  const fresh = findItemByKey(key);
  if (!fresh || !isAssigned(fresh)) {
    LOG("Chat không còn Assigned, bỏ qua:", key);
    handled.add(key);
    return false;
  }

  const lang = await detectLanguage(fresh);

  // Kiểm tra lần cuối: nếu trong lúc chờ bạn bắt đầu gõ thì KHÔNG chèn/xóa gì trong ô soạn tin.
  const busyNow = agentBusy();
  if (busyNow) {
    LOG("Hủy lượt này (không đụng vào ô soạn tin) vì", busyNow);
    rec.n--; // lượt bị hủy không tính vào số lần thử
    return false;
  }
  LOG("Ngôn ngữ:", lang, "->", REPLY[lang]);
  selfTyping = true;
  let ok = false;
  try { ok = await sendReply(REPLY[lang]); } finally { selfTyping = false; }
  if (!ok) return false; // lần quét sau thử lại (tối đa MAX_ATTEMPTS)
  lastSentAt = Date.now();  // mốc để tính 5s trước khi sang chat kế tiếp

  const changed = await waitFor(() => {
    const it = findItemByKey(key);
    return !it || !isAssigned(it);
  }, SEND_VERIFY_MS, 200);

  if (changed) {
    handled.add(key);
    LOG("Xong, trạng thái đã đổi:", key);
  } else {
    LOG("Đã gửi nhưng vẫn Assigned sau", SEND_VERIFY_MS, "ms:", key);
  }
  await sleep(POST_SEND_SETTLE_MS); // ở yên trong chat này, chưa chuyển đi ngay
  return true;
}

// ---------------------------------------------------------------------
// Vòng quét
// ---------------------------------------------------------------------
let scanning = false;
let scanStartedAt = 0;
let lastSentAt = 0; // thời điểm bấm Send gần nhất (hoặc lần thử thất bại gần nhất)
const SCAN_WATCHDOG_MS = 90000; // lượt quét treo quá 90s thì coi như kẹt và cho phép quét lại

// Ghi lại thời điểm LẦN ĐẦU thấy mỗi chat ở trạng thái Assigned
const firstSeen = new Map();
function trackAssigned() {
  const now = Date.now();
  const present = new Set();
  for (const it of getChatItems()) {
    if (!isAssigned(it)) continue;
    const k = getKey(it);
    present.add(k);
    if (!firstSeen.has(k)) firstSeen.set(k, now);
  }
  for (const k of [...firstSeen.keys()]) if (!present.has(k)) firstSeen.delete(k);
}

let lastScanAt = 0;
let lastDiagAt = 0;
document.addEventListener("visibilitychange", () => LOG("Tab", document.hidden ? "chuyển sang NỀN" : "quay lại HIỂN THỊ"));


async function scan() {
  {
    const t = Date.now();
    if (lastScanAt && t - lastScanAt > 5000) LOG(`Khoảng cách giữa 2 lượt quét: ${Math.round((t - lastScanAt) / 1000)}s (tab ẩn=${document.hidden})`);
    lastScanAt = t;
    if (document.hidden && t - lastDiagAt > 30000) {
      lastDiagAt = t;
      LOG(`[nền] đang chạy; chat Assigned nhìn thấy: ${getChatItems().filter(isAssigned).length}`);
    }
  }
  if (scanning && Date.now() - scanStartedAt > SCAN_WATCHDOG_MS) {
    LOG("Lượt quét treo >90s, reset cờ scanning");
    scanning = false;
  }
  if (!isActiveTab()) return;
  trackAssigned(); // luôn ghi nhận chat mới, kể cả khi đang bận xử lý chat khác
  if (scanning) return;

  scanning = true;
  scanStartedAt = Date.now();
  try {
    const now = Date.now();
    const pending = getChatItems().filter((it) => isAssigned(it) && canTry(getKey(it)));
    // chỉ xử lý chat đã Assigned đủ NEW_CHAT_DELAY_MS
    const ready = pending.find((it) => now - (firstSeen.get(getKey(it)) ?? now) >= NEW_CHAT_DELAY_MS);

    if (!ready) {
      if (pending.length) logWait(`chờ đủ ${NEW_CHAT_DELAY_MS / 1000}s kể từ khi chat xuất hiện (${pending.length} chat đang chờ)`);
    } else if (now - lastSentAt < BETWEEN_CHATS_MS) {
      logWait(`chờ ${BETWEEN_CHATS_MS / 1000}s giữa 2 chat (${pending.length} chat đang chờ)`);
    } else {
      const busy = agentBusy();
      if (busy) {
        logWait(busy); // chat vẫn Assigned, sẽ được xử lý ở lượt quét sau khi bạn rảnh
      } else {
        const sent = await handleAssigned(ready); // mỗi lượt quét chỉ xử lý 1 chat
        // Khoảng nghỉ 5s tính từ lúc BẤM SEND (đã ghi trong handleAssigned),
        // không cộng thêm thời gian mở chat/kiểm tra. Nếu không gửi được thì nghỉ 5s từ giờ để khỏi nhảy chat liên tục.
        if (!sent) lastSentAt = Date.now();
      }
    }
  } catch (e) {
    LOG("Lỗi khi quét:", e);
  } finally {
    scanning = false;
  }
}

// 1) Quét định kỳ ngay trong trang (dự phòng) + nhịp từ Web Worker
const intervalId = setInterval(() => { if (enabled && !isLeader) tryLead(); scan(); }, POLL_MS);
onWorkerTick = () => { if (enabled && !isLeader) tryLead(); scan(); };
if (worker) worker.postMessage({ t: "tick", ms: POLL_MS });

// 2) Quét ngay khi DOM đổi (chat mới vào danh sách). MutationObserver KHÔNG bị
//    Chrome làm chậm khi tab ở nền như setTimeout/setInterval.
let lastObs = 0;
const observer = new MutationObserver(() => {
  const now = Date.now();
  if (now - lastObs < 400) return;
  lastObs = now;
  scan();
});
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

function stop() {
  clearInterval(intervalId);
  observer.disconnect();
  onWorkerTick = null;
  if (worker) { try { worker.postMessage({ t: "stop" }); worker.terminate(); } catch (e) {} worker = null; }
  if (releaseLock) releaseLock();
  if (uiHost) uiHost.remove();
  document.removeEventListener("keydown", onKeyOrInput, true);
  document.removeEventListener("input", onKeyOrInput, true);
  document.removeEventListener("mousedown", onMouseDown, true);
  if (window.__crmStop === stop) window.__crmStop = null;
  LOG("instance stopped");
}
window.__crmStop = stop;

LOG("LOADED v2.9.1 (userscript):", location.href, "| worker timer:", !!worker);
})();
