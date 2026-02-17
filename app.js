/* Print SRS Lite Pro (Nodeなし / IndexedDB)
   2026-02-17 consolidated
   - Home: subject collapsible + subtle colors
   - Home: select -> move subject / bulk A4 print / bulk delete
   - Subject = preset + "その他(自由記載)" everywhere
   - Add/Edit: subject picker bottom sheet (no prompt for subject)
   - Edit: done button highlighted, no Home button in edit header
   - Edit done -> back to home + toast for a few seconds
   - Practice: open Q picker even if not due (with image+mask labels), pinch zoom + pan
   - PDF print: use iframe (no window.open) to avoid iPad popup block
   - Today: due list + optional subject multi-filter (including custom subjects)
   - 4 ratings: もう一度/難しい/正解/簡単
*/

const CFG = { maxW: 1600, jpegQ: 0.8, longPressMs: 350 };
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const now = () => Date.now();
const dayMs = 24 * 60 * 60 * 1000;

function uid() { return Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function clamp01(v){ return clamp(v, 0, 1); }
function toDateStr(ms){ return new Date(ms).toLocaleString(); }

const SUBJECT_PRESETS = ["算数","国語","理科","社会","英語","その他"];
const SUBJECT_ORDER = ["算数","国語","英語","理科","社会","その他"];

function normSubjectForStore(subject, otherText="") {
  const s = (subject || "その他").trim();
  if (SUBJECT_PRESETS.includes(s) && s !== "その他") return { subject: s, subjectOther: "" };
  if (s === "その他") return { subject: "その他", subjectOther: (otherText || "").trim() };
  // if user provides custom directly, store as その他 + subjectOther
  return { subject: "その他", subjectOther: s };
}
function displaySubject(p) {
  if (!p) return "その他";
  if ((p.subject || "その他") !== "その他") return p.subject;
  return (p.subjectOther || "その他").trim() || "その他";
}
function subjectKey(p) {
  // used for grouping/filtering (custom treated as its own group)
  const s = displaySubject(p);
  return s;
}
function subjectClass(subj) {
  if (subj === "算数") return "math";
  if (subj === "国語") return "jp";
  if (subj === "英語") return "en";
  if (subj === "理科") return "sci";
  if (subj === "社会") return "soc";
  return "oth";
}

/* =========================
   Fatal error UI
   ========================= */
function showFatal(err){
  console.error(err);
  const box = $("#fatal");
  if (!box) { alert("エラーが発生しました。コンソールをご確認ください。"); return; }
  box.style.display = "block";
  box.innerHTML = `
    <div style="font-weight:700;margin-bottom:6px">⚠️ エラーが発生しました（ボタン無反応の原因）</div>
    <div style="white-space:pre-wrap;font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;font-size:12px;opacity:.95">${escapeHtml(String(err?.stack || err?.message || err))}</div>
  `;
}
window.addEventListener("error", (e) => showFatal(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => showFatal(e.reason || e));

/* =========================
   IndexedDB
   ========================= */
const DB_NAME = "print_srs_lite_pro_db";
const DB_VER = 1;
let dbp = null;

function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("prints")) db.createObjectStore("prints", { keyPath: "id" });
      if (!db.objectStoreNames.contains("pages")) db.createObjectStore("pages", { keyPath: "id" });
      if (!db.objectStoreNames.contains("groups")) db.createObjectStore("groups", { keyPath: "id" });
      if (!db.objectStoreNames.contains("masks")) db.createObjectStore("masks", { keyPath: "id" });
      if (!db.objectStoreNames.contains("srs")) db.createObjectStore("srs", { keyPath: "groupId" });
      if (!db.objectStoreNames.contains("reviews")) db.createObjectStore("reviews", { keyPath: "id" });
      if (!db.objectStoreNames.contains("skips")) db.createObjectStore("skips", { keyPath: "groupId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(storeNames, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const stores = {};
    storeNames.forEach((n) => (stores[n] = t.objectStore(n)));
    Promise.resolve(fn(stores))
      .then((res) => {
        t.oncomplete = () => resolve(res);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
      .catch(reject);
  });
}

async function put(store, value) { return tx([store], "readwrite", (s) => s[store].put(value)); }
async function del(store, key) { return tx([store], "readwrite", (s) => s[store].delete(key)); }
async function getAll(store) {
  return tx([store], "readonly", (s) => new Promise((res, rej) => {
    const r = s[store].getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  }));
}

/* =========================
   SRS
   ========================= */
function initSrsState(groupId) {
  const t = now();
  return {
    groupId,
    difficulty: 5.0,
    stability: 1.0,
    lastReviewedAt: null,
    nextDueAt: t,
    reviewCount: 0,
    lapseCount: 0,
    updatedAt: t,
  };
}
function updateSrs(prev, rating) {
  const t = now();
  const d = prev.difficulty;
  const s = prev.stability;

  const dDelta =
    rating === "again" ? +1.2 :
    rating === "hard"  ? +0.6 :
    rating === "good"  ? -0.1 :
                         -0.5;

  const newD = clamp(d + dDelta, 1.0, 10.0);
  const diffFactor = 1.0 - (newD - 1.0) / 20.0;

  let newS = s;
  if (rating === "again") newS = Math.max(0.5, s * 0.35);
  else if (rating === "hard") newS = Math.max(0.8, s * (1.25 * diffFactor));
  else if (rating === "good") newS = Math.max(1.0, s * (1.9 * diffFactor));
  else newS = Math.max(2.0, s * (2.6 * diffFactor));

  const intervalDays =
    rating === "again" ? 1 :
    rating === "hard"  ? Math.max(2, Math.round(newS * 0.7)) :
    rating === "good"  ? Math.max(3, Math.round(newS)) :
                         Math.max(7, Math.round(newS * 1.4));

  return {
    ...prev,
    difficulty: newD,
    stability: newS,
    lastReviewedAt: t,
    nextDueAt: t + intervalDays * dayMs,
    reviewCount: prev.reviewCount + 1,
    lapseCount: prev.lapseCount + (rating === "again" ? 1 : 0),
    updatedAt: t,
  };
}

/* =========================
   Image load / HEIC convert / compress
   ========================= */
function isHeicLike(file) {
  const name = (file.name || "").toLowerCase();
  return file.type === "image/heic" || file.type === "image/heif" || name.endsWith(".heic") || name.endsWith(".heif");
}
async function fileToBitmap(file) {
  if (isHeicLike(file)) {
    if (!window.heic2any) throw new Error("heic2anyが読み込めません（ネット接続確認）");
    try {
      const jpegBlob = await window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.95 });
      return await createImageBitmap(jpegBlob);
    } catch {
      throw new Error("HEIC変換に失敗（非対応の可能性）。PNG/JPEGでお願いします。");
    }
  }
  return await createImageBitmap(file);
}
async function compressBitmapToJpegBlob(bitmap) {
  const scale = Math.min(1, CFG.maxW / bitmap.width);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const cctx = c.getContext("2d");
  cctx.drawImage(bitmap, 0, 0, w, h);

  const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", CFG.jpegQ));
  return { blob, width: w, height: h };
}

/* =========================
   State & Cache
   ========================= */
const state = {
  route: "home",
  currentPrintId: null,
  currentGroupId: null,
  selectedMaskIds: new Set(),
  selectedPrintIds: new Set(),
  zoom: 1,
  panX: 0,
  panY: 0,
  revealedMaskIds: new Set(),

  reviewQueue: [],
  reviewIndex: -1,
  doneTodayCount: 0,

  practiceActive: false,
  practicePrintId: null,

  todaySubjectFilter: null, // Set<string> or null(=all)
};

let cache = { prints:[], pages:[], groups:[], masks:[], srs:[], reviews:[], skips:[] };

async function refreshCache() {
  const [prints, pages, groups, masks, srs, reviews, skips] = await Promise.all([
    getAll("prints"), getAll("pages"), getAll("groups"), getAll("masks"),
    getAll("srs"), getAll("reviews"), getAll("skips"),
  ]);
  cache = { prints, pages, groups, masks, srs, reviews, skips };
}

/* =========================
   Views
   ========================= */
function show(viewId) {
  $$(".view").forEach((v) => v.classList.add("hidden"));
  $(viewId)?.classList.remove("hidden");
}

/* =========================
   Router
   ========================= */
async function nav(to) {
  state.route = to;
  try {
    if (to === "home") await renderHome();
    else if (to === "add") renderAdd();
    else if (to === "edit") await renderEdit();
    else if (to === "today") await renderToday();
  } catch (e) {
    showFatal(e);
    if (to === "home") show("#view-home");
    if (to === "add") show("#view-add");
    if (to === "edit") show("#view-edit");
    if (to === "today") show("#view-today");
  }
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-nav]");
  if (!btn) return;
  const to = btn.getAttribute("data-nav");
  if (to === "home") state.currentPrintId = null;
  nav(to);
});

/* =========================
   Toast (home)
   ========================= */
