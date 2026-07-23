"use strict";

const DEFAULT_SETTINGS = {
  baseUrl: "http://127.0.0.1:8787",
  apiToken: "",
  automationEnabled: false,
  selectedSlot: "20:00",
  aiPolicy: "remember",
  aiChoiceByBook: {},
  platformWorkIdByBook: {},
  platformPreflightByBook: {}
};
const TARGET_ROOT_HOST = "fanqienovel.com";
const BOOK_MANAGE_URL = "https://fanqienovel.com/main/writer/book-manage";
const AUTOMATION_ALARM = "ainovel-publication-runner";
const AUTOMATION_SAFETY_EPOCH = "0.3.3-stable-list-new-chapter-boundary";
const PLATFORM_PREFLIGHT_TTL_MS = 2 * 60 * 1000;
const PAGE_ADAPTER_VERSION = "0.3.3";
let automationLock = false;
const safetyReady = enforceAutomationSafetyEpoch();

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set({
    ...DEFAULT_SETTINGS,
    ...stored,
    baseUrl: stored.baseUrl || DEFAULT_SETTINGS.baseUrl,
    apiToken: stored.apiToken || "",
    automationEnabled: false,
    automationSafetyEpoch: AUTOMATION_SAFETY_EPOCH
  });
  await ensureAutomationAlarm();
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.runtime.onStartup.addListener(ensureAutomationAlarm);
chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name !== AUTOMATION_ALARM) return;
  runApprovedPlanItems().catch((error) => console.warn("scheduled automation stopped", normalizeError(error)));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: normalizeError(error), code: error.code || null }));
  return true;
});

async function handleMessage(message) {
  await safetyReady;
  switch (message && message.type) {
    case "getSettings":
      return chrome.storage.local.get(DEFAULT_SETTINGS);
    case "saveSettings":
      return saveSettings(message.settings || {});
    case "health":
      return apiRequest("/api/v1/health", { authenticated: false });
    case "getPublicationSettings":
      return apiRequest("/api/v1/settings/publication");
    case "sync":
      return apiRequest("/api/v1/sync", { method: "POST", body: { run_export: true } });
    case "getBooks":
      return apiRequest("/api/v1/books");
    case "getChapters": {
      const query = new URLSearchParams();
      if (message.status) query.set("status", message.status);
      if (message.after) query.set("after", String(message.after));
      query.set("limit", String(message.limit || 500));
      return apiRequest(`/api/v1/books/${encodeURIComponent(message.bookId)}/chapters?${query}`);
    }
    case "getChapter":
      return apiRequest(`/api/v1/books/${encodeURIComponent(message.bookId)}/chapters/${Number(message.chapterNo)}`);
    case "getPlans":
      return apiRequest(`/api/v1/books/${encodeURIComponent(message.bookId)}/publication-plans`);
    case "getPlan":
      return apiRequest(`/api/v1/publication-plans/${encodeURIComponent(message.planId)}`);
    case "createPlan":
      return apiRequest(`/api/v1/books/${encodeURIComponent(message.bookId)}/publication-plans`, {
        method: "POST",
        body: message.settings || {}
      });
    case "approvePlan":
      return apiRequest(`/api/v1/publication-plans/${encodeURIComponent(message.planId)}/approve`, { method: "POST" });
    case "resumePlanItem":
      return apiRequest(
        `/api/v1/publication-plans/${encodeURIComponent(message.planId)}/items/${Number(message.chapterNo)}/resume`,
        {
          method: "POST",
          body: {
            text_sha256: String(message.textSha256 || ""),
            acknowledgement: "platform_checked_no_submission"
          }
        }
      );
    case "recoverUnsubmittedChapter":
      return apiRequest(
        `/api/v1/books/${encodeURIComponent(message.bookId)}/chapters/${Number(message.chapterNo)}/recover-unsubmitted`,
        {
          method: "POST",
          body: {
            text_sha256: String(message.textSha256 || ""),
            acknowledgement: "platform_checked_chapter_absent",
            platform_found: false,
            evidence_url: message.evidenceUrl || null
          }
        }
      );
    case "fillChapter":
      return fillChapter(message.bookId, Number(message.chapterNo));
    case "reconcileChapter":
      return reconcileChapter(message.bookId, Number(message.chapterNo));
    case "inspectPlatform":
      return inspectPlatform(message.bookId, message.chapterNos || []);
    case "inspectActivePage": {
      const tab = await currentFanqieTab();
      return sendPageAction(tab.id, { type: "inspectPage" });
    }
    case "automateChapter":
      return automateChapter(message.bookId, Number(message.chapterNo), message.planId);
    case "continueManualAi":
      return continueManualAi(message.bookId, Number(message.chapterNo), message.planId);
    case "setAutomationEnabled":
      return setAutomationEnabled(Boolean(message.enabled));
    case "runApprovedPlanItems":
      return runApprovedPlanItems();
    default:
      throw new Error("unsupported_message");
  }
}

async function saveSettings(settings) {
  const current = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const baseUrl = String(settings.baseUrl || current.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/$/u, "");
  if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(baseUrl)) {
    throw new Error("本地接口必须是 http://127.0.0.1:端口");
  }
  const apiToken = String(settings.apiToken ?? current.apiToken ?? "").trim();
  const selectedSlot = String(settings.selectedSlot || current.selectedSlot || DEFAULT_SETTINGS.selectedSlot);
  if (!["12:00", "20:00", "22:00"].includes(selectedSlot)) throw new Error("不支持的发布时间选项。");
  const aiPolicy = String(settings.aiPolicy || current.aiPolicy || DEFAULT_SETTINGS.aiPolicy);
  if (!["remember", "use", "no", "ask"].includes(aiPolicy)) throw new Error("不支持的 AI 声明策略。");
  const automationEnabled = Boolean(settings.automationEnabled ?? current.automationEnabled);
  await chrome.storage.local.set({ baseUrl, apiToken, selectedSlot, aiPolicy, automationEnabled });
  return { baseUrl, apiTokenSaved: Boolean(apiToken), selectedSlot, aiPolicy, automationEnabled };
}

