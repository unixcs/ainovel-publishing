"use strict";

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
  "inspectPublicationList"
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
      return openNewChapter(message.bookName || null, message.workId || null);
    case "clickNext":
      return await clickNext(message.chapter);
    case "completePublicationFlow":
      return completePublicationFlow(message.options || {});
    case "inspectPublicationList":
      return inspectPublicationList(message.chapterNos || []);
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

function inspectPage(expectedBookName = null, expectedWorkId = null) {
  const body = visiblePageText();
  const fields = locateFields();
  const loginRequired = isLoginPage(body);
  const publishSettings = hasPublicationSettings(body);
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
    state,
    url: location.href,
    title: document.title,
    loginRequired,
    writer,
    editor,
    publishSettings,
    expectedBookName,
    expectedWorkId,
    currentWorkId,
    workMatches,
    diagnostics: fields.diagnostics,
    bodyPreview: body.slice(0, 500)
  };
}

function openNewChapter(expectedBookName = null, expectedWorkId = null) {
  const pageText = visiblePageText();
  if (isLoginPage(pageText)) return failure("番茄登录状态已失效，请先登录。", "login_required");
  const currentWorkId = extractPlatformWorkId(location.href);
  if (expectedWorkId && currentWorkId !== String(expectedWorkId)) {
    return failure("当前番茄页面不是已绑定的目标作品，拒绝创建章节。", "work_identity_mismatch", { currentWorkId, expectedWorkId });
  }
  if (!expectedWorkId && expectedBookName && !normalizeCompact(pageText).includes(normalizeCompact(expectedBookName))) {
    return failure("当前作家后台没有识别到目标作品，拒绝创建章节。", "work_identity_mismatch");
  }
  const root = !expectedWorkId && expectedBookName ? findWorkRoot(expectedBookName) : document;
  const button = findActionButton(["新建章节", "新建章"], root || document).element;
  if (!button) return failure("没有找到可验证的“新建章节”按钮。", "new_chapter_button_missing");
  clickVisible(button);
  return { ok: true, code: "new_chapter_clicked", page: inspectPage() };
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
  const found = findActionButton(["下一步"]);
  if (!found.element) return failure("没有找到可验证的“下一步”按钮。", "next_button_missing", { candidates: found.candidates });
  clickVisible(found.element);
  return { ok: true, code: "next_clicked", candidates: found.candidates };
}