function showHomeToast(msg, ms=2200) {
  const el = $("#homeToast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(showHomeToast._t);
  showHomeToast._t = setTimeout(() => el.classList.add("hidden"), ms);
}
function flushPendingHomeToast() {
  const msg = sessionStorage.getItem("homeToast");
  if (msg) {
    sessionStorage.removeItem("homeToast");
    showHomeToast(msg, 2600);
  }
}

/* =========================
   Subject collapse store
   ========================= */
function getCollapseMap(){
  try { return JSON.parse(localStorage.getItem("collapsedSubjects") || "{}"); }
  catch { return {}; }
}
function setCollapsed(subj, v){
  const map = getCollapseMap();
  map[subj] = !!v;
  localStorage.setItem("collapsedSubjects", JSON.stringify(map));
}

/* =========================
   Delete (cascade)
   ========================= */
async function deletePrintCascade(printId) {
  await refreshCache();
  const pages = cache.pages.filter((p) => p.printId === printId);
  const groups = cache.groups.filter((g) => g.printId === printId);
  const masks = cache.masks.filter((m) => m.printId === printId);
  const groupIds = new Set(groups.map((g) => g.id));
  const reviews = cache.reviews.filter((r) => groupIds.has(r.groupId));
  const srs = cache.srs.filter((s) => groupIds.has(s.groupId));
  const skips = cache.skips.filter((x) => groupIds.has(x.groupId));

  await tx(["prints", "pages", "groups", "masks", "srs", "reviews", "skips"], "readwrite", (st) => {
    st.prints.delete(printId);
    pages.forEach((x) => st.pages.delete(x.id));
    groups.forEach((x) => st.groups.delete(x.id));
    masks.forEach((x) => st.masks.delete(x.id));
    srs.forEach((x) => st.srs.delete(x.groupId));
    reviews.forEach((x) => st.reviews.delete(x.id));
    skips.forEach((x) => st.skips.delete(x.groupId));
  });
}
async function deletePrintsCascade(printIds) { for (const id of printIds) await deletePrintCascade(id); }

/* =========================
   Due + skip
   ========================= */
function startOfTomorrowMs() { const d = new Date(); d.setHours(24,0,0,0); return d.getTime(); }
function isSkipped(groupId) {
  const s = cache.skips.find((x) => x.groupId === groupId);
  if (!s) return false;
  return s.skipUntil && s.skipUntil > now();
}
function computeDueGroups() {
  const t = now();
  const srsMap = new Map(cache.srs.map((s) => [s.groupId, s]));
  return cache.groups
    .filter((g) => g.isActive)
    .map((g) => ({ g, s: srsMap.get(g.id) }))
    .filter((x) => x.s && x.s.nextDueAt != null && x.s.nextDueAt <= t)
    .filter((x) => !isSkipped(x.g.id))
    .sort((a, b) => a.s.nextDueAt - b.s.nextDueAt);
}
async function skipToday(groupId){
  const until = startOfTomorrowMs();
  await put("skips", { groupId, skipUntil: until });
  await refreshCache();
}

/* =========================
   HOME selection controls
   ========================= */
function updateHomeSelectionUI() {
  const n = state.selectedPrintIds.size;
  const btnDel = $("#btnDeleteSelected");
  const btnMove = $("#btnMoveSelected");
  const btnPrint = $("#btnPrintSelected");

  if (btnDel) {
    btnDel.disabled = n === 0;
    btnDel.textContent = n === 0 ? "選択したプリントを削除" : `選択したプリントを削除（${n}件）`;
  }
  if (btnMove) btnMove.disabled = n === 0;
  if (btnPrint) btnPrint.disabled = n === 0;
}

$("#btnSelectAll")?.addEventListener("click", async () => {
  await refreshCache();
  cache.prints.forEach((p) => state.selectedPrintIds.add(p.id));
  renderHome();
});
$("#btnClearSelect")?.addEventListener("click", () => {
  state.selectedPrintIds.clear();
  renderHome();
});
$("#btnDeleteSelected")?.addEventListener("click", async () => {
  const ids = Array.from(state.selectedPrintIds);
  if (ids.length === 0) return;
  if (!confirm(`選択したプリント ${ids.length} 件を削除します（関連データも全部消えます）`)) return;
  await deletePrintsCascade(ids);
  state.selectedPrintIds.clear();
  await renderHome();
});

/* =========================
   Backup / Restore (JSON)
   ========================= */
$("#btnBackup")?.addEventListener("click", async () => {
  await refreshCache();
  const payload = {
    version: 1,
    exportedAt: now(),
    data: cache
  };
  const blob = new Blob([JSON.stringify(payload)], { type:"application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `print-srs-backup-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showHomeToast("バックアップを作成しました");
});

$("#btnRestore")?.addEventListener("click", () => {
  $("#restoreFile")?.click();
});
$("#restoreFile")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const txt = await file.text();
    const payload = JSON.parse(txt);
    if (!payload?.data) throw new Error("JSON形式が違います");
    if (!confirm("復元します。現在のデータは上書きされます。よろしいですか？")) return;

    const d = payload.data;
    await tx(["prints","pages","groups","masks","srs","reviews","skips"], "readwrite", (st) => {
      // clear all
      const clear = (store) => new Promise((res, rej) => {
        const r = st[store].clear();
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
      });
      return Promise.all([
        clear("prints"),clear("pages"),clear("groups"),clear("masks"),
        clear("srs"),clear("reviews"),clear("skips")
      ]).then(() => {
        (d.prints||[]).forEach(x => st.prints.put(x));
        (d.pages||[]).forEach(x => st.pages.put(x));
        (d.groups||[]).forEach(x => st.groups.put(x));
        (d.masks||[]).forEach(x => st.masks.put(x));
        (d.srs||[]).forEach(x => st.srs.put(x));
        (d.reviews||[]).forEach(x => st.reviews.put(x));
        (d.skips||[]).forEach(x => st.skips.put(x));
      });
    });

    $("#restoreFile").value = "";
    await renderHome();
    showHomeToast("復元しました");
  } catch (err) {
    showFatal(err);
    alert("復元に失敗しました。JSONが壊れているか、形式が違います。");
  }
});

/* =========================
   Home: group prints by subject (custom subjects included)
   ========================= */
function buildSubjectGroups(prints){
  const map = new Map();
  for (const p of prints) {
    const key = subjectKey(p);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  for (const [k, arr] of map.entries()) arr.sort((a,b)=>b.createdAt-a.createdAt);

  // order: presets first if present, then custom alphabetical
  const presetKeys = SUBJECT_ORDER.filter(s => map.has(s));
  const customKeys = Array.from(map.keys())
    .filter(k => !SUBJECT_ORDER.includes(k))
    .sort((a,b)=>a.localeCompare(b,"ja"));
  return [...presetKeys, ...customKeys].map(k => [k, map.get(k)]);
}

function renderOnePrintItem(p) {
  const gCount = cache.groups.filter((g) => g.printId === p.id).length;
  const mCount = cache.masks.filter((m) => m.printId === p.id).length;
  const checked = state.selectedPrintIds.has(p.id);

  const el = document.createElement("div");
  el.className = "item indent";
  el.innerHTML = `
    <div class="row space">
      <div class="row" style="align-items:flex-start">
        <input class="checkbox" type="checkbox" data-print-check="${p.id}" ${checked ? "checked" : ""}/>
        <div>
          <div class="itemTitle">${escapeHtml(p.title)}</div>
          <div class="muted small">${escapeHtml(displaySubject(p))} / ${new Date(p.createdAt).toLocaleDateString()} / Q:${gCount} / mask:${mCount}</div>
        </div>
      </div>
      <div class="row">
        <button class="btn" data-open-edit="${p.id}">編集</button>
        <button class="btn primary" data-open-practice="${p.id}">このプリントを学習</button>
        <button class="btn danger" data-del-print="${p.id}">削除</button>
      </div>
    </div>
  `;

  el.querySelector(`[data-print-check="${p.id}"]`)?.addEventListener("change", (ev) => {
    const on = ev.target.checked;
    if (on) state.selectedPrintIds.add(p.id);
    else state.selectedPrintIds.delete(p.id);
    updateHomeSelectionUI();
  });

  el.querySelector("[data-open-edit]")?.addEventListener("click", () => {
    state.currentPrintId = p.id;
    state.currentGroupId = null;
    state.selectedMaskIds.clear();
    nav("edit");
  });

  el.querySelector("[data-open-practice]")?.addEventListener("click", async () => {
    state.currentPrintId = p.id;
    await tryOpenPracticeOrFirstDue(p.id);
  });

  el.querySelector("[data-del-print]")?.addEventListener("click", async () => {
    if (!confirm(`「${p.title}」を削除します（関連データも全部消えます）`)) return;
    await deletePrintCascade(p.id);
    state.selectedPrintIds.delete(p.id);
    renderHome();
  });

  return el;
}

async function renderHome() {
  await refreshCache();
  show("#view-home");

  const due = computeDueGroups();
  $("#dueCount") && ($("#dueCount").textContent = String(due.length));
  updateHomeSelectionUI();

  const list = $("#printList");
  if (!list) return;
  list.innerHTML = "";

  const prints = cache.prints.slice().sort((a,b)=>b.createdAt-a.createdAt);
  if (prints.length === 0) {
    list.innerHTML = `<div class="item muted">まだプリントがありません</div>`;
    flushPendingHomeToast();
    return;
  }

  const collapseMap = getCollapseMap();
  const groups = buildSubjectGroups(prints);

  for (const [subj, arr] of groups) {
    const collapsed = !!collapseMap[subj];

    const header = document.createElement("div");
    header.className = `item subjBox ${subjectClass(subj)}`;
    header.innerHTML = `
      <div class="subjHeader" data-subj-header="${escapeHtml(subj)}">
        <div>
          <div class="itemTitle">${escapeHtml(subj)}</div>
          <div class="muted small">プリント ${arr.length} 件</div>
        </div>
        <div class="row">
          <div class="subjBadge">${collapsed ? "＋ 展開" : "－ 折りたたみ"}</div>
        </div>
      </div>
    `;
    header.querySelector("[data-subj-header]")?.addEventListener("click", () => {
      setCollapsed(subj, !collapsed);
      renderHome();
    });
    list.appendChild(header);

    if (!collapsed) {
      for (const p of arr) list.appendChild(renderOnePrintItem(p));
    }
  }

  flushPendingHomeToast();
}

/* =========================
   ADD
   ========================= */
function renderAdd() {
  show("#view-add");
  $("#addStatus") && ($("#addStatus").textContent = "");
  $("#addTitle") && ($("#addTitle").value = `プリント ${new Date().toLocaleDateString()}`);

  state._addSubject = { subject:"算数", subjectOther:"" };
  $("#addSubjectLabel") && ($("#addSubjectLabel").textContent = "算数");
  $("#addSubjectOther")?.classList.add("hidden");
  $("#addSubjectOther") && ($("#addSubjectOther").value = "");
  $("#addFile") && ($("#addFile").value = "");
}

$("#btnCreatePrint")?.addEventListener("click", async () => {
  const title = ($("#addTitle")?.value || "").trim() || `プリント ${new Date().toLocaleDateString()}`;
  const subj = state._addSubject || { subject:"算数", subjectOther:"" };

  const file = $("#addFile")?.files && $("#addFile").files[0];
  if (!file) { $("#addStatus") && ($("#addStatus").textContent = "画像ファイルを選んでください。"); return; }

  if (subj.subject === "その他") {
    const other = ($("#addSubjectOther")?.value || "").trim();
    subj.subjectOther = other;
  }

  $("#addStatus") && ($("#addStatus").textContent = "取り込み中（変換/圧縮）...");
  try {
    const bitmap = await fileToBitmap(file);
    const { blob, width, height } = await compressBitmapToJpegBlob(bitmap);

    const printId = uid();
    const pageId = uid();
    const t = now();
    const print = { id: printId, title, subject: subj.subject, subjectOther: subj.subjectOther || "", createdAt: t };
    const page = { id: pageId, printId, pageIndex: 0, image: blob, width, height };

    const groupId = uid();
    const group = { id: groupId, printId, pageIndex: 0, label: "Q1", orderIndex: 0, isActive: true, createdAt: t };
    const srs = initSrsState(groupId);

    await tx(["prints", "pages", "groups", "srs"], "readwrite", (s) => {
      s.prints.put(print);
      s.pages.put(page);
      s.groups.put(group);
      s.srs.put(srs);
    });

    state.currentPrintId = printId;
    state.currentGroupId = groupId;
    state.selectedMaskIds.clear();

    $("#addStatus") && ($("#addStatus").textContent = "追加しました。編集画面へ移動します…");
    await nav("edit");

  } catch (err) {
    showFatal(err);
    $("#addStatus") && ($("#addStatus").textContent = `失敗：${err.message || err}`);
  }
});

/* =========================
   Subject picker modal (Add/Edit)
   ========================= */
const subjectModal = $("#subjectModal");
let subjectModalContext = null; // { type: "add" | "edit", printId? }

function openSubjectModal(ctx){
  subjectModalContext = ctx;
  $("#subjectModalTitle") && ($("#subjectModalTitle").textContent =
    ctx.type === "add" ? "教科を選択（プリント追加）" : "教科を選択（編集）"
  );
  renderSubjectOptions();
  subjectModal?.classList.remove("hidden");
  subjectModal?.setAttribute("aria-hidden","false");
}
function closeSubjectModal(){
  subjectModal?.classList.add("hidden");
  subjectModal?.setAttribute("aria-hidden","true");
  subjectModalContext = null;
}
document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-modal-close]");
  if (!c) return;
  const which = c.getAttribute("data-modal-close");
  if (which === "subject") closeSubjectModal();
  if (which === "move") closeMoveModal();
  if (which === "today") closeTodayModal();
  if (which === "picker") closePickerModal();
});

