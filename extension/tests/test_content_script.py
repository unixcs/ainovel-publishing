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


def invoke_action(page, message):
    return page.evaluate(
        """message => new Promise(resolve => {
          window.__ainovelListener(message, null, resolve);
        })""",
        message,
    )


def publication_flow_html() -> str:
    return """
    <!doctype html><html><body>
      <input class="serial-input" value="">
      <input class="serial-editor-input-hint-area" value="">
      <div class="ProseMirror" contenteditable="true" style="width:800px;height:500px"></div>
      <button id="next">下一步</button>
      <script>
        window.chrome = {runtime: {onMessage: {addListener(fn) { window.__ainovelListener = fn; }}}};
        document.getElementById('next').addEventListener('click', () => {
          const dialog = document.createElement('div');
          dialog.setAttribute('role', 'dialog');
          dialog.innerHTML = '<p>检测到你还有错别字未修改，是否确认提交？</p><button id="typo-submit">提交</button>';
          document.body.appendChild(dialog);
          document.getElementById('typo-submit').onclick = () => {
            dialog.remove();
            const full = document.createElement('button');
            full.id = 'full-check'; full.textContent = '全面检测';
            document.body.appendChild(full);
            full.onclick = () => {
              full.remove();
              const settings = document.createElement('div');
              settings.id = 'publish-settings'; settings.innerHTML = `
                <h2>发布设置</h2>
                <p>本次提交 第6章　上次提交 第5章</p>
                <label>是否使用 AI <span id="ai-no" role="radio" aria-checked="false">否</span></label>
                <label>发布方式 <span id="timing" role="radio" aria-checked="false">定时发布</span></label>
                <label>发布日期 <input id="publish-date" type="date"></label>
                <label>发布时间 <select id="publish-time"><option value="12:00">12:00</option><option value="20:00">20:00</option><option value="22:00">22:00</option></select></label>
                <button id="schedule">定时发布</button>`;
              document.body.appendChild(settings);
              document.getElementById('ai-no').onclick = () => document.getElementById('ai-no').setAttribute('aria-checked', 'true');
              document.getElementById('timing').onclick = () => document.getElementById('timing').setAttribute('aria-checked', 'true');
              document.getElementById('schedule').onclick = () => {
                settings.insertAdjacentHTML('beforeend', '<p>定时发布成功：2026-07-23 20:00</p>');
              };
            };
          };
        });
      </script>
    </body></html>
    """


def test_known_publication_flow_confirms_typo_check_ai_and_schedule():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content(publication_flow_html())
        page.add_script_tag(path=str(SCRIPT))
        chapter = {"chapter_no": 6, "title": "第六章 来客", "body": "正文内容", "text_sha256": "f" * 64, "char_count": 4}
        filled = invoke_action(page, {"type": "fillChapter", "chapter": chapter})
        assert filled["ok"] is True
        next_result = invoke_action(page, {"type": "clickNext", "chapter": chapter})
        assert next_result["ok"] is True
        result = invoke_action(page, {
            "type": "completePublicationFlow",
            "options": {"chapterNo": 6, "publicationDate": "2026-07-23", "publicationTime": "20:00", "aiPolicy": "no"}
        })
        assert result["ok"] is True
        assert result["code"] == "schedule_submitted"
        assert page.locator("#publish-date").input_value() == "2026-07-23"
        assert page.locator("#publish-time").input_value() == "20:00"
        assert page.locator("#ai-no").get_attribute("aria-checked") == "true"
        assert "定时发布成功" in page.locator("#publish-settings").inner_text()
        browser.close()


