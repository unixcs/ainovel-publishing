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


def test_blank_editor_uses_stable_platform_title_for_later_duplicate():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content(page_html())
        page.add_script_tag(path=str(SCRIPT))
        result = invoke(page, {
            "chapter_no": 35,
            "title": "第三十五章 晨钟",
            "platform_title": "晨钟（二）",
            "body": "正文内容",
            "text_sha256": "3" * 64,
            "char_count": 4,
        })
        assert result["ok"] is True
        assert page.locator(".serial-input").input_value() == "35"
        assert page.locator(".serial-editor-input-hint-area").input_value() == "晨钟（二）"
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


def test_fill_waits_for_persistent_fanqie_draft_route_and_editor_remount():
    html = """
    <!doctype html><html><body>
      <main id="editor-root">
        <input id="old-number" class="serial-input">
        <input id="old-title" class="serial-editor-input-hint-area">
        <div id="old-editor" class="ProseMirror" contenteditable="true" style="width:800px;height:500px"></div>
      </main>
      <script>
        window.chrome={runtime:{onMessage:{addListener(fn){window.__ainovelListener=fn}}}};
        window.__oldTouched = false;
        for (const node of document.querySelectorAll('#old-number,#old-title,#old-editor')) {
          node.addEventListener('input', () => { window.__oldTouched = true; });
        }
        setTimeout(() => {
          history.replaceState({}, '', '/main/writer/7664986207666850841/publish/7665357226344710718?enter_from=newchapter');
          document.getElementById('editor-root').innerHTML = `
            <input id="new-number" class="serial-input">
            <input id="new-title" class="serial-editor-input-hint-area">
            <div id="new-editor" class="ProseMirror" contenteditable="true" style="width:800px;height:500px"></div>
            <div id="real-next" class="byte-btn byte-btn-primary" style="position:fixed;top:20px;right:20px;width:96px;height:36px;cursor:pointer"><span>下一步</span></div>`;
        }, 600);
      </script>
    </body></html>
    """
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1200, "height": 900})
        page.route(
            "https://fanqienovel.com/**",
            lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=html),
        )
        page.goto("https://fanqienovel.com/main/writer/7664986207666850841/publish/?enter_from=newchapter")
        page.add_script_tag(path=str(SCRIPT))
        result = invoke(page, {
            "chapter_no": 8,
            "title": "第八章 兽潮前夜",
            "body": "第一段。\n\n第二段。",
            "text_sha256": "8" * 64,
            "char_count": 8,
        })
        assert result["ok"] is True
        assert page.evaluate("window.__oldTouched") is False
        assert page.locator("#new-number").input_value() == "8"
        assert page.locator("#new-title").input_value() == "兽潮前夜"
        assert "第一段" in page.locator("#new-editor").inner_text()
        assert page.url.endswith("/publish/7665357226344710718?enter_from=newchapter")
        browser.close()


def test_fill_refills_once_when_same_fanqie_draft_remounts_empty_after_one_second():
    html = """
    <!doctype html><html><body>
      <input class="serial-input">
      <input class="serial-editor-input-hint-area">
      <div id="editor" class="ProseMirror" contenteditable="true" style="width:800px;height:500px"></div>
      <div class="byte-btn byte-btn-primary" style="position:fixed;top:20px;right:20px;width:96px;height:36px;cursor:pointer"><span>下一步</span></div>
      <script>
        window.chrome={runtime:{onMessage:{addListener(fn){window.__ainovelListener=fn}}}};
        let clearScheduled = false;
        document.getElementById('editor').addEventListener('input', () => {
          if (clearScheduled || !document.getElementById('editor').innerText.trim()) return;
          clearScheduled = true;
          setTimeout(() => { document.getElementById('editor').innerHTML = ''; }, 1000);
        });
      </script>
    </body></html>
    """
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1200, "height": 900})
        page.route(
            "https://fanqienovel.com/**",
            lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=html),
        )
        page.goto("https://fanqienovel.com/main/writer/7664986207666850841/publish/7665357226344710718")
        page.add_script_tag(path=str(SCRIPT))
        result = invoke(page, {
            "chapter_no": 8,
            "title": "第八章 兽潮前夜",
            "body": "第一段。\n\n第二段。",
            "text_sha256": "8" * 64,
            "char_count": 8,
        })
        assert result["ok"] is True
        assert result["refilledAfterRemount"] is True
        assert "第一段" in page.locator("#editor").inner_text()
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
      <button id="next" style="position:fixed;top:20px;right:20px">下一步</button>
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