function renderSubjectOptions(){
  const wrap = $("#subjectOptions");
  if (!wrap) return;
  wrap.innerHTML = "";
  SUBJECT_PRESETS.forEach((name) => {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = name;
    b.addEventListener("click", async () => {
      if (!subjectModalContext) return;

      if (subjectModalContext.type === "add") {
        state._addSubject = { subject: name, subjectOther: "" };
        $("#addSubjectLabel") && ($("#addSubjectLabel").textContent = name);
        if (name === "その他") {
          $("#addSubjectOther")?.classList.remove("hidden");
          $("#addSubjectOther")?.focus();
        } else {
          $("#addSubjectOther")?.classList.add("hidden");
          $("#addSubjectOther") && ($("#addSubjectOther").value = "");
        }
        closeSubjectModal();
        return;
      }

      if (subjectModalContext.type === "edit") {
        await refreshCache();
        const p = cache.prints.find(x => x.id === state.currentPrintId);
        if (!p) return;
        p.subject = name;
        if (name !== "その他") p.subjectOther = "";
        await put("prints", p);
        await refreshCache();
        updateEditHeaderClickable();
        // show/hide inline other editor
        closeSubjectModal();
        if (name === "その他") openEditOtherPromptInline();
        return;
      }
    });
    wrap.appendChild(b);
  });
}

$("#btnAddSubjectPick")?.addEventListener("click", () => openSubjectModal({ type:"add" }));

/* =========================
   Move selected prints (modal)
   ========================= */
const moveModal = $("#moveModal");
function openMoveModal(){
  renderMoveOptions();
  $("#moveOtherWrap")?.classList.add("hidden");
  $("#moveOtherInput") && ($("#moveOtherInput").value = "");
  moveModal?.classList.remove("hidden");
  moveModal?.setAttribute("aria-hidden","false");
}
function closeMoveModal(){
  moveModal?.classList.add("hidden");
  moveModal?.setAttribute("aria-hidden","true");
}

function allSubjectsInData(){
  const set = new Set();
  cache.prints.forEach(p => set.add(displaySubject(p)));
  SUBJECT_ORDER.forEach(s => set.add(s));
  return Array.from(set).filter(Boolean).sort((a,b)=>{
    // keep presets first
    const ai = SUBJECT_ORDER.indexOf(a);
    const bi = SUBJECT_ORDER.indexOf(b);
    if (ai >=0 && bi>=0) return ai-bi;
    if (ai>=0) return -1;
    if (bi>=0) return 1;
    return a.localeCompare(b,"ja");
  });
}

function renderMoveOptions(){
  const wrap = $("#moveOptions");
  if (!wrap) return;
  wrap.innerHTML = "";
  const list = allSubjectsInData();

  // buttons for existing + presets
  list.forEach((name) => {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = name;
    b.addEventListener("click", async () => {
      if (name === "その他") {
        // ask free text
        $("#moveOtherWrap")?.classList.remove("hidden");
        $("#moveOtherInput")?.focus();
        return;
      }
      await applyMoveSelectedToSubject(name, "");
      closeMoveModal();
      await renderHome();
      showHomeToast("移動しました");
    });
    wrap.appendChild(b);
  });

  // explicit "自由記載" shortcut
  const free = document.createElement("button");
  free.className = "btn";
  free.textContent = "自由記載…";
  free.addEventListener("click", () => {
    $("#moveOtherWrap")?.classList.remove("hidden");
    $("#moveOtherInput")?.focus();
  });
  wrap.appendChild(free);
}

async function applyMoveSelectedToSubject(subjectLabel, otherText){
  await refreshCache();
  const ids = Array.from(state.selectedPrintIds);
  if (ids.length === 0) return;

  const isPreset = SUBJECT_ORDER.includes(subjectLabel) && subjectLabel !== "その他";
  const updated = [];

  for (const id of ids) {
    const p = cache.prints.find(x => x.id === id);
    if (!p) continue;

    if (isPreset) {
      p.subject = subjectLabel;
      p.subjectOther = "";
    } else {
      // custom => store as その他 + subjectOther
      p.subject = "その他";
      p.subjectOther = (subjectLabel === "その他" ? otherText : subjectLabel).trim();
    }
    updated.push(p);
  }

  await tx(["prints"], "readwrite", (st) => {
    updated.forEach(p => st.prints.put(p));
  });

  await refreshCache();
}

$("#btnMoveSelected")?.addEventListener("click", async () => {
  await refreshCache();
  if (state.selectedPrintIds.size === 0) return;
  openMoveModal();
});
$("#btnMoveOtherApply")?.addEventListener("click", async () => {
  const other = ($("#moveOtherInput")?.value || "").trim();
  if (!other) { alert("教科名を入力してください"); return; }
  await applyMoveSelectedToSubject("その他", other);
  closeMoveModal();
  await renderHome();
  showHomeToast("移動しました");
});

/* =========================
   Bulk A4 PDF print (selected)
   - iPad popup block avoid: iframe + print
   ========================= */
async function buildMaskedImageDataUrl(printId){
  await refreshCache();
  const page = cache.pages.find(x => x.printId === printId && x.pageIndex === 0);
  if (!page) throw new Error("ページが見つかりません");
  const bitmap = await createImageBitmap(page.image);

  const off = document.createElement("canvas");
  off.width = page.width;
  off.height = page.height;
  const octx = off.getContext("2d");
  octx.drawImage(bitmap, 0, 0);

  const masks = cache.masks.filter(m => m.printId === printId);
  masks.forEach(m => {
    octx.fillStyle = "black";
    octx.fillRect(m.x * page.width, m.y * page.height, m.w * page.width, m.h * page.height);
  });

  return off.toDataURL("image/jpeg", 0.95);
}

function printHtmlViaIframe(html){
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument || iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();

  iframe.onload = () => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (e) {
      console.error(e);
      alert("印刷を開始できませんでした。Safariの設定をご確認ください。");
    }
    setTimeout(() => iframe.remove(), 1500);
  };
}

