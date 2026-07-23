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
        <main><h1>章节管理</h1><button>新建章节</button><div>第 6 章  来客　定时发布 2026-07-23 20:00</div>
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
        <main><h1>章节管理</h1><button>新建章节</button>
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


def test_fill_waits_for_async_editor_mount_instead_of_requiring_second_click():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content("""
        <!doctype html><html><body>
          <div id="app"></div>
          <script>
            window.chrome={runtime:{onMessage:{addListener(fn){window.__ainovelListener=fn}}}};
            setTimeout(() => {
              document.getElementById('app').innerHTML = `
                <input class="serial-input" style="width:100px;height:30px">
                <input class="serial-editor-input-hint-area" style="width:400px;height:30px">
                <div class="ProseMirror" contenteditable="true" style="width:800px;height:500px"></div>`;
            }, 350);
          </script>
        </body></html>
        """)
        page.add_script_tag(path=str(SCRIPT))
        result = invoke(page, {
            "chapter_no": 6,
            "title": "第六章 夜话",
            "body": "第一段。\n\n第二段。",
            "text_sha256": "f" * 64,
            "char_count": 8,
        })
        assert result["ok"] is True
        assert page.locator(".serial-editor-input-hint-area").input_value() == "夜话"
        rendered = page.locator(".ProseMirror").inner_text()
        assert "第一段。" in rendered and "第二段。" in rendered
        browser.close()


def test_realistic_chapter_table_keeps_reviewing_row_isolated_from_published_neighbours():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content("""
        <main><h1>章节管理</h1><button>新建章节</button>
          <div class="chapter-table">
            <div class="data-row"><span>第6章 夜话</span><span>-</span><span>0</span><span>审核中</span><span>2026-07-24 07:10</span></div>
            <div class="data-row"><span>第5章 来客</span><span>7712</span><span>0</span><span>待发布</span><span>2026-07-23 07:10</span></div>
            <div class="data-row"><span>第4章 灵核</span><span>3388</span><span>0</span><span>已发布</span><span>2026-07-22 21:02</span></div>
          </div>
          <script>window.chrome={runtime:{onMessage:{addListener(fn){window.__ainovelListener=fn}}}};</script>
        </main>
        """)
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {"type": "inspectPublicationList", "chapterNos": [4, 5, 6]})
        rows = {row["chapterNo"]: row for row in result["rows"]}
        assert rows[6]["reviewing"] is True
        assert rows[6]["scheduled"] is True
        assert rows[6]["published"] is False
        assert rows[6]["publicationDate"] == "2026-07-24"
        assert rows[6]["publicationTime"] == "07:10"
        assert "第5章" not in rows[6]["text"]
        assert "已发布" not in rows[6]["text"]
        assert rows[5]["scheduled"] is True
        assert rows[5]["published"] is False
        assert rows[4]["published"] is True
        browser.close()


def test_publication_list_waits_for_async_rows_and_returns_only_stable_snapshot():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content("""
        <main><h1>章节管理</h1><div id="toolbar"></div><div id="rows"></div></main>
        <script>
          window.chrome={runtime:{onMessage:{addListener(fn){window.__ainovelListener=fn}}}};
          setTimeout(() => { document.getElementById('toolbar').innerHTML = '<button>新建章节</button>'; }, 180);
          setTimeout(() => { document.getElementById('rows').innerHTML = '<div class="chapter-row">第 8 章 兽潮 草稿</div>'; }, 2000);
        </script>
        """)
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {"type": "inspectPublicationList", "chapterNos": [8, 9]})
        rows = {row["chapterNo"]: row for row in result["rows"]}
        assert result["ok"] is True
        assert result["listStable"] is True
        assert result["newChapterReady"] is True
        assert rows[8]["found"] is True
        assert rows[8]["draft"] is True
        assert rows[9]["found"] is False
        browser.close()


def test_header_only_page_is_never_accepted_as_all_chapters_absent():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content("""
        <main><h1>章节管理</h1><div>页面外壳已出现，列表仍未挂载</div></main>
        <script>window.chrome={runtime:{onMessage:{addListener(fn){window.__ainovelListener=fn}}}};</script>
        """)
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {"type": "inspectPublicationList", "chapterNos": [8], "timeoutMs": 100})
        assert result["ok"] is False
        assert result["listStable"] is False
        assert result["newChapterReady"] is False
        assert result["code"] == "publication_list_not_ready"
        browser.close()