def arco_publication_flow_html() -> str:
    """A close DOM model of the current Fanqie/Arco modal sequence in live screenshots."""
    return """
    <!doctype html><html><head><style>
      .arco-modal-wrapper { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; }
      .arco-modal { width:520px; min-height:240px; background:white; padding:20px; }
      .arco-modal-content { min-height:80px; }
      .arco-modal-footer { display:flex; justify-content:flex-end; gap:16px; }
      button,.arco-radio,.setting-row,input { min-width:60px; min-height:28px; }
      .setting-row { padding:10px; }
      input[type=radio] { position:absolute; opacity:0; width:1px; height:1px; }
      .arco-picker-container,.arco-timepicker-container { min-width:260px; min-height:120px; padding:8px; }
      .arco-picker-cell,.arco-timepicker-cell { display:inline-block; min-width:24px; min-height:24px; padding:2px; }
      .arco-timepicker-list { display:inline-block; width:90px; max-height:220px; overflow:auto; vertical-align:top; }
    </style></head><body>
      <input class="serial-input" value="">
      <input class="serial-editor-input-hint-area" value="">
      <div class="ProseMirror" contenteditable="true" style="width:800px;height:500px"></div>
      <button id="outside-submit">提交</button>
      <button id="next" style="position:fixed;top:20px;right:20px">下一步</button>
      <script>
        window.chrome = {runtime: {onMessage: {addListener(fn) { window.__ainovelListener = fn; }}}};
        window.__flow = [];
        window.__chapterNo = 8;
        window.__previousChapterNo = 7;
        window.__submitted = [];
        window.__pickerFlow = [];
        document.getElementById('outside-submit').onclick = () => window.__flow.push('outside-submit');

        function typoModal() {
          document.body.insertAdjacentHTML('beforeend', `
            <div class="arco-modal-wrapper" id="typo-wrapper">
              <div class="arco-modal" id="typo-modal">
                <div class="arco-modal-header"><div class="arco-modal-title">发布提示</div></div>
                <div class="arco-modal-content">检测到你还有错别字未修改，是否确定提交？</div>
                <div class="arco-modal-footer">
                  <button class="arco-btn">取消</button>
                  <button id="typo-real-submit" class="arco-btn arco-btn-primary">提交</button>
                </div>
              </div>
            </div>`);
          document.getElementById('typo-real-submit').onclick = () => {
            window.__flow.push('typo-submit');
            document.getElementById('typo-wrapper').remove();
            setTimeout(detectionModal, 250);
          };
        }

        function detectionModal() {
          document.body.insertAdjacentHTML('beforeend', `
            <div class="arco-modal-wrapper" id="detection-wrapper">
              <div class="arco-modal" id="detection-modal">
                <div class="arco-modal-header"><div class="arco-modal-title">请选择内容检测方式</div></div>
                <div class="arco-modal-content">
                  <p>全面检测（本章节剩余次数：2/2次）</p>
                  <p>将对章节内容进行深度排查，标注当前章节可能存在的风险內容，辅助提升内容通过效率；</p>
                  <p>基础检测（不限次数）</p>
                  <p>使用平台常规功能排查特定范围的违规内容，不覆盖范围外的检测。</p>
                </div>
                <div class="arco-modal-footer">
                  <button id="basic-check" class="arco-btn">仅基础检测</button>
                  <button id="full-check-real" class="arco-btn arco-btn-primary">全面检测</button>
                </div>
              </div>
            </div>`);
          document.getElementById('basic-check').onclick = () => window.__flow.push('basic-check');
          document.getElementById('full-check-real').onclick = () => {
            window.__flow.push('full-check');
            document.getElementById('full-check-real').disabled = true;
            setTimeout(() => {
              document.getElementById('detection-wrapper').remove();
              settingsModal();
            }, 650);
          };
        }

        function settingsModal() {
          document.body.insertAdjacentHTML('beforeend', `
            <div class="arco-modal-wrapper" id="settings-wrapper">
              <div class="arco-modal" id="publish-settings-live">
                <div class="arco-modal-header"><div class="arco-modal-title">发布设置</div></div>
                <div class="arco-modal-content">
                  <div class="chapter-context">
                    <div>分卷　第一卷：默认</div>
                    <div>章节　第${window.__chapterNo}章 测试标题</div>
                    <div>上次提交　第一卷 第${window.__previousChapterNo}章 上一章</div>
                  </div>
                  <div class="setting-row ai-row">
                    <span>是否使用AI</span>
                    <label class="arco-radio"><input name="ai" type="radio" value="yes"><span>是</span></label>
                    <label class="arco-radio"><input name="ai" type="radio" value="no"><span>否</span></label>
                  </div>
                  <div class="setting-row schedule-row">
                    <span>定时发布</span>
                    <button id="schedule-switch" class="arco-switch" role="switch" aria-checked="false"></button>
                    <span>关闭定时发布后，章节在通过审核后会立即发布</span>
                    <div id="schedule-fields"></div>
                  </div>
                </div>
                <div class="arco-modal-footer">
                  <button class="arco-btn">取消</button>
                  <button id="confirm-publish" class="arco-btn arco-btn-primary">确认发布</button>
                </div>
              </div>
            </div>`);
          window.__committedDate = '2026-07-23';
          window.__committedTime = '21:00';
          document.getElementById('schedule-switch').onclick = () => {
            const control = document.getElementById('schedule-switch');
            const on = control.getAttribute('aria-checked') !== 'true';
            control.setAttribute('aria-checked', String(on));
            control.classList.toggle('arco-switch-checked', on);
            if (on) setTimeout(() => {
              document.getElementById('schedule-fields').innerHTML = `
                <div class="setting-row date-row"><span>日期</span><div class="arco-picker"><input placeholder="请选择日期" class="arco-picker-start-time publish-date" type="text" value="2026-07-23"></div></div>
                <div class="setting-row time-row"><span>时间</span><div class="arco-picker"><input placeholder="请选择时间" class="arco-picker-start-time publish-time" type="text" value="21:00"></div></div>`;
              const dateInput = document.querySelector('.publish-date');
              const timeInput = document.querySelector('.publish-time');
              dateInput.onclick = () => {
                document.querySelector('.arco-picker-container')?.remove();
                dateInput.closest('.date-row').insertAdjacentHTML('beforeend', `
                  <div class="arco-picker-container">
                    <div class="arco-picker-header-value"><span class="arco-picker-header-label">2026年</span><span class="arco-picker-header-label">7月</span></div>
                    <div class="arco-picker-body">${[23,24,25,26,27,28,29,30,31].map(day => `<div class="arco-picker-cell arco-picker-cell-in-view"><div class="arco-picker-date"><div class="arco-picker-date-value">${day}</div></div></div>`).join('')}</div>
                  </div>`);
                document.querySelectorAll('.arco-picker-cell-in-view').forEach(cell => {
                  cell.onclick = () => {
                    const day = cell.querySelector('.arco-picker-date-value').textContent.padStart(2, '0');
                    window.__committedDate = `2026-07-${day}`;
                    dateInput.value = window.__committedDate;
                    window.__pickerFlow.push('date-cell');
                    document.querySelector('.arco-picker-container').remove();
                  };
                });
              };
              timeInput.onclick = () => {
                document.querySelector('.arco-timepicker-container')?.remove();
                const hours = Array.from({length:24}, (_, value) => String(value).padStart(2, '0'));
                const minutes = Array.from({length:60}, (_, value) => String(value).padStart(2, '0'));
                const [selectedHour, selectedMinute] = window.__committedTime.split(':');
                timeInput.closest('.time-row').insertAdjacentHTML('beforeend', `
                  <div class="arco-timepicker-container">
                    <div class="arco-timepicker-list"><ul>${hours.map(value => `<li data-value="${value}" class="arco-timepicker-cell ${value === selectedHour ? 'arco-timepicker-cell-selected' : ''}"><div class="arco-timepicker-cell-inner">${value}</div></li>`).join('')}</ul></div>
                    <div class="arco-timepicker-list"><ul>${minutes.map(value => `<li data-value="${value}" class="arco-timepicker-cell ${value === selectedMinute ? 'arco-timepicker-cell-selected' : ''}"><div class="arco-timepicker-cell-inner">${value}</div></li>`).join('')}</ul></div>
                    <div class="arco-timepicker-footer-btn-wrapper"><button class="arco-btn">此刻</button><button id="time-confirm" class="arco-btn arco-btn-primary">确定</button></div>
                  </div>`);
                const lists = document.querySelectorAll('.arco-timepicker-list');
                lists.forEach(list => list.querySelectorAll('.arco-timepicker-cell').forEach(cell => {
                  cell.onclick = () => {
                    list.querySelector('.arco-timepicker-cell-selected')?.classList.remove('arco-timepicker-cell-selected');
                    cell.classList.add('arco-timepicker-cell-selected');
                  };
                }));
                document.getElementById('time-confirm').onclick = () => {
                  const values = [...document.querySelectorAll('.arco-timepicker-list')].map(list => list.querySelector('.arco-timepicker-cell-selected').dataset.value);
                  window.__committedTime = values.join(':');
                  timeInput.value = window.__committedTime;
                  window.__pickerFlow.push('time-confirm');
                  document.querySelector('.arco-timepicker-container').remove();
                };
              };
            }, 300);
          };
          document.getElementById('confirm-publish').onclick = () => {
            const yes = document.querySelector("input[name='ai'][value='yes']").checked;
            const scheduled = document.getElementById('schedule-switch').getAttribute('aria-checked') === 'true';
            const date = window.__committedDate || '';
            const time = window.__committedTime || '';
            window.__submitted.push({chapterNo:window.__chapterNo, yes, scheduled, date, time});
            window.__flow.push('confirm-publish');
            document.getElementById('settings-wrapper').remove();
            document.body.insertAdjacentHTML('beforeend', `<div role="status">已提交，预计1小时内完成审核</div>
              <main><h1>章节管理</h1><button>新建章节</button>
              <div class="chapter-row">第${window.__chapterNo}章 测试标题　审核中　${date} ${time}</div></main>`);
          };
        }

        document.getElementById('next').onclick = typoModal;
      </script>
    </body></html>
    """


