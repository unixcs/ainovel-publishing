"use strict";

const state = {
  books: [], chapters: [], selected: null, plans: [], currentPlan: null,
  publication: null, localSettings: null, platformSnapshot: null, localChapterCount: 0
};
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
  $("inspectPlatform").addEventListener("click", inspectPlatform);
  $("smartRunNext").addEventListener("click", smartRunNext);
  $("smartChapterAction").addEventListener("click", smartProcessSelected);
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
  if (!books.ok) {
    if (String(books.error || "").includes("stale_extension_version")) {
      return setStatus("插件版本未生效", "请到 edge://extensions 对本插件点一次“重新加载”，旧后台已被安全阻止。", "danger");
    }
    return setStatus("认证失败", books.error, "danger");
  }
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
  state.currentPlan = state.plans.find((plan) => ["draft", "approved"].includes(plan.status)) || null;
  renderPlan();
}

function renderChapters() {
  const list = $("chapterList");
  list.innerHTML = "";
  $("queueCount").textContent = String(state.chapters.length);
  for (const chapter of state.chapters) {
    const item = document.createElement("div");
    item.className = "chapter-item";
    item.innerHTML = `<strong>第 ${chapter.chapter_no} 章 · ${escapeHtml(chapter.title)}</strong><small>${escapeHtml(chapterStatusLabel(chapter))} · ${chapter.char_count} 字</small>`;
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
    $("previewStatus").className = "badge neutral";
    $("previewMeta").textContent = "从章节队列选择一章。";
    $("previewBody").textContent = "";
    $("smartChapterAction").disabled = true;
    $("smartChapterAction").textContent = "处理本章";
    return;
  }
  $("previewTitle").textContent = `第 ${chapter.chapter_no} 章 · ${chapter.title}`;
  $("previewStatus").textContent = chapterStatusLabel(chapter);
  $("previewStatus").className = `badge ${chapterStatusKind(chapter)}`;
  $("previewMeta").textContent = `第 ${chapter.chapter_no} 章 · ${chapter.char_count} 字 · ${platformStateLabel(chapter.platform_state)}`;
  $("previewBody").textContent = chapter.body;
  const primary = primaryActionForChapter(chapter);
  $("smartChapterAction").textContent = primary.label;
  $("smartChapterAction").disabled = primary.disabled;

}

function renderPlan() {
  const plan = state.currentPlan;
  const list = $("planList");
  if (!plan) {
    $("planBadge").textContent = "尚未排程";
    $("planBadge").className = "badge neutral";
    list.textContent = "尚未生成发布排程。";
    return;
  }
  const hasBlockedItem = (plan.items || []).some((item) => item.status === "blocked");
  $("planBadge").textContent = hasBlockedItem ? "待自动处理" : planStatusLabel(plan.status);
  $("planBadge").className = `badge ${hasBlockedItem ? "warn" : plan.status === "approved" ? "ok" : plan.status === "draft" ? "warn" : "danger"}`;
  list.innerHTML = `<div class="plan-meta">每日上限 ${plan.daily_limit} 字 · 默认 ${plan.default_slot} · ${aiPolicyLabel(plan.ai_policy)}</div>`;
  for (const item of plan.items || []) {
    const row = document.createElement("div");
    const kind = item.status === "blocked" ? "blocked" : item.status === "reserved" ? "reserved" : ["adopted", "scheduled", "published"].includes(item.status) ? "done" : "";
    row.className = `plan-item ${kind}`.trim();
    const when = item.publication_date ? `${item.publication_date} ${item.publication_time || ""}`.trim() : "日期待定";
    row.textContent = `第 ${item.chapter_no} 章 · ${item.quota_units} 字 · ${when} · ${planItemLabel(item)}`;
    if (item.reason) row.title = item.reason;
    list.appendChild(row);
  }
  renderPreview(state.selected);
}