def test_toolbar_without_list_data_is_not_accepted_as_empty_platform_list():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content("""
        <main><h1>章节管理</h1><button>新建章节</button><div>列表数据仍未挂载</div></main>
        <script>window.chrome={runtime:{onMessage:{addListener(fn){window.__ainovelListener=fn}}}};</script>
        """)
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {"type": "inspectPublicationList", "chapterNos": [8], "timeoutMs": 100})
        assert result["ok"] is False
        assert result["listStable"] is False
        assert result["newChapterReady"] is True
        assert result["listContentReady"] is False
        assert result["code"] == "publication_list_content_not_ready"
        browser.close()


def test_explicit_empty_list_can_be_stably_verified_for_a_new_work():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content("""
        <main><h1>章节管理</h1><button>新建章节</button><div class="empty-state">暂无章节</div></main>
        <script>window.chrome={runtime:{onMessage:{addListener(fn){window.__ainovelListener=fn}}}};</script>
        """)
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {"type": "inspectPublicationList", "chapterNos": [1], "timeoutMs": 4000})
        assert result["ok"] is True
        assert result["listStable"] is True
        assert result["listContentReady"] is True
        assert result["emptyList"] is True
        assert result["rows"][0]["found"] is False
        browser.close()


def test_open_new_chapter_waits_for_async_semantic_button_and_clicks_once():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content("""
        <main><h1>章节管理</h1><div id="toolbar"></div></main>
        <script>
          window.__clicks = 0;
          window.chrome={runtime:{onMessage:{addListener(fn){window.__ainovelListener=fn}}}};
          setTimeout(() => {
            const button = document.createElement('button');
            button.textContent = '新建章节';
            button.onclick = () => { window.__clicks += 1; };
            document.getElementById('toolbar').appendChild(button);
          }, 350);
        </script>
        """)
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {"type": "openNewChapter", "timeoutMs": 2000})
        assert result["ok"] is True
        assert result["mutationAttempted"] is True
        assert page.evaluate("window.__clicks") == 1
        browser.close()


def test_open_new_chapter_accepts_exact_text_in_small_custom_clickable_div():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content("""
        <main><h1>章节管理</h1>
          <div id="custom" class="create-action" style="width:120px;height:36px;cursor:pointer" onclick="window.__clicks += 1">
            <span>新建章节</span>
          </div>
        </main>
        <script>window.__clicks=0;window.chrome={runtime:{onMessage:{addListener(fn){window.__ainovelListener=fn}}}};</script>
        """)
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {"type": "openNewChapter", "timeoutMs": 100})
        assert result["ok"] is True
        assert result["selected"]["id"] == "custom"
        assert page.evaluate("window.__clicks") == 1
        browser.close()


def test_new_chapter_finder_rejects_large_container_that_only_contains_phrase():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.set_content("""
        <main><h1>章节管理</h1>
          <div id="large" style="width:1000px;height:300px;cursor:pointer" onclick="window.__clicks += 1">
            <span>新建章节</span>
          </div>
        </main>
        <script>window.__clicks=0;window.chrome={runtime:{onMessage:{addListener(fn){window.__ainovelListener=fn}}}};</script>
        """)
        page.add_script_tag(path=str(SCRIPT))
        result = page.evaluate("() => ({found: Boolean(findNewChapterControl().element), snapshot: readPublicationListSnapshot([8])})")
        assert result["found"] is False
        assert result["snapshot"]["newChapterReady"] is False
        assert page.evaluate("window.__clicks") == 0
        browser.close()


def test_missing_new_chapter_reports_no_page_mutation():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content("""
        <main><h1>章节管理</h1><p>按钮尚未加载</p></main>
        <script>window.chrome={runtime:{onMessage:{addListener(fn){window.__ainovelListener=fn}}}};</script>
        """)
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {"type": "openNewChapter", "timeoutMs": 100})
        assert result["ok"] is False
        assert result["code"] == "new_chapter_button_missing"
        assert result["mutationAttempted"] is False
        browser.close()