async function printSelectedAsA4(){
  await refreshCache();
  const ids = Array.from(state.selectedPrintIds);
  if (ids.length === 0) return;

  // build pages
  const imgs = [];
  for (const id of ids) {
    const p = cache.prints.find(x => x.id === id);
    const title = p?.title || "プリント";
    const dataUrl = await buildMaskedImageDataUrl(id);
    imgs.push({ title, dataUrl });
  }

  const pagesHtml = imgs.map((x) => `
    <section class="page">
      <div class="cap">${escapeHtml(x.title)}</div>
      <img src="${x.dataUrl}" />
    </section>
  `).join("");

  const html = `
    <html>
      <head>
        <meta charset="utf-8"/>
        <title>Print</title>
        <style>
          @page { size: A4 portrait; margin: 8mm; }
          body{ margin:0; font-family: system-ui, -apple-system, sans-serif; }
          .page{
            width: 210mm; height: 297mm;
            padding: 8mm;
            box-sizing:border-box;
            page-break-after: always;
            display:flex;
            flex-direction:column;
            gap: 6mm;
          }
          .cap{ font-size: 12px; color:#333; }
          img{ flex:1; max-width:100%; max-height:100%; object-fit: contain; border: 0; }
        </style>
      </head>
      <body>
        ${pagesHtml}
        <script>
          window.onload = function(){
            setTimeout(function(){ window.print(); }, 50);
          }
        <\/script>
      </body>
    </html>
  `;
  printHtmlViaIframe(html);
}

$("#btnPrintSelected")?.addEventListener("click", async () => {
  try {
    if (state.selectedPrintIds.size === 0) return;
    await printSelectedAsA4();
  } catch (e) {
    showFatal(e);
    alert("印刷に失敗しました。");
  }
});

/* =========================
   EDIT
   ========================= */
const canvas = $("#canvas");
const ctx = canvas?.getContext("2d");

let editImgBitmap = null;
let editPage = null;

const pointers = new Map();
let longPressTimer = null;
let longPressActive = false;

let drag = {
  mode: "none",
  sx: 0, sy: 0,
  ex: 0, ey: 0,
  startPanX: 0, startPanY: 0,
  movingMaskId: null,
  maskStart: null,
  worldStart: null,
};

async function renameCurrentPrint() {
  await refreshCache();
  const p = cache.prints.find(x => x.id === state.currentPrintId);
  if (!p) return;
  const v = prompt("プリント名を変更", p.title || "");
  if (v === null) return;
  p.title = v.trim() || p.title;
  await put("prints", p);
  await refreshCache();
  updateEditHeaderClickable();
}

function openEditOtherPromptInline(){
  // gentle inline prompt (only when "その他" selected in edit)
  const other = prompt("教科を自由記載（例：漢字 / 英検 / 地理）", "");
  if (other === null) return;
  (async ()=>{
    await refreshCache();
    const p = cache.prints.find(x => x.id === state.currentPrintId);
    if (!p) return;
    p.subject = "その他";
    p.subjectOther = other.trim();
    await put("prints", p);
    await refreshCache();
    updateEditHeaderClickable();
  })();
}

async function changeCurrentSubject() {
  // bottom sheet
  openSubjectModal({ type:"edit" });
}

function updateEditHeaderClickable() {
  const p = cache.prints.find((x) => x.id === state.currentPrintId);
  const titleEl = $("#editTitle");
  const metaEl = $("#editMeta");
  if (titleEl) {
    titleEl.textContent = p ? `編集：${p.title}` : "編集";
    titleEl.style.cursor = "pointer";
    titleEl.title = "タップで名前変更";
    titleEl.onclick = () => renameCurrentPrint();
  }
  if (metaEl) {
    metaEl.textContent = p ? `${displaySubject(p)} / ${new Date(p.createdAt).toLocaleDateString()}` : "";
    metaEl.style.cursor = "pointer";
    metaEl.title = "タップで教科変更";
    metaEl.onclick = () => changeCurrentSubject();
  }
}

$("#btnEditDone")?.addEventListener("click", async () => {
  // set toast for home
  sessionStorage.setItem("homeToast", "編集完了しました");
  await nav("home");
});

$("#btnFit")?.addEventListener("click", () => { fitToStage("#stage", canvas, editPage); drawEdit(); });
$("#btnZoomIn")?.addEventListener("click", () => { state.zoom = Math.min(5, state.zoom * 1.25); drawEdit(); });
$("#btnZoomOut")?.addEventListener("click", () => { state.zoom = Math.max(0.25, state.zoom / 1.25); drawEdit(); });

$("#btnNewGroup")?.addEventListener("click", async () => {
  await ensureEditLoaded();
  await createGroup();
  await renderEditSidebar();
  drawEdit();
});

$("#btnRenameGroup")?.addEventListener("click", async () => {
  const g = cache.groups.find((x) => x.id === state.currentGroupId);
  if (!g) return;
  const label = prompt("Qラベル（例：Q3 / 問5 / 単語②）", g.label || "");
  if (label === null) return;
  g.label = label;
  await put("groups", g);
  await refreshCache();
  await renderEditSidebar();
  drawEdit();
});

$("#btnDeleteGroup")?.addEventListener("click", async () => {
  const g = cache.groups.find((x) => x.id === state.currentGroupId);
  if (!g) return;
  if (!confirm(`${g.label || "このQ"} を削除します（マスクも消えます）`)) return;

  const masks = cache.masks.filter((m) => m.groupId === g.id);
  await tx(["groups", "masks", "srs", "reviews", "skips"], "readwrite", (s) => {
    s.groups.delete(g.id);
    s.srs.delete(g.id);
    s.skips.delete(g.id);
    cache.reviews.filter((r) => r.groupId === g.id).forEach((r) => s.reviews.delete(r.id));
    masks.forEach((m) => s.masks.delete(m.id));
  });

  state.currentGroupId = null;
  state.selectedMaskIds.clear();
  await refreshCache();

  const gg = cache.groups.filter((x) => x.printId === state.currentPrintId).sort((a, b) => a.orderIndex - b.orderIndex);
  state.currentGroupId = gg[0]?.id || null;

  await renderEditSidebar();
  drawEdit();
});

$("#btnClearSel")?.addEventListener("click", () => {
  state.selectedMaskIds.clear();
  updateSelUI();
  drawEdit();
});
$("#btnDeleteSel")?.addEventListener("click", async () => {
  const ids = Array.from(state.selectedMaskIds);
  if (ids.length === 0) return;
  if (!confirm(`選択マスク ${ids.length} 件を削除します`)) return;

  await tx(["masks"], "readwrite", (s) => { ids.forEach((id) => s.masks.delete(id)); });
  state.selectedMaskIds.clear();
  await refreshCache();
  await renderEditSidebar();
  updateSelUI();
  drawEdit();
});
$("#btnMoveSel")?.addEventListener("click", async () => {
  const gid = state.currentGroupId;
  if (!gid) return;
  const ids = Array.from(state.selectedMaskIds);
  if (ids.length === 0) return;

  await tx(["masks"], "readwrite", (s) => {
    ids.forEach((id) => {
      const m = cache.masks.find((x) => x.id === id);
      if (!m) return;
      m.groupId = gid;
      s.masks.put(m);
    });
  });

  state.selectedMaskIds.clear();
  await refreshCache();
  await renderEditSidebar();
  updateSelUI();
  drawEdit();
});

async function ensureEditLoaded() {
  if (!state.currentPrintId) throw new Error("printIdがありません");
  await refreshCache();

  editPage = cache.pages.find((p) => p.printId === state.currentPrintId && p.pageIndex === 0);
  if (!editPage) throw new Error("ページが見つかりません");
  editImgBitmap = await createImageBitmap(editPage.image);

  const groups = cache.groups.filter((g) => g.printId === state.currentPrintId).sort((a, b) => a.orderIndex - b.orderIndex);
  if (!groups[0]) {
    await createGroup();
    await refreshCache();
  }
  const groups2 = cache.groups.filter((g) => g.printId === state.currentPrintId).sort((a, b) => a.orderIndex - b.orderIndex);
  if (!state.currentGroupId) state.currentGroupId = groups2[0]?.id || null;
}

async function renderEdit() {
  await ensureEditLoaded();
  show("#view-edit");

  await refreshCache();
  updateEditHeaderClickable();

  await renderEditSidebar();
  state.selectedMaskIds.clear();
  updateSelUI();

  requestAnimationFrame(() => {
    fitToStage("#stage", canvas, editPage);
    drawEdit();
  });
}

async function renderEditSidebar() {
  await refreshCache();
  const printId = state.currentPrintId;
  const groups = cache.groups.filter((g) => g.printId === printId).sort((a, b) => a.orderIndex - b.orderIndex);
  const masks = cache.masks.filter((m) => m.printId === printId);

  const list = $("#groupList");
  if (!list) return;
  list.innerHTML = "";

  groups.forEach((g, idx) => {
    const count = masks.filter((m) => m.groupId === g.id).length;
    const active = g.id === state.currentGroupId;

    const el = document.createElement("div");
    el.className = "item";
    el.style.borderColor = active ? "rgba(63,124,255,.7)" : "";
    el.innerHTML = `
      <div class="row space">
        <div>
          <div class="itemTitle">${escapeHtml(g.label || "(ラベルなし)")}</div>
          <div class="muted small">マスク ${count}</div>
        </div>
        <div class="qctl">
          <button class="qbtn" data-q-up="${g.id}" ${idx===0?"disabled":""}>↑</button>
          <button class="qbtn" data-q-down="${g.id}" ${idx===groups.length-1?"disabled":""}>↓</button>
          <button class="btn" data-sel-group="${g.id}">選択</button>
        </div>
      </div>
    `;

    el.querySelector("[data-sel-group]")?.addEventListener("click", () => {
      state.currentGroupId = g.id;
      state.selectedMaskIds.clear();
      updateSelUI();
      renderEditSidebar();
      drawEdit();
    });

    el.querySelector("[data-q-up]")?.addEventListener("click", async () => { await moveGroupOrder(g.id, -1); });
    el.querySelector("[data-q-down]")?.addEventListener("click", async () => { await moveGroupOrder(g.id, +1); });

    list.appendChild(el);
  });

  const cur = groups.find((g) => g.id === state.currentGroupId);
  $("#currentGroupLabel") && ($("#currentGroupLabel").textContent = cur?.label || "(未選択)");
  $("#currentGroupMaskCount") && ($("#currentGroupMaskCount").textContent = String(masks.filter((m) => m.groupId === state.currentGroupId).length));

  $("#btnRenameGroup") && ($("#btnRenameGroup").disabled = !state.currentGroupId);
  $("#btnDeleteGroup") && ($("#btnDeleteGroup").disabled = !state.currentGroupId);
}