async function setAutomationEnabled(enabled) {
  await chrome.storage.local.set({ automationEnabled: Boolean(enabled) });
  return { automationEnabled: Boolean(enabled) };
}

async function enforceAutomationSafetyEpoch() {
  const stored = await chrome.storage.local.get({ automationSafetyEpoch: null });
  if (stored.automationSafetyEpoch === AUTOMATION_SAFETY_EPOCH) return;
  await chrome.storage.local.set({
    automationEnabled: false,
    automationSafetyEpoch: AUTOMATION_SAFETY_EPOCH
  });
}

async function ensureAutomationAlarm() {
  if (!chrome.alarms?.create) return;
  await chrome.alarms.create(AUTOMATION_ALARM, { periodInMinutes: 15 });
}

async function apiRequest(path, options = {}) {
  const { baseUrl, apiToken } = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (options.authenticated !== false && !apiToken) throw new Error("请先填写本地助手 API Token。");
  const headers = {
    "Content-Type": "application/json",
    "X-Ainovel-Client-Version": PAGE_ADAPTER_VERSION
  };
  if (options.authenticated !== false) headers["X-Ainovel-Token"] = apiToken;
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let payload = null;
  try { payload = await response.json(); } catch (_error) { payload = null; }
  if (!response.ok) {
    const detail = payload && payload.detail ? payload.detail : `HTTP ${response.status}`;
    const error = new Error(String(detail));
    error.code = `http_${response.status}`;
    throw error;
  }
  return payload;
}

async function fillChapter(bookId, chapterNo) {
  const chapter = await getChapter(bookId, chapterNo);
  if (!["ready", "synced", "planned", "fill_started", "filled"].includes(chapter.status)) {
    throw new Error(`章节状态 ${chapter.status} 不允许直接填充。`);
  }
  const tab = await currentFanqieTab();
  await rememberPlatformWorkId(bookId, tab.url);
  const response = await sendPageAction(tab.id, {
    type: "fillChapter",
    chapter: chapterPayload(chapter)
  });
  if (!response || !response.ok) {
    const reason = response?.error || "页面填充校验失败";
    await safePostEvent(bookId, chapterNo, "failed", chapter.text_sha256, {
      error: reason, stage: "fill_validation", code: response?.code || null,
      diagnostics: response?.diagnostics || null
    });
    throw new Error(reason);
  }
  await safePostEvent(bookId, chapterNo, "filled", chapter.text_sha256, {
    page_url: tab.url, observed_title: response.observedTitle,
    observed_chapter_no: response.observedChapterNo,
    observed_char_count: response.observedCharCount
  });
  return response;
}