def test_live_arco_modal_sequence_uses_footer_submit_full_check_ai_schedule_and_success_toast():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1365, "height": 900})
        page.set_content(arco_publication_flow_html())
        page.add_script_tag(path=str(SCRIPT))
        chapter = {"chapter_no": 8, "title": "第八章 测试标题", "body": "第一段。\n\n第二段。", "text_sha256": "8" * 64, "char_count": 8}
        assert invoke_action(page, {"type": "fillChapter", "chapter": chapter})["ok"] is True
        assert invoke_action(page, {"type": "clickNext", "chapter": chapter})["ok"] is True
        prepared = invoke_action(page, {
            "type": "completePublicationFlow",
            "options": {
                "chapterNo": 8, "publicationDate": "2026-07-25",
                "publicationTime": "20:00", "aiPolicy": "use", "deferFinalSubmit": True,
            },
        })
        assert prepared["ok"] is True
        assert prepared["code"] == "publication_ready"
        assert page.evaluate("window.__flow") == ["typo-submit", "full-check"]
        assert page.locator("input[name='ai'][value='yes']").is_checked()
        assert page.locator("#schedule-switch").get_attribute("aria-checked") == "true"
        assert page.locator(".publish-date").input_value() == "2026-07-25"
        assert page.locator(".publish-time").input_value() == "20:00"
        assert page.evaluate("window.__pickerFlow") == ["date-cell", "time-confirm"]
        assert page.locator(".arco-picker-container:visible, .arco-timepicker-container:visible").count() == 0
        assert page.evaluate("window.__submitted") == []

        submitted = invoke_action(page, {
            "type": "submitPreparedPublication",
            "options": {
                "chapterNo": 8, "publicationDate": "2026-07-25",
                "publicationTime": "20:00", "aiPolicy": "use",
            },
        })
        assert submitted["ok"] is True
        assert submitted["code"] == "schedule_submitted"
        assert page.evaluate("window.__flow") == ["typo-submit", "full-check", "confirm-publish"]
        assert page.evaluate("window.__submitted") == [{
            "chapterNo": 8, "yes": True, "scheduled": True,
            "date": "2026-07-25", "time": "20:00",
        }]
        assert "已提交，预计1小时内完成审核" in page.locator("body").inner_text()
        assert page.locator("#outside-submit").count() == 1
        browser.close()