async function moveGroupOrder(groupId, delta) {
  await refreshCache();
  const printId = state.currentPrintId;
  const groups = cache.groups.filter((g) => g.printId === printId).sort((a,b)=>a.orderIndex-b.orderIndex);
  const i = groups.findIndex((g) => g.id === groupId);
  if (i < 0) return;
  const j = i + delta;
  if (j < 0 || j >= groups.length) return;

  const a = groups[i];
  const b = groups[j];
  const tmp = a.orderIndex;
  a.orderIndex = b.orderIndex;
  b.orderIndex = tmp;

  await tx(["groups"], "readwrite", (s) => { s.groups.put(a); s.groups.put(b); });
  await renderEditSidebar();
  drawEdit();
}

function updateSelUI() {
  $("#selCount") && ($("#selCount").textContent = String(state.selectedMaskIds.size));
  $("#btnMoveSel") && ($("#btnMoveSel").disabled = !state.currentGroupId || state.selectedMaskIds.size === 0);
  $("#btnDeleteSel") && ($("#btnDeleteSel").disabled = state.selectedMaskIds.size === 0);
  $("#btnClearSel") && ($("#btnClearSel").disabled = state.selectedMaskIds.size === 0);
}

async function createGroup() {
  const printId = state.currentPrintId;
  const groups = cache.groups.filter((g) => g.printId === printId).sort((a, b) => a.orderIndex - b.orderIndex);
  const idx = groups.length;
  const groupId = uid();
  const t = now();
  const g = { id: groupId, printId, pageIndex: 0, label: `Q${idx + 1}`, orderIndex: idx, isActive: true, createdAt: t };
  await tx(["groups", "srs"], "readwrite", (s) => { s.groups.put(g); s.srs.put(initSrsState(groupId)); });
  state.currentGroupId = groupId;
}

function fitToStage(stageSel, cvs, page) {
  const stage = $(stageSel);
  if (!stage || !page) return;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  const zx = sw / page.width;
  const zy = sh / page.height;
  state.zoom = Math.min(zx, zy);
  state.panX = (sw - page.width * state.zoom) / 2;
  state.panY = (sh - page.height * state.zoom) / 2;
}
function screenToWorld(x, y) { return { x: (x - state.panX) / state.zoom, y: (y - state.panY) / state.zoom }; }

function hitTestMaskEdit(sx, sy) {
  if (!editPage) return null;
  const w = screenToWorld(sx, sy);
  const nx = w.x / editPage.width;
  const ny = w.y / editPage.height;

  const masks = cache.masks.filter((m) => m.printId === state.currentPrintId);
  for (let i = masks.length - 1; i >= 0; i--) {
    const m = masks[i];
    if (nx >= m.x && nx <= m.x + m.w && ny >= m.y && ny <= m.y + m.h) return m;
  }
  return null;
}

function drawMaskLabel(ctx2d, label, x, y, zoomScale) {
  if (!label) return;
  ctx2d.save();
  ctx2d.font = `${12 / zoomScale}px sans-serif`;
  ctx2d.fillStyle = "rgba(255,255,255,0.95)";
  ctx2d.strokeStyle = "rgba(0,0,0,0.7)";
  ctx2d.lineWidth = 3 / zoomScale;
  ctx2d.strokeText(label, x, y);
  ctx2d.fillText(label, x, y);
  ctx2d.restore();
}

function drawEdit() {
  if (!ctx || !editImgBitmap || !editPage) return;

  const stage = $("#stage");
  if (!stage) return;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  canvas.width = Math.max(1, Math.floor(w));
  canvas.height = Math.max(1, Math.floor(h));

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const gMap = new Map(cache.groups.map(g => [g.id, g]));

  ctx.save();
  ctx.translate(state.panX, state.panY);
  ctx.scale(state.zoom, state.zoom);
  ctx.drawImage(editImgBitmap, 0, 0);

  const masks = cache.masks.filter((m) => m.printId === state.currentPrintId);
  masks.forEach((m) => {
    const isCur = m.groupId === state.currentGroupId;
    const isSel = state.selectedMaskIds.has(m.id);

    const rx = m.x * editPage.width;
    const ry = m.y * editPage.height;
    const rw = m.w * editPage.width;
    const rh = m.h * editPage.height;

    ctx.save();
    ctx.fillStyle = "#000";
    ctx.fillRect(rx, ry, rw, rh);

    const gl = gMap.get(m.groupId)?.label || "";
    if (gl) drawMaskLabel(ctx, gl, rx + 4 / state.zoom, ry + 14 / state.zoom, state.zoom);

    if (isCur) {
      ctx.strokeStyle = "#ffd34d";
      ctx.lineWidth = (isSel ? 4 : 2) / state.zoom;
      ctx.strokeRect(rx, ry, rw, rh);
    }
    if (isSel) {
      ctx.strokeStyle = "#ffd34d";
      ctx.lineWidth = 6 / state.zoom;
      ctx.strokeRect(rx, ry, rw, rh);
    }
    ctx.restore();
  });

  ctx.restore();

  if (drag.mode === "draw") {
    const x1 = Math.min(drag.sx, drag.ex);
    const y1 = Math.min(drag.sy, drag.ey);
    const x2 = Math.max(drag.sx, drag.ex);
    const y2 = Math.max(drag.sy, drag.ey);
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = "#000";
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#ffd34d";
    ctx.lineWidth = 2;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.restore();
  }
}

/* Edit pointer handling */
function getCanvasPoint(cvs, e) {
  const rect = cvs.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}
function clearLongPress() {
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = null;
  longPressActive = false;
}

canvas?.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const p = getCanvasPoint(canvas, e);
  pointers.set(e.pointerId, p);

  clearLongPress();
  longPressTimer = setTimeout(() => {
    longPressActive = true;
    drag.mode = "pan";
    drag.sx = p.x; drag.sy = p.y;
    drag.startPanX = state.panX;
    drag.startPanY = state.panY;
  }, CFG.longPressMs);

  if (e.shiftKey) {
    clearLongPress();
    drag.mode = "pan";
    drag.sx = p.x; drag.sy = p.y;
    drag.startPanX = state.panX;
    drag.startPanY = state.panY;
    return;
  }

  const hit = hitTestMaskEdit(p.x, p.y);
  if (hit) {
    clearLongPress();
    state.selectedMaskIds.clear();
    state.selectedMaskIds.add(hit.id);
    updateSelUI();

    drag.mode = "moveMask";
    drag.movingMaskId = hit.id;
    drag.maskStart = { x: hit.x, y: hit.y };
    const w = screenToWorld(p.x, p.y);
    drag.worldStart = { x: w.x, y: w.y };
    drawEdit();
    return;
  }

  drag.mode = "draw";
  drag.sx = p.x; drag.sy = p.y;
  drag.ex = p.x; drag.ey = p.y;
  drawEdit();
});

canvas?.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  const p = getCanvasPoint(canvas, e);
  pointers.set(e.pointerId, p);

  if (longPressTimer && !longPressActive) {
    const dx = p.x - drag.sx, dy = p.y - drag.sy;
    if (Math.hypot(dx, dy) > 6) clearLongPress();
  }

  if (drag.mode === "pan") {
    state.panX = drag.startPanX + (p.x - drag.sx);
    state.panY = drag.startPanY + (p.y - drag.sy);
    drawEdit();
    return;
  }

  if (drag.mode === "moveMask") {
    const id = drag.movingMaskId;
    const m = cache.masks.find((x) => x.id === id);
    if (!m) return;

    const w = screenToWorld(p.x, p.y);
    const dx = (w.x - drag.worldStart.x) / editPage.width;
    const dy = (w.y - drag.worldStart.y) / editPage.height;

    m.x = clamp(drag.maskStart.x + dx, 0, 1 - m.w);
    m.y = clamp(drag.maskStart.y + dy, 0, 1 - m.h);
    drawEdit();
    return;
  }

  if (drag.mode === "draw") {
    drag.ex = p.x; drag.ey = p.y;
    drawEdit();
  }
});

canvas?.addEventListener("pointerup", async (e) => {
  pointers.delete(e.pointerId);
  clearLongPress();

  if (drag.mode === "pan") { drag.mode = "none"; return; }

  if (drag.mode === "moveMask") {
    const id = drag.movingMaskId;
    drag.mode = "none";
    drag.movingMaskId = null;
    const m = cache.masks.find((x) => x.id === id);
    if (m) {
      await put("masks", m);
      await refreshCache();
      await renderEditSidebar();
      drawEdit();
    }
    return;
  }

  if (drag.mode !== "draw") { drag.mode = "none"; return; }
  drag.mode = "none";

  const rect = canvas.getBoundingClientRect();
  const ex = e.clientX - rect.left;
  const ey = e.clientY - rect.top;

  const x1 = Math.min(drag.sx, ex);
  const y1 = Math.min(drag.sy, ey);
  const x2 = Math.max(drag.sx, ex);
  const y2 = Math.max(drag.sy, ey);

  if (Math.abs(x2 - x1) < 8 || Math.abs(y2 - y1) < 8) { drawEdit(); return; }

  if (!state.currentGroupId) { await createGroup(); await refreshCache(); await renderEditSidebar(); }

  const w1 = screenToWorld(x1, y1);
  const w2 = screenToWorld(x2, y2);

  const nx = clamp01(w1.x / editPage.width);
  const ny = clamp01(w1.y / editPage.height);
  const nw = clamp01((w2.x - w1.x) / editPage.width);
  const nh = clamp01((w2.y - w1.y) / editPage.height);

  const m = {
    id: uid(),
    groupId: state.currentGroupId,
    printId: state.currentPrintId,
    pageIndex: 0,
    x: clamp(nx, 0, 1),
    y: clamp(ny, 0, 1),
    w: clamp(nw, 0.0005, 1),
    h: clamp(nh, 0.0005, 1),
    createdAt: now(),
  };
  m.x = clamp(m.x, 0, 1 - m.w);
  m.y = clamp(m.y, 0, 1 - m.h);

  await put("masks", m);
  await refreshCache();
  await renderEditSidebar();
  drawEdit();
});