async function automateChapter(bookId, chapterNo, planId) {
  if (automationLock) throw new Error("已有自动发布任务正在运行。");
  automationLock = true;
  let activeChapter = null;
  let pageMutationStarted = false;
  let finalSubmissionArmed = false;
  try {
    if (!planId) throw new Error("自动发布必须绑定已批准的发布计划。");
    const [chapter, plan] = await Promise.all([
      getChapter(bookId, chapterNo),
      apiRequest(`/api/v1/publication-plans/${encodeURIComponent(planId)}`)
    ]);
    activeChapter = chapter;
    const bookCatalog = await apiRequest("/api/v1/books");
    const expectedBook = (bookCatalog.books || []).find((entry) => entry.book_id === bookId);
    if (!expectedBook) throw new Error("本地账本中没有找到目标作品。");
    let expectedWorkId = await platformWorkIdForBook(bookId);
    if (!expectedWorkId) expectedWorkId = await resolvePlatformWorkId(bookId, expectedBook);
    if (plan.status !== "approved") throw new Error(`发布计划状态 ${plan.status} 不允许执行。`);
    const item = (plan.items || []).find((entry) => Number(entry.chapter_no) === chapterNo);
    if (!item) throw new Error("发布计划中没有目标章节。");
    if (["adopted", "reserved"].includes(item.status)) {
      return { ok: true, adopted: true, reserved: item.status === "reserved", item };
    }
    if (item.status !== "planned") throw new Error(`计划项状态 ${item.status} 不允许执行。`);
    const resumeCurrentEditor = item.reason === "resume_current_editor" || ["fill_started", "filled"].includes(chapter.status);
    const allowedChapterStates = resumeCurrentEditor
      ? ["fill_started", "filled", "planned"]
      : ["ready", "synced", "planned"];
    if (!allowedChapterStates.includes(chapter.status)) {
      throw automationFailure(
        `第 ${chapterNo} 章当前不能安全继续，请先刷新番茄状态。`,
        "chapter_state_requires_reconciliation",
        { chapterStatus: chapter.status, platformState: chapter.platform_state || null }
      );
    }
    if (chapter.platform_state) {
      throw automationFailure(
        `平台状态 ${chapter.platform_state} 尚未完成版本对账，拒绝创建重复章节。`,
        "platform_state_requires_reconciliation",
        { chapterStatus: chapter.status, platformState: chapter.platform_state }
      );
    }
    if (item.text_sha256 !== chapter.text_sha256) {
      throw automationFailure("发布计划版本与当前服务器版本不一致，已停止。", "stale_plan_item_version");
    }

    const tab = resumeCurrentEditor
      ? await findMatchingEditorTab(chapter, expectedWorkId)
      : await stableAutomationPreflightTab(bookId, expectedWorkId, chapterNo);
    const identity = { bookName: expectedWorkId ? null : expectedBook.name, workId: expectedWorkId };
    const page = await sendPageAction(tab.id, { type: "inspectPage", ...identity });
    if (page?.loginRequired || page?.state === "login_required") {
      throw automationFailure("番茄登录状态无效，请先在 Edge 中登录后再继续。", "login_required", page);
    }
    if (!page?.ok || page.state === "unknown") {
      throw automationFailure("番茄页面仍在加载或无法识别，页面未被操作。请直接重试主按钮。", "unknown_page_state", page);
    }
    if (!page.workMatches) {
      throw automationFailure("当前番茄页面无法确认目标作品，已停止。", "work_identity_mismatch", page);
    }

    let editorTab = tab;
    if (resumeCurrentEditor) {
      if (page.state !== "editor") {
        throw automationFailure(
          `第 ${chapterNo} 章已经填过。请打开它仍保留内容的番茄编辑页，再点“继续发布本章”。`,
          "resume_editor_required",
          page
        );
      }
      const existing = await sendPageAction(tab.id, { type: "inspectChapter", chapter: chapterPayload(chapter) });
      if (!existing?.ok || !existing.titleMatches || !existing.bodyMatches || !existing.chapterMatches) {
        throw automationFailure(
          "当前编辑页不是这一本地章节的完整内容，已停止且不会新建重复章节。",
          "resume_editor_content_mismatch",
          existing
        );
      }
    } else if (page.state !== "editor") {
      const beforeIds = new Set((await chrome.tabs.query({ currentWindow: true })).map((entry) => entry.id));
      // A lost response after the click must remain fail-closed. However, when the page
      // adapter explicitly reports mutationAttempted:false (for example the SPA button
      // never mounted), nothing on Fanqie changed and the chapter must stay retryable.
      pageMutationStarted = true;
      const opened = await sendPageAction(tab.id, { type: "openNewChapter", ...identity });
      await clearPlatformPreflight(bookId);
      if (!opened?.ok) {
        pageMutationStarted = Boolean(opened?.mutationAttempted);
        throw automationFailure(opened?.error || "打开新建章节失败。", opened?.code || "new_chapter_failed", opened);
      }
      pageMutationStarted = true;
      editorTab = await waitForEditorTab(beforeIds, 20_000, expectedWorkId);
    }

    await safePostEvent(bookId, chapterNo, "automation_started", chapter.text_sha256, {
      plan_id: planId, page_url: editorTab.url, publication_date: item.publication_date,
      publication_time: item.publication_time, quota_units: item.quota_units
    });

    pageMutationStarted = true;
    const filled = await sendPageAction(editorTab.id, { type: "fillChapter", chapter: chapterPayload(chapter) });
    if (!filled?.ok) throw automationFailure(filled?.error || "自动填充失败。", filled?.code || "fill_failed", filled);
    await safePostEvent(bookId, chapterNo, "filled", chapter.text_sha256, {
      plan_id: planId, page_url: editorTab.url, observed_char_count: filled.observedCharCount
    });

    const next = await sendPageAction(editorTab.id, { type: "clickNext", chapter: chapterPayload(chapter) });
    if (!next?.ok) throw automationFailure(next?.error || "点击下一步前校验失败。", next?.code || "next_failed", next);
    await safePostEvent(bookId, chapterNo, "next_clicked", chapter.text_sha256, {
      plan_id: planId,
      selected_button: next.selected || null,
      page_url_before: next.transition?.before?.url || editorTab.url,
      page_url_after: next.transition?.after?.url || null,
      editor_present_after: next.transition?.after?.editor?.present ?? null
    });

    // Fanqie reveals the typo prompt/full-check flow in the same editor tab. Let the
    // page adapter observe that transition directly; waiting for a separately classified
    // "publication tab" was the false timeout that stranded chapter 8 after Next.
    const postNextTab = await chrome.tabs.get(editorTab.id);
    const resolvedAiPolicy = await resolveAiPolicy(bookId, plan.ai_policy);
    const publication = await sendPageAction(postNextTab.id, {
      type: "completePublicationFlow",
      options: {
        publicationDate: item.publication_date,
        publicationTime: item.publication_time,
        aiPolicy: resolvedAiPolicy,
        chapterNo,
        title: chapter.title,
        deferFinalSubmit: true,
        nextTransition: next.transition || null
      }
    });
    if (publication?.paused && publication?.code === "ai_choice_required") {
      await safePostEvent(bookId, chapterNo, "awaiting_ai_choice", chapter.text_sha256, {
        plan_id: planId,
        publication_date: item.publication_date,
        publication_time: item.publication_time,
        quota_units: item.quota_units,
        page_url: postNextTab.url
      });
      return {
        ok: true,
        paused: true,
        code: "ai_choice_required",
        chapterNo,
        message: publication.error,
        pageUrl: postNextTab.url
      };
    }
    if (!publication?.ok) {
      throw automationFailure(publication?.error || "发布流程未完成。", publication?.code || "publication_flow_failed", publication);
    }
    const submitOptions = {
      publicationDate: publication.publicationDate || item.publication_date,
      publicationTime: publication.publicationTime || item.publication_time,
      aiPolicy: resolvedAiPolicy,
      chapterNo,
      title: chapter.title
    };
    await safePostEvent(bookId, chapterNo, "final_submit_armed", chapter.text_sha256, {
      plan_id: planId,
      platform_state: "submitted_unverified",
      publication_date: submitOptions.publicationDate,
      publication_time: submitOptions.publicationTime,
      quota_units: item.quota_units,
      page_url: postNextTab.url
    });
    finalSubmissionArmed = true;
    const submitted = await sendPageAction(postNextTab.id, {
      type: "submitPreparedPublication",
      options: submitOptions
    });
    if (!submitted?.ok) {
      throw automationFailure(submitted?.error || "最终提交结果未知。", submitted?.code || "submission_unverified", submitted);
    }
    return await submitAndVerifyPublication(bookId, chapter, plan, item, postNextTab, submitted);
  } catch (error) {
    if (activeChapter && pageMutationStarted) {
      await markBlocked(bookId, chapterNo, planId, activeChapter.text_sha256, error.code || "automation_blocked", {
        message: normalizeError(error),
        details: error.details || null,
        finalSubmissionArmed
      });
    } else if (activeChapter) {
      await safePostEvent(bookId, chapterNo, "failed", activeChapter.text_sha256, {
        plan_id: planId,
        error: error.code || normalizeError(error),
        message: normalizeError(error),
        stage: "pre_mutation_check",
        details: error.details || null
      });
    }
    throw error;
  } finally {
    automationLock = false;
  }
}