async function completePublicationFlow(options) {
  const deadline = Date.now() + 8_000;
  const transition = await waitFor(() => {
    const riskDialog = findKnownDialog(/风险|违规|验证码|安全验证|人机验证|captcha/iu);
    if (riskDialog) return { blocked: true };
    const typoDialog = findKnownDialog(/错别字|错字/iu);
    if (typoDialog) return { value: { kind: "typo", root: typoDialog } };
    if (findActionButton(["全面检测"]).element || hasPublicationSettings(visiblePageText())) {
      return { value: { kind: "ready" } };
    }
    return false;
  }, deadline);
  if (transition.blocked) return failure("检测到风险控制或验证码页面，必须人工处理。", "risk_control_detected");
  if (!transition.value) return failure("下一步后未识别到错别字提示、全面检测或发布设置。", "post_next_state_unknown");
  if (transition.value.kind === "typo") {
    const submit = findButtonInRoot(transition.value.root, ["提交"]);
    if (!submit.element) return failure("已识别错别字提示，但没有找到同一弹窗内的提交按钮。", "typo_submit_missing");
    clickVisible(submit.element);
    const disappeared = await waitFor(() => !findKnownDialog(/错别字|错字/iu), Date.now() + 8_000);
    if (!disappeared.value) return failure("错别字提示提交后没有消失，已停止。", "typo_dialog_not_closed");
  }

  const risk = findKnownDialog(/风险|违规|验证码|安全验证|人机验证|captcha/iu);
  if (risk) return failure("检测到风险控制或验证码页面，必须人工处理。", "risk_control_detected");

  const settingsAlreadyVisible = hasPublicationSettings(visiblePageText());
  const fullCheck = findActionButton(["全面检测"]);
  if (!settingsAlreadyVisible && !fullCheck.element) {
    return failure("没有找到“全面检测”按钮或发布设置，页面状态未知。", "full_check_button_missing");
  } else if (!settingsAlreadyVisible) {
    const before = visiblePageText();
    clickVisible(fullCheck.element);
    const checked = await waitFor(() => {
      if (findKnownDialog(/风险|违规|验证码|安全验证|人机验证|captcha/iu)) return { blocked: true };
      const text = visiblePageText();
      const settings = hasPublicationSettings(text);
      const button = findActionButton(["全面检测"]);
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
  if (success.blocked) return failure("最终提交后出现风险控制或验证码，结果未知。", "risk_control_detected");
  if (!success.value) return failure("最终提交后未读取到可验证的成功/定时状态，结果未知。", "submission_unverified");

  return {
    ok: true,
    code: "schedule_submitted",
    publicationDate: options.publicationDate || null,
    publicationTime: options.publicationTime || null,
    aiPolicy: aiResult.policy,
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

function inspectPublicationList(chapterNos) {
  const text = visiblePageText();
  if (isLoginPage(text)) return failure("番茄登录状态已失效，请先登录。", "login_required");
  if (!/章节管理|章节列表|草稿箱/iu.test(text)) {
    return failure("当前页面不是可验证的章节管理/章节列表页面。", "publication_list_not_recognized");
  }
  const rowCandidates = [...document.querySelectorAll("tr, li, article, [role='row'], [class*='chapter'], [class*='row'], div")]
    .filter(isVisible)
    .map((element) => normalizeBody(readField(element)))
    .filter((value) => value && value.length <= 1600);
  const textLines = text.split("\n").map((line) => line.trim()).filter(Boolean);
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
  return { ok: true, state: "publication_list", url: location.href, workId: extractPlatformWorkId(location.href), rows };
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
    .filter((element) => findActionButton(["新建章节", "新建章"], element).element)
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

function findKnownDialog(pattern) {
  const candidates = [...document.querySelectorAll("[role='dialog'], .modal, .dialog, [class*='modal'], [class*='dialog']")]
    .filter(isVisible)
    .filter((element) => pattern.test(normalizeBody(readField(element))));
  return candidates.sort((a, b) => readField(a).length - readField(b).length)[0] || null;
}

function findButtonInRoot(root, texts) {
  return findActionButton(texts, root);
}

function findActionButton(texts, root = document) {
  const wanted = texts.map((text) => normalizeCompact(text));
  const candidates = [...root.querySelectorAll("button, [role='button'], a, input[type='button'], input[type='submit'], div")]
    .filter(isVisible)
    .filter((element) => !("disabled" in element && element.disabled))
    .map((element) => {
      const text = normalizeCompact(element.innerText || element.textContent || element.value || "");
      const exactIndex = wanted.findIndex((item) => text === item);
      const containsIndex = wanted.findIndex((item) => text.includes(item));
      const rect = element.getBoundingClientRect();
      const descriptor = `${element.id} ${element.className || ""} ${element.getAttribute("aria-label") || ""}`;
      let score = exactIndex >= 0 ? 1000 - exactIndex * 20 : containsIndex >= 0 ? 500 - containsIndex * 20 : -1;
      if (score < 0) return null;
      if (/guide|tutorial|新手|tour|popover/iu.test(descriptor)) score -= 500;
      if (/next|submit|publish|发布|下一步/iu.test(descriptor)) score += 50;
      score += Math.max(0, 100 - Math.round(rect.top));
      return { element, score, text, descriptor };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return {
    element: candidates[0]?.element || null,
    candidates: candidates.slice(0, 8).map((item) => ({ text: item.text, score: item.score, descriptor: item.descriptor.slice(0, 180) }))
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
    const managed = pathname.match(/\/main\/writer\/chapter-manage\/(\d{10,})/u);
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