/* =========================
   Single print from edit (A4) via iframe
   ========================= */
$("#btnExportPdf")?.addEventListener("click", async () => {
  try {
    await ensureEditLoaded();
    const dataUrl = await buildMaskedImageDataUrl(state.currentPrintId);
    const p = cache.prints.find(x => x.id === state.currentPrintId);
    const title = p?.title || "プリント";
    const html = `
      <html><head><meta charset="utf-8"/>
        <title>${escapeHtml(title)}</title>
        <style>
          @page { size: A4 portrait; margin: 8mm; }
          body{ margin:0; font-family: system-ui, -apple-system, sans-serif; }
          .page{ width:210mm; height:297mm; padding:8mm; box-sizing:border-box; display:flex; flex-direction:column; gap:6mm; }
          .cap{ font-size:12px; color:#333; }
          img{ flex:1; max-width:100%; max-height:100%; object-fit:contain; }
        </style>
      </head>
      <body>
        <section class="page">
          <div class="cap">${escapeHtml(title)}</div>
          <img src="${dataUrl}"/>
        </section>
        <script>window.onload=function(){setTimeout(function(){window.print();},50)}<\/script>
      </body></html>
    `;
    printHtmlViaIframe(html);
  } catch (e) {
    showFatal(e);
    alert("印刷に失敗しました。");
  }
});

/* =========================
   TODAY/REVIEW + Filter
   ========================= */
const todayModal = $("#todayModal");
function openTodayModal(){
  renderTodayOptions();
  todayModal?.classList.remove("hidden");
  todayModal?.setAttribute("aria-hidden","false");
}
function closeTodayModal(){
  todayModal?.classList.add("hidden");
  todayModal?.setAttribute("aria-hidden","true");
}
$("#btnTodayFilter")?.addEventListener("click", async () => {
  await refreshCache();
  openTodayModal();
});

function renderTodayOptions(){
  const wrap = $("#todayOptions");
  if (!wrap) return;
  wrap.innerHTML = "";

  const set = new Set();
  cache.prints.forEach(p => set.add(displaySubject(p)));
  SUBJECT_ORDER.forEach(s => set.add(s));
  const list = Array.from(set).filter(Boolean).sort((a,b)=>{
    const ai = SUBJECT_ORDER.indexOf(a);
    const bi = SUBJECT_ORDER.indexOf(b);
    if (ai>=0 && bi>=0) return ai-bi;
    if (ai>=0) return -1;
    if (bi>=0) return 1;
    return a.localeCompare(b,"ja");
  });

  const cur = state.todaySubjectFilter;

  list.forEach((name) => {
    const b = document.createElement("button");
    b.className = "btn";
    const on = cur ? cur.has(name) : false;
    b.textContent = on ? `✓ ${name}` : name;
    b.addEventListener("click", () => {
      if (!state.todaySubjectFilter) state.todaySubjectFilter = new Set();
      const s = state.todaySubjectFilter;
      if (s.has(name)) s.delete(name);
      else s.add(name);
      renderTodayOptions();
    });
    wrap.appendChild(b);
  });
}
$("#btnTodayAll")?.addEventListener("click", () => {
  state.todaySubjectFilter = null;
  renderTodayOptions();
});
$("#btnTodayClear")?.addEventListener("click", () => {
  state.todaySubjectFilter = new Set();
  renderTodayOptions();
});
$("#btnTodayApply")?.addEventListener("click", async () => {
  closeTodayModal();
  await renderToday();
});

const reviewCanvas = $("#reviewCanvas");
const reviewCtx = reviewCanvas?.getContext("2d");
let reviewTarget = null;

$("#btnBackToToday")?.addEventListener("click", () => $("#view-review")?.classList.add("hidden"));
$("#btnOpenEditFromReview")?.addEventListener("click", () => {
  if (!reviewTarget) return;
  state.currentPrintId = reviewTarget.g.printId;
  state.currentGroupId = reviewTarget.g.id;
  state.selectedMaskIds.clear();
  nav("edit");
});
$("#btnSkipToday")?.addEventListener("click", async () => {
  if (!reviewTarget) return;
  await skipToday(reviewTarget.g.id);
  await renderToday();
});

function updateReviewRemaining() {
  const total = state.reviewQueue?.length || 0;
  const idx = Math.max(0, state.reviewIndex);
  const rem = Math.max(0, total - idx);
  $("#reviewRemaining") && ($("#reviewRemaining").textContent = String(rem));
}

function showDoneScreen() {
  $("#view-review")?.classList.add("hidden");
  $("#view-done")?.classList.remove("hidden");
  $("#doneCount") && ($("#doneCount").textContent = String(state.doneTodayCount || 0));
}

function dueFilteredBySubjects(due){
  const filter = state.todaySubjectFilter;
  if (!filter || filter.size === 0) return due;
  return due.filter(({ g }) => {
    const p = cache.prints.find(x => x.id === g.printId);
    const s = displaySubject(p);
    return filter.has(s);
  });
}