async function inspectPlatform() {
  const bookId = $("bookSelect").value;
  if (!bookId) { setStatus("没有选择作品", "请先选择作品。", "warn"); return null; }
  const button = $("inspectPlatform");
  button.disabled = true;
  const all = await send({ type: "getChapters", bookId, status: "", limit: 1000 });
  if (!all.ok) {
    button.disabled = false;
    setStatus("章节读取失败", all.error, "danger");
    return null;
  }
  const chapterNos = (all.result.chapters || []).map((item) => item.chapter_no);
  state.localChapterCount = chapterNos.length;
  setStatus("正在打开目标作品…", "插件会进入标准章节管理页并读取列表，不会修改或发布章节。", "neutral");
  const response = await send({ type: "inspectPlatform", bookId, chapterNos });
  button.disabled = false;
  if (!response.ok) {
    const message = friendlyError(response.error);
    setStatus("番茄状态刷新失败", message, "warn");
    setActionResult(message, "warn");
    return null;
  }
  state.platformSnapshot = response.result.snapshot;
  renderPlatformSummary();
  const foundRows = (state.platformSnapshot.rows || []).filter((row) => row.found);
  setStatus(
    "番茄状态已刷新",
    `番茄平台已有 ${foundRows.length} 章；本地账本共有 ${state.localChapterCount} 章。这里只显示平台记录，不是本地小说总章数。`,
    "ok"
  );
  await loadChapters();
  await loadPlans();
  return response.result;
}

function renderPlatformSummary() {
  const element = $("platformSummary");
  const rows = (state.platformSnapshot?.rows || []).filter((row) => row.found);
  if (!rows.length) {
    element.textContent = `番茄平台当前没有识别到章节记录。本地账本共有 ${state.localChapterCount || "—"} 章。`;
    element.className = "platform-summary warn";
    return;
  }
  const relevant = rows
    .filter((row) => row.scheduled || row.published || row.reviewing || row.draft)
    .sort((a, b) => Number(a.chapterNo) - Number(b.chapterNo));
  const shown = relevant.slice(-8);
  const rowsText = shown.map((row) => {
    const when = row.publicationDate ? ` · ${row.publicationDate}${row.publicationTime ? ` ${row.publicationTime}` : ""}` : "";
    return `第 ${row.chapterNo} 章 · ${platformRowLabel(row)}${when}`;
  }).join("\n") || `识别到 ${rows.length} 个章节记录。`;
  element.textContent = `番茄平台已有 ${rows.length} 章（不是本地总章数）· 本地 ${state.localChapterCount || "—"} 章\n${rowsText}`;
  element.className = "platform-summary ok";
}

async function requestPlan({ announce = true } = {}) {
  const bookId = $("bookSelect").value;
  if (!bookId) {
    setStatus("没有选择作品", "请先选择作品。", "warn");
    return null;
  }
  if (announce) setStatus("正在更新发布排程…", "平台已有章节会直接跳过，不会重复创建。", "neutral");
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
  if (!response.ok) {
    setStatus("无法生成排程", friendlyError(response.error), "danger");
    return null;
  }
  state.currentPlan = response.result;
  state.plans = [response.result, ...state.plans.filter((plan) => plan.plan_id !== response.result.plan_id)];
  renderPlan();
  if (announce) {
    const blockers = (response.result.items || []).filter((item) => item.status === "blocked");
    setStatus(
      blockers.length ? "排程需要处理" : "排程已更新",
      blockers.length ? blockerInstruction(blockers[0]) : "已有平台记录已自动跳过，可以直接处理下一章。",
      blockers.length ? "warn" : "ok"
    );
  }
  return response.result;
}

async function smartRunNext() {
  const button = $("smartRunNext");
  button.disabled = true;
  // 主流程只保留一个入口：先自动打开并刷新已绑定作品，再处理下一章。
  // 用户无需自己切换到“我的小说”或章节管理页。
  const refreshed = await inspectPlatform();
  if (!refreshed) { button.disabled = false; return; }
  await prepareAndRun(null);
  button.disabled = false;
}

