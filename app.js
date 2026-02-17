/* Print SRS Lite Pro (Nodeなし / IndexedDB)
   今回の追加（既存仕様は保持）:
   - 教科「その他（自由記載）」: 追加/編集で入力欄。保存は print.subject にその文字列を入れる（シンプル）
   - 移動先の教科選択: 標準教科 + 既存の自由記載教科 + 「その他（自由記載）」で新規入力
   - バックアップ説明文の位置: ボタン下に表示（HTML側変更 + 文字列そのまま）
   - 今日の復習: 画面に入る時に教科を複数選択できる（自由記載も含む）
     - キャンセル時は全教科（従来と同じ）
*/

const CFG = { maxW: 1600, jpegQ: 0.8, longPressMs: 350 };
const BACKUP_VERSION = 1;

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

const SUBJECT_BASE = ["算数","国語","理科","社会","英語"];
function isBaseSubject(s){ return SUBJECT_BASE.includes((s || "").trim()); }
function normalizeSubjectLabel(s){
  const t = (s || "").trim();
  return t || "その他";
}

/* =========================
   LocalStorage keys
   ========================= */
const LS_LAST_BACKUP_AT = "psrs_lastBackupAt";
const LS_DIRTY = "psrs_dirtySinceBackup";
const LS_SUBJ_COLLAPSED = "psrs_collapsedSubjects"; // JSON string of {subject:true}
const LS_HOME_TOAST = "psrs_homeToast"; // transient message

