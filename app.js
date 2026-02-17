/* Print SRS Lite Pro (Nodeなし / IndexedDB)
   2026-02-17 update:
   - iPad PDF: window.open をクリック直後に確保（ポップアップブロック対策）
   - 「このプリントを復習」：期限が無くても “Qを画像で選んで学習” 可能
   - Q選択：編集/復習同様に、黒塗り＋Qラベル入りのプリント画像を表示し、単数/複数を選択
   - 評価ボタンを日本語（もう一度/難しい/正解/簡単）
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

const SUBJECT_ORDER = ["算数","国語","英語","理科","社会","その他"];
function normSubject(s){
  const t = (s || "その他").trim();
  // 「その他:○○」も許容
  if (t.startsWith("その他:")) return t;
  return SUBJECT_ORDER.includes(t) ? t : "その他";
}
function isOtherSubject(s){
  return (s || "").trim() === "その他" || (s || "").trim().startsWith("その他:");
}

/* toast */
let toastTimer = null;
function showToast(title, sub="", ms=2200){
  const el = $("#toast");
  if (!el) return;
  el.innerHTML = `<div class="toast__title">${escapeHtml(title)}</div>${sub?`<div class="toast__sub">${escapeHtml(sub)}</div>`:""}`;
  el.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> el.classList.add("hidden"), ms);
}

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

  // practice mode (due無関係)
  practiceActive: false,
  practicePrintId: null,
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
    if (to === "home") { state.practiceActive = false; await renderHome(); }
    else if (to === "add") { state.practiceActive = false; renderAdd(); }
    else if (to === "edit") { state.practiceActive = false; await renderEdit(); }
    else if (to === "today") {
      if (state.practiceActive) await renderPractice();
      else await renderToday();
    }
  } catch (e) {
    console.error("nav error:", e);
    if (to === "home") show("#view-home");
    if (to === "add") show("#view-add");
    if (to === "edit") show("#view-edit");
    if (to === "today") show("#view-today");
    alert("画面更新中にエラーが出ました。コンソール(DevTools)に詳細があります。");
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
  const btn = $("#btnDeleteSelected");
  if (btn) {
    btn.disabled = n === 0;
    btn.textContent = n === 0 ? "選択したプリントを削除" : `選択したプリントを削除（${n}件）`;
  }
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
   HOME (教科でカテゴリ分け)
   ========================= */
function groupPrintsBySubject(prints) {
  const map = new Map();
  for (const p of prints) {
    const subj = normSubject(p.subject);
    if (!map.has(subj)) map.set(subj, []);
    map.get(subj).push(p);
  }
  for (const [k, arr] of map.entries()) {
    arr.sort((a,b) => b.createdAt - a.createdAt);
  }
  return map;
}

function renderOnePrintItem(p) {
  const gCount = cache.groups.filter((g) => g.printId === p.id).length;
  const mCount = cache.masks.filter((m) => m.printId === p.id).length;
  const checked = state.selectedPrintIds.has(p.id);

  const el = document.createElement("div");
  el.className = "item";
  el.innerHTML = `
    <div class="row space">
      <div class="row" style="align-items:flex-start">
        <input class="checkbox" type="checkbox" data-print-check="${p.id}" ${checked ? "checked" : ""}/>
        <div>
          <div class="itemTitle">${escapeHtml(p.title)}</div>
          <div class="muted small">${escapeHtml(normSubject(p.subject))} / ${new Date(p.createdAt).toLocaleDateString()} / Q:${gCount} / mask:${mCount}</div>
        </div>
      </div>
      <div class="row">
        <button class="btn" data-open-edit="${p.id}">編集</button>
        <button class="btn" data-open-practice="${p.id}">このプリントを学習</button>
        <button class="btn primary" data-open-today="${p.id}">このプリントを復習</button>
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

  // 期限があるなら従来通り “due” を開く。無いならQ選択学習へ誘導
  el.querySelector("[data-open-today]")?.addEventListener("click", async () => {
    await refreshCache();
    const due = computeDueGroups().filter(({ g }) => g.printId === p.id);
    if (due.length > 0) {
      state.currentPrintId = p.id;
      state.practiceActive = false;
      await nav("today");
      setTimeout(() => openReview(due[0].g.id), 0);
    } else {
      // 期限なし＝学習ピッカーへ
      openPracticePicker(p.id, { reason: "dueEmpty" });
    }
  });

  el.querySelector("[data-open-practice]")?.addEventListener("click", () => {
    openPracticePicker(p.id, { reason: "manual" });
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
    return;
  }

  const bySubj = groupPrintsBySubject(prints);

  for (const subj of SUBJECT_ORDER) {
    const arr = bySubj.get(subj);
    if (!arr || arr.length === 0) continue;

    const header = document.createElement("div");
    header.className = "item";
    header.style.background = "rgba(255,255,255,0.03)";
    header.style.borderStyle = "dashed";
    header.innerHTML = `<div class="itemTitle">${escapeHtml(subj)}</div><div class="muted small">プリント ${arr.length} 件</div>`;
    list.appendChild(header);

    for (const p of arr) {
      list.appendChild(renderOnePrintItem(p));
    }
  }

  // 「その他:○○」などがある場合は最後にまとめて表示
  const others = prints.filter(p => {
    const s = normSubject(p.subject);
    return s.startsWith("その他:");
  });
  if (others.length > 0) {
    const header = document.createElement("div");
    header.className = "item";
    header.style.background = "rgba(255,255,255,0.03)";
    header.style.borderStyle = "dashed";
    header.innerHTML = `<div class="itemTitle">その他（自由記載）</div><div class="muted small">プリント ${others.length} 件</div>`;
    list.appendChild(header);
    for (const p of others) list.appendChild(renderOnePrintItem(p));
  }
}

/* =========================
   ADD
   ========================= */
function renderAdd() {
  show("#view-add");
  $("#addStatus") && ($("#addStatus").textContent = "");
  $("#addTitle") && ($("#addTitle").value = `プリント ${new Date().toLocaleDateString()}`);
  $("#addSubject") && ($("#addSubject").value = "算数");
  $("#addFile") && ($("#addFile").value = "");

  $("#addSubjectOtherWrap")?.classList.add("hidden");
  $("#addSubjectOther") && ($("#addSubjectOther").value = "");
}

function updateAddOtherUI(){
  const v = ($("#addSubject")?.value || "").trim();
  const wrap = $("#addSubjectOtherWrap");
  if (!wrap) return;
  if (v === "その他") wrap.classList.remove("hidden");
  else wrap.classList.add("hidden");
}
$("#addSubject")?.addEventListener("change", updateAddOtherUI);

$("#btnCreatePrint")?.addEventListener("click", async () => {
  const title = ($("#addTitle")?.value || "").trim() || `プリント ${new Date().toLocaleDateString()}`;
  let subject = ($("#addSubject")?.value || "その他").trim();
  if (subject === "その他") {
    const other = ($("#addSubjectOther")?.value || "").trim();
    if (other) subject = `その他:${other}`;
  }
  subject = normSubject(subject);

  const file = $("#addFile")?.files && $("#addFile").files[0];
  if (!file) { $("#addStatus") && ($("#addStatus").textContent = "画像ファイルを選んでください。"); return; }

  $("#addStatus") && ($("#addStatus").textContent = "取り込み中（変換/圧縮）...");
  try {
    const bitmap = await fileToBitmap(file);
    const { blob, width, height } = await compressBitmapToJpegBlob(bitmap);

    const printId = uid();
    const pageId = uid();
    const t = now();
    const print = { id: printId, title, subject, createdAt: t };
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
    console.error(err);
    $("#addStatus") && ($("#addStatus").textContent = `失敗：${err.message || err}`);
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

// タップでタイトル/教科変更（簡易：prompt。将来モーダル化OK）
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
async function changeCurrentSubject() {
  await refreshCache();
  const p = cache.prints.find(x => x.id === state.currentPrintId);
  if (!p) return;

  const base = isOtherSubject(p.subject) ? "その他" : normSubject(p.subject);
  let v = prompt("教科を変更（算数/国語/英語/理科/社会/その他）", base || "その他");
  if (v === null) return;
  v = v.trim();
  if (!SUBJECT_ORDER.includes(v)) v = "その他";

  let subj = v;
  if (v === "その他") {
    const other = prompt("その他（自由記載）", (p.subject || "").startsWith("その他:") ? (p.subject.split("その他:")[1] || "") : "");
    if (other && other.trim()) subj = `その他:${other.trim()}`;
    else subj = "その他";
  }
  p.subject = normSubject(subj);
  await put("prints", p);
  await refreshCache();
  updateEditHeaderClickable();
}

function updateEditHeaderClickable() {
  const p = cache.prints.find((x) => x.id === state.currentPrintId);
  const titleEl = $("#editTitle");
  const metaEl = $("#editMeta");
  if (titleEl) {
    titleEl.textContent = p ? `編集：${p.title}` : "編集";
    titleEl.style.cursor = "pointer";
    titleEl.title = "タップで名前変更";
  }
  if (metaEl) {
    metaEl.textContent = p ? `${normSubject(p.subject)} / ${new Date(p.createdAt).toLocaleDateString()}` : "";
    metaEl.style.cursor = "pointer";
    metaEl.title = "タップで教科変更";
  }
  if (titleEl) titleEl.onclick = () => renameCurrentPrint();
  if (metaEl) metaEl.onclick = () => changeCurrentSubject();
}

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

/* ----- Edit pointer handling ----- */
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
   PDF Export (A4 fit) - iPad popup safe
   ========================= */
$("#btnExportPdf")?.addEventListener("click", () => {
  // iOS Safari対策：クリック直後にタブ確保
  const win = window.open("", "_blank");
  if (!win) {
    alert("ポップアップがブロックされました。\nSafari設定でポップアップを許可するか、通常のSafariタブで開いてください。");
    return;
  }

  (async () => {
    await ensureEditLoaded();
    if (!editPage || !editImgBitmap) return;

    const off = document.createElement("canvas");
    off.width = editPage.width;
    off.height = editPage.height;
    const octx = off.getContext("2d");
    octx.drawImage(editImgBitmap, 0, 0);

    await refreshCache();
    const masks = cache.masks.filter(m => m.printId === state.currentPrintId);
    masks.forEach(m => {
      octx.fillStyle = "black";
      octx.fillRect(
        m.x * editPage.width,
        m.y * editPage.height,
        m.w * editPage.width,
        m.h * editPage.height
      );
    });

    const dataUrl = off.toDataURL("image/jpeg", 0.95);

    win.document.open();
    win.document.write(`
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>Print</title>
          <style>
            @page { size: A4 portrait; margin: 8mm; }
            html, body { margin: 0; padding: 0; }
            .bar{
              position: sticky; top: 0;
              padding: 12px;
              background: #111319;
              color: #e9eef6;
              border-bottom: 1px solid #242a36;
              display:flex; gap:10px; align-items:center; justify-content:space-between;
              font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
            }
            button{
              padding:10px 12px; border-radius:10px;
              border:1px solid #242a36; background:#3f7cff; color:#fff;
              font-size:14px;
            }
            .sheet{
              width: 210mm; min-height: 297mm;
              margin: 0 auto;
              display: flex; align-items: center; justify-content: center;
              padding: 8mm;
              box-sizing: border-box;
            }
            img { max-width: 100%; max-height: 100%; object-fit: contain; }
          </style>
        </head>
        <body>
          <div class="bar">
            <div>PDF/印刷（A4）</div>
            <button onclick="window.print()">印刷</button>
          </div>
          <div class="sheet"><img src="${dataUrl}"></div>
        </body>
      </html>
    `);
    win.document.close();
  })().catch(err => {
    console.error(err);
    try { win.close(); } catch {}
    alert("PDF出力でエラーが出ました。");
  });
});

/* 編集完了 */
$("#btnEditDone")?.addEventListener("click", async () => {
  showToast("編集完了しました", "ホームに戻ります", 1800);
  await nav("home");
});

/* =========================
   TODAY/REVIEW
   ========================= */
const reviewCanvas = $("#reviewCanvas");
const reviewCtx = reviewCanvas?.getContext("2d");
let reviewTarget = null;

$("#btnBackToToday")?.addEventListener("click", () => {
  $("#view-review")?.classList.add("hidden");
});
$("#btnOpenEditFromReview")?.addEventListener("click", () => {
  if (!reviewTarget) return;
  state.currentPrintId = reviewTarget.g.printId;
  state.currentGroupId = reviewTarget.g.id;
  state.selectedMaskIds.clear();
  nav("edit");
});
$("#btnSkipToday")?.addEventListener("click", async () => {
  if (!reviewTarget) return;
  if (state.practiceActive) return; // 学習モードではスキップ不要
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

  if (state.practiceActive) {
    $("#doneTitle") && ($("#doneTitle").textContent = "学習終了！");
    $("#doneMsg") && ($("#doneMsg").textContent = "選択したQの学習が終わりました。");
    $("#doneNote") && ($("#doneNote").textContent = "※評価はSRSに反映されています。次回の期限に応じて「今日の復習」に出ます。");
  } else {
    $("#doneTitle") && ($("#doneTitle").textContent = "本日の分は終了！");
    $("#doneMsg") && ($("#doneMsg").textContent = "おつかれさまでした。よく頑張りました。");
    $("#doneNote") && ($("#doneNote").textContent = "※明日以降、期限が来たらまた「今日の復習」に出ます。");
  }
}

async function renderToday() {
  await refreshCache();
  show("#view-today");

  $("#todayTitle") && ($("#todayTitle").textContent = "今日の復習");
  $("#todayListCard")?.classList.remove("hidden");

  $("#view-done")?.classList.add("hidden");
  $("#view-review")?.classList.add("hidden");

  const due = computeDueGroups();
  $("#todayMeta") && ($("#todayMeta").textContent = `期限が来ているQ：${due.length}（スキップ除外）`);

  state.reviewQueue = due.map(x => x.g.id);
  state.reviewIndex = -1;
  state.doneTodayCount = 0;

  const list = $("#todayList");
  if (!list) return;
  list.innerHTML = "";
  if (due.length === 0) {
    list.innerHTML = `<div class="item muted">今日は復習なし</div>`;
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
          <div class="muted small">期限：${toDateStr(s.nextDueAt)} / 難易度:${s.difficulty.toFixed(1)} / 安定度:${s.stability.toFixed(1)}日 / 復習回数:${s.reviewCount}</div>
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

async function renderPractice() {
  await refreshCache();
  show("#view-today");
  $("#todayTitle") && ($("#todayTitle").textContent = "学習（任意のQ）");
  $("#todayMeta") && ($("#todayMeta").textContent = "期限に関係なく、選択したQを学習中");
  $("#todayListCard")?.classList.add("hidden");
  $("#view-done")?.classList.add("hidden");
  $("#view-review")?.classList.remove("hidden");

  // 学習モードでは一覧に戻る必要が薄いので文言だけ
  $("#btnBackToToday") && ($("#btnBackToToday").textContent = "戻る");
  $("#btnSkipToday") && ($("#btnSkipToday").disabled = true);

  // すでにキューがある前提
  if (state.reviewQueue.length > 0) {
    state.reviewIndex = 0;
    await openReview(state.reviewQueue[0]);
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

  // queue内の位置を同期
  const idx = state.reviewQueue.indexOf(groupId);
  state.reviewIndex = idx >= 0 ? idx : 0;

  $("#view-review")?.classList.remove("hidden");
  $("#reviewTitle") && ($("#reviewTitle").textContent = `${p?.title || "プリント"} / ${g.label || "(ラベルなし)"}`);

  const s = cache.srs.find((x) => x.groupId === g.id) || initSrsState(g.id);
  $("#reviewMeta") && ($("#reviewMeta").textContent = `次回期限：${toDateStr(s.nextDueAt)} / 難易度:${s.difficulty.toFixed(1)} / 安定度:${s.stability.toFixed(1)}日`);

  // 学習モード：スキップボタン無効
  if (state.practiceActive) {
    $("#btnSkipToday")?.classList.add("hidden");
    $("#btnBackToToday") && ($("#btnBackToToday").textContent = "学習をやめる");
  } else {
    $("#btnSkipToday")?.classList.remove("hidden");
    $("#btnSkipToday") && ($("#btnSkipToday").disabled = false);
    $("#btnBackToToday") && ($("#btnBackToToday").textContent = "一覧へ戻る");
  }

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

/* =========================
   評価 → 次へ / 終了
   ========================= */
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

  // due復習の場合はスキップ解除（学習でも解除してOK）
  await del("skips", g.id);

  await tx(["srs", "reviews", "groups"], "readwrite", (st) => {
    st.srs.put(next);
    st.reviews.put({ id: uid(), groupId: g.id, reviewedAt: now(), rating });
    g.isActive = true;
    st.groups.put(g);
  });

  state.doneTodayCount = (state.doneTodayCount || 0) + 1;

  // 次へ
  const idx = state.reviewQueue.indexOf(gid);
  const nextIdx = idx >= 0 ? idx + 1 : state.reviewIndex + 1;

  if (nextIdx >= state.reviewQueue.length) {
    // 終了
    showDoneScreen();
    return;
  }

  state.reviewIndex = nextIdx;
  await openReview(state.reviewQueue[nextIdx]);
});

/* 次/前ボタン（手動移動） */
$("#btnNextQ")?.addEventListener("click", async () => {
  const i = Math.max(0, state.reviewIndex);
  if (i + 1 >= state.reviewQueue.length) return;
  state.reviewIndex = i + 1;
  await openReview(state.reviewQueue[state.reviewIndex]);
});
$("#btnPrevQ")?.addEventListener("click", async () => {
  const i = Math.max(0, state.reviewIndex);
  if (i - 1 < 0) return;
  state.reviewIndex = i - 1;
  await openReview(state.reviewQueue[state.reviewIndex]);
});

/* =========================
   Practice Picker (黒塗り＋Qラベル画像で選択) + ピンチズーム
   ========================= */
const pickerModal = $("#pickerModal");
const pickerCanvas = $("#pickerCanvas");
const pickerCtx = pickerCanvas?.getContext("2d");

const pickerState = {
  printId: null,
  page: null,
  bitmap: null,
  selectedGroupIds: new Set(),
  // display transform
  z: 1,
  px: 0,
  py: 0,
  // min/max zoom
  minZ: 0.2,
  maxZ: 6,
};

function openModalPicker(){
  if (!pickerModal) return;
  pickerModal.classList.remove("hidden");
  pickerModal.setAttribute("aria-hidden","false");
}
function closeModalPicker(){
  if (!pickerModal) return;
  pickerModal.classList.add("hidden");
  pickerModal.setAttribute("aria-hidden","true");
}

document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-modal-close]");
  if (!c) return;
  const which = c.getAttribute("data-modal-close");
  if (which === "picker") closeModalPicker();
});

async function openPracticePicker(printId, { reason="manual" } = {}) {
  await refreshCache();
  const p = cache.prints.find(x => x.id === printId);
  const page = cache.pages.find(x => x.printId === printId && x.pageIndex === 0);
  if (!p || !page) return;

  const bitmap = await createImageBitmap(page.image);

  pickerState.printId = printId;
  pickerState.page = page;
  pickerState.bitmap = bitmap;
  pickerState.selectedGroupIds.clear();

  $("#pickerTitle") && ($("#pickerTitle").textContent = "学習するQを選択");
  if (reason === "dueEmpty") {
    $("#pickerSub") && ($("#pickerSub").textContent = "このプリントは今日の復習対象（期限Q）がありません。学習したいQを選んで開始できます（複数OK）。");
  } else {
    $("#pickerSub") && ($("#pickerSub").textContent = "プリント画像上でQ（黒塗り）をタップして選択できます（複数OK）");
  }

  await renderPickerGroupList();
  openModalPicker();
  requestAnimationFrame(() => {
    fitPickerToStage(true); // reset
    drawPicker();
  });
}

function fitPickerToStage(reset=false){
  const stage = $("#pickerStage");
  if (!stage || !pickerState.page) return;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;

  if (pickerCanvas) {
    pickerCanvas.width = Math.max(1, Math.floor(sw));
    pickerCanvas.height = Math.max(1, Math.floor(sh));
  }

  // fit zoom
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
    // keep current z/px/py
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
    row.querySelector(`[data-pick-check="${g.id}"]`)?.addEventListener("change", (ev) => {
      if (ev.target.checked) pickerState.selectedGroupIds.add(g.id);
      else pickerState.selectedGroupIds.delete(g.id);
      updatePickerSelUI();
      drawPicker();
    });
    row.querySelector(`[data-pick-only="${g.id}"]`)?.addEventListener("click", () => {
      pickerState.selectedGroupIds.clear();
      pickerState.selectedGroupIds.add(g.id);
      renderPickerGroupList();
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

  // resize if needed
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

  // 黒塗り＋ラベル
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
  const stage = $("#pickerStage");
  if (!stage || !pickerState.page) return;

  newZ = clamp(newZ, pickerState.minZ, pickerState.maxZ);

  // keep the world point under cursor stable:
  // screen = pan + world*z  => world = (screen - pan)/z
  const worldX = (screenX - pickerState.px) / pickerState.z;
  const worldY = (screenY - pickerState.py) / pickerState.z;

  pickerState.z = newZ;
  pickerState.px = screenX - worldX * pickerState.z;
  pickerState.py = screenY - worldY * pickerState.z;

  drawPicker();
}

/* ---- pointer events for pinch/pan ---- */
const pickerPointers = new Map();
let pickerGesture = {
  mode: "none", // "pan" | "pinch"
  startPx: 0,
  startPy: 0,
  startZ: 1,
  startDist: 0,
  startCenter: { x: 0, y: 0 },
  lastTapTime: 0,
  moved: false,
};

function getPickerPoint(e){
  const rect = pickerCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function center(a,b){ return { x: (a.x+b.x)/2, y: (a.y+b.y)/2 }; }

pickerCanvas?.addEventListener("pointerdown", (e) => {
  if (!pickerCanvas) return;
  pickerCanvas.setPointerCapture(e.pointerId);
  const p = getPickerPoint(e);
  pickerPointers.set(e.pointerId, p);
  pickerGesture.moved = false;

  if (pickerPointers.size === 1) {
    // start pan candidate (1 finger) but we won't pan unless moved enough (so click works)
    pickerGesture.mode = "pan";
    pickerGesture.startPx = pickerState.px;
    pickerGesture.startPy = pickerState.py;
    pickerGesture.startCenter = { ...p };
  } else if (pickerPointers.size === 2) {
    // pinch
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

  // move threshold
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

    // zoom about center, but also allow pan with moving center
    // keep world point under center stable using zoomAt
    pickerZoomAt(c.x, c.y, newZ);

    // then apply pan offset difference from initial center movement
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

  // if 2->1 pointers, reset gesture base
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

    // 1本指で「動いてない」＝クリックとしてQ選択
    if (!wasMoved) {
      await refreshCache();
      if (!pickerState.page) return;

      const rect = pickerCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const { nx, ny } = pickerScreenToNorm(x, y);
      const masks = cache.masks
        .filter(m => m.printId === pickerState.printId)
        .slice()
        .reverse();

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

/* PC: wheel zoom (trackpad ok) */
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

  closeModalPicker();

  state.practiceActive = true;
  state.practicePrintId = pickerState.printId;
  state.reviewQueue = sel;
  state.reviewIndex = 0;
  state.doneTodayCount = 0;

  await nav("today");
});

/* =========================
   Boot
   ========================= */
(async function boot() {
  await nav("home");
})();