def test_stable_platform_work_id_allows_local_and_fanqie_titles_to_differ():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.route(
            "https://fanqienovel.com/**",
            lambda route: route.fulfill(
                status=200,
                content_type="text/html",
                body="""
                <main><h1>章节管理</h1><p>空脉废体，天道求我别填了</p></main>
                <script>window.chrome={runtime:{onMessage:{addListener(fn){window.__ainovelListener=fn}}}};</script>
                """,
            ),
        )
        page.goto("https://fanqienovel.com/main/writer/chapter-manage/7664986207666850841&title?type=1")
        page.add_script_tag(path=str(SCRIPT))
        matched = invoke_action(page, {
            "type": "inspectPage",
            "bookName": "尘尽天开",
            "workId": "7664986207666850841",
        })
        assert matched["workMatches"] is True
        assert matched["currentWorkId"] == "7664986207666850841"
        mismatch = invoke_action(page, {"type": "inspectPage", "workId": "7999999999999999999"})
        assert mismatch["workMatches"] is False
        browser.close()


def test_next_dialog_is_explicit_publication_transition_and_final_submit_is_separate():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content(publication_flow_html())
        page.add_script_tag(path=str(SCRIPT))
        chapter = {"chapter_no": 6, "title": "第六章 来客", "body": "正文内容", "text_sha256": "f" * 64, "char_count": 4}
        assert invoke_action(page, {"type": "fillChapter", "chapter": chapter})["ok"] is True
        assert invoke_action(page, {"type": "clickNext", "chapter": chapter})["ok"] is True
        transition = invoke_action(page, {"type": "inspectPage"})
        assert transition["publicationFlowReady"] is True
        assert transition["typoPrompt"] is True

        prepared = invoke_action(page, {
            "type": "completePublicationFlow",
            "options": {
                "chapterNo": 6, "publicationDate": "2026-07-23",
                "publicationTime": "20:00", "aiPolicy": "no", "deferFinalSubmit": True,
            },
        })
        assert prepared["ok"] is True
        assert prepared["code"] == "publication_ready"
        assert "定时发布成功" not in page.locator("#publish-settings").inner_text()

        submitted = invoke_action(page, {
            "type": "submitPreparedPublication",
            "options": {
                "chapterNo": 6, "publicationDate": "2026-07-23",
                "publicationTime": "20:00", "aiPolicy": "no",
            },
        })
        assert submitted["ok"] is True
        assert submitted["finalSubmitAttempted"] is True
        assert "定时发布成功" in page.locator("#publish-settings").inner_text()
        browser.close()


def test_failure_after_final_submit_is_marked_ambiguous_not_recoverable():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content(publication_flow_html())
        page.add_script_tag(path=str(SCRIPT))
        chapter = {"chapter_no": 6, "title": "第六章 来客", "body": "正文内容", "text_sha256": "f" * 64, "char_count": 4}
        assert invoke_action(page, {"type": "fillChapter", "chapter": chapter})["ok"] is True
        assert invoke_action(page, {"type": "clickNext", "chapter": chapter})["ok"] is True
        prepared = invoke_action(page, {
            "type": "completePublicationFlow",
            "options": {
                "chapterNo": 6, "publicationDate": "2026-07-23",
                "publicationTime": "20:00", "aiPolicy": "no", "deferFinalSubmit": True,
            },
        })
        assert prepared["ok"] is True
        page.evaluate("""
          document.querySelector('#schedule').onclick = () => {
            const risk = document.createElement('div');
            risk.setAttribute('role', 'dialog');
            risk.textContent = '安全验证';
            document.body.appendChild(risk);
          };
        """)
        result = invoke_action(page, {
            "type": "submitPreparedPublication",
            "options": {
                "chapterNo": 6, "publicationDate": "2026-07-23",
                "publicationTime": "20:00", "aiPolicy": "no",
            },
        })
        assert result["ok"] is False
        assert result["finalSubmitAttempted"] is True
        browser.close()