function markDirty(){
  try { localStorage.setItem(LS_DIRTY, "1"); } catch {}
}
function clearDirtyAndSetBackupTime(){
  try {
    localStorage.setItem(LS_LAST_BACKUP_AT, String(now()));
    localStorage.removeItem(LS_DIRTY);
  } catch {}
}
function getLastBackupAt(){
  try {
    const v = localStorage.getItem(LS_LAST_BACKUP_AT);
    return v ? Number(v) : null;
  } catch { return null; }
}
function isDirty(){
  try { return localStorage.getItem(LS_DIRTY) === "1"; } catch { return false; }
}
function getCollapsedMap(){
  try {
    const raw = localStorage.getItem(LS_SUBJ_COLLAPSED);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function setCollapsed(subject, collapsed){
  const m = getCollapsedMap();
  m[subject] = !!collapsed;
  try { localStorage.setItem(LS_SUBJ_COLLAPSED, JSON.stringify(m)); } catch {}
}
function isCollapsed(subject){
  const m = getCollapsedMap();
  return !!m[subject];
}
function setHomeToast(msg){
  try { localStorage.setItem(LS_HOME_TOAST, msg); } catch {}
}
function popHomeToast(){
  try {
    const m = localStorage.getItem(LS_HOME_TOAST);
    if (m) localStorage.removeItem(LS_HOME_TOAST);
    return m || "";
  } catch { return ""; }
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
        t.oncomplete = () => {
          if (mode === "readwrite") markDirty();
          resolve(res);
        };
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
async function clearAllStores(){
  await tx(["prints","pages","groups","masks","srs","reviews","skips"], "readwrite", (s) => {
    s.prints.clear();
    s.pages.clear();
    s.groups.clear();
    s.masks.clear();
    s.srs.clear();
    s.reviews.clear();
    s.skips.clear();
  });
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
    reviewCount: (prev.reviewCount || 0) + 1,
    lapseCount: (prev.lapseCount || 0) + (rating === "again" ? 1 : 0),
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
   Blob <-> Base64 (backup)
   ========================= */
function blobToDataURL(blob){
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
async function dataURLToBlob(dataUrl){
  const res = await fetch(dataUrl);
  return await res.blob();
}

/* =========================
   Bottom Sheet Modal
   ========================= */
const sheetOverlay = $("#sheetOverlay");
const sheet = $("#sheet");
const sheetTitle = $("#sheetTitle");
const sheetBody = $("#sheetBody");
const sheetFooter = $("#sheetFooter");
const sheetOk = $("#sheetOk");
const sheetCancel = $("#sheetCancel");
const sheetClose = $("#sheetClose");

let sheetState = { onOk: null, onCancel: null };

function openSheet({ title, bodyHtml, showFooter=false, okText="OK", cancelText="キャンセル", onOk=null, onCancel=null }){
  sheetTitle.textContent = title || "選択";
  sheetBody.innerHTML = bodyHtml || "";
  sheetFooter.classList.toggle("hidden", !showFooter);
  sheetOk.textContent = okText;
  sheetCancel.textContent = cancelText;

  sheetState = { onOk, onCancel };

  sheetOverlay.classList.remove("hidden");
  sheet.classList.remove("hidden");
  sheet.setAttribute("aria-hidden", "false");

  document.body.style.overflow = "hidden";
}
function closeSheet(){
  sheetOverlay.classList.add("hidden");
  sheet.classList.add("hidden");
  sheet.setAttribute("aria-hidden", "true");
  sheetBody.innerHTML = "";
  sheetState = { onOk: null, onCancel: null };
  document.body.style.overflow = "";
}
sheetOverlay?.addEventListener("click", () => {
  if (sheetState.onCancel) sheetState.onCancel();
  closeSheet();
});
sheetClose?.addEventListener("click", () => {
  if (sheetState.onCancel) sheetState.onCancel();
  closeSheet();
});
sheetCancel?.addEventListener("click", () => {
  if (sheetState.onCancel) sheetState.onCancel();
  closeSheet();
});
sheetOk?.addEventListener("click", async () => {
  if (sheetState.onOk) await sheetState.onOk();
  closeSheet();
});

function openTextInputSheet({ title, initialValue="", placeholder="", okText="OK", onOk }){
  const safeVal = escapeHtml(initialValue);
  openSheet({
    title,
    bodyHtml: `
      <div class="form" style="max-width:100%">
        <label>${escapeHtml(title)}
          <input id="sheetTextInput" class="sheetInput" type="text" value="${safeVal}" placeholder="${escapeHtml(placeholder)}" />
        </label>
      </div>
    `,
    showFooter: true,
    okText,
    cancelText: "キャンセル",
    onOk: async () => {
      const v = ($("#sheetTextInput")?.value || "").trim();
      await onOk(v);
    }
  });

  setTimeout(() => $("#sheetTextInput")?.focus(), 50);
}

/* ====== Subject utilities (custom-aware) ====== */
function getAllSubjectsFromCache(){
  const set = new Set();
  cache.prints.forEach(p => set.add(normalizeSubjectLabel(p.subject)));
  // base subjects always present
  SUBJECT_BASE.forEach(s => set.add(s));
  return Array.from(set).filter(Boolean);
}
function sortSubjects(subjects){
  const base = [];
  const custom = [];
  subjects.forEach(s => (isBaseSubject(s) ? base.push(s) : custom.push(s)));
  base.sort((a,b)=> SUBJECT_BASE.indexOf(a) - SUBJECT_BASE.indexOf(b));
  custom.sort((a,b)=> a.localeCompare(b, "ja"));
  // 「その他」は最後扱いにしがちだが、自由記載を増やすのでここでは文字順に含める
  return [...base, ...custom];
}

/* subject picker:
   - base + existing custom
   - include special item "__custom__" (その他自由記載)
*/
function openSubjectPickerCustom({ title="教科を選択", current="", onPick }){
  const cur = normalizeSubjectLabel(current);
  const subjects = sortSubjects(getAllSubjectsFromCache());

  const rows = subjects.map(s => `
    <div class="sheetChoice ${s===cur ? "active" : ""}" data-subj="${escapeHtml(s)}">
      <div>${escapeHtml(s)}</div>
      <div class="muted small">${s===cur ? "選択中" : ""}</div>
    </div>
  `).join("");

  const special = `
    <div class="sheetChoice" data-subj="__custom__">
      <div>その他（自由記載）</div>
      <div class="muted small">新しい教科名を入力</div>
    </div>
  `;

  openSheet({
    title,
    bodyHtml: `<div class="sheetList">${rows}${special}</div>`,
    showFooter:false
  });

  $$(".sheetChoice").forEach(el => {
    el.addEventListener("click", () => {
      const raw = el.getAttribute("data-subj") || "";
      if (raw === "__custom__") {
        closeSheet();
        openTextInputSheet({
          title: "自由記載（教科名）",
          initialValue: "",
          placeholder: "例：漢字 / 計算 / 英単語 / 社会(地理) など",
          okText: "決定",
          onOk: async (v) => {
            const label = normalizeSubjectLabel(v);
            onPick(label);
          }
        });
        return;
      }
      const picked = normalizeSubjectLabel(raw);
      closeSheet();
      onPick(picked);
    });
  });
}

/* multi-select subject picker (for Today filter) */
function openSubjectMultiPicker({ title="どの教科を復習しますか？（複数選択）", initialSelected=[], onOk }){
  const all = sortSubjects(getAllSubjectsFromCache());
  const selected = new Set((initialSelected || []).map(normalizeSubjectLabel));

  const listHtml = all.map(s => `
    <div class="sheetChoice" data-subj="${escapeHtml(s)}">
      <div class="sheetChoiceLeft">
        <input class="sheetCheck" type="checkbox" ${selected.has(s) ? "checked" : ""} />
        <div>${escapeHtml(s)}</div>
      </div>
      <div class="muted small"></div>
    </div>
  `).join("");

  const special = `
    <div class="sheetChoice" data-subj="__custom__">
      <div class="sheetChoiceLeft">
        <span class="muted">＋</span>
        <div>その他（自由記載）を追加</div>
      </div>
      <div class="muted small">新しい教科名</div>
    </div>
  `;

  openSheet({
    title,
    bodyHtml: `
      <div class="muted small" style="margin-bottom:8px">
        何も選ばずOK → 全教科になります
      </div>
      <div class="sheetList">${listHtml}${special}</div>
    `,
    showFooter: true,
    okText: "OK",
    cancelText: "キャンセル",
    onOk: async () => {
      const picked = Array.from(selected).filter(Boolean);
      await onOk(picked);
    },
    onCancel: () => {}
  });

  $$(".sheetChoice").forEach(el => {
    el.addEventListener("click", async (ev) => {
      const raw = el.getAttribute("data-subj") || "";
      if (raw === "__custom__") {
        closeSheet();
        openTextInputSheet({
          title: "自由記載（教科名）",
          initialValue: "",
          placeholder: "例：漢字 / 計算 / 英単語 など",
          okText: "追加",
          onOk: async (v) => {
            const label = normalizeSubjectLabel(v);
            if (label) selected.add(label);
            // 再オープン（選択状態を維持）
            openSubjectMultiPicker({ title, initialSelected: Array.from(selected), onOk });
          }
        });
        return;
      }

      // checkbox toggle
      const subj = normalizeSubjectLabel(raw);
      const cb = el.querySelector("input[type=checkbox]");
      if (!cb) return;
      cb.checked = !cb.checked;
      if (cb.checked) selected.add(subj);
      else selected.delete(subj);
      ev.preventDefault();
    });
  });
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

  todaySubjects: null, // null=全教科 / array=フィルタ
};

let cache = { prints:[], pages:[], groups:[], masks:[], srs:[], reviews:[], skips:[] };

async function refreshCache() {
  const [prints, pages, groups, masks, srs, reviews, skips] = await Promise.all([
    getAll("prints"), getAll("pages"), getAll("groups"), getAll("masks"),
    getAll("srs"), getAll("reviews"), getAll("skips"),
  ]);
  // subject label normalize
  prints.forEach(p => p.subject = normalizeSubjectLabel(p.subject));
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
    else if (to === "today") await renderTodayEntry(); // ★教科選択を挟む
  } catch (e) {
    console.error("nav error:", e);
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
   Backup UI status
   ========================= */
function renderBackupStatus(){
  const badge = $("#backupBadge");
  const help = $("#backupHelp");
  if (!badge || !help) return;

  const last = getLastBackupAt();
  const dirty = isDirty();

  const lastTxt = last ? `最終：${new Date(last).toLocaleString()}` : "最終：未実施";
  const dirtyTxt = dirty ? "未バックアップ変更あり" : "変更なし";

  badge.className = "badge " + (dirty || !last ? "warn" : "ok");
  badge.textContent = `${lastTxt} / ${dirtyTxt}`;

  // ★指定の文言（場所はHTML側で「ボタン下」）
  help.innerHTML =
    `バックアップ(JSON)はダウンロードされます。<br>
     iPadなら、共有 → <b>Google Drive</b> に保存が安全です。`;
}

/* =========================
   Backup / Restore
   ========================= */
async function exportBackupJson(){
  await refreshCache();

  const pages = [];
  for (const p of cache.pages) {
    const dataUrl = await blobToDataURL(p.image);
    pages.push({ ...p, imageDataUrl: dataUrl, image: undefined });
  }

  const payload = {
    backupVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    app: "Print SRS Lite Pro",
    data: {
      prints: cache.prints.map(p => ({...p, subject: normalizeSubjectLabel(p.subject)})),
      pages,
      groups: cache.groups,
      masks: cache.masks,
      srs: cache.srs,
      reviews: cache.reviews,
      skips: cache.skips,
    }
  };

  const json = JSON.stringify(payload);
  const blob = new Blob([json], { type: "application/json" });
  const name = `print-srs-backup-${new Date().toISOString().slice(0,10)}.json`;

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);

  clearDirtyAndSetBackupTime();
  renderBackupStatus();
  alert("バックアップを書き出しました。\n（iPadは共有からGoogle Driveへ保存がおすすめ）");
}

function safeNormalizeBackup(obj){
  const d = obj?.data || {};
  const prints = (d.prints || []).map(p => ({
    id: p.id,
    title: (p.title ?? "").toString(),
    subject: normalizeSubjectLabel(p.subject),
    createdAt: Number(p.createdAt || now()),
  }));

  const groups = (d.groups || []).map(g => ({
    id: g.id,
    printId: g.printId,
    pageIndex: Number(g.pageIndex || 0),
    label: (g.label ?? "").toString() || "Q1",
    orderIndex: Number(g.orderIndex || 0),
    isActive: g.isActive !== false,
    createdAt: Number(g.createdAt || now()),
  }));

  const masks = (d.masks || []).map(m => ({
    id: m.id,
    groupId: m.groupId,
    printId: m.printId,
    pageIndex: Number(m.pageIndex || 0),
    x: clamp01(Number(m.x || 0)),
    y: clamp01(Number(m.y || 0)),
    w: clamp(Number(m.w || 0.01), 0.0005, 1),
    h: clamp(Number(m.h || 0.01), 0.0005, 1),
    createdAt: Number(m.createdAt || now()),
  }));

  const srs = (d.srs || []).map(s => ({
    groupId: s.groupId,
    difficulty: clamp(Number(s.difficulty ?? 5.0), 1.0, 10.0),
    stability: clamp(Number(s.stability ?? 1.0), 0.5, 36500),
    lastReviewedAt: s.lastReviewedAt == null ? null : Number(s.lastReviewedAt),
    nextDueAt: Number(s.nextDueAt ?? now()),
    reviewCount: Number(s.reviewCount ?? 0),
    lapseCount: Number(s.lapseCount ?? 0),
    updatedAt: Number(s.updatedAt ?? now()),
  }));

  const reviews = (d.reviews || []).map(r => ({
    id: r.id || uid(),
    groupId: r.groupId,
    reviewedAt: Number(r.reviewedAt || now()),
    rating: ["again","hard","good","easy"].includes(r.rating) ? r.rating : "good",
  }));

  const skips = (d.skips || []).map(x => ({
    groupId: x.groupId,
    skipUntil: Number(x.skipUntil || 0),
  }));

  const pagesRaw = (d.pages || []);
  return { prints, groups, masks, srs, reviews, skips, pagesRaw };
}

async function importBackupJson(file){
  const text = await file.text();
  let obj;
  try { obj = JSON.parse(text); }
  catch { throw new Error("JSONの形式が正しくありません"); }

  const ver = Number(obj?.backupVersion || 0);
  if (!ver) throw new Error("バックアップファイルではない可能性があります（backupVersionなし）");
  if (ver > BACKUP_VERSION) {
    throw new Error(`このバックアップは新しい形式です（backupVersion=${ver}）。アプリ側を更新してください。`);
  }

  const ok = confirm(
    "復元すると、この端末にある現在のデータは上書きされます。\n" +
    "（必要なら先にバックアップしてから復元してください）\n\n" +
    "復元を開始しますか？"
  );
  if (!ok) return;

  const normalized = safeNormalizeBackup(obj);

  const pages = [];
  for (const p of normalized.pagesRaw) {
    const dataUrl = p.imageDataUrl || p.image;
    if (!dataUrl) continue;
    const blob = await dataURLToBlob(dataUrl);
    pages.push({
      id: p.id,
      printId: p.printId,
      pageIndex: Number(p.pageIndex || 0),
      image: blob,
      width: Number(p.width || 0),
      height: Number(p.height || 0),
    });
  }

  await clearAllStores();
  await tx(["prints","pages","groups","masks","srs","reviews","skips"], "readwrite", (st) => {
    normalized.prints.forEach(x => st.prints.put(x));
    pages.forEach(x => st.pages.put(x));
    normalized.groups.forEach(x => st.groups.put(x));
    normalized.masks.forEach(x => st.masks.put(x));
    normalized.srs.forEach(x => st.srs.put(x));
    normalized.reviews.forEach(x => st.reviews.put(x));
    normalized.skips.forEach(x => st.skips.put(x));
  });

  clearDirtyAndSetBackupTime();
  await refreshCache();
  alert("復元が完了しました。ホームを更新します。");
  await nav("home");
}

$("#btnBackupJson")?.addEventListener("click", async () => {
  try { await exportBackupJson(); }
  catch (e) {
    console.error(e);
    alert("バックアップに失敗しました。画像が多い場合、少し時間がかかることがあります。");
  }
});

$("#btnRestoreJson")?.addEventListener("click", () => {
  $("#restoreFile")?.click();
});
$("#restoreFile")?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try { await importBackupJson(file); }
  catch (err) {
    console.error(err);
    alert(`復元に失敗：${err.message || err}`);
  }
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
function computeDueGroups(subjectFilter /* array|null */) {
  const t = now();
  const srsMap = new Map(cache.srs.map((s) => [s.groupId, s]));

  const allow = subjectFilter && subjectFilter.length ? new Set(subjectFilter.map(normalizeSubjectLabel)) : null;

  return cache.groups
    .filter((g) => g.isActive)
    .map((g) => ({ g, s: srsMap.get(g.id) }))
    .filter((x) => x.s && x.s.nextDueAt != null && x.s.nextDueAt <= t)
    .filter((x) => !isSkipped(x.g.id))
    .filter((x) => {
      if (!allow) return true;
      const p = cache.prints.find(pp => pp.id === x.g.printId);
      const subj = normalizeSubjectLabel(p?.subject);
      return allow.has(subj);
    })
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
  if (btnDel) {
    btnDel.disabled = n === 0;
    btnDel.textContent = n === 0 ? "選択したプリントを削除" : `選択したプリントを削除（${n}件）`;
  }

  const btnMove = $("#btnMoveSelected");
  if (btnMove) btnMove.disabled = n === 0;

  const btnPdf = $("#btnExportSelectedPdf");
  if (btnPdf) btnPdf.disabled = n === 0;
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
   HOME: 一括移動（ボタン押下→教科選択）
   ========================= */
async function moveSelectedToSubject(subjectLabel){
  const ids = Array.from(state.selectedPrintIds);
  if (ids.length === 0) return;
  const subject = normalizeSubjectLabel(subjectLabel);

  await refreshCache();
  await tx(["prints"], "readwrite", (st) => {
    ids.forEach(id => {
      const p = cache.prints.find(x => x.id === id);
      if (!p) return;
      p.subject = subject;
      st.prints.put(p);
    });
  });

  await refreshCache();
  setHomeToast(`✅ 移動完了：${ids.length}件 →「${subject}」`);
  await renderHome();
}

$("#btnMoveSelected")?.addEventListener("click", async () => {
  const ids = Array.from(state.selectedPrintIds);
  if (ids.length === 0) return;

  openSubjectPickerCustom({
    title: "移動先の教科を選択",
    current: "",
    onPick: async (picked) => {
      const ok = confirm(`選択した ${ids.length} 件を「${picked}」へ移動しますか？`);
      if (!ok) return;
      await moveSelectedToSubject(picked);
    }
  });
});

/* =========================
   HOME: PDF print selected (combined A4)
   ========================= */
async function buildMaskedDataUrlForPrint(printId){
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
    octx.fillStyle = "black";
    octx.fillRect(
      m.x * page.width,
      m.y * page.height,
      m.w * page.width,
      m.h * page.height
    );
  });

  return off.toDataURL("image/jpeg", 0.95);
}

async function exportSelectedPrintsToPdf(){
  const ids = Array.from(state.selectedPrintIds);
  if (ids.length === 0) return;

  if (ids.length >= 20) {
    if (!confirm(`選択が ${ids.length} 件あります。印刷準備に時間がかかる可能性があります。続けますか？`)) return;
  }

  await refreshCache();
  const prints = cache.prints
    .filter(p => ids.includes(p.id))
    .slice()
    .sort((a,b)=>b.createdAt-a.createdAt);

  const dataUrls = [];
  for (const p of prints) {
    try {
      const url = await buildMaskedDataUrlForPrint(p.id);
      dataUrls.push({ title: p.title, subject: normalizeSubjectLabel(p.subject), url });
    } catch (e) {
      console.error(e);
    }
  }

  if (dataUrls.length === 0) {
    alert("PDF用の画像を作れませんでした。");
    return;
  }

  const win = window.open("");
  if (!win) { alert("ポップアップがブロックされました"); return; }

  const pagesHtml = dataUrls.map((x) => `
    <div class="page">
      <div class="meta">${escapeHtml(x.subject)} / ${escapeHtml(x.title)}</div>
      <img src="${x.url}" />
    </div>
  `).join("");

  win.document.write(`
    <html>
      <head>
        <title>Masked Prints</title>
        <style>
          @page { size: A4 portrait; margin: 8mm; }
          html, body { margin: 0; padding: 0; }
          .page { width: 210mm; height: 297mm; box-sizing: border-box; padding: 0; page-break-after: always; display:flex; flex-direction:column; }
          .meta { font: 11px sans-serif; color: #333; margin: 0 0 6mm 0; }
          img { width: 100%; height: calc(297mm - 14mm); object-fit: contain; }
        </style>
      </head>
      <body>
        ${pagesHtml}
        <script>
          window.onload = function(){ window.print(); }
        <\/script>
      </body>
    </html>
  `);

  setHomeToast(`🖨️ 印刷準備OK：選択プリント ${dataUrls.length} 件（A4）`);
}

$("#btnExportSelectedPdf")?.addEventListener("click", async () => {
  try { await exportSelectedPrintsToPdf(); }
  catch (e) {
    console.error(e);
    alert("PDF印刷の準備に失敗しました。");
  }
});

/* =========================
   HOME (教科でカテゴリ分け + 折りたたみ)
   ========================= */
function groupPrintsBySubject(prints) {
  const map = new Map();
  for (const p of prints) {
    const subj = normalizeSubjectLabel(p.subject);
    if (!map.has(subj)) map.set(subj, []);
    map.get(subj).push(p);
  }
  for (const [k, arr] of map.entries()) arr.sort((a,b) => b.createdAt - a.createdAt);
  return map;
}

function sortSubjectKeys(keys){
  const base = [];
  const custom = [];
  keys.forEach(k => (isBaseSubject(k) ? base.push(k) : custom.push(k)));
  base.sort((a,b)=> SUBJECT_BASE.indexOf(a) - SUBJECT_BASE.indexOf(b));
  custom.sort((a,b)=> a.localeCompare(b,"ja"));
  return [...base, ...custom];
}

function renderOnePrintItem(p) {
  const gCount = cache.groups.filter((g) => g.printId === p.id).length;
  const mCount = cache.masks.filter((m) => m.printId === p.id).length;
  const checked = state.selectedPrintIds.has(p.id);

  const el = document.createElement("div");
  el.className = "item childIndent";
  el.innerHTML = `
    <div class="row space">
      <div class="row" style="align-items:flex-start">
        <input class="checkbox" type="checkbox" data-print-check="${p.id}" ${checked ? "checked" : ""}/>
        <div>
          <div class="itemTitle">${escapeHtml(p.title)}</div>
          <div class="muted small">${escapeHtml(normalizeSubjectLabel(p.subject))} / ${new Date(p.createdAt).toLocaleDateString()} / Q:${gCount} / mask:${mCount}</div>
        </div>
      </div>
      <div class="row">
        <button class="btn" data-open-edit="${p.id}">編集</button>
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

  el.querySelector("[data-open-today]")?.addEventListener("click", async () => {
    // 「このプリントを復習」は従来どおり（教科フィルタではなく、そのプリント内の期限Qを開く）
    state.currentPrintId = p.id;
    await renderTodayWithFilter(null); // today画面描画
    setTimeout(() => openFirstDueOfPrint(p.id), 0);
  });

  el.querySelector("[data-del-print]")?.addEventListener("click", async () => {
    if (!confirm(`「${p.title}」を削除します（関連データも全部消えます）`)) return;
    await deletePrintCascade(p.id);
    state.selectedPrintIds.delete(p.id);
    renderHome();
  });

  return el;
}

function showHomeToast(msg){
  const el = $("#homeToast");
  if (!el) return;
  el.innerHTML = `<span>🔔</span><div><strong>${escapeHtml(msg)}</strong></div>`;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 4200);
}

async function renderHome() {
  await refreshCache();
  show("#view-home");

  const due = computeDueGroups(null);
  $("#dueCount") && ($("#dueCount").textContent = String(due.length));
  updateHomeSelectionUI();
  renderBackupStatus();

  const toast = popHomeToast();
  if (toast) showHomeToast(toast);

  const list = $("#printList");
  if (!list) return;
  list.innerHTML = "";

  const prints = cache.prints.slice().sort((a,b)=>b.createdAt-a.createdAt);
  if (prints.length === 0) {
    list.innerHTML = `<div class="item muted">まだプリントがありません</div>`;
    return;
  }

  const bySubj = groupPrintsBySubject(prints);
  const subjKeys = sortSubjectKeys(Array.from(bySubj.keys()));

  for (const subj of subjKeys) {
    const arr = bySubj.get(subj);
    if (!arr || arr.length === 0) continue;

    const collapsed = isCollapsed(subj);

    const header = document.createElement("div");
    header.className = "item subjectHeader";
    // standard only gets explicit color; custom uses fallback
    if (isBaseSubject(subj)) header.setAttribute("data-subject", subj);
    header.innerHTML = `
      <div class="subjectHeaderTop">
        <div>
          <div class="itemTitle">${escapeHtml(subj)}</div>
          <div class="muted small">プリント ${arr.length} 件</div>
        </div>
        <div class="chev">${collapsed ? "▶" : "▼"}</div>
      </div>
    `;
    header.addEventListener("click", () => {
      const next = !isCollapsed(subj);
      setCollapsed(subj, next);
      renderHome();
    });
    list.appendChild(header);

    if (collapsed) continue;

    for (const p of arr) list.appendChild(renderOnePrintItem(p));
  }
}

/* =========================
   ADD (その他自由記載)
   ========================= */
function renderAdd() {
  show("#view-add");
  $("#addStatus") && ($("#addStatus").textContent = "");
  $("#addTitle") && ($("#addTitle").value = `プリント ${new Date().toLocaleDateString()}`);
  $("#addSubject") && ($("#addSubject").value = "算数");
  $("#addSubjectCustom") && ($("#addSubjectCustom").value = "");
  $("#addSubjectCustomWrap")?.classList.add("hidden");
  $("#addFile") && ($("#addFile").value = "");
}

$("#addSubject")?.addEventListener("change", () => {
  const v = $("#addSubject")?.value;
  if (v === "__custom__") $("#addSubjectCustomWrap")?.classList.remove("hidden");
  else $("#addSubjectCustomWrap")?.classList.add("hidden");
});

$("#btnCreatePrint")?.addEventListener("click", async () => {
  const title = ($("#addTitle")?.value || "").trim() || `プリント ${new Date().toLocaleDateString()}`;

  let subjectRaw = $("#addSubject")?.value || "その他";
  if (subjectRaw === "__custom__") subjectRaw = ($("#addSubjectCustom")?.value || "").trim();
  const subject = normalizeSubjectLabel(subjectRaw);

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

$("#btnEditDone")?.addEventListener("click", async () => {
  setHomeToast("編集が完了しました（Homeに反映済み）");
  await nav("home");
});

async function renameCurrentPrintSheet() {
  await refreshCache();
  const p = cache.prints.find(x => x.id === state.currentPrintId);
  if (!p) return;

  openTextInputSheet({
    title: "プリント名を変更",
    initialValue: p.title || "",
    placeholder: "例：算数プリント 2/16",
    okText: "変更",
    onOk: async (v) => {
      const nv = v.trim();
      if (!nv) return;
      p.title = nv;
      await put("prints", p);
      await refreshCache();
      updateEditHeaderClickable();
    }
  });
}

async function changeCurrentSubjectSheet() {
  await refreshCache();
  const p = cache.prints.find(x => x.id === state.currentPrintId);
  if (!p) return;

  openSubjectPickerCustom({
    title: "教科を変更",
    current: p.subject,
    onPick: async (picked) => {
      p.subject = normalizeSubjectLabel(picked);
      await put("prints", p);
      await refreshCache();
      updateEditHeaderClickable();
    }
  });
}

function updateEditHeaderClickable() {
  const p = cache.prints.find((x) => x.id === state.currentPrintId);
  const titleEl = $("#editTitle");
  const metaEl = $("#editMeta");
  if (titleEl) {
    titleEl.innerHTML = `編集：${escapeHtml(p ? p.title : "")} <span class="hint">✏️ タップで名前変更</span>`;
    titleEl.title = "タップで名前変更";
  }
  if (metaEl) {
    metaEl.innerHTML = `${escapeHtml(p ? normalizeSubjectLabel(p.subject) : "")} / ${p ? new Date(p.createdAt).toLocaleDateString() : ""} <span class="hint">✏️ タップで教科変更</span>`;
    metaEl.title = "タップで教科変更";
  }
  if (titleEl) titleEl.onclick = () => renameCurrentPrintSheet();
  if (metaEl) metaEl.onclick = () => changeCurrentSubjectSheet();
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

  openTextInputSheet({
    title: "Q名を変更",
    initialValue: g.label || "",
    placeholder: "例：Q3 / 問5 / 単語②",
    okText: "変更",
    onOk: async (v) => {
      const nv = v.trim();
      if (!nv) return;
      g.label = nv;
      await put("groups", g);
      await refreshCache();
      await renderEditSidebar();
      drawEdit();
    }
  });
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

function updateSelUI() {
  $("#selCount") && ($("#selCount").textContent = String(state.selectedMaskIds.size));
  $("#btnMoveSel") && ($("#btnMoveSel").disabled = !state.currentGroupId || state.selectedMaskIds.size === 0);
  $("#btnDeleteSel") && ($("#btnDeleteSel").disabled = state.selectedMaskIds.size === 0);
  $("#btnClearSel") && ($("#btnClearSel").disabled = state.selectedMaskIds.size === 0);
}

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

/* ----- Edit pointer handling (PC/iPad共通) ----- */
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
   TODAY/REVIEW（教科フィルタ追加）
   ========================= */
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
  await renderTodayWithFilter(state.todaySubjects);
});

$("#btnTodayFilter")?.addEventListener("click", async () => {
  await refreshCache();
  openSubjectMultiPicker({
    title: "どの教科を復習しますか？（複数選択）",
    initialSelected: state.todaySubjects || [],
    onOk: async (picked) => {
      // pickedが空なら全教科扱い
      state.todaySubjects = picked.length ? picked : null;
      await renderTodayWithFilter(state.todaySubjects);
    }
  });
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

async function renderTodayEntry(){
  await refreshCache();
  // ★「今日の復習」を押したら教科選択（複数可）
  openSubjectMultiPicker({
    title: "どの教科を復習しますか？（複数選択）",
    initialSelected: state.todaySubjects || [],
    onOk: async (picked) => {
      state.todaySubjects = picked.length ? picked : null;
      await renderTodayWithFilter(state.todaySubjects);
    }
  });
  // キャンセル時（overlay/キャンセル）→全教科に戻す
  sheetState.onCancel = async () => {
    state.todaySubjects = null;
    await renderTodayWithFilter(null);
  };
}

async function renderTodayWithFilter(subjects){
  await refreshCache();
  show("#view-today");

  $("#view-done")?.classList.add("hidden");
  $("#view-review")?.classList.add("hidden");

  const due = computeDueGroups(subjects);

  const filterLabel = subjects && subjects.length
    ? `対象教科：${subjects.map(normalizeSubjectLabel).join(" / ")}`
    : "対象教科：全教科";

  $("#todayMeta") && ($("#todayMeta").textContent = `${filterLabel} / 期限が来ているQ：${due.length}（スキップ除外）`);

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
          <div class="muted small">${escapeHtml(normalizeSubjectLabel(p?.subject))} / 期限：${toDateStr(s.nextDueAt)} / 難易度:${s.difficulty.toFixed(1)} / 安定度:${s.stability.toFixed(1)}日 / 復習回数:${s.reviewCount}</div>
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
      await renderTodayWithFilter(state.todaySubjects);
    });
    list.appendChild(el);
  }
}

async function openFirstDueOfPrint(printId) {
  await refreshCache();
  const due = computeDueGroups(null).filter(({ g }) => g.printId === printId);
  if (due.length === 0) return;
  openReview(due[0].g.id);
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
  $("#reviewMeta") && ($("#reviewMeta").textContent = `教科：${normalizeSubjectLabel(p?.subject)} / 期限：${toDateStr(s.nextDueAt)} / 難易度:${s.difficulty.toFixed(1)} / 安定度:${s.stability.toFixed(1)}日`);

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

  await del("skips", g.id);

  await tx(["srs", "reviews", "groups"], "readwrite", (st) => {
    st.srs.put(next);
    st.reviews.put({ id: uid(), groupId: g.id, reviewedAt: now(), rating });
    g.isActive = true;
    st.groups.put(g);
  });

  state.doneTodayCount = (state.doneTodayCount || 0) + 1;

  await refreshCache();
  const dueNow = computeDueGroups(state.todaySubjects).map(x => x.g.id);

  if (dueNow.length === 0) {
    await renderTodayWithFilter(state.todaySubjects);
    showDoneScreen();
    return;
  }

  state.reviewQueue = dueNow;
  const nextIndex = Math.min(Math.max(state.reviewIndex, 0), dueNow.length - 1);
  state.reviewIndex = nextIndex;

  await openReview(dueNow[nextIndex]);
});

/* =========================
   Boot
   ========================= */
(async function boot() {
  await refreshCache();
  await nav("home");
})();