async function renderToday() {
  await refreshCache();
  show("#view-today");

  $("#view-done")?.classList.add("hidden");
  $("#view-review")?.classList.add("hidden");

  let due = computeDueGroups();
  due = dueFilteredBySubjects(due);

  const filterInfo = state.todaySubjectFilter && state.todaySubjectFilter.size > 0
    ? ` / 教科：${Array.from(state.todaySubjectFilter).join("・")}`
    : "";
  $("#todayMeta") && ($("#todayMeta").textContent = `期限が来ているQ：${due.length}（スキップ除外）${filterInfo}`);

  state.practiceActive = false;
  state.practicePrintId = null;
  state.reviewQueue = due.map(x => x.g.id);
  state.reviewIndex = -1;
  state.doneTodayCount = 0;

  const list = $("#todayList");
  if (!list) return;
  list.innerHTML = "";
  if (due.length === 0) {
    list.innerHTML = `<div class="item muted">今日は復習なし（※期限Qがありません / またはフィルタで0件）</div>`;
    return;
  }

  for (const { g, s } of due) {
    const p = cache.prints.find((x) => x.id === g.printId);
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="row space">
        <div>
          <div class="itemTitle">${escapeHtml(p?.title || "プリント")} / ${escapeHtml(g.label || "(ラベルなし)")}</div>
          <div class="muted small">教科：${escapeHtml(displaySubject(p))} / 期限：${toDateStr(s.nextDueAt)} / 難易度:${s.difficulty.toFixed(1)} / 安定度:${s.stability.toFixed(1)}日 / 復習回数:${s.reviewCount}</div>
        </div>
        <div class="row">
          <button class="btn" data-skip="${g.id}">スキップ</button>
          <button class="btn" data-open-edit="${g.printId}" data-open-edit-group="${g.id}">編集</button>
          <button class="btn primary" data-open-review="${g.id}">開く</button>
        </div>
      </div>
    `;
    el.querySelector("[data-open-review]")?.addEventListener("click", async () => openReview(g.id));
    el.querySelector("[data-open-edit]")?.addEventListener("click", () => {
      state.currentPrintId = g.printId;
      state.currentGroupId = g.id;
      state.selectedMaskIds.clear();
      nav("edit");
    });
    el.querySelector("[data-skip]")?.addEventListener("click", async () => {
      await skipToday(g.id);
      await renderToday();
    });
    list.appendChild(el);
  }
}

async function openReview(groupId) {
  await refreshCache();
  const g = cache.groups.find((x) => x.id === groupId);
  if (!g) return;
  const p = cache.prints.find((x) => x.id === g.printId);
  const page = cache.pages.find((x) => x.printId === g.printId && x.pageIndex === 0);
  if (!page) return;
  const bitmap = await createImageBitmap(page.image);

  reviewTarget = { g, p, page, bitmap };
  state.revealedMaskIds.clear();

  const idx = state.reviewQueue.indexOf(groupId);
  state.reviewIndex = idx >= 0 ? idx : 0;

  $("#view-review")?.classList.remove("hidden");
  $("#reviewTitle") && ($("#reviewTitle").textContent = `${p?.title || "プリント"} / ${g.label || "(ラベルなし)"}`);

  const s = cache.srs.find((x) => x.groupId === g.id) || initSrsState(g.id);
  $("#reviewMeta") && ($("#reviewMeta").textContent = `教科：${displaySubject(p)} / 期限：${toDateStr(s.nextDueAt)} / 難易度:${s.difficulty.toFixed(1)} / 安定度:${s.stability.toFixed(1)}日`);

  updateReviewRemaining();
  drawReview();
}

function drawReview() {
  if (!reviewTarget || !reviewCtx || !reviewCanvas) return;

  const stage = $("#reviewStage");
  if (!stage) return;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  reviewCanvas.width = Math.max(1, Math.floor(sw));
  reviewCanvas.height = Math.max(1, Math.floor(sh));
  reviewCtx.clearRect(0, 0, reviewCanvas.width, reviewCanvas.height);

  const { page, bitmap, g } = reviewTarget;

  const zx = sw / page.width;
  const zy = sh / page.height;
  const z = Math.min(zx, zy);
  const px = (sw - page.width * z) / 2;
  const py = (sh - page.height * z) / 2;

  const gMap = new Map(cache.groups.map(x => [x.id, x]));

  reviewCtx.save();
  reviewCtx.translate(px, py);
  reviewCtx.scale(z, z);
  reviewCtx.drawImage(bitmap, 0, 0);

  const allMasks = cache.masks.filter((m) => m.printId === g.printId);
  allMasks.forEach((m) => {
    const revealed = state.revealedMaskIds.has(m.id);
    const rx = m.x * page.width;
    const ry = m.y * page.height;
    const rw = m.w * page.width;
    const rh = m.h * page.height;

    if (!revealed) {
      reviewCtx.globalAlpha = 1.0;
      reviewCtx.fillStyle = "#000";
      reviewCtx.fillRect(rx, ry, rw, rh);

      const label = gMap.get(m.groupId)?.label || "";
      if (label) drawMaskLabel(reviewCtx, label, rx + 4 / z, ry + 14 / z, z);
    } else {
      reviewCtx.globalAlpha = 0.15;
      reviewCtx.fillStyle = "#000";
      reviewCtx.fillRect(rx, ry, rw, rh);
      reviewCtx.globalAlpha = 1.0;
    }
  });

  const curMasks = cache.masks.filter((m) => m.groupId === g.id);
  curMasks.forEach((m) => {
    reviewCtx.strokeStyle = "#ffd34d";
    reviewCtx.lineWidth = 3 / z;
    reviewCtx.strokeRect(m.x * page.width, m.y * page.height, m.w * page.width, m.h * page.height);
  });

  reviewCtx.restore();
}

reviewCanvas?.addEventListener("click", (e) => {
  if (!reviewTarget) return;
  const rect = reviewCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const stage = $("#reviewStage");
  if (!stage) return;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  const { page, g } = reviewTarget;
  const zx = sw / page.width;
  const zy = sh / page.height;
  const z = Math.min(zx, zy);
  const px = (sw - page.width * z) / 2;
  const py = (sh - page.height * z) / 2;

  const wx = (x - px) / z;
  const wy = (y - py) / z;
  const nx = wx / page.width;
  const ny = wy / page.height;

  const curMasks = cache.masks.filter((m) => m.groupId === g.id);
  const hit = curMasks.find((m) => nx >= m.x && nx <= m.x + m.w && ny >= m.y && ny <= m.y + m.h);
  if (!hit) return;

  if (state.revealedMaskIds.has(hit.id)) state.revealedMaskIds.delete(hit.id);
  else state.revealedMaskIds.add(hit.id);
  drawReview();
});

/* Next/Prev buttons (within current queue) */
$("#btnNextQ")?.addEventListener("click", async () => {
  if (!state.reviewQueue || state.reviewQueue.length === 0) return;
  const ni = Math.min(state.reviewIndex + 1, state.reviewQueue.length - 1);
  state.reviewIndex = ni;
  await openReview(state.reviewQueue[ni]);
});
$("#btnPrevQ")?.addEventListener("click", async () => {
  if (!state.reviewQueue || state.reviewQueue.length === 0) return;
  const pi = Math.max(state.reviewIndex - 1, 0);
  state.reviewIndex = pi;
  await openReview(state.reviewQueue[pi]);
});

/* 評価 → 次へ / 終了 */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-review-rate]");
  if (!btn || !reviewTarget) return;

  const rating = btn.getAttribute("data-review-rate");
  if (!["again", "hard", "good", "easy"].includes(rating)) return;

  await refreshCache();
  const gid = reviewTarget.g.id;
  const g = cache.groups.find((x) => x.id === gid);
  if (!g) return;

  let s = cache.srs.find((x) => x.groupId === g.id);
  if (!s) s = initSrsState(g.id);

  const next = updateSrs(s, rating);

  await del("skips", g.id);

  await tx(["srs", "reviews", "groups"], "readwrite", (st) => {
    st.srs.put(next);
    st.reviews.put({ id: uid(), groupId: g.id, reviewedAt: now(), rating });
    g.isActive = true;
    st.groups.put(g);
  });

  state.doneTodayCount = (state.doneTodayCount || 0) + 1;

  await refreshCache();

  if (state.practiceActive) {
    const nextIndex = state.reviewIndex + 1;
    if (nextIndex >= state.reviewQueue.length) {
      showDoneScreen();
      return;
    }
    state.reviewIndex = nextIndex;
    await openReview(state.reviewQueue[state.reviewIndex]);
    return;
  }

  // today mode: recompute due with filter
  let dueNow = computeDueGroups();
  dueNow = dueFilteredBySubjects(dueNow);
  const dueIds = dueNow.map(x => x.g.id);

  if (dueIds.length === 0) {
    await renderToday();
    showDoneScreen();
    return;
  }

  state.reviewQueue = dueIds;
  const nextIndex = Math.min(Math.max(state.reviewIndex, 0), dueIds.length - 1);
  state.reviewIndex = nextIndex;
  await openReview(dueIds[nextIndex]);
});

/* =========================
   Practice Picker (choose Q(s) even if not due)
   ========================= */
const pickerModal = $("#pickerModal");
const pickerCanvas = $("#pickerCanvas");
const pickerCtx = pickerCanvas?.getContext("2d");

const pickerState = {
  printId: null,
  page: null,
  bitmap: null,
  selectedGroupIds: new Set(),
  z: 1,
  px: 0,
  py: 0,
  minZ: 0.2,
  maxZ: 6,
};

function openPickerModal(){
  pickerModal?.classList.remove("hidden");
  pickerModal?.setAttribute("aria-hidden","false");
}
function closePickerModal(){
  pickerModal?.classList.add("hidden");
  pickerModal?.setAttribute("aria-hidden","true");
}
function hasPickerUI(){
  return !!(pickerModal && pickerCanvas && $("#pickerStage") && $("#pickerStart") && $("#pickerGroupList"));
}

async function tryOpenPracticeOrFirstDue(printId){
  await refreshCache();
  let dueForPrint = computeDueGroups().filter(({ g }) => g.printId === printId);
  dueForPrint = dueFilteredBySubjects(dueForPrint);

  if (dueForPrint.length > 0) {
    await nav("today");
    setTimeout(() => openReview(dueForPrint[0].g.id), 0);
    return;
  }
  const ok = await safeOpenPracticePicker(printId, { reason:"dueEmpty" });
  if (!ok) alert("学習ピッカーUIが見つかりません（index.html反映を確認してください）");
}

async function safeOpenPracticePicker(printId, { reason="manual" } = {}) {
  if (!hasPickerUI()) return false;

  await refreshCache();
  const p = cache.prints.find(x => x.id === printId);
  const page = cache.pages.find(x => x.printId === printId && x.pageIndex === 0);
  if (!p || !page) return false;

  const bitmap = await createImageBitmap(page.image);

  pickerState.printId = printId;
  pickerState.page = page;
  pickerState.bitmap = bitmap;
  pickerState.selectedGroupIds.clear();

  $("#pickerTitle") && ($("#pickerTitle").textContent = "学習するQを選択");
  $("#pickerSub") && ($("#pickerSub").textContent =
    reason === "dueEmpty"
      ? "このプリントは今日の復習対象（期限Q）がありません。学習したいQを選んで開始できます（複数OK）。"
      : "プリント画像上でQ（黒塗り）をタップして選択できます（複数OK）。"
  );

  await renderPickerGroupList();
  openPickerModal();
  requestAnimationFrame(() => {
    fitPickerToStage(true);
    drawPicker();
  });
  return true;
}

function fitPickerToStage(reset=false){
  const stage = $("#pickerStage");
  if (!stage || !pickerState.page || !pickerCanvas) return;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;

  pickerCanvas.width = Math.max(1, Math.floor(sw));
  pickerCanvas.height = Math.max(1, Math.floor(sh));

  const zx = sw / pickerState.page.width;
  const zy = sh / pickerState.page.height;
  const fitZ = Math.min(zx, zy);

  pickerState.minZ = Math.max(0.1, fitZ * 0.6);
  pickerState.maxZ = Math.max(2.5, fitZ * 6);

  if (reset) {
    pickerState.z = fitZ;
    pickerState.px = (sw - pickerState.page.width * pickerState.z) / 2;
    pickerState.py = (sh - pickerState.page.height * pickerState.z) / 2;
  } else {
    pickerState.z = clamp(pickerState.z, pickerState.minZ, pickerState.maxZ);
  }
}

async function renderPickerGroupList(){
  await refreshCache();
  const list = $("#pickerGroupList");
  if (!list) return;
  list.innerHTML = "";

  const groups = cache.groups
    .filter(g => g.printId === pickerState.printId)
    .sort((a,b) => a.orderIndex - b.orderIndex);

  for (const g of groups) {
    const count = cache.masks.filter(m => m.groupId === g.id).length;
    const checked = pickerState.selectedGroupIds.has(g.id);

    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div class="row space">
        <label class="row" style="gap:10px; cursor:pointer;">
          <input type="checkbox" data-pick-check="${g.id}" ${checked ? "checked":""}/>
          <div>
            <div class="itemTitle">${escapeHtml(g.label || "(ラベルなし)")}</div>
            <div class="muted small">マスク ${count}</div>
          </div>
        </label>
        <button class="btn" data-pick-only="${g.id}">このQだけ</button>
      </div>
    `;
    row.querySelector(`[data-pick-check="${g.id}"]`)?.addEventListener("change", async (ev) => {
      if (ev.target.checked) pickerState.selectedGroupIds.add(g.id);
      else pickerState.selectedGroupIds.delete(g.id);
      updatePickerSelUI();
      drawPicker();
    });
    row.querySelector(`[data-pick-only="${g.id}"]`)?.addEventListener("click", async () => {
      pickerState.selectedGroupIds.clear();
      pickerState.selectedGroupIds.add(g.id);
      await renderPickerGroupList();
      updatePickerSelUI();
      drawPicker();
    });

    list.appendChild(row);
  }

  updatePickerSelUI();
}

