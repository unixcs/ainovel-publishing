from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
CHROME = "/snap/bin/chromium"


def test_simplified_sidepanel_renders_user_labels_without_internal_block_codes():
    plan = {
        "plan_id": "abc1234567890",
        "status": "draft",
        "daily_limit": 9999,
        "default_slot": "20:00",
        "ai_policy": "remember",
        "items": [
            {
                "chapter_no": 4,
                "quota_units": 4497,
                "publication_date": "2026-07-22",
                "publication_time": "21:02",
                "status": "reserved",
                "reason": "existing_platform_record_unverified",
            },
            {
                "chapter_no": 6,
                "quota_units": 3713,
                "publication_date": "2026-07-24",
                "publication_time": "20:00",
                "status": "planned",
                "reason": "resume_current_editor",
            },
        ],
    }
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.add_init_script(
            """
            window.chrome = {runtime: {
              lastError: null,
              sendMessage(payload, callback) {
                const responses = {
                  getSettings: {baseUrl:'http://127.0.0.1:8787',apiToken:'token',selectedSlot:'20:00',aiPolicy:'remember',automationEnabled:false},
                  health: {ok:true,version:'0.3.1'},
                  getPublicationSettings: {daily_limit:9999,slots:['12:00','20:00','22:00'],default_slot:'20:00'},
                  getBooks: {books:[{book_id:'book',name:'示例小说',ready_count:1}]},
                  getChapters: {chapters:[{book_id:'book',chapter_no:6,title:'第六章 夜话',status:'filled',platform_state:null,version:1,char_count:3965,text_sha256:'aaaaaaaaaaaaaaa'}]},
                  getPlans: {plans:[%s]}
                };
                queueMicrotask(() => callback({ok:true,result:responses[payload.type] || {}}));
              }
            }};
            """ % __import__("json").dumps(plan, ensure_ascii=False)
        )
        page.goto((ROOT / "sidepanel.html").as_uri())
        page.wait_for_function("document.querySelector('#connectionBadge')?.textContent === '已连接'")
        assert errors == []
        assert page.locator("#inspectPlatform").inner_text() == "刷新番茄状态"
        assert page.locator("#smartRunNext").inner_text() == "自动处理下一章"
        assert page.locator(".advanced-panel").first.get_attribute("open") is None
        assert page.locator("#planList").is_visible() is False
        page.locator(".advanced-panel").first.locator("summary").click()
        text = page.locator("#planList").inner_text()
        assert "平台已有，自动跳过" in text
        assert "从当前编辑页继续" in text
        assert "existing_platform_record_unverified" not in text
        browser.close()


def test_recoverable_blocked_chapter_has_one_clickable_primary_recovery_action():
    chapter = {
        "book_id": "book", "chapter_no": 8, "title": "第八章 兽潮前夜",
        "status": "blocked", "platform_state": None, "version": 1,
        "char_count": 4846, "text_sha256": "8" * 64, "body": "正文",
        "recovery": {
            "allowed": True, "mode": "recover_unsubmitted",
            "reason": "platform_absence_check_required", "last_checkpoint": "next_clicked",
            "plan_id": "old-plan",
        },
    }
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.add_init_script(
            """
            window.chrome = {runtime: {
              lastError: null,
              sendMessage(payload, callback) {
                const responses = {
                  getSettings: {baseUrl:'http://127.0.0.1:8787',apiToken:'token',selectedSlot:'20:00',aiPolicy:'remember',automationEnabled:false},
                  health: {ok:true,version:'0.3.1'},
                  getPublicationSettings: {daily_limit:9999,slots:['12:00','20:00','22:00'],default_slot:'20:00'},
                  getBooks: {books:[{book_id:'book',name:'示例小说',ready_count:0}]},
                  getChapters: {chapters:[CHAPTER]},
                  getChapter: CHAPTER,
                  getPlans: {plans:[]}
                };
                queueMicrotask(() => callback({ok:true,result:responses[payload.type] || {}}));
              }
            }};
            """.replace("CHAPTER", __import__("json").dumps(chapter, ensure_ascii=False))
        )
        page.goto((ROOT / "sidepanel.html").as_uri())
        page.wait_for_function("document.querySelector('#connectionBadge')?.textContent === '已连接'")
        page.locator(".chapter-item").click()
        page.wait_for_function("document.querySelector('#smartChapterAction')?.textContent.includes('恢复')")
        assert errors == []
        assert page.locator("#smartChapterAction").inner_text() == "恢复并重新处理本章"
        assert page.locator("#smartChapterAction").is_enabled()
        assert page.locator("#fillChapter").is_disabled()
        assert page.locator("#resumeBlocked").is_enabled()
        browser.close()


def test_background_arms_final_submission_only_after_preparation():
    source = (ROOT / "background.js").read_text(encoding="utf-8")
    assert 'deferFinalSubmit: true' in source
    assert '"final_submit_armed"' in source
    assert 'type: "submitPreparedPublication"' in source
    assert source.index('"final_submit_armed"') < source.index('type: "submitPreparedPublication"')