async function continueManualAi(bookId, chapterNo, planId) {
  if (automationLock) throw new Error("已有自动发布任务正在运行。");
  automationLock = true;
  let activeChapter = null;
  let finalSubmissionArmed = false;
  try {
    if (!planId) throw new Error("继续发布必须绑定已批准的发布计划。");
    const [chapter, plan] = await Promise.all([
      getChapter(bookId, chapterNo),
      apiRequest(`/api/v1/publication-plans/${encodeURIComponent(planId)}`)
    ]);
    activeChapter = chapter;
    if (plan.status !== "approved") throw new Error(`发布计划状态 ${plan.status} 不允许继续。`);
    const item = (plan.items || []).find((entry) => Number(entry.chapter_no) === chapterNo);
    if (!item || item.status !== "awaiting_ai_choice" || chapter.status !== "awaiting_ai_choice") {
      throw automationFailure("当前章节不在等待手动选择 AI 的状态。", "ai_choice_resume_state_mismatch");
    }
    if (item.text_sha256 !== chapter.text_sha256) {
      throw automationFailure("等待期间章节版本已变化，已停止。", "stale_plan_item_version");
    }

    const expectedWorkId = await platformWorkIdForBook(bookId);
    const postNextTab = await findPublicationSettingsTab(expectedWorkId);
    const publication = await sendPageAction(postNextTab.id, {
      type: "completePublicationFlow",
      options: {
        publicationDate: item.publication_date,
        publicationTime: item.publication_time,
        aiPolicy: "remember",
        chapterNo,
        title: chapter.title,
        deferFinalSubmit: true
      }
    });
    if (!publication?.ok) {
      throw automationFailure(publication?.error || "继续发布失败。", publication?.code || "publication_flow_failed", publication);
    }
    const submitOptions = {
      publicationDate: publication.publicationDate || item.publication_date,
      publicationTime: publication.publicationTime || item.publication_time,
      aiPolicy: "remember",
      chapterNo,
      title: chapter.title
    };
    await safePostEvent(bookId, chapterNo, "final_submit_armed", chapter.text_sha256, {
      plan_id: planId,
      platform_state: "submitted_unverified",
      publication_date: submitOptions.publicationDate,
      publication_time: submitOptions.publicationTime,
      quota_units: item.quota_units,
      page_url: postNextTab.url
    });
    finalSubmissionArmed = true;
    const submitted = await sendPageAction(postNextTab.id, {
      type: "submitPreparedPublication",
      options: submitOptions
    });
    if (!submitted?.ok) {
      throw automationFailure(submitted?.error || "最终提交结果未知。", submitted?.code || "submission_unverified", submitted);
    }
    return await submitAndVerifyPublication(bookId, chapter, plan, item, postNextTab, submitted);
  } catch (error) {
    if (activeChapter) {
      await markBlocked(bookId, chapterNo, planId, activeChapter.text_sha256, error.code || "automation_blocked", {
        message: normalizeError(error),
        details: error.details || null,
        finalSubmissionArmed
      });
    }
    throw error;
  } finally {
    automationLock = false;
  }
}

async function submitAndVerifyPublication(bookId, chapter, plan, item, postNextTab, publication) {
  const chapterNo = Number(chapter.chapter_no);
  await rememberAiChoice(bookId, publication.aiPolicy);
  await safePostEvent(bookId, chapterNo, "schedule_submitted", chapter.text_sha256, {
    plan_id: plan.plan_id,
    platform_state: "submitted",
    publication_date: publication.publicationDate || item.publication_date,
    publication_time: publication.publicationTime || item.publication_time,
    quota_units: item.quota_units,
    page_url: postNextTab.url,
    evidence: publication.evidence
  });

  let readback = null;
  try {
    readback = await sendPageAction(postNextTab.id, {
      type: "inspectPublicationList",
      chapterNos: [chapterNo]
    });
  } catch (error) {
    readback = { ok: false, error: normalizeError(error), code: error.code || "readback_script_error" };
  }
  const expectedDate = publication.publicationDate || item.publication_date;
  const expectedTime = publication.publicationTime || item.publication_time;
  const verifiedRow = readback?.ok
    ? (readback.rows || []).find((row) => (
        Number(row.chapterNo) === chapterNo &&
        (row.scheduled || row.published) &&
        row.publicationDate === expectedDate &&
        row.publicationTime === expectedTime
      ))
    : null;
  if (!verifiedRow) {
    throw automationFailure(
      "平台已接受提交，但尚未在章节管理页回读到完全一致的日期和时间；为避免重复发布，已阻塞并等待对账。",
      "submission_readback_unverified",
      { readback, publication }
    );
  }

  await safePostEvent(bookId, chapterNo, "schedule_verified", chapter.text_sha256, {
    plan_id: plan.plan_id,
    platform_state: verifiedRow.published ? "published" : "scheduled",
    publication_date: verifiedRow.publicationDate,
    publication_time: verifiedRow.publicationTime,
    quota_units: item.quota_units,
    page_url: readback.url || postNextTab.url,
    evidence: verifiedRow.text || publication.evidence,
    version_verified: true
  });
  return { ok: true, chapterNo, publication, readback: verifiedRow };
}