def test_explicit_platform_rejection_is_returned_instead_of_ambiguous_timeout():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1365, "height": 900})
        page.set_content(arco_publication_flow_html())
        page.add_script_tag(path=str(SCRIPT))
        chapter = {
            "chapter_no": 35, "title": "第三十五章 晨钟",
            "platform_title": "晨钟（二）", "body": "正文内容",
            "text_sha256": "3" * 64, "char_count": 4,
        }
        assert invoke_action(page, {"type": "fillChapter", "chapter": chapter})["ok"] is True
        page.evaluate("window.__chapterNo=35; window.__previousChapterNo=34")
        assert invoke_action(page, {"type": "clickNext", "chapter": chapter})["ok"] is True
        options = {
            # The reusable fixture renders “测试标题” inside its publication modal.
            "chapterNo": 35, "title": "测试标题",
            "publicationDate": "2026-07-25", "publicationTime": "20:00",
            "aiPolicy": "use", "deferFinalSubmit": True,
        }
        prepared = invoke_action(page, {"type": "completePublicationFlow", "options": options})
        assert prepared["ok"] is True, prepared
        page.evaluate("""() => {
          document.getElementById('confirm-publish').onclick = () => {
            const toast = document.createElement('div');
            toast.className = 'arco-message arco-message-error';
            toast.setAttribute('role', 'alert');
            toast.style.cssText = 'display:block;width:360px;height:40px';
            toast.textContent = '本书中存在重复标题，请修改后再发布';
            document.body.appendChild(toast);
          };
        }""")
        submitted = invoke_action(page, {
            "type": "submitPreparedPublication",
            "options": {**options, "deferFinalSubmit": False},
        })
        assert submitted["ok"] is False
        assert submitted["code"] == "platform_submission_rejected"
        assert submitted["submissionRejected"] is True
        assert submitted["finalSubmitAttempted"] is True
        assert submitted["rejectionMessage"] == "本书中存在重复标题，请修改后再发布"
        assert page.locator("#confirm-publish").count() == 1
        browser.close()