async function smartProcessSelected() {
  if (!state.selected) return;
  const chapter = state.selected;
  if (chapter.status === "blocked") {
    if (chapter.recovery?.allowed) {
      await recoverBlockedChapter(chapter.chapter_no, { rerun: true });
    } else {
      const checked = await inspectPlatform();
      if (checked) {
        setActionResult("这次可能已经点过最终提交，系统只核对结果，不会重复新建。请按番茄平台显示处理。", "warn");
      }
    }
    return;
  }
  if (chapter.status === "awaiting_ai_choice") {
    const item = currentPlanItem(chapter.chapter_no);
    if (state.currentPlan?.status === "approved" && item?.status === "awaiting_ai_choice") {
      await runAutomation(item);
    } else {
      setActionResult("原来的发布设置页或排程已经失效，已停止；请先核对番茄结果。", "warn");
    }
    return;
  }
  const needsReconciliation = chapter.status === "legacy_draft" || ["scheduled_unverified", "published_unverified", "draft_unverified", "saved_draft"].includes(chapter.platform_state);
  if (needsReconciliation) {
    // 安全态（我们自己未提交的草稿）直接自动补传；平台已发布/定时态保留人工核对。
    if (isSafeSupplement(chapter)) {
      await supplementSelected();
    } else {
      await reconcileSelected();
    }
    return;
  }
  if (["scheduled", "published", "verified", "legacy_published"].includes(chapter.status) || ["scheduled", "published"].includes(chapter.platform_state)) {
    setActionResult(`第 ${chapter.chapter_no} 章在番茄已有记录，无需重复处理。`, "ok");
    return;
  }
  // Always establish one fresh platform preflight before creating a chapter. Refresh
  // lands on the bound work's canonical chapter-management URL and the following action
  // reuses that result instead of repeating login/navigation checks.
  const refreshed = await inspectPlatform();
  if (!refreshed) return;
  await prepareAndRun(chapter.chapter_no);
}

async function prepareAndRun(chapterNo) {
  const primaryButton = chapterNo ? $("smartChapterAction") : $("smartRunNext");
  primaryButton.disabled = true;
  setActionResult("正在计算额度和发布日期…", "neutral");
  const plan = await requestPlan({ announce: false });
  if (!plan) { primaryButton.disabled = false; return; }
  const blocker = (plan.items || []).find((item) => item.status === "blocked");
  if (blocker) {
    const detail = await send({ type: "getChapter", bookId: $("bookSelect").value, chapterNo: blocker.chapter_no });
    if (detail.ok && detail.result?.recovery?.allowed) {
      await recoverBlockedChapter(blocker.chapter_no, {
        rerun: true,
        targetChapterNo: chapterNo,
        platformSnapshot: state.platformSnapshot
      });
      return;
    }
    // 安全态的平台未核对记录：直接自动补传，不再卡在人工确认。
    if (detail.ok && isSafeSupplement(detail.result)) {
      const approved = await send({ type: "approvePlan", planId: plan.plan_id });
      if (!approved.ok) {
        setActionResult(friendlyError(approved.error), "danger");
        primaryButton.disabled = false;
        return;
      }
      state.currentPlan = approved.result;
      await runSupplement(blocker.chapter_no, plan.plan_id);
      primaryButton.disabled = false;
      return;
    }
    const instruction = blockerInstruction(blocker);
    setActionResult(instruction, "warn");
    setStatus("先处理一个问题", instruction, "warn");
    primaryButton.disabled = false;
    return;
  }
  const item = chapterNo
    ? (plan.items || []).find((entry) => Number(entry.chapter_no) === Number(chapterNo))
    : (plan.items || []).find((entry) => entry.status === "planned");
  if (!item) {
    const message = chapterNo ? `第 ${chapterNo} 章已在番茄存在或已经处理。` : "没有需要新建或继续发布的章节。";
    setActionResult(message, "ok");
    setStatus("无需重复处理", message, "ok");
    primaryButton.disabled = false;
    return;
  }
  if (["reserved", "adopted", "scheduled", "published"].includes(item.status)) {
    const message = `第 ${item.chapter_no} 章在番茄已有记录，插件已跳过。`;
    setActionResult(message, "ok");
    setStatus("无需重复处理", message, "ok");
    primaryButton.disabled = false;
    return;
  }
  const approved = await send({ type: "approvePlan", planId: plan.plan_id });
  if (!approved.ok) {
    const message = friendlyError(approved.error);
    setActionResult(message, "danger");
    setStatus("排程无法执行", message, "danger");
    primaryButton.disabled = false;
    return;
  }
  state.currentPlan = approved.result;
  renderPlan();
  const approvedItem = currentPlanItem(item.chapter_no);
  await runAutomation(approvedItem);
  primaryButton.disabled = false;
}

