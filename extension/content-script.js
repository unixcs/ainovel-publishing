"use strict";

const PAGE_ADAPTER_VERSION = "0.3.3";

// Selector strategy adapted from NonoOi/fanqie-author-injector (MIT); see THIRD_PARTY_NOTICES.md.
const FIELD_SELECTORS = {
  chapterNumber: [
    ".left-input input.serial-input",
    "input.serial-input",
    "input[placeholder*='章']",
    "input[aria-label*='章']",
    "input[name*='chapter']",
    "input[class*='chapter']",
    "[contenteditable='true'][data-placeholder*='章']"
  ],
  title: [
    "input.serial-editor-input-hint-area",
    "input[placeholder='请输入标题']",
    "input[placeholder*='标题']",
    "textarea[placeholder*='标题']",
    "input[aria-label*='标题']",
    "textarea[aria-label*='标题']",
    "input[name*='title']",
    "textarea[name*='title']",
    "[contenteditable='true'][data-placeholder*='标题']"
  ],
  editor: [
    ".ProseMirror",
    ".ql-editor",
    ".public-DraftEditor-content",
    "[data-slate-editor='true']",
    ".novel-editor [contenteditable='true']",
    ".novel-editor [role='textbox']",
    "[role='textbox'][aria-multiline='true']",
    "[contenteditable='true'][aria-multiline='true']",
    "textarea[placeholder*='正文']"
  ]
};

const EMPTY_EDITOR_HINTS = [
  "请输入正文",
  "请输入章节正文",
  "请在这里输入正文",
  "开始创作吧"
];

const PAGE_ACTIONS = new Set([
  "fillChapter",
  "inspectChapter",
  "inspectPage",
  "openNewChapter",
  "clickNext",
  "completePublicationFlow",
  "submitPreparedPublication",
  "inspectPublicationList",
  "inspectWorks"
]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !PAGE_ACTIONS.has(message.type)) return false;
  Promise.resolve()
    .then(() => dispatchPageAction(message))
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: normalizeError(error), code: "script_exception" }));
  return true;
});

async function dispatchPageAction(message) {
  switch (message.type) {
    case "fillChapter":
      return await fillChapter(message.chapter);
    case "inspectChapter":
      return await inspectChapter(message.chapter);
    case "inspectPage":
      return inspectPage(message.bookName || null, message.workId || null);
    case "openNewChapter":
      return openNewChapter(message.bookName || null, message.workId || null, message.timeoutMs);
    case "clickNext":
      return await clickNext(message.chapter);
    case "completePublicationFlow":
      return completePublicationFlow(message.options || {});
    case "submitPreparedPublication":
      return submitPreparedPublication(message.options || {});
    case "inspectPublicationList":
      return inspectPublicationList(message.chapterNos || [], message.timeoutMs);
    case "inspectWorks":
      return inspectWorks(message.bookName || null);
    default:
      return failure("不支持的页面操作。", "unsupported_page_action");
  }
}

async function inspectChapter(chapter) {
  const ready = await waitForEditorFields();
  if (!ready.value) {
    const fields = locateFields();
    if (!fields.titleField) return failure("当前页面不是章节编辑页，或编辑器仍未加载完成。", "title_missing", { diagnostics: fields.diagnostics });
    return failure("当前页面没有找到正文编辑器。", "editor_missing", { diagnostics: fields.diagnostics });
  }
  const fields = ready.value;
  return compareChapterFields(fields, chapter);
}

async function fillChapter(chapter) {
  // Fanqie's editor is rendered asynchronously. A single immediate query caused the
  // old UI to fail once and succeed on the second click. Wait here so one click has
  // one deterministic outcome.
  const ready = await waitForEditorFields();
  if (!ready.value) {
    const fields = locateFields();
    return failure(
      "当前页面不是章节编辑页，或编辑器在 10 秒内没有加载完成。请停留在编辑页后重试。",
      fields.titleField ? "editor_missing" : "title_missing",
      { diagnostics: fields.diagnostics }
    );
  }

  let fields = ready.value;
  const expectedTitle = pureTitle(chapter.title);
  const expectedBody = normalizeBody(chapter.body);
  const expectedChapterNo = String(chapter.chapter_no);
  const beforeTitle = readField(fields.titleField).trim();
  const rawBeforeBody = readField(fields.editor);
  const beforeBody = normalizeBody(rawBeforeBody);
  const beforeChapterNo = fields.chapterNumberField ? readField(fields.chapterNumberField).trim() : "";
  const editorIsEmpty = isEmptyEditorText(beforeBody);

  if (beforeTitle && normalizeCompact(beforeTitle) !== normalizeCompact(expectedTitle)) {
    return failure("标题栏已有其他内容，拒绝覆盖。", "title_conflict", {
      beforeTitle,
      diagnostics: fields.diagnostics
    });
  }
  if (!editorIsEmpty && beforeBody !== expectedBody) {
    return failure("正文编辑器已有其他内容，拒绝覆盖。", "body_conflict", {
      observedCharCount: countVisibleCharacters(beforeBody),
      beforeBodyPreview: beforeBody.slice(0, 160),
      editorDescriptor: fields.diagnostics.editor,
      diagnostics: fields.diagnostics
    });
  }
  if (beforeChapterNo && normalizeChapterNumber(beforeChapterNo) !== expectedChapterNo) {
    return failure("章节号与待处理章节不一致，拒绝覆盖。", "chapter_number_conflict", {
      beforeChapterNo,
      diagnostics: fields.diagnostics
    });
  }

  if (fields.chapterNumberField && !beforeChapterNo) fillField(fields.chapterNumberField, expectedChapterNo, false);
  if (!beforeTitle) fillField(fields.titleField, expectedTitle, false);
  if (editorIsEmpty) fillField(fields.editor, expectedBody, true);

  // React/ProseMirror may replace the edited node after the input event. Re-locate and
  // wait for the controlled state to settle rather than making the user click twice.
  const verified = await waitFor(() => {
    const current = locateFields();
    if (!current.titleField || !current.editor) return false;
    const comparison = compareChapterFields(current, chapter);
    return comparison.ok && comparison.titleMatches && comparison.bodyMatches && comparison.chapterMatches
      ? { value: { fields: current, comparison } }
      : false;
  }, Date.now() + EDITOR_SETTLE_TIMEOUT_MS);

  if (!verified.value) {
    fields = locateFields();
    const comparison = fields.titleField && fields.editor
      ? compareChapterFields(fields, chapter)
      : null;
    return failure("填充后页面没有稳定保存完整内容，已停止。请不要点击下一步。", "post_fill_mismatch", {
      observedTitle: comparison?.observedTitle || "",
      observedChapterNo: comparison?.observedChapterNo || "",
      observedCharCount: comparison?.observedCharCount || 0,
      titleMatches: comparison?.titleMatches || false,
      bodyMatches: comparison?.bodyMatches || false,
      chapterMatches: comparison?.chapterMatches || false,
      diagnostics: fields.diagnostics
    });
  }

  const result = verified.value.comparison;
  return {
    ok: true,
    observedTitle: result.observedTitle,
    observedChapterNo: result.observedChapterNo,
    observedCharCount: result.observedCharCount,
    alreadyPresent: Boolean(beforeTitle && !editorIsEmpty),
    diagnostics: verified.value.fields.diagnostics
  };
}

