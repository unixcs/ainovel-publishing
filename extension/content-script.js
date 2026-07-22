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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !["fillChapter", "inspectChapter"].includes(message.type)) return false;
  try {
    sendResponse(message.type === "fillChapter" ? fillChapter(message.chapter) : inspectChapter(message.chapter));
  } catch (error) {
    sendResponse({ ok: false, error: normalizeError(error), code: "script_exception" });
  }
  return false;
});

function inspectChapter(chapter) {
  const fields = locateFields();
  if (!fields.titleField) return failure("没有找到标题输入框，无法对账。", "title_missing", fields.diagnostics);
  if (!fields.editor) return failure("没有找到正文编辑器，无法对账。", "editor_missing", fields.diagnostics);

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

function fillChapter(chapter) {
  const fields = locateFields();
  if (!fields.titleField) return failure("没有找到标题输入框，已停止且未操作页面。", "title_missing", fields.diagnostics);
  if (!fields.editor) return failure("没有找到正文编辑器，已停止且未操作页面。", "editor_missing", fields.diagnostics);

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

  const observedTitle = readField(fields.titleField).trim();
  const observedBody = normalizeBody(readField(fields.editor));
  const observedChapterNo = fields.chapterNumberField
    ? readField(fields.chapterNumberField).trim()
    : expectedChapterNo;
  const titleMatches = normalizeCompact(observedTitle) === normalizeCompact(expectedTitle);
  const bodyMatches = observedBody === expectedBody;
  const chapterMatches = normalizeChapterNumber(observedChapterNo) === expectedChapterNo;
  if (!titleMatches || !bodyMatches || !chapterMatches) {
    return failure("填充后校验不一致，已停止。请不要保存当前页面。", "post_fill_mismatch", {
      observedTitle,
      observedChapterNo,
      observedCharCount: countVisibleCharacters(observedBody),
      titleMatches,
      bodyMatches,
      chapterMatches,
      diagnostics: fields.diagnostics
    });
  }

  return {
    ok: true,
    observedTitle,
    observedChapterNo,
    observedCharCount: countVisibleCharacters(observedBody),
    alreadyPresent: Boolean(beforeTitle && !editorIsEmpty),
    diagnostics: fields.diagnostics
  };
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
