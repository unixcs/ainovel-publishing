"use strict";

const state = { books: [], chapters: [], selected: null, plans: [], currentPlan: null, publication: null, localSettings: null };
const $ = (id) => document.getElementById(id);

 document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  const response = await send({ type: "getSettings" });
  if (response.ok) {
    state.localSettings = response.result;
    $("baseUrl").value = response.result.baseUrl || "http://127.0.0.1:8787";
    $("apiToken").value = response.result.apiToken || "";
    $("publicationSlot").value = response.result.selectedSlot || "20:00";
    $("aiPolicy").value = response.result.aiPolicy || "remember";
    $("automationEnabled").checked = Boolean(response.result.automationEnabled);
  }
  $("planStartDate").value = localDateString();
  await connectAndLoad();
});

function bindEvents() {
  $("saveSettings").addEventListener("click", saveSettings);
  $("syncNow").addEventListener("click", syncNow);
  $("refreshList").addEventListener("click", loadChapters);
  $("bookSelect").addEventListener("change", async () => { await loadChapters(); await loadPlans(); });
  $("statusFilter").addEventListener("change", loadChapters);
  $("fillChapter").addEventListener("click", fillSelected);
  $("autoPublishChapter").addEventListener("click", autoPublishSelected);
  $("reconcileChapter").addEventListener("click", reconcileSelected);
  $("inspectPlatform").addEventListener("click", inspectPlatform);
  $("createPlan").addEventListener("click", createPlan);
  $("approvePlan").addEventListener("click", approvePlan);
  $("runNext").addEventListener("click", runNext);
  $("resumeBlocked").addEventListener("click", resumeBlockedSelected);
}

