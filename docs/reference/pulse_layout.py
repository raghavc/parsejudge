from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import cast

from utils.autoeval.parse_benchmark.types import JsonObject


def pulse_layout_blocks(
    raw: Mapping[str, object], page_number: int
) -> list[JsonObject]:
    """Normalize Pulse `bounding_boxes` into diagnostic layout blocks.

    Pulse boxes are 8-point quads in 0-1 page coordinates. `ordered_elements`
    repeats every text element with its category, so it is preferred over the
    per-category lists; tables live only under `Tables[].table_info.location`.
    """
    payload = _mapping(raw.get("raw")) or raw
    boxes = _mapping(payload.get("bounding_boxes")) or {}
    blocks: dict[str, JsonObject] = {}
    for element in _text_elements(boxes):
        block = _block(
            element.get("id"),
            element.get("type") or element.get("source_category") or "Text",
            element.get("bounding_box"),
            element.get("page_number"),
            element.get("original_content") or element.get("content"),
            page_number,
        )
        if block is not None:
            blocks.setdefault(cast(str, block["block_id"]), block)
    for table in _mappings(boxes.get("Tables")):
        info = _mapping(table.get("table_info")) or {}
        location = _mapping(info.get("location")) or {}
        cells = (
            str(cell.get("text") or "").strip()
            for cell in _mappings(table.get("cell_data"))
        )
        block = _block(
            info.get("id"),
            "Table",
            location.get("coordinates"),
            location.get("page"),
            " | ".join(cell for cell in cells if cell),
            page_number,
        )
        if block is not None:
            blocks.setdefault(cast(str, block["block_id"]), block)
    return list(blocks.values())


def _text_elements(boxes: Mapping[str, object]) -> Iterator[Mapping[str, object]]:
    ordered = list(_mappings(boxes.get("ordered_elements")))
    if ordered:
        yield from ordered
        return
    for key, value in boxes.items():
        if key != "Tables":
            yield from _mappings(value)


def _block(
    block_id: object,
    block_type: object,
    quad: object,
    page: object,
    content: object,
    page_number: int,
) -> JsonObject | None:
    bbox = _quad_bbox(quad)
    if bbox is None or not isinstance(block_id, str) or not block_id:
        return None
    if not isinstance(page, int | float) or int(page) != page_number:
        return None
    return {
        "block_id": block_id,
        "type": str(block_type),
        "bbox": bbox,
        "content": str(content or ""),
        "parse_confidence": None,
    }


def _quad_bbox(value: object) -> JsonObject | None:
    if not isinstance(value, list) or len(value) != 8:
        return None
    points = cast(list[object], value)
    if not all(isinstance(point, int | float) for point in points):
        return None
    xs = [float(cast(float, point)) for point in points[0::2]]
    ys = [float(cast(float, point)) for point in points[1::2]]
    left, top = min(xs), min(ys)
    width, height = max(xs) - left, max(ys) - top
    if width <= 0 or height <= 0:
        return None
    return {"left": left, "top": top, "width": width, "height": height}


def _mapping(value: object) -> Mapping[str, object] | None:
    return cast(Mapping[str, object], value) if isinstance(value, dict) else None


def _mappings(value: object) -> Iterator[Mapping[str, object]]:
    for item in cast(list[object], value) if isinstance(value, list) else []:
        mapping = _mapping(item)
        if mapping is not None:
            yield mapping
