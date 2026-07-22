"use strict";

const state = { books: [], chapters: [], selected: null };
const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  const response = await send({ type: "getSettings" });
  if (response.ok) {
    $("baseUrl").value = response.result.baseUrl || "http://127.0.0.1:8787";
    $("apiToken").value = response.result.apiToken || "";
  }
  await connectAndLoad();
});

function bindEvents() {
  $("saveSettings").addEventListener("click", saveSettings);
  $("syncNow").addEventListener("click", syncNow);
  $("refreshList").addEventListener("click", loadChapters);
  $("bookSelect").addEventListener("change", loadChapters);
  $("statusFilter").addEventListener("change", loadChapters);
  $("fillChapter").addEventListener("click", fillSelected);
  $("reconcileChapter").addEventListener("click", reconcileSelected);
}

async function saveSettings() {
  setStatus("正在保存设置…", "正在测试本地助手连接。", "neutral");
  const response = await send({
    type: "saveSettings",
    settings: { baseUrl: $("baseUrl").value, apiToken: $("apiToken").value }
  });
  if (!response.ok) return setStatus("设置失败", response.error, "danger");
  await connectAndLoad();
}

async function connectAndLoad() {
  const health = await send({ type: "health" });
  if (!health.ok) {
    setConnection(false);
    return setStatus("本地助手未连接", health.error, "danger");
  }
  setConnection(true);
  const books = await send({ type: "getBooks" });
  if (!books.ok) return setStatus("认证失败", books.error, "danger");
  state.books = books.result.books || [];
  renderBooks();
  await loadChapters();
  setStatus("本地助手已连接", `版本 ${health.result.version}`, "ok");
}

async function syncNow() {
  setStatus("正在同步服务器…", "将运行服务器导出并只下载新版本。", "neutral");
  $("syncNow").disabled = true;
  const response = await send({ type: "sync" });
  $("syncNow").disabled = false;
  if (!response.ok) return setStatus("同步失败", response.error, "danger");
  const r = response.result;
  setStatus("同步完成", `清单 ${r.manifest_count} 章；下载 ${r.downloaded_count}；未变化 ${r.unchanged_count}；冲突 ${r.conflict_count}`, r.conflict_count ? "warn" : "ok");
  await connectAndLoad();
}

function renderBooks() {
  $("bookSelect").innerHTML = "";
  for (const book of state.books) {
    const option = document.createElement("option");
    option.value = book.book_id;
    option.textContent = `${book.name}（待处理 ${book.ready_count || 0}）`;
    $("bookSelect").appendChild(option);
  }
}

async function loadChapters() {
  const bookId = $("bookSelect").value;
  if (!bookId) {
    state.chapters = [];
    renderChapters();
    return;
  }
  const response = await send({
    type: "getChapters",
    bookId,
    status: $("statusFilter").value,
    limit: 1000
  });
  if (!response.ok) return setStatus("队列读取失败", response.error, "danger");
  state.chapters = response.result.chapters || [];
  state.selected = null;
  renderChapters();
  renderPreview(null);
}

function renderChapters() {
  const list = $("chapterList");
  list.innerHTML = "";
  $("queueCount").textContent = String(state.chapters.length);
  for (const chapter of state.chapters) {
    const item = document.createElement("div");
    item.className = "chapter-item";
    item.innerHTML = `<strong>第 ${chapter.chapter_no} 章 · ${escapeHtml(chapter.title)}</strong><small>${escapeHtml(chapter.status)} · v${chapter.version} · ${chapter.char_count} 字符</small>`;
    item.addEventListener("click", async () => {
      document.querySelectorAll(".chapter-item").forEach((node) => node.classList.remove("selected"));
      item.classList.add("selected");
      await selectChapter(chapter.chapter_no);
    });
    list.appendChild(item);
  }
  if (!state.chapters.length) list.textContent = "当前筛选条件下没有章节。";
}