async function recoverBlockedChapter(chapterNo, {
  rerun = false,
  targetChapterNo = chapterNo,
  platformSnapshot = null
} = {}) {
  const bookId = $("bookSelect").value;
  const detail = await send({ type: "getChapter", bookId, chapterNo });
  if (!detail.ok) return setStatus("章节读取失败", detail.error, "danger");
  const chapter = detail.result;
  if (chapter.status !== "blocked" || !chapter.recovery?.allowed) {
    const message = chapter.recovery?.reason === "final_submission_requires_reconciliation"
      ? "这次可能已经执行最终提交，只能核对番茄结果，不能重新新建。"
      : "当前章节没有可安全恢复的提交前任务。";
    setActionResult(message, "warn");
    return setStatus("不能直接重试", message, "warn");
  }

  let snapshot = platformSnapshot;
  if (!snapshot) {
    setStatus("正在确认番茄没有这一章…", "正在自动打开目标作品的章节管理页，只读取列表。", "neutral");
    const checked = await send({ type: "inspectPlatform", bookId, chapterNos: [chapterNo] });
    if (!checked.ok) return setStatus("无法确认平台状态", friendlyError(checked.error), "warn");
    snapshot = checked.result.snapshot;
  }
  const row = (snapshot.rows || []).find((entry) => Number(entry.chapterNo) === Number(chapterNo));
  if (row?.found) {
    await connectAndLoad();
    setActionResult(`番茄已经存在第 ${chapterNo} 章，插件不会重复创建。`, "warn");
    return setStatus("平台已有该章", "请打开这一章核对正文或定时状态。", "warn");
  }

  // A click on the primary action plus the fresh snapshot is already an explicit
  // user-authorized retry. Do not ask the same question a second time. Advanced/manual
  // recovery still keeps the confirmation dialog when it did not inherit that snapshot.
  const explicitlyAuthorized = Boolean(rerun && platformSnapshot);
  const confirmed = explicitlyAuthorized || window.confirm(
    `番茄章节管理列表中没有第 ${chapterNo} 章，而且这次没有执行最终提交。\n\n点击“确定”后，插件会清除这次未完成记录并重新处理本章。`
  );
  if (!confirmed) return setStatus("没有重试", "未修改本地账本和番茄页面。", "warn");
  const recovered = await send({
    type: "recoverUnsubmittedChapter",
    bookId,
    chapterNo,
    textSha256: chapter.text_sha256,
    evidenceUrl: snapshot.url || null
  });
  if (!recovered.ok) {
    const message = friendlyError(recovered.error);
    setActionResult(message, "danger");
    return setStatus("恢复失败", message, "danger");
  }

  setActionResult(`第 ${chapterNo} 章上次没有最终提交，已安全恢复。`, "ok");
  setStatus("已恢复本章", rerun ? "正在重新计算日期并继续处理。" : "可使用主按钮重新处理。", "ok");
  await connectAndLoad();
  if (rerun) await prepareAndRun(targetChapterNo);
  return recovered.result;
}