def test_same_full_flow_can_prepare_and_submit_three_consecutive_chapters():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        for chapter_no, publication_date in [(8, "2026-07-25"), (9, "2026-07-26"), (10, "2026-07-27")]:
            page = browser.new_page(viewport={"width": 1365, "height": 900})
            page.set_content(arco_publication_flow_html())
            page.evaluate("args => { window.__chapterNo=args.n; window.__previousChapterNo=args.n-1; }", {"n": chapter_no})
            page.add_script_tag(path=str(SCRIPT))
            chapter = {
                "chapter_no": chapter_no, "title": f"第{chapter_no}章 测试标题",
                "body": f"第{chapter_no}章正文。", "text_sha256": str(chapter_no)[-1] * 64,
                "char_count": 8,
            }
            assert invoke_action(page, {"type": "fillChapter", "chapter": chapter})["ok"] is True
            assert invoke_action(page, {"type": "clickNext", "chapter": chapter})["ok"] is True
            result = invoke_action(page, {
                "type": "completePublicationFlow",
                "options": {
                    "chapterNo": chapter_no, "publicationDate": publication_date,
                    "publicationTime": "20:00", "aiPolicy": "use",
                },
            })
            assert result["ok"] is True
            assert page.evaluate("window.__submitted[0]") == {
                "chapterNo": chapter_no, "yes": True, "scheduled": True,
                "date": publication_date, "time": "20:00",
            }
            page.close()
        browser.close()


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