function updatePickerSelUI(){
  $("#pickerSelCount") && ($("#pickerSelCount").textContent = String(pickerState.selectedGroupIds.size));
}

function drawPicker(){
  if (!pickerCtx || !pickerState.page || !pickerState.bitmap || !pickerCanvas) return;

  const stage = $("#pickerStage");
  if (!stage) return;

  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (pickerCanvas.width !== Math.floor(sw) || pickerCanvas.height !== Math.floor(sh)) {
    pickerCanvas.width = Math.max(1, Math.floor(sw));
    pickerCanvas.height = Math.max(1, Math.floor(sh));
  }

  pickerCtx.clearRect(0,0,pickerCanvas.width,pickerCanvas.height);

  const page = pickerState.page;
  const z = pickerState.z;
  const px = pickerState.px;
  const py = pickerState.py;

  const gMap = new Map(cache.groups.map(g => [g.id, g]));
  const masks = cache.masks.filter(m => m.printId === pickerState.printId);

  pickerCtx.save();
  pickerCtx.translate(px, py);
  pickerCtx.scale(z, z);

  pickerCtx.drawImage(pickerState.bitmap, 0, 0);

  masks.forEach(m => {
    const rx = m.x * page.width;
    const ry = m.y * page.height;
    const rw = m.w * page.width;
    const rh = m.h * page.height;

    pickerCtx.fillStyle = "#000";
    pickerCtx.fillRect(rx, ry, rw, rh);

    const label = gMap.get(m.groupId)?.label || "";
    if (label) drawMaskLabel(pickerCtx, label, rx + 4 / z, ry + 14 / z, z);

    if (pickerState.selectedGroupIds.has(m.groupId)) {
      pickerCtx.strokeStyle = "#ffd34d";
      pickerCtx.lineWidth = 4 / z;
      pickerCtx.strokeRect(rx, ry, rw, rh);
    }
  });

  pickerCtx.restore();
}

function pickerScreenToNorm(x, y){
  const page = pickerState.page;
  const z = pickerState.z;
  const px = pickerState.px;
  const py = pickerState.py;

  const wx = (x - px) / z;
  const wy = (y - py) / z;
  return { nx: wx / page.width, ny: wy / page.height };
}

function pickerZoomAt(screenX, screenY, newZ){
  newZ = clamp(newZ, pickerState.minZ, pickerState.maxZ);
  const worldX = (screenX - pickerState.px) / pickerState.z;
  const worldY = (screenY - pickerState.py) / pickerState.z;
  pickerState.z = newZ;
  pickerState.px = screenX - worldX * pickerState.z;
  pickerState.py = screenY - worldY * pickerState.z;
  drawPicker();
}

/* pinch/pan */
const pickerPointers = new Map();
let pickerGesture = { mode:"none", startPx:0, startPy:0, startZ:1, startDist:0, startCenter:{x:0,y:0}, moved:false };

function getPickerPoint(e){
  const rect = pickerCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function center(a,b){ return { x: (a.x+b.x)/2, y: (a.y+b.y)/2 }; }

pickerCanvas?.addEventListener("pointerdown", (e) => {
  pickerCanvas.setPointerCapture(e.pointerId);
  const p = getPickerPoint(e);
  pickerPointers.set(e.pointerId, p);
  pickerGesture.moved = false;

  if (pickerPointers.size === 1) {
    pickerGesture.mode = "pan";
    pickerGesture.startPx = pickerState.px;
    pickerGesture.startPy = pickerState.py;
    pickerGesture.startCenter = { ...p };
  } else if (pickerPointers.size === 2) {
    const pts = Array.from(pickerPointers.values());
    pickerGesture.mode = "pinch";
    pickerGesture.startPx = pickerState.px;
    pickerGesture.startPy = pickerState.py;
    pickerGesture.startZ = pickerState.z;
    pickerGesture.startDist = dist(pts[0], pts[1]);
    pickerGesture.startCenter = center(pts[0], pts[1]);
  } else {
    pickerGesture.mode = "none";
  }
});

pickerCanvas?.addEventListener("pointermove", (e) => {
  if (!pickerPointers.has(e.pointerId)) return;
  const p = getPickerPoint(e);
  pickerPointers.set(e.pointerId, p);

  const pts = Array.from(pickerPointers.values());

  if (pickerPointers.size === 1 && pickerGesture.mode === "pan") {
    const dx = p.x - pickerGesture.startCenter.x;
    const dy = p.y - pickerGesture.startCenter.y;
    if (Math.hypot(dx,dy) > 6) pickerGesture.moved = true;
    if (!pickerGesture.moved) return;

    pickerState.px = pickerGesture.startPx + dx;
    pickerState.py = pickerGesture.startPy + dy;
    drawPicker();
    return;
  }

  if (pickerPointers.size === 2 && pickerGesture.mode === "pinch") {
    const c = center(pts[0], pts[1]);
    const d = dist(pts[0], pts[1]);
    if (Math.abs(d - pickerGesture.startDist) > 2) pickerGesture.moved = true;

    const scale = d / Math.max(1e-6, pickerGesture.startDist);
    const newZ = pickerGesture.startZ * scale;

    pickerZoomAt(c.x, c.y, newZ);

    const cdx = c.x - pickerGesture.startCenter.x;
    const cdy = c.y - pickerGesture.startCenter.y;
    pickerState.px += cdx;
    pickerState.py += cdy;

    drawPicker();
    return;
  }
});

pickerCanvas?.addEventListener("pointerup", async (e) => {
  if (!pickerPointers.has(e.pointerId)) return;
  pickerPointers.delete(e.pointerId);

  if (pickerPointers.size === 1) {
    const p = Array.from(pickerPointers.values())[0];
    pickerGesture.mode = "pan";
    pickerGesture.startPx = pickerState.px;
    pickerGesture.startPy = pickerState.py;
    pickerGesture.startCenter = { ...p };
    pickerGesture.moved = false;
  } else if (pickerPointers.size === 0) {
    const wasMoved = pickerGesture.moved;
    pickerGesture.mode = "none";
    pickerGesture.moved = false;

    if (!wasMoved) {
      await refreshCache();
      if (!pickerState.page) return;

      const rect = pickerCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const { nx, ny } = pickerScreenToNorm(x, y);
      const masks = cache.masks.filter(m => m.printId === pickerState.printId).slice().reverse();
      const hit = masks.find(m => nx >= m.x && nx <= m.x + m.w && ny >= m.y && ny <= m.y + m.h);
      if (!hit) return;

      const gid = hit.groupId;
      if (pickerState.selectedGroupIds.has(gid)) pickerState.selectedGroupIds.delete(gid);
      else pickerState.selectedGroupIds.add(gid);

      await renderPickerGroupList();
      drawPicker();
    }
  }
});

pickerCanvas?.addEventListener("pointercancel", () => {
  pickerPointers.clear();
  pickerGesture.mode = "none";
  pickerGesture.moved = false;
});

pickerCanvas?.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (!pickerState.page) return;

  const rect = pickerCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const factor = e.deltaY > 0 ? 0.9 : 1.1;
  pickerZoomAt(x, y, pickerState.z * factor);
}, { passive:false });

$("#pickerSelectAll")?.addEventListener("click", async () => {
  await refreshCache();
  const groups = cache.groups.filter(g => g.printId === pickerState.printId);
  pickerState.selectedGroupIds = new Set(groups.map(g => g.id));
  await renderPickerGroupList();
  drawPicker();
});
$("#pickerClear")?.addEventListener("click", async () => {
  pickerState.selectedGroupIds.clear();
  await renderPickerGroupList();
  drawPicker();
});
$("#pickerFit")?.addEventListener("click", () => { fitPickerToStage(true); drawPicker(); });
$("#pickerZoomIn")?.addEventListener("click", () => {
  const stage = $("#pickerStage");
  if (!stage) return;
  pickerZoomAt(stage.clientWidth/2, stage.clientHeight/2, pickerState.z * 1.25);
});
$("#pickerZoomOut")?.addEventListener("click", () => {
  const stage = $("#pickerStage");
  if (!stage) return;
  pickerZoomAt(stage.clientWidth/2, stage.clientHeight/2, pickerState.z / 1.25);
});

$("#pickerStart")?.addEventListener("click", async () => {
  if (!pickerState.printId) return;
  await refreshCache();

  const sel = Array.from(pickerState.selectedGroupIds);
  if (sel.length === 0) {
    alert("学習するQを選択してください（画像の黒塗りをタップするか、一覧でチェック）");
    return;
  }

  const order = new Map(cache.groups.map(g => [g.id, g.orderIndex]));
  sel.sort((a,b) => (order.get(a) ?? 9999) - (order.get(b) ?? 9999));

  closePickerModal();

  state.practiceActive = true;
  state.practicePrintId = pickerState.printId;
  state.reviewQueue = sel;
  state.reviewIndex = 0;
  state.doneTodayCount = 0;

  await nav("today");
  await openReview(state.reviewQueue[0]);
});

/* =========================
   Move Selected / Print Selected button safety check
   ========================= */
$("#btnPrintSelected")?.addEventListener("mouseenter", updateHomeSelectionUI);
$("#btnMoveSelected")?.addEventListener("mouseenter", updateHomeSelectionUI);

/* =========================
   Move Selected open
   ========================= */
$("#btnMoveSelected")?.addEventListener("click", () => {
  if (state.selectedPrintIds.size === 0) return;
  openMoveModal();
});

/* =========================
   Subject modal open from edit header (click)
   ========================= */
$("#editMeta")?.addEventListener("click", () => openSubjectModal({ type:"edit" }));

/* =========================
   Boot
   ========================= */
(async function boot() {
  try {
    await nav("home");
  } catch (e) {
    showFatal(e);
  }
})();
