"use strict";

const PAGE_ADAPTER_VERSION = "0.3.7";

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
  "openExistingChapter",
  "clickNext",
  "completePublicationFlow",
  "submitPreparedPublication",
  "reschedulePublication",
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
    case "openExistingChapter":
      return openExistingChapter(Number(message.chapterNo || 0), message.workId || null);
    case "clickNext":
      return await clickNext(message.chapter, message.timeoutMs);
    case "completePublicationFlow":
      return completePublicationFlow(message.options || {});
    case "submitPreparedPublication":
      return submitPreparedPublication(message.options || {});
    case "reschedulePublication":
      return reschedulePublication(message.options || {});
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
  // Fanqie's new-chapter route first mounts a temporary blank editor, then assigns a
  // persistent draft id and remounts the controlled React/ProseMirror tree. Writing to
  // that temporary tree looks successful for a moment and is then erased. Wait for the
  // persistent route and stable field nodes before the first write.
  const ready = await waitForHydratedEditor();
  if (!ready.value) {
    const fields = locateFields();
    return failure(
      "番茄的新章节草稿或编辑器在 15 秒内没有稳定下来，页面尚未填充。请直接重试主按钮。",
      fields.titleField ? "editor_not_hydrated" : "title_missing",
      {
        url: location.href,
        draftId: extractPlatformDraftId(location.href),
        nextTextEvidence: findExactNextTextEvidence(),
        diagnostics: fields.diagnostics
      }
    );
  }

  let fields = ready.value;
  const expectedTitle = expectedChapterTitle(chapter);
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

  fillExpectedChapterFields(fields, chapter);

  // A single matching read is not durable evidence: the editor can still remount one or
  // two seconds later. Require the same complete chapter to survive continuously across
  // the settling window before looking for “下一步”.
  const expectedDraftId = ready.draftId || extractPlatformDraftId(location.href);
  let refilledAfterRemount = false;
  let verified = await waitForStableChapterContent(chapter, {
    allowRefillableBlank: true,
    expectedDraftId
  });
  if (!verified.value && verified.refillable && verified.fields) {
    // The same persistent draft replaced our editor with a new empty tree. Refill that
    // one verified-empty tree once; never overwrite non-empty or conflicting content.
    fillExpectedChapterFields(verified.fields, chapter);
    refilledAfterRemount = true;
    verified = await waitForStableChapterContent(chapter, { expectedDraftId });
  }

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
    refilledAfterRemount,
    url: location.href,
    draftId: ready.draftId || extractPlatformDraftId(location.href),
    contentStabilityMs: verified.stabilityMs || 0,
    diagnostics: verified.value.fields.diagnostics
  };
}