def test_manual_ai_policy_pauses_before_final_submission():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content(publication_flow_html())
        page.add_script_tag(path=str(SCRIPT))
        chapter = {"chapter_no": 6, "title": "第六章 来客", "body": "正文内容", "text_sha256": "f" * 64, "char_count": 4}
        assert invoke_action(page, {"type": "fillChapter", "chapter": chapter})["ok"] is True
        assert invoke_action(page, {"type": "clickNext", "chapter": chapter})["ok"] is True
        result = invoke_action(page, {
            "type": "completePublicationFlow",
            "options": {"chapterNo": 6, "publicationDate": "2026-07-23", "publicationTime": "20:00", "aiPolicy": "ask"}
        })
        assert result["ok"] is False
        assert result["paused"] is True
        assert result["code"] == "ai_choice_required"
        assert page.locator("#schedule").is_visible()
        assert "定时发布成功" not in page.locator("#publish-settings").inner_text()
        page.locator("#ai-no").click()
        continued = invoke_action(page, {
            "type": "completePublicationFlow",
            "options": {"chapterNo": 6, "publicationDate": "2026-07-23", "publicationTime": "20:00", "aiPolicy": "remember"}
        })
        assert continued["ok"] is True
        assert continued["code"] == "schedule_submitted"
        browser.close()


def test_publication_context_mismatch_blocks_before_schedule_submit():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content(publication_flow_html().replace("本次提交 第6章", "本次提交 第9章"))
        page.add_script_tag(path=str(SCRIPT))
        chapter = {"chapter_no": 6, "title": "第六章 来客", "body": "正文内容", "text_sha256": "f" * 64, "char_count": 4}
        assert invoke_action(page, {"type": "fillChapter", "chapter": chapter})["ok"] is True
        assert invoke_action(page, {"type": "clickNext", "chapter": chapter})["ok"] is True
        result = invoke_action(page, {
            "type": "completePublicationFlow",
            "options": {"chapterNo": 6, "publicationDate": "2026-07-23", "publicationTime": "20:00", "aiPolicy": "no"}
        })
        assert result["ok"] is False
        assert result["code"] == "publish_chapter_context_unverified"
        assert "定时发布成功" not in page.locator("#publish-settings").inner_text()
        browser.close()


def test_unknown_risk_dialog_blocks_without_clicking_it():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content("""
        <div role="dialog"><p>内容风险检测</p><button id="cancel">取消</button></div>
        <script>window.chrome={runtime:{onMessage:{addListener(fn){window.__ainovelListener=fn}}}};</script>
        """)
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {
            "type": "completePublicationFlow",
            "options": {"publicationDate": "2026-07-23", "publicationTime": "20:00", "aiPolicy": "no"}
        })
        assert result["ok"] is False
        assert result["code"] == "risk_control_detected"
        assert page.locator("#cancel").is_visible()
        browser.close()


def test_publication_list_extracts_schedule_evidence():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content("""
        <main><h1>章节管理</h1><div>第 6 章  来客　定时发布 2026-07-23 20:00</div>
        <script>window.chrome={runtime:{onMessage:{addListener(fn){window.__ainovelListener=fn}}}};</script></main>
        """)
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {"type": "inspectPublicationList", "chapterNos": [6, 7]})
        assert result["ok"] is True
        assert result["rows"][0]["scheduled"] is True
        assert result["rows"][0]["publicationDate"] == "2026-07-23"
        assert result["rows"][0]["publicationTime"] == "20:00"
        assert result["rows"][1]["found"] is False
        browser.close()


def test_publication_list_does_not_borrow_adjacent_chapter_date():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content("""
        <main><h1>章节管理</h1>
          <div class="chapter-row">第 6 章 来客 草稿</div>
          <div class="chapter-row">第 7 章 同行 定时发布 2026-07-25 20:00</div>
          <script>window.chrome={runtime:{onMessage:{addListener(fn){window.__ainovelListener=fn}}}};</script>
        </main>
        """)
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {"type": "inspectPublicationList", "chapterNos": [6, 7]})
        assert result["rows"][0]["found"] is True
        assert result["rows"][0]["scheduled"] is False
        assert result["rows"][0]["publicationDate"] is None
        assert result["rows"][1]["scheduled"] is True
        assert result["rows"][1]["publicationDate"] == "2026-07-25"
        browser.close()
