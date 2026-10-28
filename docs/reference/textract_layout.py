from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, cast

if TYPE_CHECKING:
    from utils.autoeval.parse_benchmark.layout import LayoutBox


def maybe_extract_textract_layout_boxes(
    raw: dict[str, object],
    page_number: int,
    max_boxes: int = 1200,
) -> list[LayoutBox] | None:
    from utils.autoeval.parse_benchmark.layout import LayoutBox

    payload = _dict_value(raw.get("raw")) or raw
    raw_blocks = payload.get("Blocks")
    if not isinstance(raw_blocks, list):
        return None
    if not any(
        isinstance(block, Mapping) and "BlockType" in block and "Geometry" in block
        for block in raw_blocks
    ):
        return None
    blocks = [_dict_value(value) for value in raw_blocks]
    blocks_by_id = {
        block_id: block
        for block in blocks
        if isinstance((block_id := block.get("Id")), str)
    }
    layout_blocks = [
        block
        for block in blocks
        if str(block.get("BlockType") or "").startswith("LAYOUT_")
        or block.get("BlockType") == "SIGNATURE"
    ]
    selected_blocks = layout_blocks or [
        block for block in blocks if block.get("BlockType") == "LINE"
    ]
    boxes: list[LayoutBox] = []
    for index, block in enumerate(selected_blocks):
        if len(boxes) >= max_boxes:
            break
        block_page = _float_value(block.get("Page"))
        if block_page is not None and int(block_page) != page_number:
            continue
        geometry = _dict_value(block.get("Geometry"))
        bounding_box = _dict_value(geometry.get("BoundingBox"))
        left = _float_value(bounding_box.get("Left"))
        top = _float_value(bounding_box.get("Top"))
        width = _float_value(bounding_box.get("Width"))
        height = _float_value(bounding_box.get("Height"))
        if (
            left is None
            or top is None
            or width is None
            or height is None
            or width <= 0
            or height <= 0
            or not 0 <= left <= 1
            or not 0 <= top <= 1
        ):
            continue
        content = _textract_block_text(block, blocks_by_id)
        preview = _preview_text(content)
        block_type = str(block.get("BlockType") or "block")
        block_id = block.get("Id")
        item_id = block_id if isinstance(block_id, str) else f"textract-{index}"
        boxes.append(
            LayoutBox(
                label=block_type.removeprefix("LAYOUT_").lower(),
                left=left,
                top=top,
                width=max(0.0, min(width, 1.0 - left)),
                height=max(0.0, min(height, 1.0 - top)),
                content_preview=preview,
                item_id=item_id,
                item_preview=preview,
                item_content=content,
            )
        )
    return boxes


def _textract_block_text(
    block: dict[str, object],
    blocks_by_id: dict[str, dict[str, object]],
    visited: frozenset[str] = frozenset(),
) -> str:
    text = block.get("Text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    block_id = block.get("Id")
    if isinstance(block_id, str):
        if block_id in visited:
            return ""
        visited = visited | {block_id}
    parts: list[str] = []
    relationships = block.get("Relationships")
    if not isinstance(relationships, list):
        return ""
    for raw_relationship in relationships:
        relationship = _dict_value(raw_relationship)
        if relationship.get("Type") != "CHILD":
            continue
        child_ids = relationship.get("Ids")
        if not isinstance(child_ids, list):
            continue
        for child_id in child_ids:
            if not isinstance(child_id, str):
                continue
            child = blocks_by_id.get(child_id)
            if child is None:
                continue
            if child.get("BlockType") == "SELECTION_ELEMENT":
                parts.append("☒" if child.get("SelectionStatus") == "SELECTED" else "☐")
                continue
            child_text = _textract_block_text(child, blocks_by_id, visited)
            if child_text:
                parts.append(child_text)
    return " ".join(parts)


def _dict_value(value: object) -> dict[str, object]:
    return cast(dict[str, object], value) if isinstance(value, Mapping) else {}


def _float_value(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    return None


def _preview_text(value: str) -> str:
    return " ".join(value.split())[:160]