function compareChapterFields(fields, chapter) {
  const observedTitle = readField(fields.titleField).trim();
  const observedBody = normalizeBody(readField(fields.editor));
  const observedChapterNo = fields.chapterNumberField
    ? readField(fields.chapterNumberField).trim()
    : String(chapter.chapter_no);
  const expectedTitle = expectedChapterTitle(chapter);
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

async function waitForHydratedEditor(timeoutMs = EDITOR_HYDRATION_TIMEOUT_MS) {
  if (!isFanqiePublishEditorRoute()) return waitForEditorFields(Math.min(timeoutMs, EDITOR_READY_TIMEOUT_MS));

  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  let stableIdentity = null;
  while (Date.now() < deadline) {
    const fields = locateFields();
    const draftId = extractPlatformDraftId(location.href);
    const nextEvidence = findExactNextTextEvidence();
    const ready = document.readyState === "complete" && fields.titleField && fields.editor && draftId && nextEvidence.length;
    if (ready) {
      const identity = {
        url: location.href,
        titleField: fields.titleField,
        chapterNumberField: fields.chapterNumberField,
        editor: fields.editor
      };
      const unchanged = stableIdentity && stableIdentity.url === identity.url &&
        stableIdentity.titleField === identity.titleField &&
        stableIdentity.chapterNumberField === identity.chapterNumberField &&
        stableIdentity.editor === identity.editor;
      if (!unchanged) {
        stableIdentity = identity;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= EDITOR_HYDRATION_STABLE_MS) {
        return { value: fields, draftId, nextTextEvidence: nextEvidence };
      }
    } else {
      stableIdentity = null;
      stableSince = 0;
    }
    await sleep(AUTOMATION_LIMITS.pollMs);
  }
  return { value: false };
}

function fillExpectedChapterFields(fields, chapter) {
  const expectedTitle = expectedChapterTitle(chapter);
  const expectedBody = normalizeBody(chapter.body);
  const expectedChapterNo = String(chapter.chapter_no);
  const currentTitle = readField(fields.titleField).trim();
  const currentBody = normalizeBody(readField(fields.editor));
  const currentChapterNo = fields.chapterNumberField ? readField(fields.chapterNumberField).trim() : "";
  if (fields.chapterNumberField && !currentChapterNo) fillField(fields.chapterNumberField, expectedChapterNo, false);
  if (!currentTitle) fillField(fields.titleField, expectedTitle, false);
  if (isEmptyEditorText(currentBody)) fillField(fields.editor, expectedBody, true);
}

function chapterFieldsAreSafelyRefillable(fields, chapter) {
  if (!fields?.titleField || !fields?.editor) return false;
  const title = readField(fields.titleField).trim();
  const body = normalizeBody(readField(fields.editor));
  const chapterNo = fields.chapterNumberField ? readField(fields.chapterNumberField).trim() : "";
  const titleSafe = !title || normalizeCompact(title) === normalizeCompact(expectedChapterTitle(chapter));
  const bodySafe = isEmptyEditorText(body) || body === normalizeBody(chapter.body);
  const chapterSafe = !chapterNo || normalizeChapterNumber(chapterNo) === String(chapter.chapter_no);
  return titleSafe && bodySafe && chapterSafe && isEmptyEditorText(body);
}

async function waitForStableChapterContent(chapter, {
  timeoutMs = EDITOR_SETTLE_TIMEOUT_MS,
  allowRefillableBlank = false,
  expectedDraftId = null
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const requiredStableMs = isFanqiePublishEditorRoute() ? EDITOR_CONTENT_STABLE_MS : 250;
  let stableSince = 0;
  let stableIdentity = null;
  let matchedOnce = false;
  let blankSince = 0;
  let blankIdentity = null;
  let lastFields = null;
  let lastComparison = null;
  while (Date.now() < deadline) {
    const fields = locateFields();
    lastFields = fields;
    if (fields.titleField && fields.editor) {
      const comparison = compareChapterFields(fields, chapter);
      lastComparison = comparison;
      const matches = comparison.titleMatches && comparison.bodyMatches && comparison.chapterMatches;
      const identity = {
        url: location.href,
        titleField: fields.titleField,
        chapterNumberField: fields.chapterNumberField,
        editor: fields.editor
      };
      const unchanged = stableIdentity && stableIdentity.url === identity.url &&
        stableIdentity.titleField === identity.titleField &&
        stableIdentity.chapterNumberField === identity.chapterNumberField &&
        stableIdentity.editor === identity.editor;
      if (matches) {
        matchedOnce = true;
        blankSince = 0;
        blankIdentity = null;
        if (!unchanged) {
          stableIdentity = identity;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= requiredStableMs) {
          return { value: { fields, comparison }, stabilityMs: Date.now() - stableSince };
        }
      } else {
        stableIdentity = null;
        stableSince = 0;
        const currentDraftId = extractPlatformDraftId(location.href);
        const sameDraft = !expectedDraftId || currentDraftId === expectedDraftId;
        const safelyBlank = matchedOnce && allowRefillableBlank && sameDraft && chapterFieldsAreSafelyRefillable(fields, chapter);
        if (safelyBlank) {
          const identityUnchanged = blankIdentity && blankIdentity.url === identity.url &&
            blankIdentity.titleField === identity.titleField &&
            blankIdentity.chapterNumberField === identity.chapterNumberField &&
            blankIdentity.editor === identity.editor;
          if (!identityUnchanged) {
            blankIdentity = identity;
            blankSince = Date.now();
          } else if (Date.now() - blankSince >= EDITOR_HYDRATION_STABLE_MS) {
            return { value: false, refillable: true, fields, comparison };
          }
        } else {
          blankSince = 0;
          blankIdentity = null;
        }
      }
    } else {
      stableIdentity = null;
      stableSince = 0;
      lastComparison = null;
      blankSince = 0;
      blankIdentity = null;
    }
    await sleep(AUTOMATION_LIMITS.pollMs);
  }
  return { value: false, fields: lastFields, comparison: lastComparison };
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

function expectedChapterTitle(chapter) {
  return pureTitle(chapter?.platform_title || chapter?.title || "");
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
const EDITOR_HYDRATION_TIMEOUT_MS = 15_000;
const EDITOR_HYDRATION_STABLE_MS = 1_000;
const EDITOR_SETTLE_TIMEOUT_MS = 8_000;
const EDITOR_CONTENT_STABLE_MS = 2_500;
const NEXT_READY_TIMEOUT_MS = 15_000;
const NEXT_READY_STABLE_MS = 500;
const DIALOG_ACTION_TIMEOUT_MS = 10_000;
const POST_TYPO_TIMEOUT_MS = 15_000;
const SETTINGS_CONTROL_TIMEOUT_MS = 8_000;
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

async function openExistingChapter(chapterNo, expectedWorkId = null) {
  const pageText = visiblePageText();
  if (isLoginPage(pageText)) {
    return failure("番茄登录状态已失效，请先登录。", "login_required", { mutationAttempted: false });
  }
  const currentWorkId = extractPlatformWorkId(location.href);
  if (expectedWorkId && currentWorkId !== String(expectedWorkId)) {
    return failure("当前番茄页面不是已绑定的目标作品，拒绝打开章节。", "work_identity_mismatch", {
      currentWorkId, expectedWorkId, mutationAttempted: false
    });
  }
  if (!Number.isInteger(chapterNo) || chapterNo < 1) {
    return failure("打开已有章节缺少有效章节号。", "chapter_no_missing", { mutationAttempted: false });
  }

  // 在章节管理列表中找到唯一的目标章节行，点进去打开它的编辑器（与“新建章节”相反，不新建）。
  const rowReady = await waitFor(() => {
    const row = findManagedChapterRow(chapterNo);
    return row ? { value: row } : false;
  }, Date.now() + NEW_CHAPTER_READY_TIMEOUT_MS);
  if (!rowReady.value) {
    return failure(
      `章节管理页没有稳定显示唯一的目标第 ${chapterNo} 章行，无法打开编辑器。`,
      "existing_chapter_row_missing",
      { mutationAttempted: false, url: location.href }
    );
  }

  const row = rowReady.value;
  // 优先点击行内可点的章节标题/编辑入口，必要时回退到整行点击。
  const entry = row.querySelector("a, [role='button'], button, .chapter-title, .title") || row;
  try {
    clickVisible(entry);
  } catch (error) {
    return failure(normalizeError(error), "existing_chapter_click_rejected", {
      mutationAttempted: false,
      selected: describeActionElement(entry)
    });
  }

  // 等待编辑器字段挂载，确认确实进入了第 chapterNo 章的编辑页。
  const editor = await waitForEditorFields();
  if (!editor.value) {
    return failure(
      `已点击第 ${chapterNo} 章，但编辑器在超时内未加载，可能跳转到了错误页面。`,
      "existing_chapter_editor_timeout",
      { mutationAttempted: true, url: location.href }
    );
  }
  return { ok: true, code: "existing_chapter_opened", mutationAttempted: true, page: inspectPage(), chapterNo };
}

async function clickNext(chapter, timeoutMs = null) {
  // The real Fanqie action is currently a small custom ByteDance control in the top
  // editor bar, not always a semantic <button>. Wait for that asynchronous control while
  // continuously re-checking the chapter. Never use a lower tutorial “下一步”.
  const requestedWait = timeoutMs === null || timeoutMs === undefined ? NEXT_READY_TIMEOUT_MS : Number(timeoutMs);
  const waitMs = Number.isFinite(requestedWait)
    ? Math.min(Math.max(requestedWait, 0), NEXT_READY_TIMEOUT_MS)
    : NEXT_READY_TIMEOUT_MS;
  const deadline = Date.now() + waitMs;
  let candidateSince = 0;
  let candidateElement = null;
  let candidateReady = false;
  let lastFound = { element: null, candidates: [], textEvidence: [] };
  let lastComparison = null;
  let lastFields = null;
  while (Date.now() < deadline) {
    const fields = locateFields();
    lastFields = fields;
    if (fields.titleField && fields.editor) {
      const comparison = chapter ? compareChapterFields(fields, chapter) : { titleMatches: true, bodyMatches: true, chapterMatches: true };
      lastComparison = comparison;
      const contentMatches = comparison.titleMatches && comparison.bodyMatches && comparison.chapterMatches;
      const found = findStrictNextControl();
      lastFound = found;
      if (contentMatches && found.element) {
        if (candidateElement !== found.element) {
          candidateElement = found.element;
          candidateSince = Date.now();
        } else if (Date.now() - candidateSince >= NEXT_READY_STABLE_MS) {
          lastFound = found;
          candidateReady = true;
          break;
        }
      } else {
        candidateElement = null;
        candidateSince = 0;
      }
    } else {
      candidateElement = null;
      candidateSince = 0;
    }
    await sleep(AUTOMATION_LIMITS.pollMs);
  }

  const before = captureTransitionDiagnostics();
  if (!candidateReady || !lastFound.element || candidateElement !== lastFound.element) {
    if (lastComparison && (!lastComparison.titleMatches || !lastComparison.bodyMatches || !lastComparison.chapterMatches)) {
      return failure("等待“下一步”期间，番茄编辑器中的章节内容发生变化，已停止且未点击页面。", "pre_next_mismatch", {
        observedTitle: lastComparison.observedTitle,
        observedChapterNo: lastComparison.observedChapterNo,
        observedCharCount: lastComparison.observedCharCount,
        candidates: lastFound.candidates,
        textEvidence: lastFound.textEvidence,
        diagnostics: before
      });
    }
    return failure(`${Math.ceil(waitMs / 1000)} 秒内没有找到可安全点击的顶部“下一步”控件，已停止且未点击页面。`, "next_button_missing", {
      candidates: lastFound.candidates,
      textEvidence: lastFound.textEvidence,
      fieldDiagnostics: lastFields?.diagnostics || null,
      diagnostics: before
    });
  }
  const finalFields = locateFields();
  if (chapter) {
    const finalComparison = finalFields.titleField && finalFields.editor ? compareChapterFields(finalFields, chapter) : null;
    if (!finalComparison || !finalComparison.titleMatches || !finalComparison.bodyMatches || !finalComparison.chapterMatches) {
      return failure("点击“下一步”前的最终章节校验失败，已停止且未点击页面。", "pre_next_mismatch", {
        observedTitle: finalComparison?.observedTitle || "",
        observedChapterNo: finalComparison?.observedChapterNo || "",
        observedCharCount: finalComparison?.observedCharCount || 0,
        candidates: lastFound.candidates,
        textEvidence: lastFound.textEvidence,
        diagnostics: before
      });
    }
  }

  const found = lastFound;
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
  const transition = await waitFor(() => detectPostNextState(), Date.now() + transitionTimeoutMs);
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

  // Stage 1: Fanqie may first show a typo warning. Arco renders the message body and
  // footer as siblings, so the smallest node containing “错别字” is not the dialog.
  // Re-resolve the complete dialog surface until its exact Submit action is mounted.
  if (transition.value.kind === "typo") {
    const typoSubmit = await waitFor(() => {
      if (findRiskControlDialog()) return { blocked: true };
      const dialog = findTypoDialog();
      if (!dialog) return false;
      const action = findDialogAction(dialog, ["提交"]);
      return action.element ? { value: { dialog, action } } : false;
    }, Date.now() + DIALOG_ACTION_TIMEOUT_MS);
    if (typoSubmit.blocked) return failure("错别字提示期间出现风险控制，已停止。", "risk_control_detected");
    if (!typoSubmit.value) {
      return failure("已识别错别字提示，但提交按钮在 10 秒内仍未完整加载。", "typo_submit_missing", {
        diagnostics: captureTransitionDiagnostics(options.nextTransition?.before || null),
        typoDialog: describeDialogSurface(findTypoDialog())
      });
    }
    clickVisible(typoSubmit.value.action.element);
    const nextStage = await waitFor(() => detectAfterTypoState(), Date.now() + POST_TYPO_TIMEOUT_MS);
    if (nextStage.blocked) return failure("错别字提示后出现风险控制，已停止。", "risk_control_detected");
    if (!nextStage.value) {
      return failure("错别字提示已提交，但内容检测窗口没有加载出来。", "post_typo_state_unknown", {
        diagnostics: captureTransitionDiagnostics(options.nextTransition?.before || null)
      });
    }
  }

  // Stage 2: choose the explicit full-content inspection path. Do not confuse the
  // lower/basic action or a page-wide text match with the dialog's real action.
  const settingsBeforeCheck = findPublicationRoot();
  if (!settingsBeforeCheck) {
    const detection = await waitFor(() => {
      if (findRiskControlDialog()) return { blocked: true };
      const dialog = findDetectionDialog();
      if (!dialog) return false;
      const action = findDialogAction(dialog, ["全面检测", "全文检测"]);
      return action.element ? { value: { dialog, action } } : false;
    }, Date.now() + DIALOG_ACTION_TIMEOUT_MS);
    if (detection.blocked) return failure("内容检测阶段出现风险控制，已停止。", "risk_control_detected");
    if (!detection.value) {
      return failure("没有找到内容检测窗口中的“全面检测”按钮。", "full_check_button_missing", {
        diagnostics: captureTransitionDiagnostics(options.nextTransition?.before || null),
        detectionDialog: describeDialogSurface(findDetectionDialog())
      });
    }
    clickVisible(detection.value.action.element);
    const checked = await waitFor(() => {
      if (findRiskControlDialog()) return { blocked: true };
      const settings = findPublicationRoot();
      return settings ? { value: settings } : false;
    }, Date.now() + AUTOMATION_LIMITS.fullCheckMs);
    if (checked.blocked) return failure("全面检测触发了风险控制，已停止。", "risk_control_detected");
    if (!checked.value) {
      return failure("全面检测后 60 秒内没有进入发布设置。", "full_check_timeout", {
        diagnostics: captureTransitionDiagnostics(options.nextTransition?.before || null),
        detectionDialog: describeDialogSurface(findDetectionDialog())
      });
    }
  }

  // Stage 3: verify the target chapter, AI declaration, scheduling switch, and exact
  // date/time. Each controlled setting is read back before the final action is exposed.
  const prepared = await preparePublicationSettings(options);
  if (!prepared.ok) return prepared;
  if (options.deferFinalSubmit) return prepared;
  return submitPreparedPublication(options);
}

async function preparePublicationSettings(options) {
  const settingsWait = await waitFor(() => {
    const root = findPublicationRoot();
    return root ? { value: root } : false;
  }, Date.now() + DIALOG_ACTION_TIMEOUT_MS);
  const settings = settingsWait.value;
  if (!settings) return failure("没有识别到完整的发布设置窗口，已停止。", "publish_settings_missing", {
    diagnostics: captureTransitionDiagnostics()
  });

  const contextResult = verifyPublicationContext(settings, options);
  if (!contextResult.ok) return contextResult;
  const aiResult = await configureAiPolicy(settings, options.aiPolicy || "remember");
  if (!aiResult.ok) return aiResult;
  const scheduleResult = await configureSchedule(settings, options.publicationDate, options.publicationTime);
  if (!scheduleResult.ok) return scheduleResult;
  const submit = findDialogAction(settings, ["确认发布", "定时发布", "提交发布", "发布"]);
  if (!submit.element) return failure("发布设置中没有找到可验证的“确认发布”按钮。", "final_submit_missing", {
    settings: describeDialogSurface(settings), diagnostics: captureTransitionDiagnostics()
  });
  return {
    ok: true,
    code: "publication_ready",
    publicationDate: scheduleResult.publicationDate,
    publicationTime: scheduleResult.publicationTime,
    aiPolicy: aiResult.policy,
    evidence: normalizeBody(readField(settings)).slice(0, 1000),
    selectedFinalAction: submit.descriptor || describeActionElement(submit.element),
    url: location.href
  };
}

async function submitPreparedPublication(options) {
  const prepared = await preparePublicationSettings(options);
  if (!prepared.ok) return prepared;
  const settings = findPublicationRoot();
  if (!settings) return failure("最终提交前发布设置窗口已消失。", "publish_settings_missing");
  const submit = findDialogAction(settings, ["确认发布", "定时发布", "提交发布", "发布"]);
  if (!submit.element) return failure("发布设置中没有找到可验证的“确认发布”按钮。", "final_submit_missing");

  const beforeSubmitText = visiblePageText();
  const beforeSubmitUrl = location.href;
  const rejectionNodesBefore = new Set(visibleSubmissionRejections().map((item) => item.element));
  const selected = submit.descriptor || describeActionElement(submit.element);
  clickVisible(submit.element);

  const success = await waitFor(() => {
    const riskDialog = findRiskControlDialog();
    if (riskDialog) return { blocked: true };
    const rejection = visibleSubmissionRejections().find((item) => !rejectionNodesBefore.has(item.element));
    if (rejection) return { value: { rejected: true, rejection } };
    const text = visiblePageText();
    const acceptedToast = /已提交[^\n]{0,40}(?:小时|审核)|预计\s*\d+\s*小时内完成审核|提交成功|定时发布成功|发布成功|已定时发布|发布完成/iu.test(text);
    const management = isChapterManagementPage(text);
    const changed = text !== beforeSubmitText || location.href !== beforeSubmitUrl;
    return changed && (acceptedToast || management)
      ? { value: { acceptedToast, management, text: text.slice(0, 1200), url: location.href } }
      : false;
  }, Date.now() + AUTOMATION_LIMITS.successMs);
  if (success.blocked) return failure(
    "最终提交后出现风险控制或验证码，结果未知。",
    "risk_control_detected",
    { finalSubmitAttempted: true, selected }
  );
  if (success.value?.rejected) return failure(
    `番茄拒绝发布：${success.value.rejection.message}`,
    "platform_submission_rejected",
    {
      finalSubmitAttempted: true,
      submissionRejected: true,
      rejectionMessage: success.value.rejection.message,
      selected,
      url: location.href
    }
  );
  if (!success.value) return failure(
    "已点击“确认发布”，但 25 秒内没有看到“已提交”或章节管理页；结果未知。",
    "submission_unverified",
    { finalSubmitAttempted: true, selected, url: location.href }
  );

  return {
    ok: true,
    code: "schedule_submitted",
    publicationDate: options.publicationDate || null,
    publicationTime: options.publicationTime || null,
    aiPolicy: prepared.aiPolicy,
    finalSubmitAttempted: true,
    selected,
    evidence: success.value.text,
    url: success.value.url
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
  const expectedTitle = pureTitle(options.title || "");
  if (expectedTitle && !normalizeCompact(text).includes(normalizeCompact(`第${chapterNo}章${expectedTitle}`))) {
    return failure("发布设置中的章节标题与计划不一致，拒绝提交。", "publish_title_context_unverified", {
      expectedChapterNo: chapterNo,
      expectedTitle,
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
  const riskDialog = findRiskControlDialog();
  if (riskDialog) return { blocked: true };
  const typoDialog = findTypoDialog();
  if (typoDialog) return { value: { kind: "typo", root: typoDialog } };
  if (findPublicationRoot() || hasPublicationSettings(visiblePageText())) {
    return { value: { kind: "ready" } };
  }
  if (findDetectionDialog()) {
    return { value: { kind: "ready" } };
  }
  const messages = visibleValidationMessages();
  if (messages.length) return { value: { kind: "validation", messages } };
  return false;
}

function detectAfterTypoState() {
  if (findRiskControlDialog()) return { blocked: true };
  const settings = findPublicationRoot();
  if (settings) return { value: { kind: "settings", root: settings } };
  const detection = findDetectionDialog();
  if (detection) return { value: { kind: "detection", root: detection } };
  return false;
}

function visibleSubmissionRejections() {
  // Fanqie's business API reports many validation failures as HTTP 200 and renders the
  // message in a transient Arco toast. Treat an explicit rejection as proof that no
  // submission was accepted instead of waiting and mislabelling the result unknown.
  const pattern = /本书中存在重复标题|请修改后再发布|(?:发布|提交)(?:失败|未成功|被拒绝)|无法(?:发布|提交)|(?:今日|每日|当日)[^\n]{0,40}(?:字数|上限|限制)|(?:字数|章节)[^\n]{0,30}(?:超过|超出)[^\n]{0,20}(?:限制|上限)/iu;
  const candidates = [...document.querySelectorAll(
    "[role='alert'], [aria-live], .arco-message, [class*='message'], [class*='notification'], [class*='toast'], [class*='error']"
  )]
    .filter(isVisible)
    .map((element) => ({ element, message: normalizeBody(readField(element)).trim() }))
    .filter((item) => item.message && pattern.test(item.message));
  return candidates.filter((item) => !candidates.some((other) => (
    other !== item && item.element.contains(other.element) && other.message === item.message
  )));
}

function isChapterManagementPage(text = visiblePageText()) {
  const workId = extractPlatformWorkId(location.href);
  const routeMatches = /\/main\/writer\/chapter-manage\/\d{10,}/u.test(location.pathname);
  return Boolean(workId && routeMatches && /章节管理/iu.test(String(text || "")));
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

function findManagedChapterRow(chapterNo) {
  const expected = Number(chapterNo);
  const candidates = [...document.querySelectorAll("tr, [role='row']")]
    .filter(isVisible)
    .filter((element) => {
      const numbers = distinctChapterNumbers(readField(element));
      return numbers.size === 1 && numbers.has(expected);
    });
  return candidates.length === 1 ? candidates[0] : null;
}

function managedChapterRowDetails(row, chapterNo) {
  if (!row) return null;
  const text = normalizeBody(readField(row));
  const heading = text.match(new RegExp(`第\\s*${Number(chapterNo)}\\s*章\\s*([^\\n\\t]*)`, "iu"));
  const timeMatch = text.match(/(?:^|\D)([012]?\d):([0-5]\d)(?:\D|$)/u);
  return {
    text,
    title: String(heading?.[1] || "").trim(),
    publicationDate: parsePublicationDate(text),
    publicationTime: timeMatch ? `${String(timeMatch[1]).padStart(2, "0")}:${timeMatch[2]}` : null,
    scheduled: /待发布|定时|已安排|审核中|待审核|审核通过/iu.test(text) && !/已发布|已上线/iu.test(text)
  };
}

function findScheduleModificationRoot(chapterNo) {
  const root = findDialogSurface(/修改定时/iu);
  if (!root) return null;
  const text = normalizeBody(readField(root));
  const chapterPattern = new RegExp(`第\\s*${Number(chapterNo)}\\s*章(?:\\s|$)`, "iu");
  if (!chapterPattern.test(text)) return null;
  const dateField = findFormControlByLabel(root, /^(?:发布)?日期$/u, "date");
  const timeField = findFormControlByLabel(root, /^(?:发布)?时间$/u, "time");
  const confirm = findDialogAction(root, ["确认修改"]);
  return dateField && timeField && confirm.element ? { root, dateField, timeField, confirm } : null;
}

async function reschedulePublication(options) {
  const chapterNo = Number(options.chapterNo || 0);
  const publicationDate = String(options.publicationDate || "");
  const publicationTime = String(options.publicationTime || "");
  if (!Number.isInteger(chapterNo) || chapterNo < 1) {
    return failure("修改定时缺少有效章节号。", "reschedule_chapter_missing");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(publicationDate)) {
    return failure("修改定时的日期格式无效。", "schedule_date_invalid");
  }
  if (!/^\d{2}:\d{2}$/u.test(publicationTime)) {
    return failure("修改定时的时间格式无效。", "schedule_time_invalid");
  }

  const rowReady = await waitFor(() => {
    const candidate = findManagedChapterRow(chapterNo);
    const details = managedChapterRowDetails(candidate, chapterNo);
    return candidate && details?.publicationDate && details?.publicationTime
      ? { value: { row: candidate, details } }
      : false;
  }, Date.now() + DIALOG_ACTION_TIMEOUT_MS);
  if (!rowReady.value) return failure(
    "章节列表在 10 秒内没有稳定显示唯一的目标章节行，未修改定时。",
    "reschedule_row_unverified"
  );
  const { row, details: before } = rowReady.value;
  const expectedTitle = pureTitle(options.title || "");
  if (expectedTitle && normalizeCompact(before.title) !== normalizeCompact(expectedTitle)) {
    return failure("章节标题与本地账本不一致，拒绝修改定时。", "reschedule_title_mismatch", {
      expectedTitle, observedTitle: before.title
    });
  }
  if (!before.scheduled || !before.publicationDate || !before.publicationTime) {
    return failure("目标章节不是可验证的定时待发布状态。", "reschedule_state_unverified", { before });
  }
  if (before.publicationDate === publicationDate && before.publicationTime === publicationTime) {
    return { ok: true, code: "schedule_unchanged", chapterNo, publicationDate, publicationTime, evidence: before.text };
  }

  const clockCandidates = [...row.querySelectorAll(".tomato-clock, [class*='clock']")]
    .filter(isVisible)
    .filter(isActionEnabled);
  if (clockCandidates.length !== 1) {
    return failure("没有找到唯一可验证的“修改定时”控件。", "reschedule_action_unverified", {
      candidateCount: clockCandidates.length, before
    });
  }
  clickVisible(clockCandidates[0]);

  let lastDialog = null;
  const hydrated = await waitFor(() => {
    if (findRiskControlDialog()) return { blocked: true };
    const anyDialog = findDialogSurface(/修改定时/iu);
    if (anyDialog) lastDialog = anyDialog;
    const ready = findScheduleModificationRoot(chapterNo);
    return ready ? { value: ready } : false;
  }, Date.now() + DIALOG_ACTION_TIMEOUT_MS);
  if (hydrated.blocked) return failure("修改定时时出现风险控制或验证码，已停止。", "risk_control_detected");
  if (!hydrated.value) return failure("“修改定时”窗口没有完整加载，未提交修改。", "reschedule_dialog_unverified", {
    dialog: describeDialogSurface(lastDialog)
  });

  let current = hydrated.value;
  let dateField = current.dateField;
  if (!dateMatches(readControlValue(dateField), publicationDate)) {
    const selectedDate = isArcoPickerInput(dateField)
      ? await selectArcoDate(dateField, publicationDate)
      : setPlainScheduleControl(dateField, publicationDate);
    if (!selectedDate.ok) return selectedDate;
  }
  const dateVerified = await waitForStableFormValue(
    current.root, /^(?:发布)?日期$/u, "date", publicationDate, dateMatches
  );
  if (!dateVerified.value) return failure("修改定时的日期没有被平台控件确认。", "reschedule_date_unverified", {
    expected: publicationDate, observed: dateVerified.observedValue || ""
  });

  current = findScheduleModificationRoot(chapterNo) || current;
  let timeField = current.timeField;
  if (!timeMatches(readControlValue(timeField), publicationTime)) {
    const selectedTime = isArcoPickerInput(timeField)
      ? await selectArcoTime(timeField, publicationTime)
      : setPlainScheduleControl(timeField, publicationTime);
    if (!selectedTime.ok) return selectedTime;
  }
  const timeVerified = await waitForStableFormValue(
    current.root, /^(?:发布)?时间$/u, "time", publicationTime, timeMatches
  );
  if (!timeVerified.value) return failure("修改定时的时间没有被平台控件确认。", "reschedule_time_unverified", {
    expected: publicationTime, observed: timeVerified.observedValue || ""
  });
  if (visibleArcoPickerContainers().length) {
    return failure("日期或时间选择面板仍未关闭，拒绝确认修改。", "schedule_picker_still_open");
  }

  current = findScheduleModificationRoot(chapterNo);
  if (!current) return failure("确认修改前窗口状态发生变化，已停止。", "reschedule_dialog_changed");
  const dialogText = normalizeBody(readField(current.root));
  if (!new RegExp(`第\\s*${chapterNo}\\s*章(?:\\s|$)`, "iu").test(dialogText)) {
    return failure("确认修改前章节号发生变化，已停止。", "reschedule_chapter_changed");
  }
  const selected = current.confirm.descriptor || describeActionElement(current.confirm.element);
  clickVisible(current.confirm.element);

  const verified = await waitFor(() => {
    if (findRiskControlDialog()) return { blocked: true };
    const refreshedRow = findManagedChapterRow(chapterNo);
    const observed = managedChapterRowDetails(refreshedRow, chapterNo);
    const dialogClosed = !findDialogSurface(/修改定时/iu);
    return dialogClosed && observed?.publicationDate === publicationDate && observed?.publicationTime === publicationTime
      ? { value: observed }
      : false;
  }, Date.now() + AUTOMATION_LIMITS.successMs);
  if (verified.blocked) return failure(
    "确认修改后出现风险控制或验证码，结果未知。", "risk_control_detected",
    { scheduleModificationAttempted: true, selected }
  );
  if (!verified.value) return failure(
    "已点击“确认修改”，但没有从章节列表回读到目标时间；结果未知。", "reschedule_unverified",
    { scheduleModificationAttempted: true, selected, chapterNo, publicationDate, publicationTime }
  );
  return {
    ok: true,
    code: "schedule_rescheduled",
    chapterNo,
    previousPublicationDate: before.publicationDate,
    previousPublicationTime: before.publicationTime,
    publicationDate,
    publicationTime,
    scheduleModificationAttempted: true,
    selected,
    evidence: verified.value.text,
    url: location.href
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

async function configureAiPolicy(root, policy) {
  const normalized = String(policy || "remember");
  const aiGroup = findSettingGroup(root, /是否\s*使用\s*AI|使用\s*AI/iu, /(?:^|\s)是(?:\s|$)|(?:^|\s)否(?:\s|$)/u);
  if (!aiGroup) return failure("发布设置中没有找到完整的“是否使用 AI”选项。", "ai_choice_missing");

  if (normalized === "remember") {
    const selected = findSelectedAiChoice(aiGroup);
    if (selected) return { ok: true, policy: selected.text };
    // 页面没有选中任何 AI 选项：不要中断发布，默认声明“使用 AI”并主动勾选，
    // 与 background 的 resolveAiPolicy 兜底保持一致，解决“AI 选项没有明确选择，无法安全沿用”。
    const choice = findAiChoice(aiGroup, "yes");
    if (!choice?.element) return failure("没有找到指定的 AI 声明选项。", "ai_choice_missing", {
      aiGroup: normalizeBody(readField(aiGroup)).slice(0, 500)
    });
    if (!elementIsSelected(choice.element)) clickVisible(choice.clickTarget || choice.element);
    const verified = await waitFor(() => {
      const current = findSelectedAiChoice(aiGroup);
      if (!current) return false;
      return current.kind === "yes" ? { value: current } : false;
    }, Date.now() + SETTINGS_CONTROL_TIMEOUT_MS);
    if (!verified.value) return failure("AI 声明选项点击后无法验证。", "ai_choice_unverified", {
      expected: "是",
      aiGroup: normalizeBody(readField(aiGroup)).slice(0, 500)
    });
    return { ok: true, policy: verified.value.text };
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
  const choice = findAiChoice(aiGroup, wantUse ? "yes" : "no");
  if (!choice.element) return failure("没有找到指定的 AI 声明选项。", "ai_choice_missing", {
    aiGroup: normalizeBody(readField(aiGroup)).slice(0, 500)
  });
  if (!elementIsSelected(choice.element)) clickVisible(choice.clickTarget || choice.element);
  const verified = await waitFor(() => {
    const current = findSelectedAiChoice(aiGroup);
    if (!current) return false;
    const matches = wantUse ? current.kind === "yes" : current.kind === "no";
    return matches ? { value: current } : false;
  }, Date.now() + SETTINGS_CONTROL_TIMEOUT_MS);
  if (!verified.value) return failure("AI 声明选项点击后无法验证。", "ai_choice_unverified", {
    expected: wantUse ? "是" : "否",
    aiGroup: normalizeBody(readField(aiGroup)).slice(0, 500)
  });
  return { ok: true, policy: verified.value.text };
}

async function configureSchedule(root, publicationDate, publicationTime) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(publicationDate || ""))) return failure("计划日期格式无效。", "schedule_date_invalid");
  if (!/^\d{2}:\d{2}$/u.test(String(publicationTime || ""))) return failure("计划时间格式无效。", "schedule_time_invalid");

  const timing = findLabeledToggle(root, /定时发布/iu);
  if (!timing.element) return failure("没有找到“定时发布”开关。", "schedule_mode_missing", {
    settings: describeDialogSurface(root)
  });
  if (!toggleIsSelected(timing.element)) clickVisible(timing.clickTarget || timing.element);
  const enabled = await waitFor(() => {
    const current = findLabeledToggle(root, /定时发布/iu);
    return current.element && toggleIsSelected(current.element) ? { value: current } : false;
  }, Date.now() + SETTINGS_CONTROL_TIMEOUT_MS);
  if (!enabled.value) return failure("“定时发布”开关点击后无法验证。", "schedule_mode_unverified");

  // Date/time controls are mounted only after the switch animation. Resolve them by
  // their own form row instead of assuming the label is the input's direct parent.
  const controls = await waitFor(() => {
    const dateField = findFormControlByLabel(root, /^(?:发布)?日期$/u, "date");
    const timeField = findFormControlByLabel(root, /^(?:发布)?时间$/u, "time");
    return dateField && timeField ? { value: { dateField, timeField } } : false;
  }, Date.now() + SETTINGS_CONTROL_TIMEOUT_MS);
  if (!controls.value?.dateField) return failure("定时开关已打开，但没有找到日期控件。", "schedule_date_control_missing", {
    settings: describeDialogSurface(root)
  });
  if (!controls.value?.timeField) return failure("定时开关已打开，但没有找到时间控件。", "schedule_time_control_missing", {
    settings: describeDialogSurface(root)
  });

  const dateControlResult = isArcoPickerInput(controls.value.dateField)
    ? await selectArcoDate(controls.value.dateField, publicationDate)
    : setPlainScheduleControl(controls.value.dateField, publicationDate);
  if (!dateControlResult.ok) return dateControlResult;
  const dateVerified = await waitForStableFormValue(root, /^(?:发布)?日期$/u, "date", publicationDate, dateMatches);
  if (!dateVerified.value) return failure("定时日期写入后校验不一致或被页面重置。", "schedule_date_unverified", {
    observedDate: dateVerified.observedValue || ""
  });

  const currentTimeField = findFormControlByLabel(root, /^(?:发布)?时间$/u, "time") || controls.value.timeField;
  const timeControlResult = isArcoPickerInput(currentTimeField)
    ? await selectArcoTime(currentTimeField, publicationTime)
    : setPlainScheduleControl(currentTimeField, publicationTime);
  if (!timeControlResult.ok) return timeControlResult;
  const timeVerified = await waitForStableFormValue(root, /^(?:发布)?时间$/u, "time", publicationTime, timeMatches);
  if (!timeVerified.value) return failure("定时时间写入后校验不一致或被页面重置。", "schedule_time_unverified", {
    observedTime: timeVerified.observedValue || ""
  });

  const pickerClosed = await waitFor(() => (
    visibleArcoPickerContainers().length === 0 ? { value: true } : false
  ), Date.now() + SETTINGS_CONTROL_TIMEOUT_MS);
  if (!pickerClosed.value) return failure(
    "日期或时间选择面板仍未关闭，拒绝点击最终发布。",
    "schedule_picker_still_open"
  );

  // Re-read every setting as one atomic pre-submit checkpoint.
  const finalToggle = findLabeledToggle(root, /定时发布/iu);
  const finalAi = findSelectedAiChoice(findSettingGroup(root, /是否\s*使用\s*AI|使用\s*AI/iu, /(?:^|\s)是(?:\s|$)|(?:^|\s)否(?:\s|$)/u));
  if (!finalToggle.element || !toggleIsSelected(finalToggle.element) || !finalAi) {
    return failure("发布设置在最终校验时发生变化，拒绝提交。", "publish_settings_changed");
  }
  return { ok: true, publicationDate, publicationTime };
}

function setPlainScheduleControl(control, value) {
  setControlValue(control, value);
  return { ok: true };
}

function isArcoPickerInput(control) {
  return Boolean(
    control instanceof HTMLInputElement &&
    control.classList.contains("arco-picker-start-time") &&
    control.closest(".arco-picker")
  );
}

function visibleArcoPickerContainers(kind = null) {
  const selector = kind === "date"
    ? ".arco-picker-container"
    : kind === "time"
      ? ".arco-timepicker-container"
      : ".arco-picker-container, .arco-timepicker-container";
  return [...document.querySelectorAll(selector)].filter(isVisible);
}

function uniqueVisibleArcoPicker(kind) {
  const candidates = visibleArcoPickerContainers(kind);
  return candidates.length === 1 ? candidates[0] : null;
}

async function openArcoPicker(control, kind) {
  clickVisible(control);
  const opened = await waitFor(() => {
    const picker = uniqueVisibleArcoPicker(kind);
    return picker ? { value: picker } : false;
  }, Date.now() + SETTINGS_CONTROL_TIMEOUT_MS);
  if (!opened.value) return failure(
    kind === "date" ? "日期选择面板没有打开。" : "时间选择面板没有打开。",
    kind === "date" ? "schedule_date_picker_missing" : "schedule_time_picker_missing"
  );
  return { ok: true, picker: opened.value };
}

function readArcoCalendarMonth(picker) {
  if (!picker) return null;
  const labels = [...picker.querySelectorAll(".arco-picker-header-label")]
    .map((element) => normalizeCompact(readField(element)));
  const matched = labels.join("").match(/(20\d{2})年(\d{1,2})月/u);
  if (!matched) return null;
  return { year: Number(matched[1]), month: Number(matched[2]) };
}

function monthIndex(value) {
  return value.year * 12 + value.month - 1;
}

function findArcoMonthNavigation(picker, direction) {
  const iconSelector = direction < 0 ? ".arco-icon-left" : ".arco-icon-right";
  const icon = picker?.querySelector(iconSelector);
  return icon?.closest(".arco-picker-header-icon") || null;
}

async function selectArcoDate(control, expected) {
  const matched = String(expected || "").match(/^(20\d{2})-(\d{2})-(\d{2})$/u);
  if (!matched) return failure("计划日期格式无效。", "schedule_date_invalid");
  const target = { year: Number(matched[1]), month: Number(matched[2]), day: Number(matched[3]) };
  const opened = await openArcoPicker(control, "date");
  if (!opened.ok) return opened;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const picker = uniqueVisibleArcoPicker("date");
    const current = readArcoCalendarMonth(picker);
    if (!picker || !current) return failure("无法读取日期选择面板的年月。", "schedule_date_calendar_unrecognized");
    const delta = monthIndex(target) - monthIndex(current);
    if (delta === 0) {
      const cells = [...picker.querySelectorAll(".arco-picker-cell-in-view")]
        .filter(isVisible)
        .filter((element) => !/(?:^|[\s_-])disabled(?:$|[\s_-])/iu.test(String(element.className || "")))
        .filter((element) => normalizeCompact(
          element.querySelector(".arco-picker-date-value")?.textContent || ""
        ) === String(target.day));
      if (cells.length !== 1) return failure("日期选择面板中没有唯一的目标日期。", "schedule_date_cell_ambiguous", {
        expected, candidateCount: cells.length
      });
      clickVisible(cells[0]);
      const committed = await waitFor(() => {
        const valueMatches = dateMatches(readControlValue(control), expected);
        const popupClosed = visibleArcoPickerContainers("date").length === 0;
        return valueMatches && popupClosed ? { value: true } : false;
      }, Date.now() + SETTINGS_CONTROL_TIMEOUT_MS);
      if (!committed.value) return failure("日期选择后没有被番茄控件确认。", "schedule_date_picker_unverified", {
        expected, observedDate: readControlValue(control)
      });
      return { ok: true };
    }

    const navigation = findArcoMonthNavigation(picker, delta < 0 ? -1 : 1);
    if (!navigation || !isVisible(navigation)) return failure("日期选择面板无法切换月份。", "schedule_date_navigation_missing", {
      expected, current
    });
    const previousIndex = monthIndex(current);
    clickVisible(navigation);
    const changed = await waitFor(() => {
      const next = readArcoCalendarMonth(uniqueVisibleArcoPicker("date"));
      return next && monthIndex(next) !== previousIndex ? { value: next } : false;
    }, Date.now() + SETTINGS_CONTROL_TIMEOUT_MS);
    if (!changed.value) return failure("日期选择面板切换月份后没有响应。", "schedule_date_navigation_unverified", {
      expected, current
    });
  }
  return failure("目标发布日期超出可自动选择的月份范围。", "schedule_date_out_of_range", { expected });
}

function findArcoTimeCell(list, expected) {
  const cells = [...(list?.querySelectorAll(".arco-timepicker-cell") || [])]
    .filter(isVisible)
    .filter((element) => normalizeCompact(
      element.querySelector(".arco-timepicker-cell-inner")?.textContent || element.textContent || ""
    ) === expected);
  return cells.length === 1 ? cells[0] : null;
}

async function selectArcoTime(control, expected) {
  const matched = String(expected || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/u);
  if (!matched) return failure("计划时间格式无效。", "schedule_time_invalid");
  const opened = await openArcoPicker(control, "time");
  if (!opened.ok) return opened;
  const picker = opened.picker;
  const lists = [...picker.querySelectorAll(".arco-timepicker-list")].filter(isVisible);
  if (lists.length < 2) return failure("时间选择面板缺少小时或分钟列表。", "schedule_time_picker_unrecognized");
  const hour = findArcoTimeCell(lists[0], matched[1]);
  const minute = findArcoTimeCell(lists[1], matched[2]);
  if (!hour || !minute) return failure("时间选择面板中没有目标小时或分钟。", "schedule_time_cell_missing", {
    expected
  });

  // 选小时：点击后等待其进入选中态，确保选择已经生效（Arco 列表可能在选择后重渲染）。
  if (!/(?:^|[\s_-])selected(?:$|[\s_-])/iu.test(String(hour.className || ""))) {
    clickVisible(hour);
    await waitFor(() => /(?:^|[\s_-])selected(?:$|[\s_-])/iu.test(String(hour.className || "")), Date.now() + SETTINGS_CONTROL_TIMEOUT_MS);
  }
  // 选分钟：列表可能因滚动重新渲染，按最新引用再查一次并等待选中态。
  const minuteNow = findArcoTimeCell(lists[1], matched[2]);
  if (minuteNow && !/(?:^|[\s_-])selected(?:$|[\s_-])/iu.test(String(minuteNow.className || ""))) {
    clickVisible(minuteNow);
    await waitFor(() => {
      const m = findArcoTimeCell(lists[1], matched[2]);
      return m && /(?:^|[\s_-])selected(?:$|[\s_-])/iu.test(String(m.className || ""));
    }, Date.now() + SETTINGS_CONTROL_TIMEOUT_MS);
  }

  // 提交并关闭面板。Arco 时间选择器（“TimePicker”）在不同情况下行为不同：
  //  - 多数情况面板内有“确定”按钮，点击即提交并关闭；
  //  - 但重渲染后原“确定”按钮引用可能失效，需在最新面板或整个弹窗内重新定位；
  //  - 少数情况下面板根本没有“确定”按钮（选中即生效），只能靠点击面板外或按 Esc 关闭。
  // 下面三种方式都尝试，确保时间写回且面板关闭，修复“时间选择后没有被最新控件确认”导致的停滞。
  const valueConfirmed = () => timeMatches(readControlValue(control) || control.textContent || "", expected);
  const pickerClosed = () => visibleArcoPickerContainers("time").length === 0;

  const dismissTimePicker = () => {
    // 1) 优先点击“确定”：先在最新面板内找，找不到再到整个模态内找（覆盖重渲染后引用失效）。
    const pickerNow = uniqueVisibleArcoPicker("time") || picker;
    let confirm = findDialogAction(pickerNow, ["确定"]).element;
    if (!confirm) {
      const modal = control.closest(".arco-modal, [role='dialog']");
      if (modal) confirm = findDialogAction(modal, ["确定"]).element;
    }
    if (confirm && isVisible(confirm) && isActionEnabled(confirm)) clickVisible(confirm);
    // 2) 面板仍未关闭：在模态内部点击一个中性区域（标题栏）或 body，触发“点击外部关闭”。
    //    注意绝不点击遮罩层，否则会关掉整个发布设置弹窗。
    if (!pickerClosed()) {
      const modal = control.closest(".arco-modal, [role='dialog']");
      const neutral = (modal && modal.querySelector(
        ".arco-modal-header, .arco-modal-title, header, [class*='modal-title'], [class*='dialog-title']"
      )) || document.body;
      neutral.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      neutral.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      // 3) 最后兜底：按 Esc 让 Arco 自行关闭时间面板。
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, which: 27, bubbles: true }));
    }
  };

  dismissTimePicker();
  let ok = await waitFor(() => (valueConfirmed() && pickerClosed()) ? { value: true } : false, Date.now() + SETTINGS_CONTROL_TIMEOUT_MS);
  if (ok.value) return { ok: true };

  // 仍无效再尝试一轮，覆盖面板动画/重渲染时序。
  dismissTimePicker();
  ok = await waitFor(() => (valueConfirmed() && pickerClosed()) ? { value: true } : false, Date.now() + SETTINGS_CONTROL_TIMEOUT_MS);
  if (ok.value) return { ok: true };

  return failure("时间选择后没有被番茄控件确认。", "schedule_time_picker_unverified", {
    expected, observedTime: readControlValue(control) || control.textContent || ""
  });
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

function publicationRootIsHydrated(root) {
  if (!root) return false;
  const text = normalizeBody(readField(root));
  if (text.length > 4000 || !/发布设置/iu.test(text) || !/第\s*\d+\s*章/iu.test(text) ||
      !/是否\s*使用\s*AI|使用\s*AI/iu.test(text)) return false;
  const aiGroup = findSettingGroup(root, /是否\s*使用\s*AI|使用\s*AI/iu);
  const schedule = findLabeledToggle(root, /定时发布/iu);
  return Boolean(aiGroup && schedule.element);
}

function findPublicationRoot() {
  const surface = findDialogSurface(/发布设置/iu);
  // Arco first mounts a modal shell containing only its title, then hydrates the
  // chapter and controls. Treating that shell as ready races the React render and
  // creates a false chapter-context failure. Do not expose the surface until it owns
  // the chapter context plus the real AI and scheduling controls.
  if (publicationRootIsHydrated(surface)) return surface;
  // Test fixtures and older Fanqie builds may use an unlabelled settings container.
  const candidates = [...document.querySelectorAll("section, article, div")]
    .filter(isVisible)
    .filter(publicationRootIsHydrated)
    .sort((a, b) => readField(a).length - readField(b).length);
  return candidates[0] || null;
}

function findTypoDialog() {
  return findDialogSurface(/检测到你还有错别字未修改|错别字|错字/iu, {
    fallbackActionTexts: ["提交", "取消"]
  });
}

function findDetectionDialog() {
  const surface = findDialogSurface(/请选择内容检测方式|内容检测方式|全面检测\s*[（(]?本章节剩余次数/iu, {
    fallbackActionTexts: ["全面检测", "仅基础检测"]
  });
  if (surface) return surface;
  // Compatibility with older builds that mounted a lone full-check button without a
  // labelled modal. This is used only after the verified Next transition.
  const action = findActionButton(["全面检测", "全文检测"]);
  return action.element ? (action.element.parentElement || document.body) : null;
}

function findDialogSurface(pattern, { fallbackActionTexts = [] } = {}) {
  const strong = [...document.querySelectorAll(
    "[role='dialog'], [aria-modal='true'], .modal, .dialog, [class*='modal'], [class*='dialog']"
  )]
    .filter(isVisible)
    .filter(isDialogSurfaceElement)
    .filter((element) => pattern.test(normalizeBody(readField(element))))
    .sort((a, b) => readField(a).length - readField(b).length);
  if (strong.length) return strong[0];

  // Unlabelled ByteDance overlays: choose the smallest container that owns both the
  // prompt and at least one expected footer action. This keeps page prose out.
  const fallback = [...document.querySelectorAll("section, article, div")]
    .filter(isVisible)
    .filter((element) => {
      const text = normalizeBody(readField(element));
      if (!text || text.length > 4000 || !pattern.test(text)) return false;
      return fallbackActionTexts.length === 0 || Boolean(findDialogAction(element, fallbackActionTexts).element);
    })
    .sort((a, b) => readField(a).length - readField(b).length);
  return fallback[0] || null;
}

function isDialogSurfaceElement(element) {
  if (!element) return false;
  if (element.getAttribute("role") === "dialog" || element.getAttribute("aria-modal") === "true") return true;
  const tokens = String(typeof element.className === "string" ? element.className : "").split(/\s+/u).filter(Boolean);
  return tokens.some((token) => /(?:^|[-_])(?:modal|dialog)$/iu.test(token));
}

function describeDialogSurface(root) {
  if (!root) return null;
  return {
    element: describeElement(root),
    text: normalizeBody(readField(root)).slice(0, 1200),
    actions: [...root.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']")]
      .filter(isVisible)
      .map(describeActionElement)
      .slice(0, 20)
  };
}

function findKnownDialog(pattern) {
  const candidates = [...document.querySelectorAll(
    "[role='dialog'], [aria-modal='true'], .modal, .dialog, [class*='modal'], [class*='dialog'], [class*='popup'], [class*='confirm'], [class*='message-box']"
  )]
    .filter(isVisible)
    .filter((element) => pattern.test(normalizeBody(readField(element))));
  return candidates.sort((a, b) => readField(a).length - readField(b).length)[0] || null;
}

function findRiskControlDialog() {
  // “风险内容 / 违规内容” are ordinary explanatory words in Fanqie's legitimate
  // full-content inspection dialog. Only stop on an explicit account/access challenge.
  return findKnownDialog(
    /验证码|安全验证|人机验证|行为验证|滑块(?:验证)?|请(?:先)?完成验证|请验证身份|账号异常|操作(?:过于)?频繁|访问(?:受限|异常)|风险控制|captcha/iu
  );
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

function findExactNextTextEvidence(root = document) {
  const wanted = normalizeCompact("下一步");
  const topLimit = Math.min(220, Math.max(140, Math.round(window.innerHeight * 0.25)));
  return [...root.querySelectorAll("button, [role='button'], a[href], input[type='button'], input[type='submit'], span, div")]
    .filter(isVisible)
    .filter((element) => actionText(element) === wanted)
    .filter((element) => ![...element.children].some((child) => actionText(child) === wanted))
    .filter((element) => !element.closest(
      "[role='dialog'], [aria-modal='true'], [class*='guide'], [class*='tutorial'], [class*='tour'], [class*='popover']"
    ))
    .map((element) => ({ element, descriptor: describeActionElement(element) }))
    .filter((item) => item.descriptor.rect.top >= -20 && item.descriptor.rect.bottom <= topLimit)
    .sort((a, b) => a.descriptor.rect.top - b.descriptor.rect.top || b.descriptor.rect.right - a.descriptor.rect.right)
    .slice(0, 20)
    .map((item) => item.descriptor);
}

function findStrictNextControl(root = document, { allowDisabled = false } = {}) {
  const wanted = normalizeCompact("下一步");
  const topLimit = Math.min(220, Math.max(140, Math.round(window.innerHeight * 0.25)));
  const excluded = (element) => Boolean(element.closest(
    "[role='dialog'], [aria-modal='true'], [class*='guide'], [class*='tutorial'], [class*='tour'], [class*='popover']"
  ));
  const candidates = [];
  const seen = new Set();
  const add = (element, priority, source) => {
    if (!element || seen.has(element) || !isVisible(element) || excluded(element)) return;
    if (!allowDisabled && !isActionEnabled(element)) return;
    if (actionText(element) !== wanted) return;
    const descriptor = describeActionElement(element);
    const rect = descriptor.rect;
    const smallEnough = rect.width > 0 && rect.height > 0 && rect.width <= 420 && rect.height <= 140 && rect.width * rect.height <= 45_000;
    if (!smallEnough || rect.top < -20 || rect.bottom > topLimit) return;
    const marker = `${descriptor.id} ${descriptor.className} ${descriptor.role} ${descriptor.ariaLabel}`;
    const actionArea = Boolean(element.closest(
      "header, [class*='header'], [class*='toolbar'], [class*='top'], [class*='action'], [class*='operation'], [class*='operate'], [class*='submit'], [class*='publish']"
    ));
    const primary = /primary|submit|publish|next|byte-btn/iu.test(marker);
    seen.add(element);
    candidates.push({
      element,
      descriptor,
      source,
      actionArea,
      primary,
      priority: priority + (actionArea ? 40 : 0) + (primary ? 25 : 0)
    });
  };

  for (const element of root.querySelectorAll(
    "button, [role='button'], a[href], input[type='button'], input[type='submit']"
  )) add(element, 400, "semantic");

  // Fanqie's current ByteDance UI renders the real top action as exact text inside a
  // small custom clickable control. Accept only a proven small top-bar ancestor; a
  // tutorial/lower-page div that merely contains “下一步” never qualifies.
  for (const leaf of root.querySelectorAll("span, div")) {
    if (!isVisible(leaf) || actionText(leaf) !== wanted || excluded(leaf)) continue;
    if ([...leaf.children].some((child) => actionText(child) === wanted)) continue;
    let candidate = leaf.closest("button, [role='button'], a[href], [tabindex]");
    if (!candidate) {
      let current = leaf;
      for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
        const marker = `${current.id || ""} ${typeof current.className === "string" ? current.className : ""}`;
        const computedPointer = window.getComputedStyle(current).cursor === "pointer";
        const inheritedPointer = current.parentElement
          ? window.getComputedStyle(current.parentElement).cursor === "pointer"
          : false;
        const explicitPointer = current.style?.cursor === "pointer" || (computedPointer && !inheritedPointer);
        const clickable = typeof current.onclick === "function" || explicitPointer ||
          /(?:^|[\s_-])(?:byte-?btn|btn|button|next|submit|publish|primary|action|operation|operate)(?:$|[\s_-])/iu.test(marker);
        if (clickable) { candidate = current; break; }
      }
    }
    if (candidate) add(candidate, 300, "custom-top-action");
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
      primary: item.primary,
      priority: item.priority
    })),
    textEvidence: findExactNextTextEvidence(root)
  };
}

function findDialogAction(root, texts) {
  if (!root) return { element: null, descriptor: null, candidates: [] };
  const wanted = texts.map((text) => normalizeCompact(text));
  const candidates = [];
  const seen = new Set();
  const add = (element, source, baseScore) => {
    if (!element || seen.has(element) || !root.contains(element) || !isVisible(element) || !isActionEnabled(element)) return;
    const text = actionText(element);
    const index = wanted.indexOf(text);
    if (index < 0) return;
    const descriptor = describeActionElement(element);
    const rect = descriptor.rect;
    if (rect.width <= 0 || rect.height <= 0 || rect.width > 480 || rect.height > 160 || rect.width * rect.height > 55_000) return;
    const marker = `${descriptor.id} ${descriptor.className} ${descriptor.role} ${descriptor.ariaLabel}`;
    const footer = Boolean(element.closest("footer, [class*='footer'], [class*='action'], [class*='button-group']"));
    const primary = /primary|confirm|submit|publish|orange|danger/iu.test(marker);
    seen.add(element);
    candidates.push({
      element, descriptor, text, source,
      score: baseScore - index * 40 + (footer ? 25 : 0) + (primary ? 15 : 0)
    });
  };

  for (const element of root.querySelectorAll(
    "button, [role='button'], a[href], input[type='button'], input[type='submit']"
  )) add(element, "semantic", 500);

  for (const leaf of root.querySelectorAll("span, div")) {
    if (!isVisible(leaf) || !wanted.includes(actionText(leaf))) continue;
    if ([...leaf.children].some((child) => wanted.includes(actionText(child)))) continue;
    let candidate = leaf.closest("button, [role='button'], a[href], [tabindex]");
    if (!candidate || !root.contains(candidate)) {
      candidate = null;
      let current = leaf;
      for (let depth = 0; current && current !== root.parentElement && depth < 5; depth += 1, current = current.parentElement) {
        const marker = `${current.id || ""} ${typeof current.className === "string" ? current.className : ""}`;
        const pointer = current.style?.cursor === "pointer" || window.getComputedStyle(current).cursor === "pointer";
        const clickable = typeof current.onclick === "function" || pointer ||
          /(?:^|[\s_-])(?:arco-)?(?:btn|button|confirm|submit|publish|primary|action)(?:$|[\s_-])/iu.test(marker);
        if (clickable) { candidate = current; break; }
        if (current === root) break;
      }
    }
    if (candidate) add(candidate, "custom", 400);
  }

  candidates.sort((a, b) => b.score - a.score || b.descriptor.rect.bottom - a.descriptor.rect.bottom ||
    b.descriptor.rect.right - a.descriptor.rect.right);
  return {
    element: candidates[0]?.element || null,
    descriptor: candidates[0]?.descriptor || null,
    candidates: candidates.slice(0, 12).map((item) => ({ ...item.descriptor, source: item.source, score: item.score }))
  };
}

function findSettingGroup(root, labelPattern) {
  if (!root) return null;
  const candidates = [root, ...root.querySelectorAll("fieldset, section, article, li, tr, label, [class*='item'], [class*='row'], div")]
    .filter(isVisible)
    .filter((element) => {
      const text = normalizeBody(readField(element));
      return text.length <= 1600 && labelPattern.test(text) &&
        (Boolean(findAiChoice(element, "yes").element) || Boolean(findAiChoice(element, "no").element));
    })
    .sort((a, b) => readField(a).length - readField(b).length);
  return candidates[0] || null;
}

function choiceText(element) {
  if (!element) return "";
  const label = element instanceof HTMLInputElement
    ? (element.closest("label") || (element.id ? document.querySelector(`label[for='${cssEscape(element.id)}']`) : null))
    : null;
  return normalizeCompact(
    label?.innerText || element.innerText || element.textContent || element.getAttribute("aria-label") || element.getAttribute("value") || ""
  );
}

function findAiChoice(root, kind) {
  if (!root) return { element: null, clickTarget: null, text: "", kind };
  const candidates = [...root.querySelectorAll(
    "label, [role='radio'], input[type='radio'], [class*='radio']"
  )]
    .map((element) => {
      const clickTarget = element instanceof HTMLInputElement
        ? (element.closest("label") || element.closest("[role='radio']") || element)
        : element;
      const text = choiceText(element);
      return { element, clickTarget, text, kind };
    })
    .filter((item) => isVisible(item.clickTarget))
    .filter((item) => kind === "yes"
      ? /^(?:是|使用AI|使用)$/iu.test(item.text)
      : /^(?:否|不使用AI|未使用AI|不使用)$/iu.test(item.text))
    .sort((a, b) => {
      const aInput = a.element instanceof HTMLInputElement ? 0 : 1;
      const bInput = b.element instanceof HTMLInputElement ? 0 : 1;
      return aInput - bInput || readField(a.clickTarget).length - readField(b.clickTarget).length;
    });
  return candidates[0] || { element: null, clickTarget: null, text: "", kind };
}

function findSelectedAiChoice(root) {
  if (!root) return null;
  for (const kind of ["yes", "no"]) {
    const choice = findAiChoice(root, kind);
    if (choice.element && (elementIsSelected(choice.element) || elementIsSelected(choice.clickTarget))) return choice;
  }
  return null;
}

function findLabeledToggle(root, pattern) {
  if (!root) return { element: null, clickTarget: null };
  const controls = [...root.querySelectorAll(
    "[role='switch'], [role='radio'], input[type='checkbox'], button[class*='switch'], [class*='switch']"
  )];
  const candidates = [];
  const seen = new Set();
  for (const element of controls) {
    const control = element.matches("[role='switch'], [role='radio'], input[type='checkbox'], button")
      ? element
      : (element.querySelector("[role='switch'], input[type='checkbox'], button") || element);
    if (seen.has(control)) continue;
    const clickTarget = control instanceof HTMLInputElement
      ? (control.closest("label") || control.closest("[class*='switch']") || control)
      : control;
    if (!isVisible(clickTarget)) continue;
    let current = clickTarget;
    let groupText = "";
    for (let depth = 0; current && root.contains(current) && depth < 7; depth += 1, current = current.parentElement) {
      const text = normalizeBody(readField(current));
      if (pattern.test(text)) { groupText = text; break; }
      if (current === root) break;
    }
    if (!groupText) continue;
    seen.add(control);
    candidates.push({ element: control, clickTarget, groupText });
  }
  candidates.sort((a, b) => a.groupText.length - b.groupText.length);
  return candidates[0] || { element: null, clickTarget: null };
}

function toggleIsSelected(element) {
  if (!element) return false;
  if (element.checked === true || element.getAttribute("aria-checked") === "true") return true;
  const className = `${typeof element.className === "string" ? element.className : ""} ${typeof element.parentElement?.className === "string" ? element.parentElement.className : ""}`;
  return /(?:^|[\s_-])(?:checked|selected|active|on)(?:$|[\s_-])/iu.test(className);
}

function findFormControlByLabel(root, labelPattern, type) {
  if (!root) return null;
  const controlSelector = type === "date"
    ? "input[type='date'], input[placeholder*='日期'], input[aria-label*='日期'], input[name*='date'], input[class*='date'], input[type='text']"
    : "input[type='time'], input[placeholder*='时间'], input[aria-label*='时间'], input[name*='time'], input[class*='time'], select, input[type='text']";
  const labels = [...root.querySelectorAll("label, span, p, div")]
    .filter(isVisible)
    .filter((element) => {
      const directText = normalizeCompact([...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join(" "));
      return labelPattern.test(directText || normalizeCompact(readField(element)));
    })
    .filter((element) => ![...element.children].some((child) => labelPattern.test(normalizeCompact(readField(child)))));
  const candidates = [];
  for (const label of labels) {
    let current = label.parentElement;
    for (let depth = 0; current && root.contains(current) && depth < 7; depth += 1, current = current.parentElement) {
      const controls = [...current.querySelectorAll(controlSelector)].filter(isVisible);
      if (controls.length === 1) {
        candidates.push({ control: controls[0], groupLength: readField(current).length, depth });
        break;
      }
      if (current === root) break;
    }
  }
  if (candidates.length) {
    candidates.sort((a, b) => a.depth - b.depth || a.groupLength - b.groupLength);
    return candidates[0].control;
  }
  const attributed = [...root.querySelectorAll(controlSelector)]
    .filter(isVisible)
    .find((control) => labelPattern.test(normalizeCompact(
      `${control.getAttribute("aria-label") || ""}${control.getAttribute("placeholder") || ""}${control.getAttribute("name") || ""}`
    )));
  return attributed || null;
}

async function waitForStableFormValue(root, labelPattern, type, expected, matcher, stableMs = 800) {
  const deadline = Date.now() + SETTINGS_CONTROL_TIMEOUT_MS;
  let stableSince = 0;
  let stableControl = null;
  let observedValue = "";
  while (Date.now() < deadline) {
    const control = findFormControlByLabel(root, labelPattern, type);
    observedValue = control ? readControlValue(control) : "";
    if (control?.isConnected && matcher(observedValue, expected)) {
      if (stableControl !== control) {
        stableControl = control;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= stableMs) {
        return { value: control, observedValue, stabilityMs: Date.now() - stableSince };
      }
    } else {
      stableControl = null;
      stableSince = 0;
    }
    await sleep(AUTOMATION_LIMITS.pollMs);
  }
  return { value: false, observedValue };
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(String(value));
  return String(value).replace(/["'\\]/gu, "\\$&");
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
  if (!element) return false;
  if (element.checked === true || element.getAttribute("aria-checked") === "true") return true;
  if (element.querySelector?.(":checked, [aria-checked='true']")) return true;
  const marker = `${typeof element.className === "string" ? element.className : ""} ${typeof element.parentElement?.className === "string" ? element.parentElement.className : ""}`;
  return /(?:^|[\s_-])(?:checked|selected|active)(?:$|[\s_-])/iu.test(marker);
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
  control.focus();
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
  try {
    control.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: String(value) }));
  } catch (_error) { /* older Chromium: the plain input event below is sufficient */ }
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
  control.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  control.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  control.blur();
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

function extractPlatformDraftId(url) {
  try {
    const pathname = new URL(url).pathname;
    const matched = pathname.match(/\/main\/writer\/\d{10,}\/publish\/(\d{10,})(?:\/|$)/u);
    return matched ? matched[1] : null;
  } catch (_error) {
    return null;
  }
}

function isFanqiePublishEditorRoute() {
  try {
    const url = new URL(location.href);
    return /(^|\.)fanqienovel\.com$/iu.test(url.hostname) && /\/main\/writer\/\d{10,}\/publish(?:\/|$)/u.test(url.pathname);
  } catch (_error) {
    return false;
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