async function runApprovedPlanItems() {
  await safetyReady;
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (!settings.automationEnabled || automationLock) return { skipped: true, reason: "automation_disabled_or_busy" };
  const books = await apiRequest("/api/v1/books");
  for (const book of books.books || []) {
    const plans = await apiRequest(`/api/v1/books/${encodeURIComponent(book.book_id)}/publication-plans`);
    for (const plan of plans.plans || []) {
      if (plan.status !== "approved") continue;
      const item = (plan.items || []).find((entry) => entry.status === "planned");
      if (!item) continue;
      try {
        return await automateChapter(book.book_id, Number(item.chapter_no), plan.plan_id);
      } catch (error) {
        return { ok: false, error: normalizeError(error), planId: plan.plan_id, chapterNo: item.chapter_no };
      }
    }
  }
  return { skipped: true, reason: "no_approved_items" };
}

function canonicalChapterManagementUrl(workId) {
  return `https://fanqienovel.com/main/writer/chapter-manage/${encodeURIComponent(String(workId))}?type=1`;
}

function isChapterManagementUrl(url, expectedWorkId = null) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/main\/writer\/chapter-manage\/(\d{10,})(?:&.*)?$/u);
    return Boolean(match && (!expectedWorkId || match[1] === String(expectedWorkId)));
  } catch (_error) {
    return false;
  }
}

function isCanonicalChapterManagementUrl(url, workId) {
  try {
    const current = new URL(url);
    const expected = new URL(canonicalChapterManagementUrl(workId));
    return current.origin === expected.origin && current.pathname === expected.pathname && current.searchParams.get("type") === "1";
  } catch (_error) {
    return false;
  }
}

async function ensureChapterManagementTab(expectedWorkId) {
  if (!expectedWorkId) throw automationFailure("还没有绑定番茄作品，无法打开章节管理页。", "platform_work_not_bound");
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const matching = tabs.filter((tab) => tab.id && isChapterManagementUrl(tab.url, expectedWorkId));
  let tab = matching.find((entry) => entry.active) || matching[0] || null;
  const url = canonicalChapterManagementUrl(expectedWorkId);
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: true });
  } else if (!isCanonicalChapterManagementUrl(tab.url, expectedWorkId)) {
    tab = await chrome.tabs.update(tab.id, { url, active: true });
  } else if (!tab.active) {
    tab = await chrome.tabs.update(tab.id, { active: true });
  }
  await waitForTabComplete(tab.id, 30_000);
  await waitForPageScript(tab.id, 15_000);
  return chrome.tabs.get(tab.id);
}

async function ensureBookManagementTab() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const isBookManagement = (tab) => {
    try { return tab.id && new URL(tab.url).pathname === "/main/writer/book-manage"; } catch (_error) { return false; }
  };
  let tab = tabs.find((entry) => entry.active && isBookManagement(entry)) || tabs.find(isBookManagement);
  if (!tab) tab = await chrome.tabs.create({ url: BOOK_MANAGE_URL, active: true });
  else if (!tab.active) tab = await chrome.tabs.update(tab.id, { active: true });
  await waitForTabComplete(tab.id, 30_000);
  await waitForPageScript(tab.id, 15_000);
  return chrome.tabs.get(tab.id);
}

async function resolvePlatformWorkId(bookId, expectedBook) {
  const stored = await platformWorkIdForBook(bookId);
  if (stored) return stored;

  // If the user already opened exactly one chapter-management page, that URL is the
  // strongest identity evidence and avoids guessing from a possibly different title.
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const visibleWorkIds = [...new Set(tabs
    .filter((tab) => tab.id && isChapterManagementUrl(tab.url))
    .map((tab) => extractPlatformWorkId(tab.url))
    .filter(Boolean))];
  if (visibleWorkIds.length === 1) {
    await rememberPlatformWorkIdValue(bookId, visibleWorkIds[0]);
    return visibleWorkIds[0];
  }

  // First-time binding: open “我的小说”, read its real links, and bind only an exact
  // local-name match or the sole work. We never invent a numeric work ID.
  const tab = await ensureBookManagementTab();
  const page = await sendPageAction(tab.id, { type: "inspectPage" });
  if (!page?.ok || page.state === "login_required") {
    throw automationFailure("番茄登录状态无效，请先在 Edge 中登录。", "login_required", page);
  }
  let discovery = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    discovery = await sendPageAction(tab.id, { type: "inspectWorks", bookName: expectedBook?.name || null });
    if (discovery?.matchedWorkId || (discovery?.works || []).length) break;
    await sleep(400);
  }
  if (!discovery?.ok) {
    throw automationFailure(discovery?.error || "无法读取“我的小说”作品列表。", discovery?.code || "book_list_unrecognized", discovery);
  }
  if (!discovery.matchedWorkId) {
    throw automationFailure(
      "“我的小说”里有多个作品，无法安全判断本地小说对应哪一本。请打开目标作品的章节管理页后再刷新一次。",
      "platform_work_binding_required",
      { works: discovery.works || [] }
    );
  }
  await rememberPlatformWorkIdValue(bookId, discovery.matchedWorkId);
  return discovery.matchedWorkId;
}

async function waitForPageScript(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let reloadedForUpgrade = false;
  while (Date.now() < deadline) {
    try {
      const page = await sendPageAction(tabId, { type: "inspectPage" });
      if (page?.adapterVersion === PAGE_ADAPTER_VERSION) return page;
      // Reload exactly once when an already-open Fanqie tab still has the previous
      // extension's content script. This removes the old manual “refresh the tab” step.
      if (page && !reloadedForUpgrade) {
        reloadedForUpgrade = true;
        await chrome.tabs.reload(tabId);
        await waitForTabComplete(tabId, Math.min(15_000, Math.max(1_000, deadline - Date.now())));
        continue;
      }
    } catch (error) {
      if (error.code !== "content_script_unavailable") throw error;
      // Reload once as well when the previous extension context was invalidated and no
      // listener answers at all after the user reloaded the unpacked extension.
      if (!reloadedForUpgrade) {
        reloadedForUpgrade = true;
        await chrome.tabs.reload(tabId);
        await waitForTabComplete(tabId, Math.min(15_000, Math.max(1_000, deadline - Date.now())));
        continue;
      }
    }
    await sleep(300);
  }
  throw automationFailure(`番茄页面已打开，但 ${PAGE_ADAPTER_VERSION} 页面适配器没有加载完成。请在扩展管理页重新加载插件。`, "content_script_unavailable");
}