def test_publication_settings_waits_for_arco_modal_hydration_before_context_check():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content("""
        <!doctype html><html><body>
          <div role="dialog" id="publish-settings" style="width:520px;min-height:240px">
            <h2>发布设置</h2>
          </div>
          <script>
            window.chrome = {runtime: {onMessage: {addListener(fn) { window.__ainovelListener = fn; }}}};
            setTimeout(() => {
              const settings = document.getElementById('publish-settings');
              settings.innerHTML = `
                <h2>发布设置</h2>
                <p>章节 第20章 追影</p>
                <p>上次提交 第一卷 第19章 一卷空白</p>
                <label>是否使用 AI <span id="ai-no" role="radio" aria-checked="false">否</span></label>
                <label>发布方式 <span id="timing" role="radio" aria-checked="false">定时发布</span></label>
                <label>发布日期 <input id="publish-date" type="date"></label>
                <label>发布时间 <select id="publish-time"><option value="20:00">20:00</option></select></label>
                <button id="confirm-publish">确认发布</button>`;
              document.getElementById('ai-no').onclick = () => document.getElementById('ai-no').setAttribute('aria-checked', 'true');
              document.getElementById('timing').onclick = () => document.getElementById('timing').setAttribute('aria-checked', 'true');
              document.getElementById('confirm-publish').onclick = () => {
                settings.insertAdjacentHTML('beforeend', '<p>已提交，预计1小时内完成审核</p>');
              };
            }, 300);
          </script>
        </body></html>
        """)
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {
            "type": "submitPreparedPublication",
            "options": {
                "chapterNo": 20, "publicationDate": "2026-08-06",
                "publicationTime": "20:00", "aiPolicy": "no",
            },
        })
        assert result["ok"] is True
        assert result["code"] == "schedule_submitted"
        assert "已提交" in page.locator("#publish-settings").inner_text()
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
        <div role="dialog"><p>安全验证：检测到操作频繁，请完成滑块验证</p><button id="cancel">取消</button></div>
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


def reschedule_flow_html() -> str:
    return """
    <!doctype html><html><head><style>
      table { width: 900px; }
      tr { height: 44px; }
      .tomato-clock { display:inline-block; width:20px; height:20px; cursor:pointer; }
      [role=dialog] { width:520px; min-height:220px; padding:20px; }
      input,select,button,[role=switch] { min-width:80px; min-height:28px; }
    </style></head><body>
      <h1>章节管理</h1>
      <table><tbody><tr id="chapter-9">
        <td>第9章 青石劫</td><td>4675</td><td>待发布</td>
        <td class="timing">2026-07-26 20:00 <i class="tomato-clock"></i></td>
      </tr></tbody></table>
      <script>
        window.chrome = {runtime: {onMessage: {addListener(fn) { window.__ainovelListener = fn; }}}};
        window.__confirmed = [];
        document.querySelector('.tomato-clock').onclick = () => {
          document.body.insertAdjacentHTML('beforeend', `
            <div role="dialog" id="modify-timing">
              <h2>修改定时</h2><p>章节 第9章 青石劫</p>
              <label>日期 <input id="modify-date" type="date" value="2026-07-26"></label>
              <label>时间 <select id="modify-time"><option value="20:00">20:00</option></select></label>
              <button id="cancel-modify">取消</button><button id="confirm-modify">确认修改</button>
            </div>`);
          document.getElementById('cancel-modify').onclick = () => document.getElementById('modify-timing').remove();
          document.getElementById('confirm-modify').onclick = () => {
            const date = document.getElementById('modify-date').value;
            const time = document.getElementById('modify-time').value;
            window.__confirmed.push({date, time});
            document.querySelector('#chapter-9 .timing').textContent = `${date} ${time}`;
            document.getElementById('modify-timing').remove();
          };
        };
      </script>
    </body></html>
    """