def editor_action_html(actions: str, handler: str = "") -> str:
    return f"""
    <!doctype html><html><body>
      <input class="serial-input" value="8">
      <input class="serial-editor-input-hint-area" value="兽潮前夜">
      <div class="ProseMirror" contenteditable="true" style="width:800px;height:500px">正文内容</div>
      {actions}
      <script>
        window.chrome = {{runtime: {{onMessage: {{addListener(fn) {{ window.__ainovelListener = fn; }}}}}}}};
        window.__clicked = [];
        {handler}
      </script>
    </body></html>
    """


def chapter_eight() -> dict:
    return {"chapter_no": 8, "title": "第八章 兽潮前夜", "body": "正文内容", "text_sha256": "8" * 64, "char_count": 4}


def test_next_never_clicks_plain_div_container():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content(editor_action_html(
            '<div id="fake-next" style="width:120px;height:40px">下一步</div>',
            "document.getElementById('fake-next').onclick = () => window.__clicked.push('fake');",
        ))
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {"type": "clickNext", "chapter": chapter_eight()})
        assert result["ok"] is False
        assert result["code"] == "next_button_missing"
        assert page.evaluate("window.__clicked") == []
        browser.close()


def test_next_clicks_bottommost_exact_real_button_in_action_area():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1200, "height": 900})
        page.set_content(editor_action_html(
            """
            <button id="top-next" style="position:absolute;top:20px;left:20px">下一步</button>
            <div id="plain-container">下一步</div>
            <footer class="editor-action-footer" style="position:absolute;top:780px;left:20px">
              <button id="bottom-next">下一步</button>
            </footer>
            """,
            """
            document.getElementById('top-next').onclick = () => window.__clicked.push('top');
            document.getElementById('bottom-next').onclick = () => window.__clicked.push('bottom');
            document.getElementById('plain-container').onclick = () => window.__clicked.push('div');
            """,
        ))
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {"type": "clickNext", "chapter": chapter_eight()})
        assert result["ok"] is True
        assert result["selected"]["id"] == "bottom-next"
        assert page.evaluate("window.__clicked") == ["bottom"]
        browser.close()


def test_next_records_url_change_and_editor_remount():
    html = editor_action_html(
        '<footer class="action-footer"><button id="next">下一步</button></footer>',
        """
        document.getElementById('next').onclick = () => {
          history.pushState({}, '', '/main/writer/7664986207666850841/publish/review');
          document.querySelector('.serial-input').remove();
          document.querySelector('.serial-editor-input-hint-area').remove();
          document.querySelector('.ProseMirror').remove();
          const full = document.createElement('button'); full.textContent = '全面检测'; document.body.appendChild(full);
        };
        """,
    )
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.route("https://example.test/**", lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=html))
        page.goto("https://example.test/main/writer/7664986207666850841/publish/")
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {"type": "clickNext", "chapter": chapter_eight()})
        assert result["ok"] is True
        assert result["transition"]["after"]["urlChanged"] is True
        assert result["transition"]["after"]["editor"]["present"] is False
        assert result["transition"]["after"]["state"] != "editor"
        browser.close()


def test_unknown_post_next_state_returns_actionable_diagnostics():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content(editor_action_html(
            '<footer class="action-footer"><button id="next">下一步</button></footer>',
            """
            document.getElementById('next').onclick = () => {
              document.querySelector('.serial-input').remove();
              document.querySelector('.serial-editor-input-hint-area').remove();
              document.querySelector('.ProseMirror').remove();
              document.body.insertAdjacentHTML('beforeend', '<p>未知的中间页面</p><button id="draft">保存草稿</button>');
            };
            """,
        ))
        page.add_script_tag(path=str(SCRIPT))
        next_result = invoke_action(page, {"type": "clickNext", "chapter": chapter_eight()})
        result = invoke_action(page, {
            "type": "completePublicationFlow",
            "options": {"transitionTimeoutMs": 300, "nextTransition": next_result["transition"]},
        })
        assert result["ok"] is False
        assert result["code"] == "post_next_state_unknown"
        assert result["diagnostics"]["editor"]["present"] is False
        assert any(button["text"] == "保存草稿" for button in result["diagnostics"]["visibleButtons"])
        assert "未知的中间页面" in result["diagnostics"]["pageTextStart"]
        assert result["transition"]["before"]["editor"]["present"] is True
        browser.close()