async function recentPlatformPreflightTab(bookId, expectedWorkId, chapterNo = null) {
  const stored = await chrome.storage.local.get({ platformPreflightByBook: {} });
  const preflight = stored.platformPreflightByBook?.[bookId];
  if (!preflight || preflight.workId !== String(expectedWorkId)) return null;
  if (chapterNo !== null && !(preflight.chapterNos || []).map(Number).includes(Number(chapterNo))) return null;
  if (Date.now() - Number(preflight.checkedAt || 0) > PLATFORM_PREFLIGHT_TTL_MS) return null;
  try {
    const tab = await chrome.tabs.get(Number(preflight.tabId));
    if (!tab?.id || !isCanonicalChapterManagementUrl(tab.url, expectedWorkId)) return null;
    return tab;
  } catch (_error) {
    return null;
  }
}

async function stableAutomationPreflightTab(bookId, expectedWorkId, chapterNo) {
  const recent = await recentPlatformPreflightTab(bookId, expectedWorkId, chapterNo);
  if (recent) return recent;

  // Background execution and direct chapter actions may not have a side-panel refresh.
  // They still need the same stable absence evidence immediately before creating a
  // chapter; a document-ready shell is not sufficient for a Fanqie SPA.
  const tab = await ensureChapterManagementTab(expectedWorkId);
  const snapshot = await sendPageAction(tab.id, {
    type: "inspectPublicationList",
    chapterNos: [Number(chapterNo)]
  });
  if (!snapshot?.ok || !snapshot.listStable || !snapshot.newChapterReady) {
    throw automationFailure(
      snapshot?.error || "章节管理页尚未稳定加载，页面未被操作。请直接重试主按钮。",
      snapshot?.code || "publication_list_unstable",
      snapshot
    );
  }
  if (snapshot.workId !== String(expectedWorkId)) {
    throw automationFailure("章节管理页不是已绑定的目标作品，已停止。", "work_identity_mismatch", {
      expectedWorkId, snapshot
    });
  }
  const existing = (snapshot.rows || []).find((row) => Number(row.chapterNo) === Number(chapterNo) && row.found);
  if (existing) {
    throw automationFailure(
      `番茄平台已经存在第 ${chapterNo} 章记录，拒绝重复新建。请用主按钮刷新并对账。`,
      "platform_record_requires_reconciliation",
      { snapshot, existing }
    );
  }
  await rememberPlatformPreflight(bookId, expectedWorkId, tab, snapshot);
  return tab;
}

async function rememberPlatformPreflight(bookId, workId, tab, snapshot) {
  const stored = await chrome.storage.local.get({ platformPreflightByBook: {} });
  await chrome.storage.local.set({
    platformPreflightByBook: {
      ...(stored.platformPreflightByBook || {}),
      [bookId]: {
        workId: String(workId),
        tabId: tab.id,
        checkedAt: Date.now(),
        url: snapshot?.url || tab.url,
        chapterNos: (snapshot?.rows || []).map((row) => Number(row.chapterNo))
      }
    }
  });
}

async function clearPlatformPreflight(bookId) {
  const stored = await chrome.storage.local.get({ platformPreflightByBook: {} });
  const next = { ...(stored.platformPreflightByBook || {}) };
  delete next[bookId];
  await chrome.storage.local.set({ platformPreflightByBook: next });
}

async function currentFanqieTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isFanqieUrl(tab.url)) throw new Error("当前活动页面不是番茄页面。");
  return tab;
}

async function findMatchingEditorTab(chapter, expectedWorkId = null) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const ordered = [...tabs.filter((tab) => tab.active), ...tabs.filter((tab) => !tab.active)];
  for (const tab of ordered) {
    if (!tab.id || !isFanqieUrl(tab.url)) continue;
    if (expectedWorkId && extractPlatformWorkId(tab.url) !== expectedWorkId) continue;
    try {
      const page = await sendPageAction(tab.id, { type: "inspectPage", workId: expectedWorkId });
      if (page?.state !== "editor") continue;
      const inspected = await sendPageAction(tab.id, { type: "inspectChapter", chapter: chapterPayload(chapter) });
      if (inspected?.ok && inspected.titleMatches && inspected.bodyMatches && inspected.chapterMatches) return tab;
    } catch (_error) { /* inspect the next local Fanqie tab */ }
  }
  throw automationFailure(
    `没有找到仍保留第 ${chapter.chapter_no} 章完整内容的番茄编辑页。请打开该编辑页后再继续。`,
    "resume_editor_required"
  );
}

async function waitForEditorTab(beforeIds, timeoutMs, expectedWorkId = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const candidates = tabs.filter((tab) => (
      tab.id && isFanqieUrl(tab.url) && (!expectedWorkId || extractPlatformWorkId(tab.url) === expectedWorkId) &&
      (!beforeIds.has(tab.id) || tab.active)
    ));
    for (const tab of candidates) {
      try {
        await waitForTabComplete(tab.id, 5_000);
        const page = await sendPageAction(tab.id, { type: "inspectPage" });
        if (page?.state === "editor") return tab;
      } catch (_error) { /* keep polling */ }
    }
    await sleep(400);
  }
  throw new Error("新建章节后未找到可验证的编辑页。");
}

async function findPublicationSettingsTab(expectedWorkId = null) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const ordered = [...tabs.filter((tab) => tab.active), ...tabs.filter((tab) => !tab.active)];
  for (const tab of ordered) {
    if (!tab.id || !isFanqieUrl(tab.url)) continue;
    if (expectedWorkId && extractPlatformWorkId(tab.url) !== expectedWorkId) continue;
    try {
      const page = await sendPageAction(tab.id, { type: "inspectPage", workId: expectedWorkId });
      if (page?.state === "publish_settings") return tab;
    } catch (_error) { /* inspect the next Fanqie tab */ }
  }
  throw automationFailure(
    "没有找到仍停留在“发布设置”的番茄标签页，请不要刷新或关闭该页面。",
    "publish_settings_tab_missing"
  );
}