function compareChapterFields(fields, chapter) {
  const observedTitle = readField(fields.titleField).trim();
  const observedBody = normalizeBody(readField(fields.editor));
  const observedChapterNo = fields.chapterNumberField
    ? readField(fields.chapterNumberField).trim()
    : String(chapter.chapter_no);
  const expectedTitle = pureTitle(chapter.title);
  const expectedBody = normalizeBody(chapter.body);
  const expectedChapterNo = String(chapter.chapter_no);
  return {
    ok: true,
    titleMatches: normalizeCompact(observedTitle) === normalizeCompact(expectedTitle),
    bodyMatches: observedBody === expectedBody,
    chapterMatches: normalizeChapterNumber(observedChapterNo) === expectedChapterNo,
    observedTitle,
    observedBody,
    observedChapterNo,
    observedCharCount: countVisibleCharacters(observedBody),
    diagnostics: fields.diagnostics
  };
}

async function waitForEditorFields(timeoutMs = EDITOR_READY_TIMEOUT_MS) {
  return waitFor(() => {
    const fields = locateFields();
    return fields.titleField && fields.editor ? { value: fields } : false;
  }, Date.now() + timeoutMs);
}

function locateFields() {
  const titleField = findVisible(FIELD_SELECTORS.title);
  const chapterNumberField = findVisible(FIELD_SELECTORS.chapterNumber, titleField);
  const editorResult = findBestEditor(FIELD_SELECTORS.editor, [titleField, chapterNumberField]);
  return {
    titleField,
    chapterNumberField,
    editor: editorResult.element,
    diagnostics: {
      title: describeElement(titleField),
      chapterNumber: describeElement(chapterNumberField),
      editor: describeElement(editorResult.element),
      editorCandidates: editorResult.candidates
    }
  };
}

function findVisible(selectors, exclude = null) {
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (element !== exclude && isVisible(element)) return element;
    }
  }
  return null;
}

