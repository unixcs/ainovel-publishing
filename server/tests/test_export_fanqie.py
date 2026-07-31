import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "export_fanqie.py"
SPEC = importlib.util.spec_from_file_location("ainovel_export_fanqie", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
parse_markdown_chapter = MODULE.parse_markdown_chapter


def test_plain_first_line_chapter_heading_becomes_title_and_is_removed_from_body(tmp_path: Path):
    chapter = tmp_path / "13.md"
    chapter.write_text("第十三章 白眉\n\n陆尘往前走。\n", encoding="utf-8")

    title, body = parse_markdown_chapter(chapter, "第13章")

    assert title == "第十三章 白眉"
    assert body == "陆尘往前走。"


def test_markdown_heading_after_leading_blank_is_still_recognized(tmp_path: Path):
    chapter = tmp_path / "14.md"
    chapter.write_text("\n\n# 第十四章 同行的路\n\n正文。\n", encoding="utf-8")

    title, body = parse_markdown_chapter(chapter, "第14章")

    assert title == "第十四章 同行的路"
    assert body == "正文。"


def test_ordinary_first_line_prose_is_not_mistaken_for_a_title(tmp_path: Path):
    chapter = tmp_path / "15.md"
    chapter.write_text("第一声钟响的时候，陆尘醒了。\n\n正文继续。\n", encoding="utf-8")

    title, body = parse_markdown_chapter(chapter, "第15章")

    assert title == "第15章"
    assert body == "第一声钟响的时候，陆尘醒了。\n\n正文继续。"
