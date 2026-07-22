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
                  health: {ok:true,version:'0.3.2'},
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
                  health: {ok:true,version:'0.3.2'},
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


def test_background_canonical_navigation_binds_dynamic_work_and_reuses_preflight():
    source = (ROOT / "background.js").read_text(encoding="utf-8")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content("<html><body></body></html>")
        page.evaluate(
            """() => {
            window.__store = {};
            window.__updated = [];
            window.__adapterVersion = '0.3.1';
            window.__reloadCount = 0;
            window.__tabs = [{
              id: 17, active: true, status: 'complete',
              url: 'https://fanqienovel.com/main/writer/chapter-manage/7664986207666850841&name?type=2'
            }];
            window.chrome = {
              runtime: {
                onInstalled: {addListener() {}}, onStartup: {addListener() {}},
                onMessage: {addListener() {}}, lastError: null
              },
              alarms: {onAlarm: {addListener() {}}, create: async () => {}},
              sidePanel: {setPanelBehavior: async () => {}},
              storage: {local: {
                async get(defaults) { return {...defaults, ...window.__store}; },
                async set(values) { Object.assign(window.__store, values); }
              }},
              tabs: {
                async query() { return window.__tabs.map(tab => ({...tab})); },
                async get(id) { return {...window.__tabs.find(tab => tab.id === Number(id))}; },
                async update(id, changes) {
                  const tab = window.__tabs.find(item => item.id === Number(id));
                  Object.assign(tab, changes, {status: 'complete'}); window.__updated.push({...changes}); return {...tab};
                },
                async reload(id) {
                  const tab=window.__tabs.find(item => item.id === Number(id)); tab.status='complete';
                  window.__adapterVersion='0.3.2'; window.__reloadCount += 1;
                },
                async create(changes) { const tab={id:99,status:'complete',...changes}; window.__tabs.push(tab); return {...tab}; },
                async sendMessage(_id, message) {
                  if (message.type === 'inspectPage') return {ok:true,adapterVersion:window.__adapterVersion,state:'writer'};
                  return {ok:true};
                }
              }
            };
            }
            """
        )
        page.add_script_tag(content=source)
        result = page.evaluate(
            """async () => {
              const workId = await resolvePlatformWorkId('local-book', {name:'本地书名'});
              const tab = await ensureChapterManagementTab(workId);
              await rememberPlatformPreflight('local-book', workId, tab, {url:tab.url});
              const reused = await recentPlatformPreflightTab('local-book', workId);
              return {workId, tab, reused, store:window.__store, updated:window.__updated, reloadCount:window.__reloadCount};
            }"""
        )
        assert result["workId"] == "7664986207666850841"
        assert result["tab"]["url"] == "https://fanqienovel.com/main/writer/chapter-manage/7664986207666850841?type=1"
        assert result["reused"]["id"] == 17
        assert result["store"]["platformWorkIdByBook"]["local-book"] == "7664986207666850841"
        assert result["store"]["platformPreflightByBook"]["local-book"]["tabId"] == 17
        assert result["updated"][-1]["url"].endswith("/7664986207666850841?type=1")
        assert result["reloadCount"] == 1
        browser.close()


def test_main_button_no_longer_requires_user_to_open_writer_page_first():
    source = (ROOT / "sidepanel.js").read_text(encoding="utf-8")
    start = source.index("async function smartRunNext()")
    end = source.index("async function smartProcessSelected()")
    block = source[start:end]
    assert "inspectPlatform()" in block
    assert "inspectActivePage" not in block
    assert "请先打开章节管理页" not in block
