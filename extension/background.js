"use strict";

const DEFAULT_SETTINGS = {
  baseUrl: "http://127.0.0.1:8787",
  apiToken: ""
};
const TARGET_ROOT_HOST = "fanqienovel.com";

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set({
    baseUrl: stored.baseUrl || DEFAULT_SETTINGS.baseUrl,
    apiToken: stored.apiToken || ""
  });
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: normalizeError(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message && message.type) {
    case "getSettings":
      return chrome.storage.local.get(DEFAULT_SETTINGS);
    case "saveSettings":
      return saveSettings(message.settings || {});
    case "health":
      return apiRequest("/api/v1/health", { authenticated: false });
    case "sync":
      return apiRequest("/api/v1/sync", {
        method: "POST",
        body: { run_export: true }
      });
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
      return apiRequest(
        `/api/v1/books/${encodeURIComponent(message.bookId)}/chapters/${Number(message.chapterNo)}`
      );
    case "fillChapter":
      return fillChapter(message.bookId, Number(message.chapterNo));
    case "reconcileChapter":
      return reconcileChapter(message.bookId, Number(message.chapterNo));
    default:
      throw new Error("unsupported_message");
  }
}

async function saveSettings(settings) {
  const baseUrl = String(settings.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/$/u, "");
  if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(baseUrl)) {
    throw new Error("本地接口必须是 http://127.0.0.1:端口");
  }
  const apiToken = String(settings.apiToken || "").trim();
  await chrome.storage.local.set({ baseUrl, apiToken });
  return { baseUrl, apiTokenSaved: Boolean(apiToken) };
}

async function apiRequest(path, options = {}) {
  const { baseUrl, apiToken } = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (options.authenticated !== false && !apiToken) {
    throw new Error("请先填写本地助手 API Token。");
  }
  const headers = { "Content-Type": "application/json" };
  if (options.authenticated !== false) {
    headers["X-Ainovel-Token"] = apiToken;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    payload = null;
  }
  if (!response.ok) {
    const detail = payload && payload.detail ? payload.detail : `HTTP ${response.status}`;
    throw new Error(String(detail));
  }
  return payload;
}

async function fillChapter(bookId, chapterNo) {
  const chapter = await apiRequest(
    `/api/v1/books/${encodeURIComponent(bookId)}/chapters/${chapterNo}`
  );
  if (!["ready", "synced", "fill_started", "filled"].includes(chapter.status)) {
    throw new Error(`章节状态 ${chapter.status} 不允许直接填充。`);
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url) {
    throw new Error("没有找到当前活动标签页。");
  }
  const url = new URL(tab.url);
  if (!isFanqieHost(url.hostname)) {
    throw new Error("当前页面不是番茄作家章节编辑页。");
  }

  await postEvent(bookId, chapterNo, "fill_started", chapter.text_sha256, {
    page_url: tab.url
  });

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, {
      type: "fillChapter",
      chapter: {
        chapter_no: chapter.chapter_no,
        title: chapter.title,
        body: chapter.body,
        text_sha256: chapter.text_sha256,
        char_count: chapter.char_count
      }
    });
  } catch (error) {
    await postEvent(bookId, chapterNo, "failed", chapter.text_sha256, {
      error: normalizeError(error),
      stage: "content_script"
    });
    throw new Error("无法连接番茄页面脚本，请刷新编辑页后重试。");
  }

  if (!response || !response.ok) {
    const reason = response && response.error ? response.error : "页面填充校验失败";
    await postEvent(bookId, chapterNo, "failed", chapter.text_sha256, {
      error: reason,
      stage: "fill_validation",
      code: response && response.code ? response.code : null,
      before_body_preview: response && response.beforeBodyPreview ? response.beforeBodyPreview : null,
      observed_char_count: response && response.observedCharCount ? response.observedCharCount : null,
      editor_descriptor: response && response.editorDescriptor ? response.editorDescriptor : null,
      diagnostics: response && response.diagnostics ? response.diagnostics : null
    });
    throw new Error(reason);
  }

  await postEvent(bookId, chapterNo, "filled", chapter.text_sha256, {
    page_url: tab.url,
    observed_title: response.observedTitle,
    observed_chapter_no: response.observedChapterNo,
    observed_char_count: response.observedCharCount
  });
  return response;
}


async function reconcileChapter(bookId, chapterNo) {
  const chapter = await apiRequest(
    `/api/v1/books/${encodeURIComponent(bookId)}/chapters/${chapterNo}`
  );
  if (chapter.status !== "legacy_draft") {
    throw new Error(`章节状态 ${chapter.status} 不允许执行首次草稿对账。`);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url) throw new Error("没有找到当前活动标签页。");
  const url = new URL(tab.url);
  if (!TARGET_HOSTS.has(url.hostname)) throw new Error("当前页面不是番茄作家章节编辑页。");

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, {
      type: "inspectChapter",
      chapter: {
        chapter_no: chapter.chapter_no,
        title: chapter.title,
        body: chapter.body,
        text_sha256: chapter.text_sha256
      }
    });
  } catch (_error) {
    throw new Error("无法连接番茄页面脚本，请刷新第四章草稿编辑页后重试。");
  }
  if (!response || !response.ok) throw new Error((response && response.error) || "草稿读取失败。");
  const matched = response.titleMatches && response.bodyMatches && response.chapterMatches;
  await postEvent(
    bookId,
    chapterNo,
    matched ? "reconcile_match" : "reconcile_conflict",
    chapter.text_sha256,
    {
      platform_state: "saved_draft",
      page_url: tab.url,
      title_matches: response.titleMatches,
      body_matches: response.bodyMatches,
      chapter_matches: response.chapterMatches,
      observed_title: response.observedTitle,
      observed_chapter_no: response.observedChapterNo,
      observed_char_count: response.observedCharCount
    }
  );
  return { ...response, matched, expectedBody: chapter.body };
}

async function postEvent(bookId, chapterNo, event, textSha256, payload) {
  return apiRequest(
    `/api/v1/books/${encodeURIComponent(bookId)}/chapters/${chapterNo}/events`,
    {
      method: "POST",
      body: { event, text_sha256: textSha256, payload: payload || {} }
    }
  );
}

function isFanqieHost(hostname) {
  return hostname === TARGET_ROOT_HOST || hostname.endsWith(`.${TARGET_ROOT_HOST}`);
}

function normalizeError(error) {
  if (error instanceof Error) return error.message;
  return String(error || "未知错误");
}