async function waitForTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await sleep(300);
  }
  throw new Error("页面加载超时。");
}

async function sendPageAction(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response;
  } catch (error) {
    const wrapped = new Error(`页面脚本不可用：${normalizeError(error)}`);
    wrapped.code = "content_script_unavailable";
    throw wrapped;
  }
}

async function inspectPlatform(bookId, chapterNos) {
  if (!bookId) throw new Error("缺少作品标识。");
  const bookCatalog = await apiRequest("/api/v1/books");
  const expectedBook = (bookCatalog.books || []).find((entry) => entry.book_id === bookId);
  if (!expectedBook) throw new Error("本地账本中没有找到目标作品。");
  const expectedWorkId = await resolvePlatformWorkId(bookId, expectedBook);
  const tab = await ensureChapterManagementTab(expectedWorkId);
  const snapshot = await sendPageAction(tab.id, { type: "inspectPublicationList", chapterNos });
  if (!snapshot?.ok) throw automationFailure(snapshot?.error || "读取平台章节列表失败。", snapshot?.code || "publication_list_unrecognized", snapshot);
  if (!snapshot.listStable || !snapshot.newChapterReady) {
    throw automationFailure(
      "章节管理页尚未稳定加载，本次结果不会用于判断章节不存在。请直接重试主按钮。",
      "publication_list_unstable",
      snapshot
    );
  }
  if (snapshot.workId !== String(expectedWorkId)) {
    throw automationFailure("章节管理页不是已绑定的目标作品，已停止。", "work_identity_mismatch", { expectedWorkId, snapshot });
  }
  await rememberPlatformWorkIdValue(bookId, expectedWorkId);
  await rememberPlatformPreflight(bookId, expectedWorkId, tab, snapshot);
  const publicationSettings = await apiRequest("/api/v1/settings/publication");
  const observations = [];
  const recordObservations = [];
  for (const row of snapshot.rows || []) {
    if (!row.found) continue;
    const chapter = await getChapter(bookId, Number(row.chapterNo));
    // Bootstrap published chapters are already an explicit ledger boundary. Do not
    // downgrade them to an unverified version merely because the list row has no body.
    if (chapter.status === "legacy_published" && row.published) continue;
    if ((!row.scheduled && !row.published) || !row.publicationDate) {
      const platformState = row.scheduled
        ? "scheduled_unverified"
        : row.published
          ? "published_unverified"
          : "draft_unverified";
      await postEvent(bookId, chapter.chapter_no, "platform_record_observed", chapter.text_sha256, {
        platform_state: platformState,
        evidence: row.text || null,
        page_url: snapshot.url,
        publication_date: row.publicationDate || null,
        publication_time: row.publicationTime || null
      });
      recordObservations.push({ chapterNo: chapter.chapter_no, platformState });
      continue;
    }
    const matchingEvidence = [...(chapter.events || [])].reverse().find((event) => {
      if (!["schedule_submitted", "schedule_verified", "published", "verified"].includes(event.event_type)) return false;
      if (event.text_sha256 !== chapter.text_sha256) return false;
      const payload = event.payload || {};
      if (payload.publication_date && payload.publication_date !== row.publicationDate) return false;
      if (event.event_type === "schedule_submitted") {
        if (!row.publicationTime || !payload.publication_time || payload.publication_time !== row.publicationTime) return false;
      } else if (payload.publication_time && row.publicationTime && payload.publication_time !== row.publicationTime) {
        return false;
      }
      return true;
    });
    const versionVerified = Boolean(matchingEvidence);
    observations.push({
      chapter_no: chapter.chapter_no,
      text_sha256: chapter.text_sha256,
      publication_date: row.publicationDate,
      publication_time: row.publicationTime || matchingEvidence?.payload?.publication_time || null,
      quota_units: versionVerified
        ? countVisibleCharacters(chapter.body)
        : Number(publicationSettings.daily_limit || 9999),
      platform_state: row.published ? "published" : "scheduled",
      version_verified: versionVerified,
      evidence: row.text || null,
      plan_id: matchingEvidence?.payload?.plan_id || null
    });
  }
  let recorded = null;
  if (observations.length) {
    recorded = await apiRequest(`/api/v1/books/${encodeURIComponent(bookId)}/platform-observations`, {
      method: "POST", body: { observations }
    });
  }
  return { snapshot, observations, recordObservations, recorded };
}

async function getChapter(bookId, chapterNo) {
  return apiRequest(`/api/v1/books/${encodeURIComponent(bookId)}/chapters/${chapterNo}`);
}

function chapterPayload(chapter) {
  return {
    chapter_no: chapter.chapter_no,
    title: chapter.title,
    body: chapter.body,
    text_sha256: chapter.text_sha256,
    char_count: chapter.char_count
  };
}

async function safePostEvent(bookId, chapterNo, event, textSha256, payload) {
  return postEvent(bookId, chapterNo, event, textSha256, payload);
}

async function markBlocked(bookId, chapterNo, planId, textSha256, code, details) {
  try {
    await safePostEvent(bookId, chapterNo, "blocked", textSha256, {
      plan_id: planId,
      error: code,
      stage: "automation",
      platform_state: (details?.finalSubmissionArmed || ["submission_readback_unverified", "submission_unverified"].includes(code))
        ? "submitted_unverified"
        : undefined,
      details: details || null
    });
  } catch (_error) { /* preserve original stop reason */ }
}