async function selectChapter(chapterNo) {
  const response = await send({ type: "getChapter", bookId: $("bookSelect").value, chapterNo });
  if (!response.ok) return setStatus("章节读取失败", response.error, "danger");
  state.selected = response.result;
  renderPreview(state.selected);
}

function renderPreview(chapter) {
  if (!chapter) {
    $("previewTitle").textContent = "未选择章节";
    $("previewStatus").textContent = "—";
    $("previewMeta").textContent = "从章节队列选择一章。";
    $("previewBody").textContent = "";
    $("fillChapter").disabled = true;
    $("reconcileChapter").disabled = true;
    return;
  }
  $("previewTitle").textContent = `第 ${chapter.chapter_no} 章 · ${chapter.title}`;
  $("previewStatus").textContent = chapter.status;
  $("previewMeta").textContent = `版本 ${chapter.version} · ${chapter.char_count} 字符 · ${chapter.text_sha256.slice(0, 12)}…`;
  $("previewBody").textContent = chapter.body;
  $("fillChapter").disabled = !["ready", "synced", "fill_started", "filled"].includes(chapter.status);
  $("reconcileChapter").disabled = chapter.status !== "legacy_draft";
}

async function reconcileSelected() {
  if (!state.selected) return;
  const button = $("reconcileChapter");
  button.disabled = true;
  setStatus("正在对账第四章草稿…", "只读取并比较，不会覆盖番茄内容。", "neutral");
  const response = await send({
    type: "reconcileChapter",
    bookId: state.selected.book_id,
    chapterNo: state.selected.chapter_no
  });
  if (!response.ok) {
    button.disabled = false;
    return setStatus("草稿对账失败", response.error, "danger");
  }
  if (response.result.matched) {
    setStatus("草稿内容一致", "第四章已确认是服务器当前版本。", "ok");
    await loadChapters();
  } else {
    setStatus("发现草稿版本差异", "已停止且未覆盖。下面同时显示服务器版本与番茄草稿。", "warn");
    $("previewBody").textContent = `=== 服务器版本 ===\n${response.result.expectedBody}\n\n=== 番茄草稿 ===\n${response.result.observedBody}`;
  }
}

async function fillSelected() {
  if (!state.selected) return;
  const button = $("fillChapter");
  button.disabled = true;
  setStatus("正在填充当前章节…", "页面或内容不符合预期时会立即停止。", "neutral");
  setActionResult("正在检查当前番茄编辑页，请稍候…", "neutral");
  const response = await send({
    type: "fillChapter",
    bookId: state.selected.book_id,
    chapterNo: state.selected.chapter_no
  });
  if (!response.ok) {
    button.disabled = false;
    setActionResult(`填充失败：${response.error}`, "danger");
    return setStatus("填充已停止", response.error, "danger");
  }
  setActionResult(`填充成功：第 ${state.selected.chapter_no} 章已写入并通过页面校验。请人工检查后保存或发布。`, "ok");
  setStatus("填充并校验成功", `已填入第 ${state.selected.chapter_no} 章，共 ${response.result.observedCharCount} 个可见字符。请在番茄页面人工检查后保存或发布。`, "ok");
  await loadChapters();
}

function setActionResult(message, kind) {
  const element = $("actionResult");
  element.textContent = message;
  element.className = `action-result ${kind || "neutral"}`;
  element.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function setConnection(ok) {
  const badge = $("connectionBadge");
  badge.textContent = ok ? "已连接" : "未连接";
  badge.className = `badge ${ok ? "ok" : "danger"}`;
}

function setStatus(title, detail, kind) {
  $("statusTitle").textContent = title;
  $("statusDetail").textContent = detail;
  const panel = document.querySelector(".status-panel");
  panel.className = `panel status-panel ${kind === "danger" ? "error" : kind === "ok" ? "success" : ""}`;
}

function send(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: false, error: "扩展后台没有响应。" });
      }
    });
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