async function saveSettings() {
  setStatus("正在保存设置…", "正在测试本地助手连接。", "neutral");
  const response = await send({
    type: "saveSettings",
    settings: {
      baseUrl: $("baseUrl").value,
      apiToken: $("apiToken").value,
      selectedSlot: $("publicationSlot").value,
      aiPolicy: $("aiPolicy").value,
      automationEnabled: $("automationEnabled").checked
    }
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
  const publication = await send({ type: "getPublicationSettings" });
  if (publication.ok) {
    state.publication = publication.result;
    const configuredLimit = Number(publication.result.daily_limit || 9999);
    $("dailyLimit").max = String(configuredLimit);
    if (Number($("dailyLimit").value || 0) > configuredLimit || Number($("dailyLimit").value || 0) < 1) {
      $("dailyLimit").value = String(configuredLimit);
    }
    const allowedSlots = publication.result.slots || ["12:00", "20:00", "22:00"];
    if (!allowedSlots.includes($("publicationSlot").value)) {
      $("publicationSlot").value = publication.result.default_slot || "20:00";
    }
  }
  const books = await send({ type: "getBooks" });
  if (!books.ok) return setStatus("认证失败", books.error, "danger");
  state.books = books.result.books || [];
  renderBooks();
  await loadChapters();
  await loadPlans();
  setStatus("本地助手已连接", `版本 ${health.result.version} · 时区 Asia/Shanghai`, "ok");
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
  if (!bookId) { state.chapters = []; renderChapters(); renderPreview(null); return; }
  const response = await send({ type: "getChapters", bookId, status: $("statusFilter").value, limit: 1000 });
  if (!response.ok) return setStatus("队列读取失败", response.error, "danger");
  state.chapters = response.result.chapters || [];
  state.selected = null;
  renderChapters();
  renderPreview(null);
}

async function loadPlans() {
  const bookId = $("bookSelect").value;
  if (!bookId) { state.plans = []; state.currentPlan = null; renderPlan(); return; }
  const response = await send({ type: "getPlans", bookId });
  if (!response.ok) return setStatus("计划读取失败", response.error, "danger");
  state.plans = response.result.plans || [];
  state.currentPlan = state.plans[0] || null;
  renderPlan();
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
    $("autoPublishChapter").disabled = true;
    $("reconcileChapter").disabled = true;
    $("resumeBlocked").disabled = true;
    return;
  }
  $("previewTitle").textContent = `第 ${chapter.chapter_no} 章 · ${chapter.title}`;
  $("previewStatus").textContent = chapter.status;
  $("previewMeta").textContent = `版本 ${chapter.version} · ${chapter.char_count} 字符 · 平台 ${chapter.platform_state || "未登记"} · ${chapter.text_sha256.slice(0, 12)}…`;
  $("previewBody").textContent = chapter.body;
  $("fillChapter").disabled = !["ready", "synced", "planned", "fill_started", "filled"].includes(chapter.status);
  $("reconcileChapter").textContent = ["scheduled_unverified", "published_unverified"].includes(chapter.platform_state)
    ? "核对当前番茄章节正文"
    : "对账当前番茄草稿";
  $("reconcileChapter").disabled = !(
    chapter.status === "legacy_draft" ||
    ["scheduled_unverified", "published_unverified", "draft_unverified"].includes(chapter.platform_state)
  );
  const item = currentPlanItem(chapter.chapter_no);
  const waitingForAi = item?.status === "awaiting_ai_choice";
  $("autoPublishChapter").textContent = waitingForAi
    ? "我已手动选择 AI，继续发布"
    : "按当前计划自动定时发布";
  $("autoPublishChapter").disabled = !(
    state.currentPlan?.status === "approved" && ["planned", "awaiting_ai_choice"].includes(item?.status)
  );
  $("resumeBlocked").disabled = !(
    chapter.status === "blocked" &&
    state.currentPlan?.status === "approved" &&
    item?.status === "blocked" &&
    ["login_required", "work_identity_mismatch", "unknown_page_state"].includes(item?.reason)
  );
}

function renderPlan() {
  const plan = state.currentPlan;
  const list = $("planList");
  if (!plan) {
    $("planBadge").textContent = "未生成";
    $("planBadge").className = "badge neutral";
    list.textContent = "尚未生成发布计划。";
    $("approvePlan").disabled = true;
    $("runNext").disabled = true;
    return;
  }
  $("planBadge").textContent = plan.status;
  $("planBadge").className = `badge ${plan.status === "approved" ? "ok" : plan.status === "draft" ? "warn" : "danger"}`;
  const blocked = (plan.items || []).filter((item) => item.status === "blocked");
  list.innerHTML = `<div class="plan-meta">计划 ${escapeHtml(plan.plan_id.slice(0, 12))}… · 上限 ${plan.daily_limit} · 默认 ${plan.default_slot} · AI ${escapeHtml(plan.ai_policy)}</div>`;
  for (const item of plan.items || []) {
    const row = document.createElement("div");
    row.className = `plan-item ${item.status === "blocked" ? "blocked" : ""}`;
    row.textContent = `第 ${item.chapter_no} 章 · ${item.quota_units} 字 · ${item.publication_date || "—"} ${item.publication_time || ""} · ${item.status}${item.reason ? `（${item.reason}）` : ""}`;
    list.appendChild(row);
  }
  $("approvePlan").disabled = plan.status !== "draft" || blocked.length > 0;
  $("runNext").disabled = plan.status !== "approved" || !(plan.items || []).some((item) => item.status === "planned");
  renderPreview(state.selected);
}

async function inspectPlatform() {
  const bookId = $("bookSelect").value;
  if (!bookId) return setStatus("没有选择作品", "请先选择作品。", "warn");
  const all = await send({ type: "getChapters", bookId, status: "", limit: 1000 });
  if (!all.ok) return setStatus("章节读取失败", all.error, "danger");
  const chapterNos = (all.result.chapters || []).map((item) => item.chapter_no);
  setStatus("正在读取番茄平台状态…", "请先确保当前页面是作品章节管理/发布列表。", "neutral");
  const response = await send({ type: "inspectPlatform", bookId, chapterNos });
  if (!response.ok) return setStatus("平台对账停止", response.error, "danger");
  const found = (response.result.snapshot.rows || []).filter((row) => row.scheduled || row.published).length;
  setStatus(
    "平台记录读取完成",
    `识别 ${found} 个已有定时/已发布章节；未核对正文的章节只占用额度，不会被当成同一版本。`,
    "ok"
  );
  await connectAndLoad();
}

async function createPlan() {
  const bookId = $("bookSelect").value;
  if (!bookId) return setStatus("没有选择作品", "请先选择作品。", "warn");
  setStatus("正在生成发布计划…", "会先扣除已经在番茄确认过的定时任务。", "neutral");
  const response = await send({
    type: "createPlan",
    bookId,
    settings: {
      slot: $("publicationSlot").value,
      daily_limit: Number($("dailyLimit").value || 9999),
      ai_policy: $("aiPolicy").value,
      start_date: $("planStartDate").value || localDateString()
    }
  });
  if (!response.ok) return setStatus("生成计划失败", response.error, "danger");
  state.currentPlan = response.result;
  state.plans = [response.result, ...state.plans.filter((plan) => plan.plan_id !== response.result.plan_id)];
  renderPlan();
  setStatus("计划已生成", "请检查日期、字数和 AI 策略；确认无阻塞项后再批准。", "ok");
}

async function approvePlan() {
  if (!state.currentPlan) return;
  const response = await send({ type: "approvePlan", planId: state.currentPlan.plan_id });
  if (!response.ok) return setStatus("计划批准失败", response.error, "danger");
  state.currentPlan = response.result;
  renderPlan();
  setStatus("计划已批准", "可以执行计划下一章，或打开自动执行开关等待本地 Edge 运行。", "ok");
}

async function runNext() {
  if (!state.currentPlan) return;
  const item = (state.currentPlan.items || []).find((entry) => entry.status === "planned");
  if (!item) return setStatus("没有可执行章节", "当前计划没有 planned 项。", "warn");
  await runAutomation(item);
}

async function autoPublishSelected() {
  if (!state.selected) return;
  const item = currentPlanItem(state.selected.chapter_no);
  if (!item) return setActionResult("当前章节不在当前发布计划中。", "warn");
  await runAutomation(item);
}

async function resumeBlockedSelected() {
  if (!state.selected || !state.currentPlan) return;
  const item = currentPlanItem(state.selected.chapter_no);
  if (state.selected.status !== "blocked" || item?.status !== "blocked") {
    return setActionResult("当前章节不是可解除的运行时阻塞项。", "warn");
  }

  setStatus("正在核对平台…", "请保持番茄章节管理/章节列表页面处于打开状态。", "neutral");
  const checked = await send({
    type: "inspectPlatform",
    bookId: state.selected.book_id,
    chapterNos: [state.selected.chapter_no]
  });
  if (!checked.ok) return setStatus("无法解除阻塞", checked.error, "danger");

  const platformRow = (checked.result.snapshot.rows || []).find((row) => Number(row.chapterNo) === Number(state.selected.chapter_no));
  if (platformRow?.found) {
    await connectAndLoad();
    return setStatus(
      "平台仍有该章记录，未解除阻塞",
      "请先打开该章核对正文和定时状态；系统不会冒险重复创建。",
      "warn"
    );
  }

  const confirmed = window.confirm(
    `请确认：你已在番茄章节管理页核对，第 ${state.selected.chapter_no} 章没有草稿、定时或已发布记录。\n\n确认后才允许重新执行。`
  );
  if (!confirmed) return setStatus("保持阻塞", "没有进行任何重试。", "warn");

  const resumed = await send({
    type: "resumePlanItem",
    planId: state.currentPlan.plan_id,
    chapterNo: state.selected.chapter_no,
    textSha256: state.selected.text_sha256
  });
  if (!resumed.ok) return setStatus("解除阻塞失败", resumed.error, "danger");
  state.currentPlan = resumed.result;
  setActionResult(`第 ${state.selected.chapter_no} 章已恢复为 planned，可再次执行。`, "ok");
  setStatus("已解除阻塞", "仅恢复执行资格，没有修改番茄页面。", "ok");
  await connectAndLoad();
}

async function runAutomation(item) {
  if (!state.currentPlan || state.currentPlan.status !== "approved") return setActionResult("请先批准发布计划。", "warn");
  setStatus(`正在自动处理第 ${item.chapter_no} 章…`, `计划 ${item.publication_date} ${item.publication_time}，Edge 将执行并回读平台状态。`, "neutral");
  setActionResult("正在检查登录、作品、编辑器和发布设置，请不要手动点击页面。", "neutral");
  const continuingAiChoice = item.status === "awaiting_ai_choice";
  const response = await send({
    type: continuingAiChoice ? "continueManualAi" : "automateChapter",
    bookId: $("bookSelect").value,
    chapterNo: item.chapter_no,
    planId: state.currentPlan.plan_id
  });
  if (!response.ok) {
    setActionResult(`自动发布已停止：${response.error}`, "danger");
    return setStatus("自动发布已阻塞", response.error, "danger");
  }
  if (response.result?.paused) {
    $("statusFilter").value = "awaiting_ai_choice";
    await connectAndLoad();
    setActionResult("发布流程已停在 AI 声明处：请在番茄页面手动选择，然后回到插件继续。", "warn");
    setStatus("等待你选择 AI", "没有执行最终提交；选择完成后点击“我已手动选择 AI，继续发布”。", "warn");
    return;
  }
  setActionResult(`第 ${item.chapter_no} 章已完成平台定时状态验证。`, "ok");
  setStatus("自动发布成功", `${item.publication_date} ${item.publication_time} 的定时任务已登记。`, "ok");
  await connectAndLoad();
}

async function reconcileSelected() {
  if (!state.selected) return;
  const button = $("reconcileChapter");
  button.disabled = true;
  setStatus("正在核对当前番茄章节…", "只读取并比较章节号、标题和正文，不会覆盖番茄内容。", "neutral");
  const response = await send({ type: "reconcileChapter", bookId: state.selected.book_id, chapterNo: state.selected.chapter_no });
  if (!response.ok) { button.disabled = false; return setStatus("草稿对账失败", response.error, "danger"); }
  if (response.result.matched) {
    setStatus("草稿内容一致", "已确认服务器当前版本。", "ok");
    await loadChapters();
  } else {
    setStatus("发现草稿版本差异", "已停止且未覆盖。", "warn");
    $("previewBody").textContent = `=== 服务器版本 ===\n${response.result.expectedBody}\n\n=== 番茄草稿 ===\n${response.result.observedBody}`;
  }
}

async function fillSelected() {
  if (!state.selected) return;
  const button = $("fillChapter"); button.disabled = true;
  setStatus("正在填充当前章节…", "页面或内容不符合预期时会立即停止。", "neutral");
  setActionResult("正在检查当前番茄编辑页，请稍候…", "neutral");
  const response = await send({ type: "fillChapter", bookId: state.selected.book_id, chapterNo: state.selected.chapter_no });
  if (!response.ok) { button.disabled = false; setActionResult(`填充失败：${response.error}`, "danger"); return setStatus("填充已停止", response.error, "danger"); }
  setActionResult(`填充成功：第 ${state.selected.chapter_no} 章已写入并通过页面校验。`, "ok");
  setStatus("填充并校验成功", `已填入 ${response.result.observedCharCount} 个可见字符；可继续批准计划或人工处理。`, "ok");
  await loadChapters();
}

function currentPlanItem(chapterNo) { return state.currentPlan?.items?.find((item) => Number(item.chapter_no) === Number(chapterNo)); }
function localDateString() { const date = new Date(); const offset = date.getTimezoneOffset(); return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10); }
function setActionResult(message, kind) { const element = $("actionResult"); element.textContent = message; element.className = `action-result ${kind || "neutral"}`; element.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
function setConnection(ok) { const badge = $("connectionBadge"); badge.textContent = ok ? "已连接" : "未连接"; badge.className = `badge ${ok ? "ok" : "danger"}`; }
function setStatus(title, detail, kind) { $("statusTitle").textContent = title; $("statusDetail").textContent = detail; const panel = document.querySelector(".status-panel"); panel.className = `panel status-panel ${kind === "danger" ? "error" : kind === "ok" ? "success" : ""}`; }
function send(payload) { return new Promise((resolve) => { chrome.runtime.sendMessage(payload, (response) => { if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message }); else resolve(response || { ok: false, error: "扩展后台没有响应。" }); }); }); }
function escapeHtml(value) { return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