async function runAutomation(item) {
  if (!state.currentPlan || state.currentPlan.status !== "approved") return setActionResult("请先批准发布计划。", "warn");
  setStatus(`正在自动处理第 ${item.chapter_no} 章…`, `计划 ${item.publication_date} ${item.publication_time}，Edge 将执行并回读平台状态。`, "neutral");
  setActionResult(`正在处理第 ${item.chapter_no} 章：已完成作品预检，正在打开编辑页、填充并点击“下一步”。`, "neutral");
  const continuingAiChoice = item.status === "awaiting_ai_choice";
  const response = await send({
    type: continuingAiChoice ? "continueManualAi" : "automateChapter",
    bookId: $("bookSelect").value,
    chapterNo: item.chapter_no,
    planId: state.currentPlan.plan_id
  });
  if (!response.ok) {
    const originalError = response.error;
    await connectAndLoad();
    setActionResult(`自动发布已停止：${originalError}`, "danger");
    return setStatus("自动发布已停止", "状态已经重新读取；若页面没有被操作，可直接重试主按钮。", "danger");
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
  setStatus("正在核对当前番茄章节…", "只读取并比较章节号、标题和正文，不会覆盖番茄内容。", "neutral");
  const response = await send({ type: "reconcileChapter", bookId: state.selected.book_id, chapterNo: state.selected.chapter_no });
  if (!response.ok) {
    setActionResult(`核对失败：${response.error}`, "danger");
    return setStatus("草稿对账失败", response.error, "danger");
  }
  if (response.result.matched) {
    setStatus("草稿内容一致", "已确认服务器当前版本。", "ok");
    await loadChapters();
  } else {
    setStatus("发现草稿版本差异", "已停止且未覆盖。", "warn");
    $("previewBody").textContent = `=== 服务器版本 ===\n${response.result.expectedBody}\n\n=== 番茄草稿 ===\n${response.result.observedBody}`;
  }
}

// 安全态：平台已有但我们自己未提交的草稿（draft_unverified / saved_draft / legacy_draft）。
// 这类可自动补传；已发布/定时态不在此列，需人工核对，避免覆盖用户手动修改。
function isSafeSupplement(chapter) {
  return (
    chapter.platform_state === "draft_unverified" ||
    chapter.platform_state === "saved_draft" ||
    chapter.status === "legacy_draft"
  );
}

async function supplementSelected() {
  if (!state.selected) return;
  setStatus("正在自动补传当前章节…", "打开已有编辑器、填入本地内容并提交，不会新建重复章节。", "neutral");
  const plan = await requestPlan({ announce: false });
  if (!plan) return;
  const approved = await send({ type: "approvePlan", planId: plan.plan_id });
  if (!approved.ok) {
    setActionResult(friendlyError(approved.error), "danger");
    return setStatus("排程无法执行", friendlyError(approved.error), "danger");
  }
  state.currentPlan = approved.result;
  await runSupplement(state.selected.chapter_no, plan.plan_id);
}

async function runSupplement(chapterNo, planId) {
  const response = await send({
    type: "autoSupplementChapter",
    bookId: $("bookSelect").value,
    chapterNo,
    planId
  });
  if (!response.ok) {
    await connectAndLoad();
    setActionResult(`自动补传已停止：${response.error}`, "danger");
    return setStatus("自动补传已停止", "状态已重新读取；可直接重试主按钮。", "danger");
  }
  if (response.paused) {
    $("statusFilter").value = "awaiting_ai_choice";
    await connectAndLoad();
    setActionResult("发布流程已停在 AI 声明处：请在番茄页面手动选择，然后回到插件继续。", "warn");
    return setStatus("等待你选择 AI", "选择完成后点击“我已手动选择 AI，继续发布”。", "warn");
  }
  setActionResult(`第 ${chapterNo} 章已自动补传并完成平台状态验证。`, "ok");
  setStatus("自动补传成功", "该章节已由插件接管。", "ok");
  await connectAndLoad();
}

function currentPlanItem(chapterNo) { return state.currentPlan?.items?.find((item) => Number(item.chapter_no) === Number(chapterNo)); }
function localDateString() { const date = new Date(); const offset = date.getTimezoneOffset(); return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10); }
function setActionResult(message, kind) { const element = $("actionResult"); element.textContent = message; element.className = `action-result ${kind || "neutral"}`; element.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
function setConnection(ok) { const badge = $("connectionBadge"); badge.textContent = ok ? "已连接" : "未连接"; badge.className = `badge ${ok ? "ok" : "danger"}`; }
function setStatus(title, detail, kind) { $("statusTitle").textContent = title; $("statusDetail").textContent = detail; const panel = document.querySelector(".status-panel"); panel.className = `panel status-panel ${kind === "danger" ? "error" : kind === "ok" ? "success" : ""}`; }
function send(payload) { return new Promise((resolve) => { chrome.runtime.sendMessage(payload, (response) => { if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message }); else resolve(response || { ok: false, error: "扩展后台没有响应。" }); }); }); }
function escapeHtml(value) { return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

function chapterStatusLabel(chapter) {
  if (["scheduled_unverified", "published_unverified", "draft_unverified"].includes(chapter.platform_state)) return "平台已有，待核对";
  if (chapter.status === "blocked" && chapter.recovery?.allowed) return "上次未提交，待自动恢复";
  const labels = {
    ready: "待发布",
    synced: "待发布",
    planned: "已排程",
    fill_started: "编辑页处理中",
    filled: "已填入，待继续",
    legacy_draft: "旧草稿，待核对",
    legacy_published: "已发布",
    scheduled: "已定时",
    published: "已发布",
    verified: "已核对",
    awaiting_ai_choice: "等待选择 AI",
    submitted: "已提交，待确认",
    blocked: "需要人工确认",
    version_conflict: "内容冲突",
    saved_draft: "平台草稿"
  };
  return labels[chapter.status] || "待确认";
}

function chapterStatusKind(chapter) {
  if (["scheduled", "published", "verified", "legacy_published"].includes(chapter.status)) return "ok";
  if (chapter.status === "version_conflict" || chapter.status === "blocked") return "danger";
  if (["filled", "fill_started", "legacy_draft"].includes(chapter.status) || String(chapter.platform_state || "").endsWith("_unverified")) return "warn";
  return "neutral";
}

function platformStateLabel(value) {
  const labels = {
    scheduled_unverified: "番茄已有定时/审核记录，正文待核对",
    published_unverified: "番茄已有发布记录，正文待核对",
    draft_unverified: "番茄已有草稿，正文待核对",
    scheduled: "番茄已定时",
    published: "番茄已发布",
    submitted_unverified: "番茄已接收提交，结果待核对",
    submitted: "番茄已接收提交",
    saved_draft: "番茄已有草稿"
  };
  return labels[value] || "番茄尚未登记";
}

function primaryActionForChapter(chapter) {
  if (isSafeSupplement(chapter)) {
    return { label: "自动补传本章", disabled: false };
  }
  if (["scheduled_unverified", "published_unverified"].includes(chapter.platform_state)) {
    return { label: "核对当前番茄章节", disabled: false };
  }
  if (["scheduled", "published", "verified", "legacy_published"].includes(chapter.status) || ["scheduled", "published"].includes(chapter.platform_state)) {
    return { label: "本章已处理", disabled: true };
  }
  if (["filled", "fill_started"].includes(chapter.status)) return { label: "继续发布本章", disabled: false };
  if (["ready", "synced", "planned"].includes(chapter.status)) return { label: "自动发布本章", disabled: false };
  if (chapter.status === "awaiting_ai_choice") return { label: "AI 已选择，继续发布", disabled: false };
  if (chapter.status === "blocked" && chapter.recovery?.allowed) return { label: "恢复并重新处理本章", disabled: false };
  if (chapter.status === "blocked") return { label: "核对最终提交结果", disabled: false };
  return { label: "需要人工确认", disabled: true };
}

function planStatusLabel(status) {
  return { draft: "待确认", approved: "执行中", completed: "已完成", blocked: "需处理" }[status] || "待确认";
}

function aiPolicyLabel(policy) {
  return { remember: "AI 选项沿用上次", use: "声明使用 AI", no: "声明未使用 AI", ask: "每章手动选择 AI" }[policy] || "AI 选项待确认";
}

function planItemLabel(item) {
  if (item.status === "reserved") return "平台已有，自动跳过";
  if (item.status === "adopted") return "平台记录已核对";
  if (item.status === "planned" && item.reason === "resume_current_editor") return "从当前编辑页继续";
  if (item.status === "planned") return "待自动发布";
  if (item.status === "blocked") return blockerReasonLabel(item.reason);
  return {
    awaiting_ai_choice: "等待选择 AI",
    submitted: "已提交，待平台确认",
    scheduled: "已定时",
    published: "已发布"
  }[item.status] || "待确认";
}

function blockerReasonLabel(reason) {
  const exact = {
    existing_schedule_version_conflict: "平台正文与本地版本冲突",
    empty_chapter: "章节正文为空",
    chapter_exceeds_daily_limit: "单章超过每日 9999 字上限",
    resume_editor_required: "请打开已填充的编辑页",
    resume_editor_content_mismatch: "当前编辑页内容不一致"
  };
  if (exact[reason]) return exact[reason];
  if (String(reason || "").startsWith("platform_state:")) return "平台已有未核对记录";
  if (String(reason || "").startsWith("chapter_status:legacy_draft")) return "先打开并核对旧草稿";
  if (String(reason || "").startsWith("chapter_status:version_conflict")) return "先解决正文版本冲突";
  if (String(reason || "").startsWith("chapter_status:blocked")) return "先核对上次停止的结果";
  return "需要人工确认后再继续";
}

function blockerInstruction(item) {
  return `先处理第 ${item.chapter_no} 章：${blockerReasonLabel(item.reason)}。`;
}

function platformRowLabel(row) {
  if (row.published) return "已发布";
  if (row.reviewing) return "审核中";
  if (row.scheduled) return "待发布";
  if (row.draft) return "草稿";
  return "平台已有";
}

function friendlyError(error) {
  const value = String(error || "未知错误");
  const labels = {
    plan_contains_blocked_items: "排程中还有必须先处理的章节。",
    no_plannable_chapters: "当前没有需要排程的章节。",
    daily_limit_exceeds_configured_safety_cap: "每日上限不能超过 9999 字。",
    final_submission_requires_reconciliation: "这次可能已经执行最终提交，必须先核对番茄结果。",
    platform_state_requires_reconciliation: "番茄已有该章记录，不能重复新建。",
    recovery_acknowledgement_required: "需要先确认番茄章节列表里没有这一章。"
  };
  return labels[value] || value;
}