function findBestEditor(selectors, excluded) {
  const candidates = [];
  const seen = new Set();
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (seen.has(element) || excluded.includes(element) || !isVisible(element)) continue;
      seen.add(element);
      const rect = element.getBoundingClientRect();
      const descriptor = describeElement(element);
      const text = normalizeBody(readField(element));
      let score = rect.width * rect.height;
      if (isEditable(element)) score += 1_000_000;
      if (element.getAttribute("aria-multiline") === "true") score += 200_000;
      if (element.matches(".ProseMirror, .ql-editor, [data-slate-editor='true']")) score += 100_000;
      if (/正文|内容|article|editor|write|text/iu.test(descriptor)) score += 50_000;
      if (/作者有话|签名|评论|标题/iu.test(descriptor)) score -= 200_000;
      candidates.push({ element, score, descriptor, charCount: countVisibleCharacters(text) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return { element: candidates[0]?.element || null, candidates: candidates.slice(0, 8).map(({ descriptor, score, charCount }) => ({ descriptor, score, charCount })) };
}

function describeElement(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    tag: element.tagName,
    id: element.id || "",
    className: typeof element.className === "string" ? element.className.slice(0, 160) : "",
    placeholder: element.getAttribute("placeholder") || "",
    ariaLabel: element.getAttribute("aria-label") || "",
    role: element.getAttribute("role") || "",
    contenteditable: element.getAttribute("contenteditable") || "",
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function isVisible(element) {
  if (!(element instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isEmptyEditorText(value) {
  const compact = normalizeCompact(value);
  if (!compact) return true;
  if (EMPTY_EDITOR_HINTS.some((hint) => compact === normalizeCompact(hint))) return true;
  return compact.length <= 30 && compact.includes("请输入") && compact.includes("正文");
}

function pureTitle(title) {
  return String(title || "")
    .replace(/^第[〇零一二三四五六七八九十百千万两\d]+章\s*/u, "")
    .trim();
}

function normalizeCompact(value) {
  return String(value || "").replace(/[\s\u200b\ufeff]+/gu, "").trim();
}

function normalizeChapterNumber(value) {
  const match = String(value || "").match(/\d+/u);
  return match ? String(Number(match[0])) : String(value || "").trim();
}

function normalizeBody(value) {
  return String(value || "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t \f\v\u00a0\u3000]+$/gmu, "")
    .replace(/[\u200b\ufeff]/gu, "")
    .replace(/^\n+|\n+$/gu, "")
    .replace(/\n{3,}/gu, "\n\n");
}

function countVisibleCharacters(value) {
  return String(value || "").replace(/\s+/gu, "").length;
}

function readField(element) {
  if (!element) return "";
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value || "";
  return element.innerText || element.textContent || "";
}

function fillField(element, value, multiline) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = element instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (!descriptor || typeof descriptor.set !== "function") throw new Error("输入框 value setter 不可用，已停止。");
    element.focus();
    descriptor.set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (!isEditable(element)) throw new Error("无法识别目标编辑区域，已停止。");
  const normalized = String(value || "").replace(/\r\n?/gu, "\n");
  element.focus();
  selectNodeContents(element);
  document.execCommand("delete", false, null);
  if (document.execCommand("insertText", false, normalized)) {
    dispatchEditableChange(element, normalized);
    return;
  }
  if (!multiline) {
    element.textContent = normalized;
  } else {
    element.innerHTML = "";
    const fragment = document.createDocumentFragment();
    for (const line of normalized.split("\n")) {
      const paragraph = document.createElement("p");
      if (line) paragraph.textContent = line;
      else paragraph.appendChild(document.createElement("br"));
      fragment.appendChild(paragraph);
    }
    element.appendChild(fragment);
  }
  dispatchEditableChange(element, normalized);
}

function isEditable(element) {
  return Boolean(element && (element.getAttribute("contenteditable") === "true" || element.getAttribute("contenteditable") === "plaintext-only" || element.getAttribute("role") === "textbox"));
}

function selectNodeContents(element) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function dispatchEditableChange(element, text) {
  try {
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
  } catch (_error) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function failure(error, code, details = {}) {
  return { ok: false, error, code, ...details };
}

function normalizeError(error) {
  return error instanceof Error ? error.message : String(error || "未知错误");
}

// ---- Verified publication workflow -------------------------------------------------
// These helpers intentionally use semantic visible controls and post-condition checks.
// They do not use screen coordinates or force-click hidden elements.

const AUTOMATION_LIMITS = {
  transitionMs: 25_000,
  fullCheckMs: 60_000,
  successMs: 25_000,
  pollMs: 250
};
const EDITOR_READY_TIMEOUT_MS = 10_000;
const EDITOR_SETTLE_TIMEOUT_MS = 4_000;
const NEW_CHAPTER_READY_TIMEOUT_MS = 15_000;
const PUBLICATION_LIST_TIMEOUT_MS = 15_000;
const PUBLICATION_LIST_STABLE_MS = 1_200;
const PUBLICATION_LIST_MIN_SETTLE_MS = 1_800;

function inspectPage(expectedBookName = null, expectedWorkId = null) {
  const body = visiblePageText();
  const fields = locateFields();
  const loginRequired = isLoginPage(body);
  const publishSettings = hasPublicationSettings(body);
  const typoPrompt = Boolean(findTypoDialog());
  const fullCheckReady = Boolean(findActionButton(["全面检测", "全文检测"]).element);
  const publicationFlowReady = publishSettings || typoPrompt || fullCheckReady;
  const editor = Boolean(fields.titleField && fields.editor);
  const writer = isWriterPage(body);
  let state = "unknown";
  if (loginRequired) state = "login_required";
  else if (publishSettings) state = "publish_settings";
  else if (editor) state = "editor";
  else if (writer) state = "writer";
  const currentWorkId = extractPlatformWorkId(location.href);
  const workMatches = expectedWorkId
    ? currentWorkId === String(expectedWorkId)
    : (!expectedBookName || normalizeCompact(body).includes(normalizeCompact(expectedBookName)));
  return {
    ok: state !== "unknown",
    adapterVersion: PAGE_ADAPTER_VERSION,
    state,
    url: location.href,
    title: document.title,
    loginRequired,
    writer,
    editor,
    publishSettings,
    typoPrompt,
    fullCheckReady,
    publicationFlowReady,
    expectedBookName,
    expectedWorkId,
    currentWorkId,
    workMatches,
    diagnostics: fields.diagnostics,
    bodyPreview: body.slice(0, 500)
  };
}

async function openNewChapter(expectedBookName = null, expectedWorkId = null, timeoutMs = null) {
  const pageText = visiblePageText();
  if (isLoginPage(pageText)) {
    return failure("番茄登录状态已失效，请先登录。", "login_required", { mutationAttempted: false });
  }
  const currentWorkId = extractPlatformWorkId(location.href);
  if (expectedWorkId && currentWorkId !== String(expectedWorkId)) {
    return failure("当前番茄页面不是已绑定的目标作品，拒绝创建章节。", "work_identity_mismatch", {
      currentWorkId, expectedWorkId, mutationAttempted: false
    });
  }
  if (!expectedWorkId && expectedBookName && !normalizeCompact(pageText).includes(normalizeCompact(expectedBookName))) {
    return failure("当前作家后台没有识别到目标作品，拒绝创建章节。", "work_identity_mismatch", {
      mutationAttempted: false
    });
  }

  // “新建章节”只负责可逆的页面导航。番茄是 SPA，标题栏通常比按钮先挂载，
  // 因此在一次用户点击中等待按钮出现，而不是让用户反复点击插件。
  const requestedWait = timeoutMs === null || timeoutMs === undefined ? NEW_CHAPTER_READY_TIMEOUT_MS : Number(timeoutMs);
  const waitMs = Number.isFinite(requestedWait)
    ? Math.min(Math.max(requestedWait, 0), NEW_CHAPTER_READY_TIMEOUT_MS)
    : NEW_CHAPTER_READY_TIMEOUT_MS;
  const deadline = Date.now() + waitMs;
  const actionRoot = () => (!expectedWorkId && expectedBookName ? findWorkRoot(expectedBookName) : document) || document;
  let found = findNewChapterControl(actionRoot());
  while (!found.element && Date.now() < deadline) {
    await sleep(Math.min(AUTOMATION_LIMITS.pollMs, Math.max(1, deadline - Date.now())));
    found = findNewChapterControl(actionRoot());
  }
  if (!found.element) {
    return failure(
      "章节管理页已经打开，但“新建章节”按钮在 15 秒内仍未加载。页面未被操作，请直接重试主按钮。",
      "new_chapter_button_missing",
      { mutationAttempted: false, candidates: found.candidates, url: location.href }
    );
  }
  try {
    clickVisible(found.element);
  } catch (error) {
    return failure(normalizeError(error), "new_chapter_click_rejected", {
      mutationAttempted: false,
      selected: describeActionElement(found.element),
      candidates: found.candidates
    });
  }
  return {
    ok: true,
    code: "new_chapter_clicked",
    mutationAttempted: true,
    selected: describeActionElement(found.element),
    page: inspectPage()
  };
}

async function clickNext(chapter) {
  const ready = await waitForEditorFields();
  if (!ready.value) return failure("点击下一步前未识别到已加载完成的编辑器。", "editor_missing");
  if (chapter) {
    const comparison = compareChapterFields(ready.value, chapter);
    if (!comparison.titleMatches || !comparison.bodyMatches || !comparison.chapterMatches) {
      return failure("点击下一步前页面内容校验失败，已停止。", "pre_next_mismatch", {
        observedTitle: comparison.observedTitle,
        observedChapterNo: comparison.observedChapterNo,
        observedCharCount: comparison.observedCharCount
      });
    }
  }

  // “下一步”是一次不可随意猜测的页面操作。只接受真正的 button 或
  // role=button，文字必须完全相等，并选择页面最下方的有效候选。旧版把普通
  // div 也当按钮，可能点中新手引导或外层容器，导致编辑器被重挂载/清空。
  const before = captureTransitionDiagnostics();
  const found = findStrictNextButton();
  if (!found.element) {
    return failure("没有找到唯一可验证的“下一步”按钮，已停止且未操作页面。", "next_button_missing", {
      candidates: found.candidates,
      diagnostics: before
    });
  }
  const selected = describeActionElement(found.element);
  clickVisible(found.element);
  // 让同步的弹窗、SPA 路由或编辑器重挂载先发生，留下可核对的前后证据。
  await sleep(150);
  const after = captureTransitionDiagnostics(before);
  return {
    ok: true,
    code: "next_clicked",
    selected,
    candidates: found.candidates,
    transition: { before, after }
  };
}

async function completePublicationFlow(options) {
  const requestedTimeout = Number(options.transitionTimeoutMs || AUTOMATION_LIMITS.transitionMs);
  const transitionTimeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(Math.max(requestedTimeout, 100), AUTOMATION_LIMITS.transitionMs)
    : AUTOMATION_LIMITS.transitionMs;
  const deadline = Date.now() + transitionTimeoutMs;
  const transition = await waitFor(() => detectPostNextState(), deadline);
  if (transition.blocked) {
    return failure("检测到风险控制或验证码页面，必须人工处理。", "risk_control_detected", {
      transition: options.nextTransition || null,
      diagnostics: captureTransitionDiagnostics(options.nextTransition?.before || null)
    });
  }
  if (!transition.value) {
    return failure("下一步后页面没有进入可识别的发布流程，已停止。", "post_next_state_unknown", {
      transition: options.nextTransition || null,
      diagnostics: captureTransitionDiagnostics(options.nextTransition?.before || null)
    });
  }
  if (transition.value.kind === "validation") {
    return failure("番茄没有接受“下一步”：页面仍有必填项或内容校验错误。", "post_next_validation_error", {
      validationMessages: transition.value.messages,
      transition: options.nextTransition || null,
      diagnostics: captureTransitionDiagnostics(options.nextTransition?.before || null)
    });
  }
  if (transition.value.kind === "typo") {
    const submit = findButtonInRoot(transition.value.root, ["提交"]);
    if (!submit.element) return failure("已识别错别字提示，但没有找到同一弹窗内的提交按钮。", "typo_submit_missing");
    clickVisible(submit.element);
    const disappeared = await waitFor(() => !findTypoDialog(), Date.now() + 8_000);
    if (!disappeared.value) return failure("错别字提示提交后没有消失，已停止。", "typo_dialog_not_closed");
    // The full-check control is mounted asynchronously in some Fanqie releases.
    // Do not fail in the small gap between the typo dialog disappearing and the next
    // stage appearing.
    const nextStage = await waitFor(() => {
      if (findKnownDialog(/风险|违规|验证码|安全验证|人机验证|captcha/iu)) return { blocked: true };
      return findPublicationRoot() || hasPublicationSettings(visiblePageText()) || findActionButton(["全面检测", "全文检测"]).element;
    }, Date.now() + 10_000);
    if (nextStage.blocked) return failure("错别字提示后出现风险控制，已停止。", "risk_control_detected");
    if (!nextStage.value) {
      return failure("错别字提示已提交，但后续检测页面没有加载出来。", "post_typo_state_unknown", {
        diagnostics: captureTransitionDiagnostics(options.nextTransition?.before || null)
      });
    }
  }

  const risk = findKnownDialog(/风险|违规|验证码|安全验证|人机验证|captcha/iu);
  if (risk) return failure("检测到风险控制或验证码页面，必须人工处理。", "risk_control_detected");

  const settingsAlreadyVisible = hasPublicationSettings(visiblePageText());
  const fullCheck = findActionButton(["全面检测", "全文检测"]);
  if (!settingsAlreadyVisible && !fullCheck.element) {
    return failure("没有找到“全面检测”按钮或发布设置，页面状态未知。", "full_check_button_missing");
  } else if (!settingsAlreadyVisible) {
    const before = visiblePageText();
    clickVisible(fullCheck.element);
    const checked = await waitFor(() => {
      if (findKnownDialog(/风险|违规|验证码|安全验证|人机验证|captcha/iu)) return { blocked: true };
      const text = visiblePageText();
      const settings = hasPublicationSettings(text);
      const button = findActionButton(["全面检测", "全文检测"]);
      const completeText = /检测完成|检测通过|检测结果|发布设置/iu.test(text);
      return settings || (completeText && text !== before && (!button.element || !button.element.disabled));
    }, Date.now() + AUTOMATION_LIMITS.fullCheckMs);
    if (checked.blocked) return failure("全面检测触发了风险控制，已停止。", "risk_control_detected");
    if (!checked.value) return failure("等待“全面检测”完成超时，未进入可验证的发布设置。", "full_check_timeout");
  }

  const settings = findPublicationRoot();
  if (!settings) return failure("没有识别到发布设置区域，已停止。", "publish_settings_missing");

  const contextResult = verifyPublicationContext(settings, options);
  if (!contextResult.ok) return contextResult;

  const aiResult = configureAiPolicy(settings, options.aiPolicy || "remember");
  if (!aiResult.ok) return aiResult;
  const scheduleResult = configureSchedule(settings, options.publicationDate, options.publicationTime);
  if (!scheduleResult.ok) return scheduleResult;

  const submit = findButtonInRoot(settings, ["定时发布", "确认发布", "提交发布", "发布"]);
  if (!submit.element) return failure("发布设置中没有找到可验证的最终提交按钮。", "final_submit_missing");
  if (options.deferFinalSubmit) {
    return {
      ok: true,
      code: "publication_ready",
      publicationDate: scheduleResult.publicationDate,
      publicationTime: scheduleResult.publicationTime,
      aiPolicy: aiResult.policy,
      evidence: normalizeBody(readField(settings)).slice(0, 1000),
      url: location.href
    };
  }
  return submitPreparedPublication(options);
}

async function submitPreparedPublication(options) {
  const settings = findPublicationRoot();
  if (!settings) return failure("没有识别到已经准备好的发布设置区域。", "publish_settings_missing");
  const contextResult = verifyPublicationContext(settings, options);
  if (!contextResult.ok) return contextResult;
  const aiResult = configureAiPolicy(settings, options.aiPolicy || "remember");
  if (!aiResult.ok) return aiResult;
  const scheduleResult = configureSchedule(settings, options.publicationDate, options.publicationTime);
  if (!scheduleResult.ok) return scheduleResult;
  const submit = findButtonInRoot(settings, ["定时发布", "确认发布", "提交发布", "发布"]);
  if (!submit.element) return failure("发布设置中没有找到可验证的最终提交按钮。", "final_submit_missing");
  const beforeSubmitText = visiblePageText();
  clickVisible(submit.element);

  const success = await waitFor(() => {
    const riskDialog = findKnownDialog(/风险|违规|验证码|安全验证|人机验证|captcha/iu);
    if (riskDialog) return { blocked: true };
    const text = visiblePageText();
    const successText = /定时发布成功|发布成功|提交成功|已定时发布|已发布|发布完成/iu.test(text);
    const changed = text !== beforeSubmitText;
    const scheduleEvidence = text.includes(String(options.publicationDate || "")) || text.includes(String(options.publicationTime || "")) || text.includes(String(options.chapterNo || ""));
    return successText && changed && (scheduleEvidence || !hasPublicationSettings(text));
  }, Date.now() + AUTOMATION_LIMITS.successMs);
  if (success.blocked) return failure(
    "最终提交后出现风险控制或验证码，结果未知。",
    "risk_control_detected",
    { finalSubmitAttempted: true }
  );
  if (!success.value) return failure(
    "最终提交后未读取到可验证的成功/定时状态，结果未知。",
    "submission_unverified",
    { finalSubmitAttempted: true }
  );

  return {
    ok: true,
    code: "schedule_submitted",
    publicationDate: options.publicationDate || null,
    publicationTime: options.publicationTime || null,
    aiPolicy: aiResult.policy,
    finalSubmitAttempted: true,
    evidence: visiblePageText().slice(0, 1000),
    url: location.href
  };
}

function verifyPublicationContext(root, options) {
  const chapterNo = Number(options.chapterNo || 0);
  if (!Number.isInteger(chapterNo) || chapterNo < 1) {
    return failure("发布设置缺少有效的计划章节号。", "publish_chapter_context_missing");
  }
  const text = normalizeBody(readField(root));
  const currentPattern = new RegExp(`(?:本次(?:提交|发布)[^\\d]{0,12}(?:第\\s*)?${chapterNo}\\s*章?|当前章节[^\\d]{0,12}(?:第\\s*)?${chapterNo}\\s*章?|章节(?:号)?[^\\d]{0,8}(?:第\\s*)?${chapterNo}\\s*章?)`, "iu");
  if (!currentPattern.test(text)) {
    return failure("发布设置中无法确认本次章节号，拒绝提交。", "publish_chapter_context_unverified", {
      expectedChapterNo: chapterNo,
      contextPreview: text.slice(0, 500)
    });
  }
  const previous = text.match(/上(?:一|次)(?:次)?(?:提交|发布)[\s\S]{0,50}?第?\s*(\d+)\s*章/iu);
  if (previous && Number(previous[1]) !== chapterNo - 1) {
    return failure("发布设置显示的上次章节与当前计划不连续，已停止。", "previous_chapter_mismatch", {
      expectedPreviousChapterNo: chapterNo - 1,
      observedPreviousChapterNo: Number(previous[1])
    });
  }
  return { ok: true, chapterNo };
}

function detectPostNextState() {
  const riskDialog = findKnownDialog(/风险|违规|验证码|安全验证|人机验证|captcha/iu);
  if (riskDialog) return { blocked: true };
  const typoDialog = findTypoDialog();
  if (typoDialog) return { value: { kind: "typo", root: typoDialog } };
  if (findPublicationRoot() || hasPublicationSettings(visiblePageText())) {
    return { value: { kind: "ready" } };
  }
  if (findActionButton(["全面检测", "全文检测"]).element) {
    return { value: { kind: "ready" } };
  }
  const messages = visibleValidationMessages();
  if (messages.length) return { value: { kind: "validation", messages } };
  return false;
}

function visibleValidationMessages() {
  const pattern = /(?:标题|正文|章节|字数|内容).{0,18}(?:不能为空|未填写|不符合|错误|失败|限制|至少|最多)|请(?:填写|输入|完善).{0,18}(?:标题|正文|章节|内容)/iu;
  return [...document.querySelectorAll(
    "[role='alert'], [aria-live='assertive'], .error, [class*='error'], [class*='invalid'], [class*='form-message'], [class*='form-item-message']"
  )]
    .filter(isVisible)
    .map((element) => normalizeBody(readField(element)))
    .filter((text) => text && text.length <= 500 && pattern.test(text))
    .filter((text, index, values) => values.indexOf(text) === index)
    .slice(0, 12);
}

function captureTransitionDiagnostics(baseline = null) {
  const fields = locateFields();
  const text = visiblePageText();
  const dialogs = [...document.querySelectorAll(
    "[role='dialog'], [aria-modal='true'], .modal, .dialog, [class*='modal'], [class*='dialog'], [class*='popup'], [class*='confirm'], [class*='message-box']"
  )]
    .filter(isVisible)
    .map((element) => ({
      element: describeElement(element),
      text: normalizeBody(readField(element)).slice(0, 800)
    }))
    .filter((item) => item.text)
    .slice(0, 12);
  const visibleButtons = [...document.querySelectorAll(
    "button, [role='button'], a[href], input[type='button'], input[type='submit']"
  )]
    .filter(isVisible)
    .filter(isActionEnabled)
    .map(describeActionElement)
    .filter((item) => item.text || item.ariaLabel)
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
    .slice(0, 40);
  let state = "unknown";
  if (isLoginPage(text)) state = "login_required";
  else if (findPublicationRoot() || hasPublicationSettings(text)) state = "publish_settings";
  else if (fields.titleField && fields.editor) state = "editor";
  else if (isWriterPage(text)) state = "writer";
  const url = location.href;
  return {
    capturedAt: new Date().toISOString(),
    url,
    urlChanged: Boolean(baseline?.url && baseline.url !== url),
    title: document.title,
    readyState: document.readyState,
    state,
    workId: extractPlatformWorkId(url),
    editor: {
      present: Boolean(fields.titleField && fields.editor),
      titlePresent: Boolean(fields.titleField),
      chapterNumberPresent: Boolean(fields.chapterNumberField),
      observedTitle: fields.titleField ? readField(fields.titleField).trim().slice(0, 240) : "",
      observedChapterNo: fields.chapterNumberField ? readField(fields.chapterNumberField).trim().slice(0, 80) : "",
      observedCharCount: fields.editor ? countVisibleCharacters(normalizeBody(readField(fields.editor))) : 0,
      diagnostics: fields.diagnostics
    },
    visibleButtons,
    dialogs,
    validationMessages: visibleValidationMessages(),
    pageTextStart: text.slice(0, 1200),
    pageTextEnd: text.slice(-1200)
  };
}

function inspectWorks(expectedBookName = null) {
  const text = visiblePageText();
  if (isLoginPage(text)) return failure("番茄登录状态已失效，请先登录。", "login_required");
  const expected = normalizeCompact(expectedBookName || "");
  const byWorkId = new Map();
  for (const anchor of document.querySelectorAll("a[href]")) {
    if (!isVisible(anchor)) continue;
    const href = anchor.href || anchor.getAttribute("href") || "";
    const workId = extractPlatformWorkId(href);
    if (!workId) continue;
    const root = anchor.closest("article, li, tr, [class*='book'], [class*='card'], [class*='work'], [class*='item']") || anchor;
    const rootText = normalizeBody(readField(root)).slice(0, 1000);
    const anchorText = normalizeBody(readField(anchor)).slice(0, 300);
    const name = rootText || anchorText;
    const candidate = {
      workId,
      name,
      href,
      matchesBookName: Boolean(expected && normalizeCompact(name).includes(expected))
    };
    const previous = byWorkId.get(workId);
    if (!previous || candidate.matchesBookName || (!previous.matchesBookName && candidate.name.length < previous.name.length)) {
      byWorkId.set(workId, candidate);
    }
  }
  const works = [...byWorkId.values()];
  return {
    ok: true,
    state: "book_manage",
    url: location.href,
    works,
    matchedWorkId: works.find((item) => item.matchesBookName)?.workId || (works.length === 1 ? works[0].workId : null)
  };
}

async function inspectPublicationList(chapterNos, timeoutMs = null) {
  const requestedWait = timeoutMs === null || timeoutMs === undefined ? PUBLICATION_LIST_TIMEOUT_MS : Number(timeoutMs);
  const waitMs = Number.isFinite(requestedWait)
    ? Math.min(Math.max(requestedWait, 0), PUBLICATION_LIST_TIMEOUT_MS)
    : PUBLICATION_LIST_TIMEOUT_MS;
  const deadline = Date.now() + waitMs;
  let firstReadyAt = 0;
  let stableSince = 0;
  let stableSignature = null;
  let lastSnapshot = null;

  while (Date.now() < deadline) {
    const snapshot = readPublicationListSnapshot(chapterNos);
    lastSnapshot = snapshot;
    if (snapshot.loginRequired) {
      return failure("番茄登录状态已失效，请先登录。", "login_required", {
        listStable: false, newChapterReady: false, url: location.href
      });
    }

    // A usable toolbar is not proof that the asynchronous list data has arrived.
    // Negative evidence ("chapter N is absent") is accepted only after we can see
    // at least one real chapter record, or an explicit empty-list state.
    const ready = snapshot.recognized && !snapshot.loading && snapshot.newChapterReady && snapshot.listContentReady;
    if (ready) {
      if (!firstReadyAt) firstReadyAt = Date.now();
      const signature = publicationSnapshotSignature(snapshot);
      if (signature !== stableSignature) {
        stableSignature = signature;
        stableSince = Date.now();
      }
      const settledLongEnough = Date.now() - firstReadyAt >= PUBLICATION_LIST_MIN_SETTLE_MS;
      const unchangedLongEnough = Date.now() - stableSince >= PUBLICATION_LIST_STABLE_MS;
      if (settledLongEnough && unchangedLongEnough) {
        return {
          ...snapshot,
          ok: true,
          state: "publication_list",
          listStable: true,
          stabilityMs: Date.now() - stableSince
        };
      }
    } else {
      firstReadyAt = 0;
      stableSince = 0;
      stableSignature = null;
    }
    await sleep(AUTOMATION_LIMITS.pollMs);
  }

  const details = {
    ...(lastSnapshot || {}),
    ok: false,
    listStable: false,
    url: location.href
  };
  if (!lastSnapshot?.recognized) {
    return failure("15 秒内没有识别到完整的章节管理页。请确认番茄页面可正常打开后重试。", "publication_list_not_recognized", details);
  }
  if (!lastSnapshot?.newChapterReady) {
    return failure("章节管理页尚未加载完成：“新建章节”按钮不可用。页面未被读取为“章节不存在”。", "publication_list_not_ready", details);
  }
  if (!lastSnapshot?.listContentReady) {
    return failure("章节管理页的工具栏已经出现，但章节列表数据尚未加载。页面未被读取为“章节不存在”。", "publication_list_content_not_ready", details);
  }
  return failure("章节列表仍在加载或变化，未使用这次不完整结果。请直接重试主按钮。", "publication_list_unstable", details);
}

function readPublicationListSnapshot(chapterNos) {
  const text = visiblePageText();
  const loginRequired = isLoginPage(text);
  const recognized = /章节管理|章节列表|草稿箱/iu.test(text);
  const newChapter = findNewChapterControl();
  const loading = publicationListIsLoading(text);
  const rowCandidates = recognized
    ? [...document.querySelectorAll("tr, li, article, [role='row'], [class*='chapter'], [class*='row'], div")]
      .filter(isVisible)
      .map((element) => normalizeBody(readField(element)))
      .filter((value) => value && value.length <= 1600)
    : [];
  const textLines = recognized ? text.split("\n").map((line) => line.trim()).filter(Boolean) : [];
  const listRecords = recognized ? publicationListRecords(rowCandidates) : [];
  const emptyList = recognized && publicationListHasExplicitEmptyState(textLines);
  const rows = [];
  for (const chapterNo of chapterNos.map(Number)) {
    const rowText = findChapterRowText(chapterNo, rowCandidates, textLines);
    const timeMatch = rowText.match(/(?:^|\D)([012]?\d):([0-5]\d)(?:\D|$)/u);
    const publicationDate = parsePublicationDate(rowText);
    const publicationTime = timeMatch
      ? `${String(timeMatch[1]).padStart(2, "0")}:${timeMatch[2]}`
      : null;
    const published = Boolean(rowText && /已发布|已上线/iu.test(rowText));
    const reviewing = Boolean(rowText && /审核中|待审核|审核通过|审核未通过|审核失败|驳回/iu.test(rowText));
    const scheduled = Boolean(rowText && !published && (/定时|待发布|已安排/iu.test(rowText) || (reviewing && publicationDate)));
    const draft = Boolean(rowText && /草稿|未提交/iu.test(rowText));
    rows.push({
      chapterNo,
      found: Boolean(rowText),
      text: rowText || null,
      scheduled,
      published,
      reviewing,
      draft,
      platformStatus: published ? "published" : reviewing ? "reviewing" : scheduled ? "scheduled" : draft ? "draft" : "unknown",
      publicationDate,
      publicationTime
    });
  }
  return {
    ok: false,
    state: recognized ? "publication_list_loading" : "unknown",
    url: location.href,
    workId: extractPlatformWorkId(location.href),
    loginRequired,
    recognized,
    loading,
    listStable: false,
    listContentReady: listRecords.length > 0 || emptyList,
    emptyList,
    observedChapterNos: [...new Set(listRecords.flatMap((value) => [...distinctChapterNumbers(value)]))].sort((a, b) => a - b),
    listRecordSignature: listRecords.map((value) => normalizeCompact(value).slice(0, 500)),
    newChapterReady: Boolean(newChapter.element),
    newChapterCandidates: newChapter.candidates,
    rows
  };
}

function publicationSnapshotSignature(snapshot) {
  return JSON.stringify({
    workId: snapshot.workId || null,
    newChapterReady: Boolean(snapshot.newChapterReady),
    listContentReady: Boolean(snapshot.listContentReady),
    emptyList: Boolean(snapshot.emptyList),
    observedChapterNos: snapshot.observedChapterNos || [],
    listRecordSignature: snapshot.listRecordSignature || [],
    rows: (snapshot.rows || []).map((row) => ({
      chapterNo: Number(row.chapterNo),
      found: Boolean(row.found),
      platformStatus: row.platformStatus,
      publicationDate: row.publicationDate || null,
      publicationTime: row.publicationTime || null,
      text: normalizeCompact(row.text || "")
    }))
  });
}

function publicationListRecords(rowCandidates) {
  const chapterPattern = /第\s*\d+\s*章/iu;
  const statePattern = /定时|待发布|已安排|已发布|已上线|草稿|未提交|审核中|待审核|审核通过|审核未通过|审核失败|驳回/iu;
  const records = rowCandidates
    .filter((value) => chapterPattern.test(value) && statePattern.test(value))
    // List/table ancestors mention several chapters and do not represent one record.
    .filter((value) => distinctChapterNumbers(value).size === 1)
    .map((value) => normalizeBody(value).slice(0, 1200));
  return [...new Set(records)].sort();
}

function publicationListHasExplicitEmptyState(textLines) {
  const exactEmpty = /^(?:暂无(?:章节|章节数据)|暂未(?:创建|发布|添加)?章节|还没有章节|尚无章节)(?:[，。！!；;：:]?.{0,20})?$/iu;
  if (textLines.some((line) => line.length <= 60 && exactEmpty.test(line))) return true;
  return [...document.querySelectorAll("[class*='empty'], [class*='Empty'], [data-testid*='empty'], [data-test*='empty']")]
    .filter(isVisible)
    .map((element) => normalizeBody(readField(element)))
    .some((value) => value.length <= 120 && exactEmpty.test(value));
}

function publicationListIsLoading(text) {
  if (document.readyState !== "complete") return true;
  if (/(?:^|\n)\s*(?:加载中|正在加载|请稍候)[…。.\s]*(?:$|\n)/iu.test(String(text || ""))) return true;
  return [...document.querySelectorAll(
    "[aria-busy='true'], [role='progressbar'], [class*='skeleton'], [class*='spin-loading'], [class*='spinning']"
  )].some((element) => {
    if (!isVisible(element)) return false;
    const marker = `${element.id || ""} ${typeof element.className === "string" ? element.className : ""}`;
    return element.getAttribute("aria-busy") === "true" || /skeleton|spin-loading|spinning/iu.test(marker);
  });
}

function findChapterRowText(chapterNo, rowCandidates, textLines) {
  const pattern = new RegExp(`(?:第\\s*${chapterNo}\\s*章|章节号[^\\d]{0,8}${chapterNo}(?:\\D|$))`, "iu");
  const statePattern = /定时|待发布|已安排|已发布|已上线|草稿|未提交|审核中|待审核|审核通过|审核未通过|审核失败|驳回/iu;

  // A container that mentions several chapters is a table/list ancestor, not a row.
  // Reject it so chapter 6 cannot borrow chapter 4's “已发布” state.
  const candidates = rowCandidates
    .filter((value) => pattern.test(value))
    .filter((value) => {
      const numbers = distinctChapterNumbers(value);
      return numbers.size === 0 || (numbers.size === 1 && numbers.has(Number(chapterNo)));
    });

  const lineBlock = chapterTextBlock(chapterNo, textLines);
  if (lineBlock) candidates.push(lineBlock);
  const unique = [...new Set(candidates)];
  const withState = unique.filter((value) => statePattern.test(value)).sort((a, b) => a.length - b.length);
  if (withState.length) return withState[0].slice(0, 700);
  unique.sort((a, b) => a.length - b.length);
  return unique.length ? unique[0].slice(0, 700) : "";
}

function distinctChapterNumbers(text) {
  const result = new Set();
  for (const match of String(text || "").matchAll(/第\s*(\d+)\s*章/gu)) result.add(Number(match[1]));
  return result;
}

function chapterTextBlock(chapterNo, textLines) {
  const startPattern = new RegExp(`^第\\s*${chapterNo}\\s*章(?:\\s|$)`, "iu");
  const anyChapterPattern = /^第\s*\d+\s*章(?:\s|$)/iu;
  const start = textLines.findIndex((line) => startPattern.test(line));
  if (start < 0) return "";
  const block = [textLines[start]];
  for (let index = start + 1; index < textLines.length && block.length < 12; index += 1) {
    if (anyChapterPattern.test(textLines[index])) break;
    block.push(textLines[index]);
  }
  return normalizeBody(block.join("\n"));
}

function parsePublicationDate(text) {
  const value = String(text || "");
  const full = value.match(/(20\d{2})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})日?/u);
  if (full) return `${full[1]}-${String(full[2]).padStart(2, "0")}-${String(full[3]).padStart(2, "0")}`;
  const now = new Date();
  if (/今天/u.test(value)) return localIsoDate(now);
  if (/明天/u.test(value)) return localIsoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const short = value.match(/(?:^|\D)(\d{1,2})[月\-\/.](\d{1,2})日?(?:\D|$)/u);
  if (short) return `${now.getFullYear()}-${String(short[1]).padStart(2, "0")}-${String(short[2]).padStart(2, "0")}`;
  return null;
}

function localIsoDate(value) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function configureAiPolicy(root, policy) {
  const normalized = String(policy || "remember");
  if (normalized === "remember") {
    const selected = findSelectedChoice(root, /使用\s*AI|不使用\s*AI|是|否|AI/iu);
    if (!selected) return failure("发布设置中的 AI 选项没有明确选择，无法安全沿用。", "ai_choice_ambiguous");
    return { ok: true, policy: selected.text };
  }
  if (normalized === "ask") {
    return {
      ok: false,
      paused: true,
      error: "请在当前发布设置页手动选择是否使用 AI，然后回到插件点击继续。",
      code: "ai_choice_required"
    };
  }
  const wantUse = normalized === "use" || normalized === "yes" || normalized === "使用AI";
  const wantNo = normalized === "no" || normalized === "否" || normalized === "不使用AI";
  if (!wantUse && !wantNo) return failure("未知的 AI 声明策略。", "ai_policy_unknown");
  const choice = findChoice(root, wantUse ? /使用\s*AI|是/iu : /不使用\s*AI|否/iu);
  if (!choice.element) return failure("没有找到指定的 AI 声明选项。", "ai_choice_missing");
  clickVisible(choice.element);
  const selected = findSelectedChoice(root, /使用\s*AI|不使用\s*AI|是|否|AI/iu);
  if (!selected || (wantUse && !/是|使用/iu.test(selected.text)) || (wantNo && !/否|不使用/iu.test(selected.text))) {
    return failure("AI 声明选项点击后无法验证。", "ai_choice_unverified");
  }
  return { ok: true, policy: selected.text };
}

function configureSchedule(root, publicationDate, publicationTime) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(publicationDate || ""))) return failure("计划日期格式无效。", "schedule_date_invalid");
  if (!/^\d{2}:\d{2}$/u.test(String(publicationTime || ""))) return failure("计划时间格式无效。", "schedule_time_invalid");

  const timing = findChoice(root, /定时发布|定时/iu);
  if (!timing.element) return failure("没有找到明确的“定时发布”模式选项。", "schedule_mode_missing");
  clickVisible(timing.element);
  const selectedTiming = findSelectedChoice(root, /定时发布|定时/iu);
  if (!selectedTiming) return failure("“定时发布”模式点击后无法验证，拒绝最终提交。", "schedule_mode_unverified");

  const dateField = findLabeledControl(root, /日期|发布日|时间/iu, "date");
  if (!dateField) return failure("没有找到可验证的定时日期控件。", "schedule_date_control_missing");
  setControlValue(dateField, publicationDate);
  const observedDate = readControlValue(dateField);
  if (!dateMatches(observedDate, publicationDate)) return failure("定时日期写入后校验不一致。", "schedule_date_unverified", { observedDate });

  const timeField = findLabeledControl(root, /时间|时刻/iu, "time");
  if (timeField) {
    setControlValue(timeField, publicationTime);
  } else {
    const timeChoice = findChoice(root, new RegExp(escapeRegex(publicationTime), "u"));
    if (!timeChoice.element) return failure("没有找到可验证的定时时间控件。", "schedule_time_control_missing");
    clickVisible(timeChoice.element);
  }
  const observedTime = timeField ? readControlValue(timeField) : visiblePageText();
  if (timeField && !timeMatches(observedTime, publicationTime)) return failure("定时时间写入后校验不一致。", "schedule_time_unverified", { observedTime });
  return { ok: true, publicationDate, publicationTime };
}

function findWorkRoot(bookName) {
  const expected = normalizeCompact(bookName);
  const candidates = [...document.querySelectorAll("article, tr, li, [class*='book'], [class*='card'], [class*='row'], main, body")]
    .filter(isVisible)
    .filter((element) => normalizeCompact(readField(element)).includes(expected))
    .filter((element) => findNewChapterControl(element).element)
    .sort((a, b) => readField(a).length - readField(b).length);
  return candidates[0] || null;
}

function findPublicationRoot() {
  const candidates = [...document.querySelectorAll("[role='dialog'], .modal, .dialog, [class*='modal'], [class*='dialog'], body")]
    .filter(isVisible)
    .filter((element) => /发布设置|定时发布|确认发布/iu.test(normalizeBody(readField(element))))
    .sort((a, b) => readField(a).length - readField(b).length);
  return candidates[0] || null;
}

function findTypoDialog() {
  const known = findKnownDialog(/错别字|错字/iu);
  if (known) return known;
  // Some Fanqie releases use an unlabelled ByteDance overlay. Accept only the
  // smallest visible container that has both the exact prompt meaning and its own
  // Submit button, so page prose containing “错别字” cannot be mistaken for a dialog.
  const candidates = [...document.querySelectorAll("section, article, div")]
    .filter(isVisible)
    .filter((element) => {
      const text = normalizeBody(readField(element));
      return text.length <= 1000 && /错别字|错字/iu.test(text) && Boolean(findButtonInRoot(element, ["提交"]).element);
    })
    .sort((a, b) => readField(a).length - readField(b).length);
  return candidates[0] || null;
}

function findKnownDialog(pattern) {
  const candidates = [...document.querySelectorAll(
    "[role='dialog'], [aria-modal='true'], .modal, .dialog, [class*='modal'], [class*='dialog'], [class*='popup'], [class*='confirm'], [class*='message-box']"
  )]
    .filter(isVisible)
    .filter((element) => pattern.test(normalizeBody(readField(element))));
  return candidates.sort((a, b) => readField(a).length - readField(b).length)[0] || null;
}

function findButtonInRoot(root, texts) {
  return findActionButton(texts, root);
}

function isActionEnabled(element) {
  if (!element) return false;
  if ("disabled" in element && element.disabled) return false;
  if (element.getAttribute("aria-disabled") === "true") return false;
  const className = typeof element.className === "string" ? element.className : "";
  return !/(?:^|[\s_-])disabled(?:$|[\s_-])/iu.test(className);
}

function actionText(element) {
  return normalizeCompact(element?.innerText || element?.textContent || element?.value || element?.getAttribute?.("aria-label") || "");
}

function describeActionElement(element) {
  const rect = element.getBoundingClientRect();
  const className = typeof element.className === "string" ? element.className : "";
  return {
    tag: element.tagName,
    id: element.id || "",
    className: className.slice(0, 220),
    role: element.getAttribute("role") || "",
    ariaLabel: element.getAttribute("aria-label") || "",
    text: actionText(element).slice(0, 240),
    rect: {
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  };
}

function findNewChapterControl(root = document) {
  const wanted = new Set([normalizeCompact("新建章节"), normalizeCompact("新建章")]);
  const excluded = (element) => Boolean(element.closest(
    "[role='dialog'], [aria-modal='true'], [class*='guide'], [class*='tutorial'], [class*='tour'], [class*='popover']"
  ));
  const smallEnough = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.width <= 420 && rect.height <= 140 && rect.width * rect.height <= 45_000;
  };
  const candidates = [];
  const seen = new Set();
  const add = (element, priority, source) => {
    if (!element || seen.has(element) || !isVisible(element) || !isActionEnabled(element) || excluded(element)) return;
    if (!wanted.has(actionText(element))) return;
    if (source !== "semantic" && !smallEnough(element)) return;
    seen.add(element);
    const descriptor = describeActionElement(element);
    const actionArea = Boolean(element.closest(
      "header, [class*='header'], [class*='toolbar'], [class*='operation'], [class*='action']"
    ));
    candidates.push({ element, priority: priority + (actionArea ? 20 : 0), source, actionArea, descriptor });
  };

  for (const element of root.querySelectorAll(
    "button, [role='button'], a[href], input[type='button'], input[type='submit']"
  )) add(element, 300, "semantic");

  // Some Fanqie releases render a button as exact text in a span/div inside a custom
  // clickable div. Climb only to a small exact-text clickable ancestor; never click a
  // large list/header container merely because it contains the phrase.
  for (const leaf of root.querySelectorAll("span, div")) {
    if (!isVisible(leaf) || !wanted.has(actionText(leaf)) || excluded(leaf)) continue;
    const nestedExact = [...leaf.children].some((child) => wanted.has(actionText(child)));
    if (nestedExact) continue;
    let candidate = leaf.closest("button, [role='button'], a[href], [tabindex]");
    if (!candidate) {
      let current = leaf;
      for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
        const marker = `${current.id || ""} ${typeof current.className === "string" ? current.className : ""}`;
        // cursor is inherited, so computedStyle alone would make a harmless child span
        // look clickable when only a huge ancestor owns the click. Require evidence on
        // the candidate element itself.
        const computedPointer = window.getComputedStyle(current).cursor === "pointer";
        const inheritedPointer = current.parentElement
          ? window.getComputedStyle(current.parentElement).cursor === "pointer"
          : false;
        const explicitPointer = current.style?.cursor === "pointer" || (computedPointer && !inheritedPointer);
        const clickable = typeof current.onclick === "function" || explicitPointer || /(?:^|[\s_-])(?:btn|button|create|add|new|action)(?:$|[\s_-])/iu.test(marker);
        if (clickable) { candidate = current; break; }
      }
    }
    if (candidate) add(candidate, 220, "custom-clickable");
  }

  candidates.sort((a, b) => (
    b.priority - a.priority ||
    a.descriptor.rect.top - b.descriptor.rect.top ||
    b.descriptor.rect.right - a.descriptor.rect.right
  ));
  return {
    element: candidates[0]?.element || null,
    candidates: candidates.slice(0, 12).map((item) => ({
      ...item.descriptor,
      source: item.source,
      actionArea: item.actionArea,
      priority: item.priority
    }))
  };
}

function findStrictNextButton(root = document) {
  const candidates = [...root.querySelectorAll("button, [role='button']")]
    .filter(isVisible)
    .filter(isActionEnabled)
    .filter((element) => actionText(element) === normalizeCompact("下一步"))
    .filter((element) => !element.closest(
      "[role='dialog'], [aria-modal='true'], [class*='guide'], [class*='tutorial'], [class*='tour'], [class*='popover']"
    ))
    .map((element) => {
      const descriptor = describeActionElement(element);
      const actionArea = Boolean(element.closest(
        "footer, [class*='footer'], [class*='bottom'], [class*='action'], [class*='operation'], [class*='operate'], [class*='submit']"
      ));
      return { element, descriptor, actionArea };
    });
  const scoped = candidates.some((item) => item.actionArea)
    ? candidates.filter((item) => item.actionArea)
    : candidates;
  scoped.sort((a, b) => (
    b.descriptor.rect.bottom - a.descriptor.rect.bottom ||
    b.descriptor.rect.right - a.descriptor.rect.right
  ));
  return {
    element: scoped[0]?.element || null,
    candidates: candidates
      .map((item) => ({ ...item.descriptor, actionArea: item.actionArea }))
      .sort((a, b) => b.rect.bottom - a.rect.bottom)
      .slice(0, 12)
  };
}

function findActionButton(texts, root = document) {
  const wanted = texts.map((text) => normalizeCompact(text));
  const candidates = [...root.querySelectorAll("button, [role='button'], a, input[type='button'], input[type='submit']")]
    .filter(isVisible)
    .filter(isActionEnabled)
    .map((element) => {
      const text = actionText(element);
      const exactIndex = wanted.findIndex((item) => text === item);
      const containsIndex = wanted.findIndex((item) => text.includes(item));
      const descriptor = describeActionElement(element);
      let score = exactIndex >= 0 ? 1000 - exactIndex * 20 : containsIndex >= 0 ? 500 - containsIndex * 20 : -1;
      if (score < 0) return null;
      if (/guide|tutorial|新手|tour|popover/iu.test(`${descriptor.id} ${descriptor.className} ${descriptor.ariaLabel}`)) score -= 500;
      if (/next|submit|publish|发布|下一步/iu.test(`${descriptor.id} ${descriptor.className} ${descriptor.ariaLabel}`)) score += 50;
      return { element, score, text, descriptor };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.descriptor.rect.bottom - a.descriptor.rect.bottom);
  return {
    element: candidates[0]?.element || null,
    candidates: candidates.slice(0, 8).map((item) => ({ text: item.text, score: item.score, ...item.descriptor }))
  };
}

function findChoice(root, pattern) {
  const candidates = [...root.querySelectorAll("label, [role='radio'], input[type='radio'], button, span, div")]
    .filter(isVisible)
    .map((element) => ({ element, text: normalizeBody(readField(element)) }))
    .filter((item) => item.text && pattern.test(item.text))
    .sort((a, b) => a.text.length - b.text.length);
  return candidates[0] || { element: null, text: "" };
}

function findSelectedChoice(root, pattern) {
  const candidates = [...root.querySelectorAll("label, [role='radio'], input[type='radio'], [aria-checked='true'], :checked")]
    .filter(isVisible)
    .map((element) => ({ element, text: normalizeBody(readField(element)) || element.getAttribute("aria-label") || "" }))
    .filter((item) => item.text && pattern.test(item.text));
  const checked = candidates.find((item) => elementIsSelected(item.element));
  return checked || null;
}

function elementIsSelected(element) {
  return Boolean(element.checked || element.getAttribute("aria-checked") === "true" || element.classList.contains("selected") || element.classList.contains("active"));
}

function findLabeledControl(root, pattern, type) {
  const selector = type === "date"
    ? "input[type='date'], input[placeholder*='日期'], input[aria-label*='日期'], input[name*='date'], input[class*='date'], input[type='text']"
    : "input[type='time'], input[placeholder*='时间'], input[aria-label*='时间'], input[name*='time'], input[class*='time'], select";
  const controls = [...root.querySelectorAll(selector)].filter(isVisible);
  const labeled = controls.filter((control) => {
    const parentText = normalizeBody(control.parentElement?.innerText || "");
    const labelText = control.getAttribute("aria-label") || control.getAttribute("placeholder") || "";
    return pattern.test(`${labelText} ${parentText}`);
  });
  return labeled[0] || (controls.length === 1 ? controls[0] : null);
}

function setControlValue(control, value) {
  if (control.tagName === "SELECT") {
    const option = [...control.options].find((item) => item.value === value || item.textContent.trim() === value);
    if (!option) throw new Error(`未找到选项:${value}`);
    control.value = option.value;
  } else {
    const prototype = control instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (!descriptor?.set) throw new Error("定时控件不可写");
    descriptor.set.call(control, value);
  }
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
  control.dispatchEvent(new Event("blur", { bubbles: true }));
}

function readControlValue(control) {
  return control.value || control.getAttribute("value") || "";
}

function dateMatches(observed, expected) {
  const text = String(observed || "");
  return text === expected || text.includes(expected) || text.includes(expected.replaceAll("-", "/"));
}

function timeMatches(observed, expected) {
  return String(observed || "").includes(expected);
}

function hasPublicationSettings(text) {
  return /发布设置|定时发布|确认发布/iu.test(String(text || ""));
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

function isWriterPage(text) {
  return /作家专区|作家中心|我的作品|章节管理|新建章节/iu.test(String(text || ""));
}

function isLoginPage(text) {
  const url = location.href;
  return /login|passport|account/iu.test(url) || (/登录|扫码登录|手机号登录/iu.test(String(text || "")) && !/作家专区|作家中心|章节管理/iu.test(String(text || "")));
}

function visiblePageText() {
  return normalizeBody(document.body?.innerText || document.body?.textContent || "");
}

function clickVisible(element) {
  if (!element || !isVisible(element)) throw new Error("目标控件不可见");
  if ("disabled" in element && element.disabled) throw new Error("目标控件当前不可用");
  element.scrollIntoView({ block: "center", inline: "center" });
  element.click();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, deadline) {
  while (Date.now() < deadline) {
    const result = predicate();
    if (result && typeof result === "object" && (result.blocked || Object.prototype.hasOwnProperty.call(result, "value"))) {
      if (result.blocked) return result;
      if (result.value) return result;
    } else if (result) {
      return { value: result };
    }
    await sleep(AUTOMATION_LIMITS.pollMs);
  }
  return { value: false };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
