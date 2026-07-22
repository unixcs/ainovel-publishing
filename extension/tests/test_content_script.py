from pathlib import Path

from playwright.sync_api import sync_playwright

SCRIPT = Path(__file__).parents[1] / "content-script.js"
CHROME = "/snap/bin/chromium"


def page_html(title: str = "", body: str = "", chapter_no: str = "") -> str:
    return f"""
    <!doctype html><html><body>
      <input class="serial-input" value="{chapter_no}">
      <input class="serial-editor-input-hint-area" value="{title}">
      <div class="ProseMirror" contenteditable="true" style="width:800px;height:500px">{body}</div>
      <script>
        window.chrome = {{runtime: {{onMessage: {{addListener(fn) {{ window.__ainovelListener = fn; }}}}}}}};
      </script>
    </body></html>
    """


def invoke(page, chapter):
    return page.evaluate(
        """chapter => new Promise(resolve => {
          window.__ainovelListener({type: 'fillChapter', chapter}, null, resolve);
        })""",
        chapter,
    )


def test_blank_editor_fills_and_validates():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content(page_html())
        page.add_script_tag(path=str(SCRIPT))
        result = invoke(page, {"chapter_no": 5, "title": "第五章 来客", "body": "第一段。\n\n第二段。", "text_sha256": "a" * 64, "char_count": 8})
        assert result["ok"] is True
        assert page.locator(".serial-input").input_value() == "5"
        assert page.locator(".serial-editor-input-hint-area").input_value() == "来客"
        assert "第一段" in page.locator(".ProseMirror").inner_text()
        browser.close()


def test_existing_other_title_fails_without_overwrite():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content(page_html(title="别的标题", body="已有正文", chapter_no="99"))
        page.add_script_tag(path=str(SCRIPT))
        result = invoke(page, {"chapter_no": 5, "title": "第五章 来客", "body": "新正文", "text_sha256": "b" * 64, "char_count": 3})
        assert result["ok"] is False
        assert result["code"] == "title_conflict"
        assert page.locator(".serial-editor-input-hint-area").input_value() == "别的标题"
        assert page.locator(".ProseMirror").inner_text() == "已有正文"
        browser.close()


def test_inspect_reports_mismatch_without_mutation():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content(page_html(title="来客", body="番茄旧正文", chapter_no="5"))
        page.add_script_tag(path=str(SCRIPT))
        result = page.evaluate(
            """chapter => new Promise(resolve => {
              window.__ainovelListener({type: 'inspectChapter', chapter}, null, resolve);
            })""",
            {"chapter_no": 5, "title": "第五章 来客", "body": "服务器新正文", "text_sha256": "c" * 64},
        )
        assert result["ok"] is True
        assert result["titleMatches"] is True
        assert result["chapterMatches"] is True
        assert result["bodyMatches"] is False
        assert page.locator(".ProseMirror").inner_text() == "番茄旧正文"
        browser.close()


def test_placeholder_text_is_treated_as_empty():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content(page_html(body="请输入正文"))
        page.add_script_tag(path=str(SCRIPT))
        result = invoke(page, {"chapter_no": 5, "title": "第五章 来客", "body": "真正正文", "text_sha256": "d" * 64, "char_count": 4})
        assert result["ok"] is True
        assert page.locator(".ProseMirror").inner_text() == "真正正文"
        browser.close()


def test_largest_editor_is_selected_when_page_has_multiple_editors():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content("""
        <!doctype html><html><body>
          <input class="serial-input" style="width:100px;height:30px">
          <input class="serial-editor-input-hint-area" style="width:400px;height:30px">
          <div class="ProseMirror author-note" contenteditable="true" style="width:200px;height:40px">作者有话说</div>
          <div class="ProseMirror novel-editor" contenteditable="true" aria-multiline="true" style="width:800px;height:500px"></div>
          <script>window.chrome={runtime:{onMessage:{addListener(fn){window.__ainovelListener=fn}}}};</script>
        </body></html>
        """)
        page.add_script_tag(path=str(SCRIPT))
        result = invoke(page, {"chapter_no": 5, "title": "第五章 来客", "body": "正文内容", "text_sha256": "e" * 64, "char_count": 4})
        assert result["ok"] is True
        assert page.locator(".author-note").inner_text() == "作者有话说"
        assert page.locator(".novel-editor").inner_text() == "正文内容"
        browser.close()