async function reconcileChapter(bookId, chapterNo) {
  const chapter = await getChapter(bookId, chapterNo);
  const platformObservation = [...(chapter.events || [])].reverse().find((event) =>
    ["schedule_observed", "published_observed"].includes(event.event_type)
  );
  const draftObservation = [...(chapter.events || [])].reverse().find((event) =>
    event.event_type === "platform_record_observed" && event.payload?.platform_state === "draft_unverified"
  );
  const isLegacyDraft = chapter.status === "legacy_draft";
  const hasUnverifiedPlatformVersion = Boolean(
    platformObservation && ["scheduled_unverified", "published_unverified"].includes(chapter.platform_state)
  );
  const hasUnverifiedDraft = Boolean(draftObservation && chapter.platform_state === "draft_unverified");
  if (!isLegacyDraft && !hasUnverifiedPlatformVersion && !hasUnverifiedDraft) {
    throw new Error(`章节状态 ${chapter.status}/${chapter.platform_state || "无平台状态"} 不允许执行版本对账。`);
  }
  const tab = await currentFanqieTab();
  const response = await sendPageAction(tab.id, {
    type: "inspectChapter",
    chapter: { chapter_no: chapter.chapter_no, title: chapter.title, body: chapter.body, text_sha256: chapter.text_sha256 }
  });
  if (!response?.ok) throw new Error(response?.error || "草稿读取失败。");
  const matched = response.titleMatches && response.bodyMatches && response.chapterMatches;
  const evidencePayload = {
    page_url: tab.url,
    title_matches: response.titleMatches,
    body_matches: response.bodyMatches,
    chapter_matches: response.chapterMatches,
    observed_title: response.observedTitle,
    observed_chapter_no: response.observedChapterNo,
    observed_char_count: response.observedCharCount
  };
  if (matched && platformObservation) {
    const observed = platformObservation.payload || {};
    const verifiedState = platformObservation.event_type === "schedule_observed" ? "scheduled" : "published";
    if (verifiedState === "scheduled" && !observed.publication_time) {
      throw automationFailure(
        "正文已匹配，但平台列表没有可验证的定时时刻；仍保持未接管状态。",
        "schedule_time_unverified"
      );
    }
    await postEvent(
      bookId,
      chapterNo,
      verifiedState === "scheduled" ? "schedule_verified" : "published",
      chapter.text_sha256,
      {
        ...observed,
        ...evidencePayload,
        platform_state: verifiedState,
        version_verified: true,
        quota_units: countVisibleCharacters(chapter.body),
        reconciliation: "editor_title_body_chapter_match"
      }
    );
  } else {
    await postEvent(bookId, chapterNo, matched ? "reconcile_match" : "reconcile_conflict", chapter.text_sha256, {
      ...evidencePayload,
      platform_state: platformObservation
        ? (platformObservation.payload?.platform_state || chapter.platform_state)
        : "saved_draft"
    });
  }
  return { ...response, matched, expectedBody: chapter.body };
}

async function postEvent(bookId, chapterNo, event, textSha256, payload) {
  return apiRequest(`/api/v1/books/${encodeURIComponent(bookId)}/chapters/${chapterNo}/events`, {
    method: "POST", body: { event, text_sha256: textSha256, payload: payload || {} }
  });
}

function extractPlatformWorkId(url) {
  try {
    const pathname = new URL(url).pathname;
    const managed = pathname.match(/\/main\/writer\/(?:chapter-manage|book-info)\/(\d{10,})/u);
    if (managed) return managed[1];
    const workRoot = pathname.match(/\/main\/writer\/(\d{10,})(?:\/|$)/u);
    return workRoot ? workRoot[1] : null;
  } catch (_error) {
    return null;
  }
}

async function rememberPlatformWorkId(bookId, url) {
  const workId = extractPlatformWorkId(url);
  if (!bookId || !workId) return null;
  return rememberPlatformWorkIdValue(bookId, workId);
}

async function rememberPlatformWorkIdValue(bookId, workId) {
  if (!bookId || !workId) return null;
  const stored = await chrome.storage.local.get({ platformWorkIdByBook: {} });
  await chrome.storage.local.set({
    platformWorkIdByBook: { ...(stored.platformWorkIdByBook || {}), [bookId]: String(workId) }
  });
  return String(workId);
}

async function platformWorkIdForBook(bookId) {
  const stored = await chrome.storage.local.get({ platformWorkIdByBook: {} });
  return stored.platformWorkIdByBook?.[bookId] || null;
}

function isFanqieUrl(url) {
  try { return isFanqieHost(new URL(url).hostname); } catch (_error) { return false; }
}

function isFanqieHost(hostname) {
  return hostname === TARGET_ROOT_HOST || hostname.endsWith(`.${TARGET_ROOT_HOST}`);
}

function countVisibleCharacters(value) {
  return String(value || "").replace(/\s+/gu, "").length;
}

async function resolveAiPolicy(bookId, planPolicy) {
  const policy = String(planPolicy || "remember");
  if (policy !== "remember") return policy;
  const stored = await chrome.storage.local.get({ aiChoiceByBook: {} });
  const remembered = stored.aiChoiceByBook?.[bookId];
  return ["use", "no"].includes(remembered) ? remembered : "remember";
}

async function rememberAiChoice(bookId, observedChoice) {
  const text = String(observedChoice || "").replace(/\s+/gu, "");
  let normalized = null;
  if (/不使用AI|未使用AI/iu.test(text) || text === "否" || /否$/u.test(text)) normalized = "no";
  else if (/使用AI/iu.test(text) || text === "是" || /是$/u.test(text)) normalized = "use";
  if (!normalized) return;
  const stored = await chrome.storage.local.get({ aiChoiceByBook: {} });
  await chrome.storage.local.set({
    aiChoiceByBook: { ...(stored.aiChoiceByBook || {}), [bookId]: normalized }
  });
}

function normalizeError(error) {
  if (error instanceof Error) return error.message;
  return String(error || "未知错误");
}

function automationFailure(message, code, details = null) {
  const error = new Error(String(message || code || "自动发布已停止。"));
  error.code = String(code || "automation_blocked");
  error.details = details;
  return error;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