def test_scheduled_chapter_can_be_rescheduled_and_read_back_without_deletion():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content(reschedule_flow_html())
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {
            "type": "reschedulePublication",
            "options": {
                "chapterNo": 9, "title": "第九章 青石劫",
                "publicationDate": "2026-07-25", "publicationTime": "20:00",
            },
        })
        assert result["ok"] is True
        assert result["code"] == "schedule_rescheduled"
        assert result["previousPublicationDate"] == "2026-07-26"
        assert page.evaluate("window.__confirmed") == [{"date": "2026-07-25", "time": "20:00"}]
        assert "2026-07-25 20:00" in page.locator("#chapter-9").inner_text()
        browser.close()


def test_reschedule_refuses_a_title_mismatch_before_opening_the_dialog():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content(reschedule_flow_html())
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {
            "type": "reschedulePublication",
            "options": {
                "chapterNo": 9, "title": "第九章 其他标题",
                "publicationDate": "2026-07-25", "publicationTime": "20:00",
            },
        })
        assert result["ok"] is False
        assert result["code"] == "reschedule_title_mismatch"
        assert page.locator("#modify-timing").count() == 0
        assert page.evaluate("window.__confirmed") == []
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
        result = invoke_action(page, {"type": "clickNext", "chapter": chapter_eight(), "timeoutMs": 100})
        assert result["ok"] is False
        assert result["code"] == "next_button_missing"
        assert page.evaluate("window.__clicked") == []
        browser.close()


def test_next_clicks_top_editor_action_and_rejects_lower_tutorial_control():
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
        assert result["selected"]["id"] == "top-next"
        assert page.evaluate("window.__clicked") == ["top"]
        browser.close()


def test_next_accepts_small_custom_byte_button_in_top_editor_bar():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1200, "height": 900})
        page.set_content(editor_action_html(
            """
            <div id="real-next" class="byte-btn byte-btn-primary" style="position:fixed;top:20px;right:20px;width:96px;height:36px;cursor:pointer">
              <span>下一步</span>
            </div>
            <div role="dialog" style="position:fixed;top:300px;left:20px;width:300px;height:160px">
              <button id="guide-next">下一步</button>
            </div>
            """,
            """
            document.getElementById('real-next').onclick = () => window.__clicked.push('real');
            document.getElementById('guide-next').onclick = () => window.__clicked.push('guide');
            """,
        ))
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {"type": "clickNext", "chapter": chapter_eight()})
        assert result["ok"] is True
        assert result["selected"]["id"] == "real-next"
        assert result["selected"]["text"] == "下一步"
        assert page.evaluate("window.__clicked") == ["real"]
        browser.close()


def test_next_waits_for_top_custom_control_to_become_enabled():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1200, "height": 900})
        page.set_content(editor_action_html(
            """
            <div id="real-next" class="byte-btn byte-btn-primary disabled" aria-disabled="true"
                 style="position:fixed;top:20px;right:20px;width:96px;height:36px;cursor:pointer">
              <span>下一步</span>
            </div>
            """,
            """
            document.getElementById('real-next').onclick = () => window.__clicked.push('real');
            setTimeout(() => {
              const next = document.getElementById('real-next');
              next.classList.remove('disabled');
              next.setAttribute('aria-disabled', 'false');
            }, 700);
            """,
        ))
        page.add_script_tag(path=str(SCRIPT))
        result = invoke_action(page, {
            "type": "clickNext", "chapter": chapter_eight(), "timeoutMs": 3000,
        })
        assert result["ok"] is True
        assert result["selected"]["id"] == "real-next"
        assert page.evaluate("window.__clicked") == ["real"]
        browser.close()


def test_next_records_url_change_and_editor_remount():
    html = editor_action_html(
        '<header class="action-header"><button id="next" style="position:fixed;top:20px;right:20px">下一步</button></header>',
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
            '<header class="action-header"><button id="next" style="position:fixed;top:20px;right:20px">下一步</button></header>',
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
