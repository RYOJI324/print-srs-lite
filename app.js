/* Print SRS Lite Pro (Nodeなし / IndexedDB)
   2026-02-17 integrated build:
   - 教科折りたたみ + 控えめ色
   - prompt廃止 -> 教科選択シート（bottom sheet）
     - その他は自由記載（カスタム教科として保存）
   - HOME: 選択プリント一括移動（先にボタン、後で移動先選択）
   - HOME: 選択プリントをA4 PDF印刷（1つにまとめる）
     - iPad popup block回避のため window.open 不使用（iframe印刷）
   - 編集完了: ホームへ戻って下にトーストを数秒表示（ホーム側）
   - 今日の復習: 教科を複数選択して絞り込み（カスタム教科含む）
   - 今日対象外でも学習: HOMEの「このプリントを復習」-> Qピッカーで選択して開始
     - ピンチズーム/パン対応
   - レビュー4段階表示: もう一度/難しい/正解/簡単
*/

const CFG = {
  maxW: 1600,
  jpegQ: 0.82,
  longPressMs: 350,
  toastMs: 2500,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const now = () => Date.now();
const dayMs = 24 * 60 * 60 * 1000;

function uid() {
  return Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function clamp01(v){ return clamp(v, 0, 1); }
function toDateStr(ms){ return new Date(ms).toLocaleString(); }

/* ========= 教科 ========= */
const SUBJECT_ORDER = ["算数","国語","英語","理科","社会","その他"];
function normSubject(s){
  const t = (s || "その他").trim();
  if (!t) return "その他";
  // 既定教科に完全一致ならそのまま
  if (SUBJECT_ORDER.includes(t)) return t;
  // カスタム教科はそのまま（=「その他」ではなく名前で保存）
  return t;
}
function isStandardSubject(s){
  return SUBJECT_ORDER.includes(s);
}
function subjectClass(s){
  const t = normSubject(s);
  if (t === "算数") return "subj-math";
  if (t === "国語") return "subj-jpn";
  if (t === "英語") return "subj-eng";
  if (t === "理科") return "subj-sci";
  if (t === "社会") return "subj-soc";
  return "subj-oth";
}

/* ========= IndexedDB ========= */
const DB_NAME = "print_srs_lite_pro_db";
const DB_VER = 2;
let dbp = null;

function openDB(){
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
      // UI状態（折りたたみ等）
      if (!db.objectStoreNames.contains("ui")) db.createObjectStore("ui", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(storeNames, mode, fn){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const stores = {};
    storeNames.forEach(n => stores[n] = t.objectStore(n));
    Promise.resolve(fn(stores))
      .then(res => {
        t.oncomplete = () => resolve(res);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
      .catch(reject);
  });
}

async function put(store, value){ return tx([store], "readwrite", (s) => s[store].put(value)); }
async function del(store, key){ return tx([store], "readwrite", (s) => s[store].delete(key)); }
async function get(store, key){
  return tx([store], "readonly", (s) => new Promise((res, rej) => {
    const r = s[store].get(key);
    r.onsuccess = () => res(r.result ?? null);
    r.onerror = () => rej(r.error);
  }));
}
async function getAll(store){
  return tx([store], "readonly", (s) => new Promise((res, rej) => {
    const r = s[store].getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  }));
}

/* ========= SRS ========= */
function initSrsState(groupId){
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
function updateSrs(prev, rating){
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

/* ========= Image load / HEIC / compress ========= */
function isHeicLike(file){
  const name = (file.name || "").toLowerCase();
  return file.type === "image/heic" || file.type === "image/heif" || name.endsWith(".heic") || name.endsWith(".heif");
}
async function fileToBitmap(file){
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
async function compressBitmapToJpegBlob(bitmap){
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

/* ========= State & Cache ========= */
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

  // UI
  collapsedSubjects: new Set(), // subject strings
  toastTimer: null,

  // today filter
  todaySubjectFilter: null, // Set of subjects or null (=all)

  // practice picker
  picker: {
    open: false,
    printId: null,
    page: null,
    bitmap: null,
    zoom: 1,
    panX: 0,
    panY: 0,
    selectedGroupIds: new Set(),
  }
};

let cache = { prints:[], pages:[], groups:[], masks:[], srs:[], reviews:[], skips:[], ui:[] };

async function refreshCache(){
  const [prints, pages, groups, masks, srs, reviews, skips, ui] = await Promise.all([
    getAll("prints"), getAll("pages"), getAll("groups"), getAll("masks"),
    getAll("srs"), getAll("reviews"), getAll("skips"),
    getAll("ui"),
  ]);
  cache = { prints, pages, groups, masks, srs, reviews, skips, ui };
}

function show(viewId){
  $$(".view").forEach((v) => v.classList.add("hidden"));
  $(viewId)?.classList.remove("hidden");
}

/* ========= Router ========= */
async function nav(to){
  state.route = to;
  try {
    if (to === "home") { state.currentPrintId = null; await renderHome(); }
    else if (to === "add") renderAdd();
    else if (to === "edit") await renderEdit();
    else if (to === "today") await renderToday();
  } catch (e) {
    console.error("nav error:", e);
    alert("画面更新中にエラーが出ました。コンソール(DevTools)に詳細があります。");
  }
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-nav]");
  if (!btn) return;
  const to = btn.getAttribute("data-nav");
  nav(to);
});

/* ========= UI: Toast ========= */
function showHomeToast(msg){
  const el = $("#homeToast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.add("hidden"), CFG.toastMs);
}

/* ========= UI: Collapsed subjects persistence ========= */
async function loadCollapsedSubjects(){
  try {
    const rec = await get("ui", "collapsedSubjects");
    if (rec && rec.value && Array.isArray(rec.value)) {
      state.collapsedSubjects = new Set(rec.value);
    }
  } catch {}
}
async function saveCollapsedSubjects(){
  try {
    await put("ui", { key: "collapsedSubjects", value: Array.from(state.collapsedSubjects), updatedAt: now() });
  } catch {}
}

/* ========= Due + skip ========= */
function startOfTomorrowMs(){
  const d = new Date();
  d.setHours(24,0,0,0);
  return d.getTime();
}
function isSkipped(groupId){
  const s = cache.skips.find((x) => x.groupId === groupId);
  if (!s) return false;
  return s.skipUntil && s.skipUntil > now();
}
function computeDueGroups(){
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

/* ========= Delete (cascade) ========= */
async function deletePrintCascade(printId){
  await refreshCache();
  const pages = cache.pages.filter((p) => p.printId === printId);
  const groups = cache.groups.filter((g) => g.printId === printId);
  const masks = cache.masks.filter((m) => m.printId === printId);
  const groupIds = new Set(groups.map((g) => g.id));
  const reviews = cache.reviews.filter((r) => groupIds.has(r.groupId));
  const srs = cache.srs.filter((s) => groupIds.has(s.groupId));
  const skips = cache.skips.filter((x) => groupIds.has(x.groupId));

  await tx(["prints","pages","groups","masks","srs","reviews","skips"], "readwrite", (st) => {
    st.prints.delete(printId);
    pages.forEach((x) => st.pages.delete(x.id));
    groups.forEach((x) => st.groups.delete(x.id));
    masks.forEach((x) => st.masks.delete(x.id));
    srs.forEach((x) => st.srs.delete(x.groupId));
    reviews.forEach((x) => st.reviews.delete(x.id));
    skips.forEach((x) => st.skips.delete(x.groupId));
  });
}
async function deletePrintsCascade(printIds){
  for (const id of printIds) await deletePrintCascade(id);
}

/* ========= HOME selection UI ========= */
function updateHomeSelectionUI(){
  const n = state.selectedPrintIds.size;

  const btnDel = $("#btnDeleteSelected");
  const btnMove = $("#btnMoveSelected");
  const btnPdf = $("#btnPrintSelectedPdf");

  if (btnDel) {
    btnDel.disabled = n === 0;
    btnDel.textContent = n === 0 ? "選択したプリントを削除" : `選択したプリントを削除（${n}件）`;
  }
  if (btnMove) {
    btnMove.disabled = n === 0;
    btnMove.textContent = n === 0 ? "選択プリントを移動" : `選択プリントを移動（${n}件）`;
  }
  if (btnPdf) {
    btnPdf.disabled = n === 0;
    btnPdf.textContent = n === 0 ? "選択をA4PDF印刷" : `選択をA4PDF印刷（${n}件）`;
  }
}

/* ========= HOME render ========= */
function getAllSubjectsFromPrints(){
  const set = new Set();
  cache.prints.forEach(p => set.add(normSubject(p.subject)));
  // 既定教科も含める（存在しなくても選べるように）
  SUBJECT_ORDER.forEach(s => set.add(s));
  // 表示順：既定教科→カスタム
  const std = SUBJECT_ORDER.slice();
  const custom = Array.from(set).filter(s => !SUBJECT_ORDER.includes(s)).sort((a,b)=>a.localeCompare(b,'ja'));
  return std.concat(custom);
}

function groupPrintsBySubject(prints){
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

function renderOnePrintItem(p){
  const gCount = cache.groups.filter((g) => g.printId === p.id).length;
  const mCount = cache.masks.filter((m) => m.printId === p.id).length;
  const checked = state.selectedPrintIds.has(p.id);

  const el = document.createElement("div");
  el.className = "item";
  el.innerHTML = `
    <div class="row space wrap">
      <div class="row wrap" style="align-items:flex-start; gap:10px;">
        <input class="checkbox" type="checkbox" data-print-check="${p.id}" ${checked ? "checked" : ""}/>
        <div>
          <div class="itemTitle">${escapeHtml(p.title)}</div>
          <div class="muted small">${escapeHtml(normSubject(p.subject))} / ${new Date(p.createdAt).toLocaleDateString()} / Q:${gCount} / mask:${mCount}</div>
        </div>
      </div>
      <div class="row wrap">
        <button class="btn" data-open-edit="${p.id}">編集</button>
        <button class="btn primary" data-open-practice="${p.id}">このプリントを復習</button>
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

  // 任意学習（今日対象外でもOK）
  el.querySelector("[data-open-practice]")?.addEventListener("click", async () => {
    await openPracticePicker(p.id);
  });

  el.querySelector("[data-del-print]")?.addEventListener("click", async () => {
    if (!confirm(`「${p.title}」を削除します（関連データも全部消えます）`)) return;
    await deletePrintCascade(p.id);
    state.selectedPrintIds.delete(p.id);
    await renderHome();
  });

  return el;
}

async function renderHome(){
  await refreshCache();
  show("#view-home");

  // due count
  const due = computeDueGroups();
  $("#dueCount") && ($("#dueCount").textContent = String(due.length));

  // selection UI
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
  const subjects = getAllSubjectsFromPrints();

  for (const subj of subjects) {
    const arr = bySubj.get(subj);
    if (!arr || arr.length === 0) continue;

    const collapsed = state.collapsedSubjects.has(subj);

    const header = document.createElement("div");
    header.className = `subjectHeader ${subjectClass(subj)}`;
    header.innerHTML = `
      <div class="left">
        <div class="bar"></div>
        <div>
          <div class="title">${escapeHtml(subj)}</div>
          <div class="meta">プリント ${arr.length} 件</div>
        </div>
      </div>
      <div class="chev">${collapsed ? "▶" : "▼"}</div>
    `;
    header.addEventListener("click", async () => {
      if (state.collapsedSubjects.has(subj)) state.collapsedSubjects.delete(subj);
      else state.collapsedSubjects.add(subj);
      await saveCollapsedSubjects();
      await renderHome();
    });
    list.appendChild(header);

    if (!collapsed) {
      const box = document.createElement("div");
      box.className = "subjectBox";
      for (const p of arr) {
        box.appendChild(renderOnePrintItem(p));
      }
      list.appendChild(box);
    }
  }
}

/* ========= HOME controls ========= */
$("#btnSelectAll")?.addEventListener("click", async () => {
  await refreshCache();
  cache.prints.forEach(p => state.selectedPrintIds.add(p.id));
  await renderHome();
});
$("#btnClearSelect")?.addEventListener("click", async () => {
  state.selectedPrintIds.clear();
  await renderHome();
});
$("#btnDeleteSelected")?.addEventListener("click", async () => {
  const ids = Array.from(state.selectedPrintIds);
  if (ids.length === 0) return;
  if (!confirm(`選択したプリント ${ids.length} 件を削除します（関連データも全部消えます）`)) return;
  await deletePrintsCascade(ids);
  state.selectedPrintIds.clear();
  await renderHome();
});

/* ========= Subject Sheet (bottom sheet) ========= */
const subjectSheet = $("#subjectSheet");
const subjectSheetList = $("#subjectSheetList");
const subjectOtherWrap = $("#subjectOtherWrap");
const subjectOtherInput = $("#subjectOtherInput");
const subjectSheetTitle = $("#subjectSheetTitle");
const subjectSheetSub = $("#subjectSheetSub");

let subjectSheetCtx = null;
/*
  ctx = {
    mode: "single" | "multi",
    title: string,
    subtitle: string,
    subjects: string[], // list
    initial: Set<string>,
    allowOtherFreeText: boolean,
    onOk: (selectedSet, otherText) => void
    onCancel: () => void
  }
*/

function openSubjectSheet(ctx){
  subjectSheetCtx = ctx;
  if (subjectSheetTitle) subjectSheetTitle.textContent = ctx.title || "教科を選択";
  if (subjectSheetSub) subjectSheetSub.textContent = ctx.subtitle || (ctx.mode === "multi" ? "複数選択できます" : "1つ選んでください");

  if (!subjectSheetList) return;
  subjectSheetList.innerHTML = "";

  const selected = new Set(ctx.initial ? Array.from(ctx.initial) : []);
  // 「その他」自体は既定選択肢として残す（ただし自由記載は otherText に入れる）
  let otherText = "";

  // 初期値が既定教科以外なら「その他自由記載」に入れておく（singleのとき）
  if (ctx.mode === "single") {
    const only = Array.from(selected)[0] || "";
    if (only && !SUBJECT_ORDER.includes(only)) {
      // カスタム教科
      otherText = only;
      selected.clear();
      selected.add("その他");
    }
  }

  // 初期値が multi でカスタム含む場合：そのまま個別の項目として並べたいので subjects に含める
  // subjectsは呼び出し側で用意している想定

  function render(){
    const isOtherSelected = selected.has("その他") && ctx.allowOtherFreeText;
    if (subjectOtherWrap) subjectOtherWrap.classList.toggle("hidden", !isOtherSelected);
    if (subjectOtherInput && isOtherSelected && otherText) subjectOtherInput.value = otherText;
    if (subjectOtherInput && !isOtherSelected) subjectOtherInput.value = "";

    $$(".sheetItem").forEach(() => {});
  }

  const subjects = ctx.subjects || SUBJECT_ORDER;
  subjects.forEach((s) => {
    const item = document.createElement("div");
    item.className = "sheetItem";
    item.setAttribute("data-subj", s);
    const on = selected.has(s);
    if (on) item.classList.add("on");
    item.innerHTML = `
      <div>${escapeHtml(s)}</div>
      <div style="font-weight:900; opacity:${on?1:0};">✓</div>
    `;
    item.addEventListener("click", () => {
      if (ctx.mode === "single") {
        selected.clear();
        selected.add(s);
      } else {
        if (selected.has(s)) selected.delete(s);
        else selected.add(s);
      }
      // 「その他」を外したら自由記載も消す
      if (!selected.has("その他")) otherText = "";
      // 反映
      $$(".sheetItem").forEach((x) => x.classList.remove("on"));
      $$(".sheetItem").forEach((x) => {
        const ss = x.getAttribute("data-subj");
        if (selected.has(ss)) x.classList.add("on");
        x.lastElementChild.style.opacity = selected.has(ss) ? "1" : "0";
      });
      render();
    });
    subjectSheetList.appendChild(item);
  });

  if (subjectOtherInput) {
    subjectOtherInput.value = otherText || "";
    subjectOtherInput.oninput = () => {
      otherText = subjectOtherInput.value || "";
    };
  }

  render();

  // show
  subjectSheet?.classList.remove("hidden");
  subjectSheet?.setAttribute("aria-hidden", "false");
}
function closeSubjectSheet(){
  subjectSheet?.classList.add("hidden");
  subjectSheet?.setAttribute("aria-hidden", "true");
  subjectSheetCtx = null;
  if (subjectOtherInput) subjectOtherInput.value = "";
  if (subjectOtherWrap) subjectOtherWrap.classList.add("hidden");
}
$("#subjectSheetClose")?.addEventListener("click", () => {
  subjectSheetCtx?.onCancel?.();
  closeSubjectSheet();
});
$("#subjectSheetCancel")?.addEventListener("click", () => {
  subjectSheetCtx?.onCancel?.();
  closeSubjectSheet();
});
$(".sheetBackdrop")?.addEventListener("click", () => {
  subjectSheetCtx?.onCancel?.();
  closeSubjectSheet();
});
$("#subjectSheetOk")?.addEventListener("click", () => {
  if (!subjectSheetCtx) return;

  // collect selected
  const selectedEls = $$(".sheetItem.on");
  const selected = new Set(selectedEls.map(el => el.getAttribute("data-subj")));
  let otherText = (subjectOtherInput?.value || "").trim();

  // allowOtherFreeText: 「その他」が選ばれていれば自由記載で置換（single）or カスタムを追加（multi）
  if (subjectSheetCtx.allowOtherFreeText && selected.has("その他")) {
    if (otherText) {
      if (subjectSheetCtx.mode === "single") {
        selected.clear();
        selected.add(otherText);
      } else {
        // multi: 既定の「その他」は残してもよいが、実運用ではカスタム名を入れる方が分かりやすいので置換
        selected.delete("その他");
        selected.add(otherText);
      }
    } else {
      // otherTextなし → 「その他」のまま
      if (subjectSheetCtx.mode === "single") {
        selected.clear();
        selected.add("その他");
      }
    }
  }

  subjectSheetCtx.onOk?.(selected, otherText);
  closeSubjectSheet();
});

/* ========= ADD ========= */
function renderAdd(){
  show("#view-add");
  $("#addStatus") && ($("#addStatus").textContent = "");
  $("#addTitle") && ($("#addTitle").value = `プリント ${new Date().toLocaleDateString()}`);
  $("#addSubject") && ($("#addSubject").value = "算数");
  $("#addFile") && ($("#addFile").value = "");
}

// add subject picker
$("#btnPickAddSubject")?.addEventListener("click", async () => {
  await refreshCache();
  const subjects = getAllSubjectsFromPrints();
  const current = normSubject($("#addSubject")?.value || "算数");
  openSubjectSheet({
    mode: "single",
    title: "教科を選択（プリント追加）",
    subtitle: "「その他」は自由記載できます",
    subjects,
    initial: new Set([current]),
    allowOtherFreeText: true,
    onOk: (sel) => {
      const v = Array.from(sel)[0] || "その他";
      $("#addSubject") && ($("#addSubject").value = v);
    },
    onCancel: () => {}
  });
});

$("#btnCreatePrint")?.addEventListener("click", async () => {
  const title = ($("#addTitle")?.value || "").trim() || `プリント ${new Date().toLocaleDateString()}`;
  const subject = normSubject($("#addSubject")?.value || "その他");
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

    await tx(["prints","pages","groups","srs"], "readwrite", (s) => {
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

/* ========= EDIT ========= */
const canvas = $("#canvas");
const ctx = canvas?.getContext("2d");
let editImgBitmap = null;
let editPage = null;

const pointersEdit = new Map();
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

function getCanvasPoint(cvs, e){
  const rect = cvs.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}
function clearLongPress(){
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = null;
  longPressActive = false;
}
function screenToWorld(x, y){
  return { x: (x - state.panX) / state.zoom, y: (y - state.panY) / state.zoom };
}
function fitToStage(stageSel, cvs, page){
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

function hitTestMaskEdit(sx, sy){
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
function drawMaskLabel(ctx2d, label, x, y, zoomScale){
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

function drawEdit(){
  if (!ctx || !editImgBitmap || !editPage) return;
  const stage = $("#stage");
  if (!stage) return;

  const w = stage.clientWidth;
  const h = stage.clientHeight;
  canvas.width = Math.max(1, Math.floor(w));
  canvas.height = Math.max(1, Math.floor(h));
  ctx.clearRect(0,0,canvas.width,canvas.height);

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

  // draw preview rectangle while drawing
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

async function ensureEditLoaded(){
  if (!state.currentPrintId) throw new Error("printIdがありません");
  await refreshCache();

  editPage = cache.pages.find((p) => p.printId === state.currentPrintId && p.pageIndex === 0);
  if (!editPage) throw new Error("ページが見つかりません");
  editImgBitmap = await createImageBitmap(editPage.image);

  const groups = cache.groups.filter((g) => g.printId === state.currentPrintId).sort((a,b)=>a.orderIndex-b.orderIndex);
  if (!groups[0]) {
    await createGroup();
    await refreshCache();
  }
  const groups2 = cache.groups.filter((g) => g.printId === state.currentPrintId).sort((a,b)=>a.orderIndex-b.orderIndex);
  if (!state.currentGroupId) state.currentGroupId = groups2[0]?.id || null;
}

async function renderEdit(){
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

async function renderEditSidebar(){
  await refreshCache();
  const printId = state.currentPrintId;
  const groups = cache.groups.filter((g) => g.printId === printId).sort((a,b)=>a.orderIndex-b.orderIndex);
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
      <div class="row space wrap">
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

async function moveGroupOrder(groupId, delta){
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

function updateSelUI(){
  $("#selCount") && ($("#selCount").textContent = String(state.selectedMaskIds.size));
  $("#btnMoveSel") && ($("#btnMoveSel").disabled = !state.currentGroupId || state.selectedMaskIds.size === 0);
  $("#btnDeleteSel") && ($("#btnDeleteSel").disabled = state.selectedMaskIds.size === 0);
  $("#btnClearSel") && ($("#btnClearSel").disabled = state.selectedMaskIds.size === 0);
}

async function createGroup(){
  const printId = state.currentPrintId;
  const groups = cache.groups.filter((g) => g.printId === printId).sort((a,b)=>a.orderIndex-b.orderIndex);
  const idx = groups.length;
  const groupId = uid();
  const t = now();
  const g = { id: groupId, printId, pageIndex: 0, label: `Q${idx + 1}`, orderIndex: idx, isActive: true, createdAt: t };
  await tx(["groups","srs"], "readwrite", (s) => {
    s.groups.put(g);
    s.srs.put(initSrsState(groupId));
  });
  state.currentGroupId = groupId;
}

/* ---- Edit: header click to rename title/subject (sheet) ---- */
async function renameCurrentPrint(){
  await refreshCache();
  const p = cache.prints.find(x => x.id === state.currentPrintId);
  if (!p) return;

  // promptは残しても良いが、将来完全タップUI化のため最小限にする
  const v = window.prompt("プリント名を変更", p.title || "");
  if (v === null) return;
  p.title = v.trim() || p.title;
  await put("prints", p);
  await refreshCache();
  updateEditHeaderClickable();
}
async function changeCurrentSubjectSheet(){
  await refreshCache();
  const p = cache.prints.find(x => x.id === state.currentPrintId);
  if (!p) return;

  const subjects = getAllSubjectsFromPrints();
  const current = normSubject(p.subject);

  openSubjectSheet({
    mode: "single",
    title: "教科を変更",
    subtitle: "「その他」は自由記載できます",
    subjects,
    initial: new Set([current]),
    allowOtherFreeText: true,
    onOk: async (sel) => {
      const v = Array.from(sel)[0] || "その他";
      p.subject = normSubject(v);
      await put("prints", p);
      await refreshCache();
      updateEditHeaderClickable();
      // HOME側の分類が変わるので折りたたみも反映（次回homeでOK）
    },
    onCancel: () => {}
  });
}

function updateEditHeaderClickable(){
  const p = cache.prints.find((x) => x.id === state.currentPrintId);
  const titleEl = $("#editTitle");
  const metaEl = $("#editMeta");
  if (titleEl) {
    titleEl.innerHTML = `編集：${escapeHtml(p ? p.title : "")} <span class="hint">✏️ タップで名前変更</span>`;
    titleEl.style.cursor = "pointer";
  }
  if (metaEl) {
    metaEl.innerHTML = `${escapeHtml(p ? normSubject(p.subject) : "")} / ${p ? new Date(p.createdAt).toLocaleDateString() : ""} <span class="hint">✏️ タップで教科変更</span>`;
    metaEl.style.cursor = "pointer";
  }
  if (titleEl) titleEl.onclick = () => renameCurrentPrint();
  if (metaEl) metaEl.onclick = () => changeCurrentSubjectSheet();
}

/* ---- Edit controls ---- */
$("#btnFit")?.addEventListener("click", () => { fitToStage("#stage", canvas, editPage); drawEdit(); });
$("#btnZoomIn")?.addEventListener("click", () => { state.zoom = Math.min(6, state.zoom * 1.25); drawEdit(); });
$("#btnZoomOut")?.addEventListener("click", () => { state.zoom = Math.max(0.2, state.zoom / 1.25); drawEdit(); });

$("#btnNewGroup")?.addEventListener("click", async () => {
  await ensureEditLoaded();
  await createGroup();
  await renderEditSidebar();
  drawEdit();
});
$("#btnRenameGroup")?.addEventListener("click", async () => {
  const g = cache.groups.find((x) => x.id === state.currentGroupId);
  if (!g) return;
  const label = window.prompt("Qラベル（例：Q3 / 問5 / 単語②）", g.label || "");
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
  await tx(["groups","masks","srs","reviews","skips"], "readwrite", (s) => {
    s.groups.delete(g.id);
    s.srs.delete(g.id);
    s.skips.delete(g.id);
    cache.reviews.filter((r) => r.groupId === g.id).forEach((r) => s.reviews.delete(r.id));
    masks.forEach((m) => s.masks.delete(m.id));
  });

  state.currentGroupId = null;
  state.selectedMaskIds.clear();
  await refreshCache();

  const gg = cache.groups.filter((x) => x.printId === state.currentPrintId).sort((a,b)=>a.orderIndex-b.orderIndex);
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

/* ---- Edit Done ---- */
$("#btnEditDone")?.addEventListener("click", async () => {
  // HOMEでトースト表示するため ui にメッセージ保存
  await put("ui", { key: "lastToast", value: "編集完了しました", updatedAt: now() });
  await nav("home");
  // home描画後に表示
  const rec = await get("ui", "lastToast");
  if (rec?.value) {
    showHomeToast(String(rec.value));
    await del("ui", "lastToast");
  }
});

/* ---- Edit pointer handling (PC/iPad) ---- */
canvas?.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const p = getCanvasPoint(canvas, e);
  pointersEdit.set(e.pointerId, p);

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
  if (!pointersEdit.has(e.pointerId)) return;
  const p = getCanvasPoint(canvas, e);
  pointersEdit.set(e.pointerId, p);

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
    if (!m || !editPage) return;

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
  pointersEdit.delete(e.pointerId);
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

  const p = getCanvasPoint(canvas, e);
  const x1 = Math.min(drag.sx, p.x);
  const y1 = Math.min(drag.sy, p.y);
  const x2 = Math.max(drag.sx, p.x);
  const y2 = Math.max(drag.sy, p.y);

  if (Math.abs(x2 - x1) < 8 || Math.abs(y2 - y1) < 8) { drawEdit(); return; }

  if (!state.currentGroupId) { await createGroup(); await refreshCache(); await renderEditSidebar(); }

  if (!editPage) return;
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

/* ========= TODAY / REVIEW ========= */
const reviewCanvas = $("#reviewCanvas");
const reviewCtx = reviewCanvas?.getContext("2d");
let reviewTarget = null;

// review gesture (pinch/2finger pan)
const pointersReview = new Map();
let reviewGesture = {
  mode: "none",
  startDist: 0,
  startZoom: 1,
  startMid: null,
  panStart: null,
  panX: 0,
  panY: 0,
  zoom: 1,
};

// review view transform
function resetReviewTransform(){
  reviewGesture.zoom = 1;
  reviewGesture.panX = 0;
  reviewGesture.panY = 0;
}

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

function updateReviewRemaining(){
  const total = state.reviewQueue?.length || 0;
  const idx = Math.max(0, state.reviewIndex);
  const rem = Math.max(0, total - idx);
  $("#reviewRemaining") && ($("#reviewRemaining").textContent = String(rem));
}

function showDoneScreen(){
  $("#view-review")?.classList.add("hidden");
  $("#view-done")?.classList.remove("hidden");
  $("#doneCount") && ($("#doneCount").textContent = String(state.doneTodayCount || 0));
}

async function renderToday(){
  await refreshCache();
  show("#view-today");

  $("#view-done")?.classList.add("hidden");
  $("#view-review")?.classList.add("hidden");

  let due = computeDueGroups();

  // 教科フィルタ（複数）
  if (state.todaySubjectFilter && state.todaySubjectFilter.size > 0) {
    const allowed = state.todaySubjectFilter;
    due = due.filter(({ g }) => {
      const p = cache.prints.find(x => x.id === g.printId);
      const s = normSubject(p?.subject || "その他");
      return allowed.has(s);
    });
  }

  $("#todayMeta") && ($("#todayMeta").textContent =
    `期限が来ているQ：${due.length}（スキップ除外）` + (state.todaySubjectFilter?.size ? ` / 絞り込み：${Array.from(state.todaySubjectFilter).join("・")}` : "")
  );

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
      <div class="row space wrap">
        <div>
          <div class="itemTitle">${escapeHtml(p?.title || "プリント")} / ${escapeHtml(g.label || "(ラベルなし)")}</div>
          <div class="muted small">教科：${escapeHtml(normSubject(p?.subject || "その他"))}</div>
          <div class="muted small">期限：${toDateStr(s.nextDueAt)} / 難易度:${s.difficulty.toFixed(1)} / 安定度:${s.stability.toFixed(1)}日 / 復習回数:${s.reviewCount}</div>
        </div>
        <div class="row wrap">
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

// today filter button
$("#btnTodayFilter")?.addEventListener("click", async () => {
  await refreshCache();
  const subjects = getAllSubjectsFromPrints().filter(s => s !== "その他"); // 「その他」も選べるが自由記載と衝突するので、実際には「その他」も残す
  const all = getAllSubjectsFromPrints();

  openSubjectSheet({
    mode: "multi",
    title: "今日の復習：教科を選択",
    subtitle: "複数選択できます（自由記載の教科も含みます）",
    subjects: all,
    initial: state.todaySubjectFilter ? new Set(state.todaySubjectFilter) : new Set(),
    allowOtherFreeText: true,
    onOk: (sel) => {
      // selが空ならフィルタ解除
      if (!sel || sel.size === 0) state.todaySubjectFilter = null;
      else state.todaySubjectFilter = new Set(sel);
      renderToday();
    },
    onCancel: () => {}
  });
});

async function openReview(groupId){
  await refreshCache();
  const g = cache.groups.find((x) => x.id === groupId);
  if (!g) return;
  const p = cache.prints.find((x) => x.id === g.printId);
  const page = cache.pages.find((x) => x.printId === g.printId && x.pageIndex === 0);
  if (!page) return;
  const bitmap = await createImageBitmap(page.image);

  reviewTarget = { g, p, page, bitmap };
  state.revealedMaskIds.clear();
  resetReviewTransform();

  const idx = state.reviewQueue.indexOf(groupId);
  state.reviewIndex = idx >= 0 ? idx : 0;

  $("#view-review")?.classList.remove("hidden");
  $("#reviewTitle") && ($("#reviewTitle").textContent = `${p?.title || "プリント"} / ${g.label || "(ラベルなし)"}`);

  const s = cache.srs.find((x) => x.groupId === g.id) || initSrsState(g.id);
  $("#reviewMeta") && ($("#reviewMeta").textContent =
    `教科：${normSubject(p?.subject || "その他")} / 期限：${toDateStr(s.nextDueAt)} / 難易度:${s.difficulty.toFixed(1)} / 安定度:${s.stability.toFixed(1)}日`
  );

  updateReviewRemaining();
  drawReview();
}

function drawReview(){
  if (!reviewTarget || !reviewCtx || !reviewCanvas) return;

  const stage = $("#reviewStage");
  if (!stage) return;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;

  reviewCanvas.width = Math.max(1, Math.floor(sw));
  reviewCanvas.height = Math.max(1, Math.floor(sh));
  reviewCtx.clearRect(0,0,reviewCanvas.width,reviewCanvas.height);

  const { page, bitmap, g } = reviewTarget;

  // base fit
  const zx = sw / page.width;
  const zy = sh / page.height;
  const baseZ = Math.min(zx, zy);
  const basePX = (sw - page.width * baseZ) / 2;
  const basePY = (sh - page.height * baseZ) / 2;

  // user transform (pinch/ pan)
  const z = baseZ * reviewGesture.zoom;
  const px = basePX + reviewGesture.panX;
  const py = basePY + reviewGesture.panY;

  const gMap = new Map(cache.groups.map(x => [x.id, x]));

  reviewCtx.save();
  reviewCtx.translate(px, py);
  reviewCtx.scale(z, z);
  reviewCtx.drawImage(bitmap, 0, 0);

  // always hide all masks, reveal only tapped in current group
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

  // highlight current group's masks
  const curMasks = cache.masks.filter((m) => m.groupId === g.id);
  curMasks.forEach((m) => {
    reviewCtx.strokeStyle = "#ffd34d";
    reviewCtx.lineWidth = 3 / z;
    reviewCtx.strokeRect(m.x * page.width, m.y * page.height, m.w * page.width, m.h * page.height);
  });

  reviewCtx.restore();
}

// Tap to reveal (single finger tap). Pinch/2-finger pan for zoom.
reviewCanvas?.addEventListener("pointerdown", (e) => {
  reviewCanvas.setPointerCapture(e.pointerId);
  const rect = reviewCanvas.getBoundingClientRect();
  pointersReview.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });

  if (pointersReview.size === 2) {
    const pts = Array.from(pointersReview.values());
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    reviewGesture.mode = "pinch";
    reviewGesture.startDist = Math.hypot(dx, dy);
    reviewGesture.startZoom = reviewGesture.zoom;
    reviewGesture.startMid = { x: (pts[0].x + pts[1].x)/2, y: (pts[0].y + pts[1].y)/2 };
    reviewGesture.panStart = { panX: reviewGesture.panX, panY: reviewGesture.panY };
  }
});
reviewCanvas?.addEventListener("pointermove", (e) => {
  if (!pointersReview.has(e.pointerId)) return;
  const rect = reviewCanvas.getBoundingClientRect();
  pointersReview.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });

  if (pointersReview.size === 2 && reviewGesture.mode === "pinch") {
    const pts = Array.from(pointersReview.values());
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    const dist = Math.hypot(dx, dy);
    const scale = dist / Math.max(1, reviewGesture.startDist);

    reviewGesture.zoom = clamp(reviewGesture.startZoom * scale, 0.6, 6.0);

    // pan with midpoint shift
    const mid = { x: (pts[0].x + pts[1].x)/2, y: (pts[0].y + pts[1].y)/2 };
    const mdx = mid.x - reviewGesture.startMid.x;
    const mdy = mid.y - reviewGesture.startMid.y;
    reviewGesture.panX = reviewGesture.panStart.panX + mdx;
    reviewGesture.panY = reviewGesture.panStart.panY + mdy;

    drawReview();
  }
});
reviewCanvas?.addEventListener("pointerup", (e) => {
  pointersReview.delete(e.pointerId);
  if (pointersReview.size < 2) reviewGesture.mode = "none";
});
reviewCanvas?.addEventListener("pointercancel", (e) => {
  pointersReview.delete(e.pointerId);
  if (pointersReview.size < 2) reviewGesture.mode = "none";
});

reviewCanvas?.addEventListener("click", (e) => {
  // pinch中はタップ扱いしない
  if (reviewGesture.mode === "pinch") return;
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
  const baseZ = Math.min(zx, zy);
  const basePX = (sw - page.width * baseZ) / 2;
  const basePY = (sh - page.height * baseZ) / 2;

  const z = baseZ * reviewGesture.zoom;
  const px = basePX + reviewGesture.panX;
  const py = basePY + reviewGesture.panY;

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

/* ========= 評価 -> 次へ / 終了 ========= */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-review-rate]");
  if (!btn || !reviewTarget) return;
  const rating = btn.getAttribute("data-review-rate");
  if (!["again","hard","good","easy"].includes(rating)) return;

  await refreshCache();
  const gid = reviewTarget.g.id;
  const g = cache.groups.find((x) => x.id === gid);
  if (!g) return;

  let s = cache.srs.find((x) => x.groupId === g.id);
  if (!s) s = initSrsState(g.id);

  const next = updateSrs(s, rating);

  // スキップ解除
  await del("skips", g.id);

  await tx(["srs","reviews","groups"], "readwrite", (st) => {
    st.srs.put(next);
    st.reviews.put({ id: uid(), groupId: g.id, reviewedAt: now(), rating });
    g.isActive = true;
    st.groups.put(g);
  });

  state.doneTodayCount = (state.doneTodayCount || 0) + 1;

  await refreshCache();
  let dueNow = computeDueGroups().map(x => x.g.id);

  // today subject filter still applies
  if (state.todaySubjectFilter && state.todaySubjectFilter.size > 0) {
    dueNow = dueNow.filter((gid2) => {
      const gg = cache.groups.find(x => x.id === gid2);
      const pp = cache.prints.find(x => x.id === gg?.printId);
      const subj = normSubject(pp?.subject || "その他");
      return state.todaySubjectFilter.has(subj);
    });
  }

  if (dueNow.length === 0) {
    await renderToday();
    showDoneScreen();
    return;
  }

  state.reviewQueue = dueNow;
  const nextIndex = Math.min(Math.max(state.reviewIndex, 0), dueNow.length - 1);
  state.reviewIndex = nextIndex;

  await openReview(dueNow[nextIndex]);
});

/* ========= 任意学習（HOME -> Q選択 -> 学習開始） ========= */
const pickerModal = $("#pickerModal");
const pickerCanvas = $("#pickerCanvas");
const pickerCtx = pickerCanvas?.getContext("2d");
const pickerStage = $("#pickerStage");

const pointersPicker = new Map();
let pickerGesture = {
  mode: "none",
  startDist: 0,
  startZoom: 1,
  startMid: null,
  panStart: null,
};

function openPickerModal(){
  pickerModal?.classList.remove("hidden");
  pickerModal?.setAttribute("aria-hidden", "false");
}
function closePickerModal(){
  pickerModal?.classList.add("hidden");
  pickerModal?.setAttribute("aria-hidden", "true");
  state.picker.open = false;
  state.picker.printId = null;
  state.picker.bitmap = null;
  state.picker.page = null;
  state.picker.selectedGroupIds.clear();
  pointersPicker.clear();
  pickerGesture.mode = "none";
  $("#pickerSelCount") && ($("#pickerSelCount").textContent = "0");
  $("#pickerStart") && ($("#pickerStart").disabled = true);
}

$("#pickerCancel")?.addEventListener("click", () => closePickerModal());
$(".modalBackdrop")?.addEventListener("click", () => closePickerModal());

function fitPickerToStage(){
  if (!state.picker.page || !pickerStage) return;
  const sw = pickerStage.clientWidth;
  const sh = pickerStage.clientHeight;
  const zx = sw / state.picker.page.width;
  const zy = sh / state.picker.page.height;
  state.picker.zoom = Math.min(zx, zy);
  state.picker.panX = (sw - state.picker.page.width * state.picker.zoom) / 2;
  state.picker.panY = (sh - state.picker.page.height * state.picker.zoom) / 2;
}

function drawPicker(){
  if (!pickerCtx || !pickerCanvas || !state.picker.bitmap || !state.picker.page || !pickerStage) return;

  const sw = pickerStage.clientWidth;
  const sh = pickerStage.clientHeight;
  pickerCanvas.width = Math.max(1, Math.floor(sw));
  pickerCanvas.height = Math.max(1, Math.floor(sh));
  pickerCtx.clearRect(0,0,pickerCanvas.width,pickerCanvas.height);

  const z = state.picker.zoom;
  const px = state.picker.panX;
  const py = state.picker.panY;

  const page = state.picker.page;
  const bitmap = state.picker.bitmap;

  const gMap = new Map(cache.groups.map(g => [g.id, g]));

  pickerCtx.save();
  pickerCtx.translate(px, py);
  pickerCtx.scale(z, z);

  pickerCtx.drawImage(bitmap, 0, 0);

  // 全マスクを黒塗り + ラベル表示（編集画面と同等）
  const allMasks = cache.masks.filter(m => m.printId === state.picker.printId);
  allMasks.forEach((m) => {
    const rx = m.x * page.width;
    const ry = m.y * page.height;
    const rw = m.w * page.width;
    const rh = m.h * page.height;

    pickerCtx.fillStyle = "#000";
    pickerCtx.fillRect(rx, ry, rw, rh);

    const label = gMap.get(m.groupId)?.label || "";
    if (label) drawMaskLabel(pickerCtx, label, rx + 4 / z, ry + 14 / z, z);

    // 選択中のQは枠を強調
    if (state.picker.selectedGroupIds.has(m.groupId)) {
      pickerCtx.strokeStyle = "#ffd34d";
      pickerCtx.lineWidth = 4 / z;
      pickerCtx.strokeRect(rx, ry, rw, rh);
    }
  });

  pickerCtx.restore();
}

async function openPracticePicker(printId){
  await refreshCache();
  const page = cache.pages.find(p => p.printId === printId && p.pageIndex === 0);
  if (!page) { alert("ページが見つかりません"); return; }
  const bitmap = await createImageBitmap(page.image);

  state.picker.open = true;
  state.picker.printId = printId;
  state.picker.page = page;
  state.picker.bitmap = bitmap;
  state.picker.selectedGroupIds = new Set(); // empty at start

  openPickerModal();
  requestAnimationFrame(() => {
    fitPickerToStage();
    drawPicker();
  });
}

// picker: pinch/2finger pan, tap to toggle group
pickerCanvas?.addEventListener("pointerdown", (e) => {
  pickerCanvas.setPointerCapture(e.pointerId);
  const rect = pickerCanvas.getBoundingClientRect();
  pointersPicker.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });

  if (pointersPicker.size === 2) {
    const pts = Array.from(pointersPicker.values());
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    pickerGesture.mode = "pinch";
    pickerGesture.startDist = Math.hypot(dx, dy);
    pickerGesture.startZoom = state.picker.zoom;
    pickerGesture.startMid = { x: (pts[0].x + pts[1].x)/2, y: (pts[0].y + pts[1].y)/2 };
    pickerGesture.panStart = { panX: state.picker.panX, panY: state.picker.panY };
  }
});
pickerCanvas?.addEventListener("pointermove", (e) => {
  if (!pointersPicker.has(e.pointerId)) return;
  const rect = pickerCanvas.getBoundingClientRect();
  pointersPicker.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });

  if (pointersPicker.size === 2 && pickerGesture.mode === "pinch") {
    const pts = Array.from(pointersPicker.values());
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    const dist = Math.hypot(dx, dy);
    const scale = dist / Math.max(1, pickerGesture.startDist);

    state.picker.zoom = clamp(pickerGesture.startZoom * scale, 0.2, 8.0);

    const mid = { x: (pts[0].x + pts[1].x)/2, y: (pts[0].y + pts[1].y)/2 };
    const mdx = mid.x - pickerGesture.startMid.x;
    const mdy = mid.y - pickerGesture.startMid.y;
    state.picker.panX = pickerGesture.panStart.panX + mdx;
    state.picker.panY = pickerGesture.panStart.panY + mdy;

    drawPicker();
  }
});
pickerCanvas?.addEventListener("pointerup", (e) => {
  pointersPicker.delete(e.pointerId);
  if (pointersPicker.size < 2) pickerGesture.mode = "none";
});
pickerCanvas?.addEventListener("pointercancel", (e) => {
  pointersPicker.delete(e.pointerId);
  if (pointersPicker.size < 2) pickerGesture.mode = "none";
});

pickerCanvas?.addEventListener("click", (e) => {
  if (!state.picker.open) return;
  if (pickerGesture.mode === "pinch") return;
  if (!state.picker.page) return;

  const rect = pickerCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const page = state.picker.page;
  const z = state.picker.zoom;
  const px = state.picker.panX;
  const py = state.picker.panY;

  const wx = (x - px) / z;
  const wy = (y - py) / z;
  const nx = wx / page.width;
  const ny = wy / page.height;

  const masks = cache.masks.filter(m => m.printId === state.picker.printId);
  // maskをクリックしたら、そのmaskのgroupIdをトグル（Q選択）
  const hit = masks.find(m => nx >= m.x && nx <= m.x + m.w && ny >= m.y && ny <= m.y + m.h);
  if (!hit) return;

  if (state.picker.selectedGroupIds.has(hit.groupId)) state.picker.selectedGroupIds.delete(hit.groupId);
  else state.picker.selectedGroupIds.add(hit.groupId);

  $("#pickerSelCount") && ($("#pickerSelCount").textContent = String(state.picker.selectedGroupIds.size));
  $("#pickerStart") && ($("#pickerStart").disabled = state.picker.selectedGroupIds.size === 0);

  drawPicker();
});

// 学習開始（選択Qだけでreviewキューを作る）
$("#pickerStart")?.addEventListener("click", async () => {
  if (!state.picker.open) return;
  const gids = Array.from(state.picker.selectedGroupIds);
  if (gids.length === 0) return;

  closePickerModal();

  // review queue を選択分だけで開始（今日の復習とは別枠）
  state.reviewQueue = gids;
  state.reviewIndex = 0;
  state.doneTodayCount = 0;

  // today filter はこの任意学習では影響させない
  //（必要ならここで退避/復元できる）

  await openReview(gids[0]);
});

/* ========= HOME: 選択プリント移動 ========= */
$("#btnMoveSelected")?.addEventListener("click", async () => {
  const ids = Array.from(state.selectedPrintIds);
  if (ids.length === 0) return;

  await refreshCache();
  const subjects = getAllSubjectsFromPrints();

  openSubjectSheet({
    mode: "single",
    title: "移動先の教科を選択",
    subtitle: "「その他」は自由記載できます",
    subjects,
    initial: new Set(["算数"]),
    allowOtherFreeText: true,
    onOk: async (sel) => {
      const dest = normSubject(Array.from(sel)[0] || "その他");
      await refreshCache();
      await tx(["prints"], "readwrite", (st) => {
        ids.forEach((pid) => {
          const p = cache.prints.find(x => x.id === pid);
          if (!p) return;
          p.subject = dest;
          st.prints.put(p);
        });
      });
      await refreshCache();
      showHomeToast(`移動しました：${ids.length}件 → ${dest}`);
      await renderHome();
    },
    onCancel: () => {}
  });
});

/* ========= 印刷（A4 PDF） ========= */
async function renderMaskedDataUrlForPrint(printId){
  await refreshCache();
  const page = cache.pages.find(p => p.printId === printId && p.pageIndex === 0);
  if (!page) throw new Error("ページが見つかりません");
  const bitmap = await createImageBitmap(page.image);

  const off = document.createElement("canvas");
  off.width = page.width;
  off.height = page.height;
  const octx = off.getContext("2d");
  octx.drawImage(bitmap, 0, 0);

  const masks = cache.masks.filter(m => m.printId === printId);
  masks.forEach(m => {
    octx.fillStyle = "#000";
    octx.fillRect(
      m.x * page.width,
      m.y * page.height,
      m.w * page.width,
      m.h * page.height
    );
  });

  return off.toDataURL("image/jpeg", 0.92);
}

function buildPrintHtml(pages){
  // pages: [{title, subject, dataUrl}]
  const safe = pages.map(p => ({
    title: escapeHtml(p.title),
    subject: escapeHtml(p.subject),
    dataUrl: p.dataUrl
  }));

  const body = safe.map((p, i) => `
    <section class="page">
      <div class="meta">
        <div class="t">${p.title}</div>
        <div class="s">${p.subject}</div>
      </div>
      <div class="sheet"><img src="${p.dataUrl}" /></div>
    </section>
  `).join("\n");

  return `
<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Print</title>
<style>
  @page { size: A4 portrait; margin: 8mm; }
  html, body { margin:0; padding:0; }
  .page { page-break-after: always; }
  .meta { font-family: system-ui, -apple-system, sans-serif; margin: 0 0 6mm; }
  .t { font-size: 12pt; font-weight: 700; }
  .s { font-size: 10pt; opacity: 0.75; margin-top: 2mm; }
  .sheet { width: 100%; height: 277mm; display:flex; align-items:center; justify-content:center; }
  img { max-width: 100%; max-height: 100%; object-fit: contain; }
</style>
</head>
<body>
${body}
<script>
  // iOS Safariでもなるべく確実に印刷を起動
  window.onload = () => {
    setTimeout(() => { window.focus(); window.print(); }, 60);
  };
<\/script>
</body>
</html>
  `;
}

async function printHtmlViaIframe(html){
  const frame = $("#printFrame");
  if (!frame) throw new Error("printFrameが見つかりません");
  frame.classList.remove("hidden");

  // srcdocで印刷（popup不要）
  frame.srcdoc = html;

  // load待ち
  await new Promise((res) => {
    frame.onload = () => res();
    // Safariでonloadが不安定な時の保険
    setTimeout(res, 250);
  });

  try {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
  } catch (e) {
    console.warn("iframe print failed:", e);
    alert("印刷の起動に失敗しました。ブラウザのポップアップ/印刷設定をご確認ください。");
  }
}

// 選択プリントをまとめてA4印刷
$("#btnPrintSelectedPdf")?.addEventListener("click", async () => {
  const ids = Array.from(state.selectedPrintIds);
  if (ids.length === 0) return;

  await refreshCache();
  const targets = ids
    .map(id => cache.prints.find(p => p.id === id))
    .filter(Boolean);

  if (targets.length === 0) return;

  // 重いので確認
  if (!confirm(`選択した ${targets.length} 件をA4 PDF印刷します（1つにまとめます）。よろしいですか？`)) return;

  try {
    const pages = [];
    for (const p of targets) {
      const dataUrl = await renderMaskedDataUrlForPrint(p.id);
      pages.push({ title: p.title, subject: normSubject(p.subject), dataUrl });
    }
    const html = buildPrintHtml(pages);
    await printHtmlViaIframe(html);
    showHomeToast(`A4印刷を開始しました（${targets.length}件）`);
  } catch (e) {
    console.error(e);
    alert(`印刷に失敗しました：${e.message || e}`);
  }
});

/* ========= Backup / Restore ========= */
function downloadText(filename, text){
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

$("#btnBackup")?.addEventListener("click", async () => {
  await refreshCache();
  const payload = {
    meta: {
      app: "Print SRS Lite Pro",
      exportedAt: now(),
      version: "20260217-9",
      db: { name: DB_NAME, ver: DB_VER },
    },
    data: {
      prints: cache.prints,
      pages: cache.pages, // Blobはstructured cloneで保存されるがJSONにするには不可 → ここは注意
      groups: cache.groups,
      masks: cache.masks,
      srs: cache.srs,
      reviews: cache.reviews,
      skips: cache.skips,
      ui: cache.ui,
    }
  };

  // pages.image (Blob) は JSON にそのまま入らないので base64 化
  const pagesPacked = [];
  for (const p of cache.pages) {
    const buf = await p.image.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);
    pagesPacked.push({ ...p, imageBase64: b64, imageType: p.image.type || "image/jpeg" });
  }
  payload.data.pages = pagesPacked;

  const fname = `print_srs_backup_${new Date().toISOString().slice(0,10)}.json`;
  downloadText(fname, JSON.stringify(payload));
  showHomeToast("バックアップをダウンロードしました");
});

function arrayBufferToBase64(buffer){
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
function base64ToBlob(b64, type){
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i=0; i<len; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || "image/jpeg" });
}

$("#btnRestore")?.addEventListener("click", () => {
  $("#restoreFile")?.click();
});

$("#restoreFile")?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  if (!confirm("復元すると現在のデータは上書きされます。よろしいですか？")) {
    e.target.value = "";
    return;
  }

  try {
    const text = await file.text();
    const json = JSON.parse(text);

    if (!json?.data) throw new Error("バックアップ形式が不正です（dataがありません）");

    const prints = Array.isArray(json.data.prints) ? json.data.prints : [];
    const pagesPacked = Array.isArray(json.data.pages) ? json.data.pages : [];
    const groups = Array.isArray(json.data.groups) ? json.data.groups : [];
    const masks = Array.isArray(json.data.masks) ? json.data.masks : [];
    const srs = Array.isArray(json.data.srs) ? json.data.srs : [];
    const reviews = Array.isArray(json.data.reviews) ? json.data.reviews : [];
    const skips = Array.isArray(json.data.skips) ? json.data.skips : [];
    const ui = Array.isArray(json.data.ui) ? json.data.ui : [];

    // pages: base64 -> Blob
    const pages = pagesPacked.map(p => {
      if (p.imageBase64) {
        const blob = base64ToBlob(p.imageBase64, p.imageType);
        const { imageBase64, imageType, ...rest } = p;
        return { ...rest, image: blob };
      }
      // 旧形式（念のため）
      return p;
    });

    // いったん全削除 -> 書き込み
    await tx(["prints","pages","groups","masks","srs","reviews","skips","ui"], "readwrite", (st) => {
      ["prints","pages","groups","masks","srs","reviews","skips","ui"].forEach(name => {
        const store = st[name];
        store.clear();
      });

      prints.forEach(p => { p.subject = normSubject(p.subject); st.prints.put(p); });
      pages.forEach(p => st.pages.put(p));
      groups.forEach(g => st.groups.put(g));
      masks.forEach(m => st.masks.put(m));
      srs.forEach(s => st.srs.put(s));
      reviews.forEach(r => st.reviews.put(r));
      skips.forEach(s => st.skips.put(s));
      ui.forEach(u => st.ui.put(u));
    });

    await refreshCache();
    showHomeToast("復元しました");
    await renderHome();
  } catch (err) {
    console.error(err);
    alert(`復元に失敗：${err.message || err}`);
  } finally {
    e.target.value = "";
  }
});

/* ========= HOME: buttons ensure enabled ========= */
document.addEventListener("change", (e) => {
  // checkbox change already handled in item, but safety refresh
  if (e.target?.matches?.(".checkbox")) updateHomeSelectionUI();
});

/* ========= 初期起動 ========= */
(async function boot(){
  await loadCollapsedSubjects();
  await nav("home");
})();
