from __future__ import annotations

import struct
from collections.abc import Mapping
from dataclasses import dataclass
from typing import cast


@dataclass(frozen=True, slots=True)
class LayoutBox:
    label: str
    left: float
    top: float
    width: float
    height: float
    content_preview: str
    item_id: str | None = None
    item_preview: str = ""
    item_content: str = ""


RawBox = tuple[float, float, float, float, tuple[float, float] | None, str | None]


def png_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", data[16:24])


def layout_box_to_dict(
    box: LayoutBox,
    *,
    include_item_content: bool = False,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "label": box.label,
        "left": box.left,
        "top": box.top,
        "width": box.width,
        "height": box.height,
        "content_preview": box.content_preview,
        "item_id": box.item_id,
        "item_preview": box.item_preview,
    }
    if include_item_content:
        payload["item_content"] = box.item_content
    return payload


def extract_layout_boxes(
    raw: dict[str, object],
    config_id: str,
    page_number: int,
    image_size: tuple[int, int] | None,
    max_boxes: int = 1200,
) -> list[LayoutBox]:
    from utils.autoeval.parse_benchmark.textract_layout import (
        maybe_extract_textract_layout_boxes,
    )

    textract_boxes = maybe_extract_textract_layout_boxes(
        raw,
        page_number=page_number,
        max_boxes=max_boxes,
    )
    if textract_boxes is not None:
        return textract_boxes
    boxes: list[LayoutBox] = []
    page_size_hint: tuple[float, float] | None = None
    item_counter = 0

    def visit(
        node: object,
        current_page: int | None = None,
        current_page_size: tuple[float, float] | None = None,
    ) -> None:
        nonlocal item_counter, page_size_hint
        if len(boxes) >= max_boxes:
            return
        if isinstance(node, dict):
            node_dict = cast(dict[str, object], node)
            node_page = _page_number_for_node(node_dict) or current_page
            node_page_size = _page_size_for_node(node_dict) or current_page_size
            raw_bboxes = _raw_bboxes(node_dict)
            label = str(
                node_dict.get("type")
                or node_dict.get("block_type")
                or node_dict.get("object")
                or "block"
            )
            item_preview = _content_preview(node_dict)
            item_id = None
            if raw_bboxes and label != "Page":
                item_counter += 1
                item_id = f"{config_id}-item-{item_counter}"
            if node_dict.get("block_type") == "Page" and raw_bboxes:
                _, _, page_width, page_height, _, _ = raw_bboxes[0]
                if page_width > 1 and page_height > 1:
                    page_size_hint = page_width, page_height
                    node_page_size = page_width, page_height
            for raw_bbox in raw_bboxes:
                if node_page is not None and node_page != page_number:
                    continue
                normalized = _normalize_box(
                    raw_bbox, image_size, node_page_size or page_size_hint
                )
                if normalized is None:
                    continue
                left, top, width, height = normalized
                valid = 0 <= left <= 1 and 0 <= top <= 1
                if not valid or width > 1.5 or height > 1.5:
                    continue
                if label == "Page" or width * height >= 0.98:
                    continue
                safe_left = max(0.0, left)
                safe_top = max(0.0, top)
                boxes.append(
                    LayoutBox(
                        label=label,
                        left=safe_left,
                        top=safe_top,
                        width=max(0.0, min(width, 1.0 - safe_left)),
                        height=max(0.0, min(height, 1.0 - safe_top)),
                        content_preview=raw_bbox[5] or item_preview,
                        item_id=item_id,
                        item_preview=item_preview,
                        item_content=_node_text(node_dict),
                    )
                )
            for value in node_dict.values():
                visit(value, node_page, node_page_size)
        elif isinstance(node, list):
            for item in node:
                visit(item, current_page, current_page_size)

    visit(raw)
    return boxes


def extract_mistral_layout_boxes(
    raw: dict[str, object],
    page_number: int,
    include_images: bool = False,
    max_boxes: int = 1200,
) -> list[LayoutBox]:
    payload = _dict_value(raw.get("raw")) or raw
    pages = payload.get("pages")
    if not isinstance(pages, list) or not 1 <= page_number <= len(pages):
        return []
    page = _dict_value(pages[page_number - 1])
    page_size = _mistral_page_size(page)
    blocks = page.get("blocks")
    if page_size is None:
        return []

    boxes: list[LayoutBox] = []
    represented_image_ids: set[str] = set()
    raw_blocks = blocks if isinstance(blocks, list) else []
    for block_index, raw_block in enumerate(raw_blocks):
        if len(boxes) >= max_boxes:
            break
        block = _dict_value(raw_block)
        image_id = block.get("image_id")
        if isinstance(image_id, str) and image_id:
            represented_image_ids.add(image_id)
        content = _node_text(block)
        box = _mistral_layout_box(
            block,
            page_size=page_size,
            label=str(block.get("type") or "block"),
            item_id=f"page_{page_number}:block_{block_index}",
            content=content,
        )
        if box is None:
            continue
        boxes.append(box)

    images = page.get("images")
    raw_images = images if include_images and isinstance(images, list) else []
    for image_index, raw_image in enumerate(raw_images):
        if len(boxes) >= max_boxes:
            break
        image = _dict_value(raw_image)
        image_id = image.get("id")
        if (
            not isinstance(image_id, str)
            or not image_id
            or image_id in represented_image_ids
        ):
            continue
        content = f"![{image_id}]({image_id})"
        box = _mistral_layout_box(
            image,
            page_size=page_size,
            label="image",
            item_id=f"page_{page_number}:image_{image_index}",
            content=content,
        )
        if box is not None:
            boxes.append(box)
    return boxes


def _mistral_page_size(page: dict[str, object]) -> tuple[float, float] | None:
    dimensions = _dict_value(page.get("dimensions"))
    width = _float_value(dimensions.get("width"))
    height = _float_value(dimensions.get("height"))
    if width and height:
        return width, height
    return _page_size_for_node(page)


def _mistral_layout_box(
    mapping: dict[str, object],
    *,
    page_size: tuple[float, float],
    label: str,
    item_id: str,
    content: str,
) -> LayoutBox | None:
    parsed = _box_from_mapping(mapping)
    if parsed is None:
        return None
    left, top, width, height = parsed
    normalized = _normalize_box(
        (left, top, width, height, page_size, None),
        image_size=None,
        page_size_hint=page_size,
    )
    if normalized is None:
        return None
    normalized_left, normalized_top, normalized_width, normalized_height = normalized
    preview = _preview_text(content)
    return LayoutBox(
        label=label,
        left=normalized_left,
        top=normalized_top,
        width=normalized_width,
        height=normalized_height,
        content_preview=preview,
        item_id=item_id,
        item_preview=preview,
        item_content=content,
    )


def _page_number_for_node(node: dict[str, object]) -> int | None:
    page_number = _float_value(node.get("page_number"))
    if page_number is not None:
        return int(page_number)
    bbox = _dict_value(node.get("bbox"))
    page = _float_value(bbox.get("original_page") or bbox.get("page"))
    if page is not None:
        return int(page)
    metadata = _dict_value(node.get("metadata"))
    page_range = _dict_value(metadata.get("page_range"))
    if page_range.get("start") == page_range.get("end"):
        page = _float_value(page_range.get("start"))
        if page is not None:
            return int(page)
    page_meta = _dict_value(metadata.get("page"))
    page = _float_value(page_meta.get("number"))
    if page is not None:
        return int(page)
    page = _float_value(node.get("page"))
    if page is not None:
        return int(page) + 1
    return None


def _page_size_for_node(node: dict[str, object]) -> tuple[float, float] | None:
    width = _float_value(node.get("page_width"))
    height = _float_value(node.get("page_height"))
    if width and height:
        return width, height
    page = _dict_value(_dict_value(node.get("metadata")).get("page"))
    width = _float_value(page.get("width"))
    height = _float_value(page.get("height"))
    if width and height:
        return width, height
    return None


def _node_text(node: dict[str, object]) -> str:
    value = (
        node.get("content")
        or node.get("markdown")
        or node.get("md")
        or node.get("value")
        or node.get("text")
        or node.get("html")
        or ""
    )
    return value if isinstance(value, str) else str(value)


def _preview_text(value: str) -> str:
    return " ".join(value.split())[:160]


def _content_preview(node: dict[str, object]) -> str:
    return _preview_text(_node_text(node))


def _fragment_preview(node: dict[str, object], bbox: dict[str, object]) -> str | None:
    start = bbox.get("start_index")
    end = bbox.get("end_index")
    if not isinstance(start, int) or not isinstance(end, int) or start >= end:
        return None
    value = _node_text(node)
    if start < 0 or end > len(value):
        return None
    preview = _preview_text(value[start:end])
    return preview or None


def _raw_bboxes(node: dict[str, object]) -> list[RawBox]:
    bbox = node.get("bbox") or node.get("bounding_box") or node.get("boundingBox")
    page_size = _page_size_for_node(node)
    if isinstance(bbox, dict):
        bbox_dict = cast(dict[str, object], bbox)
        parsed = _box_from_mapping(bbox_dict)
        if parsed is None:
            return []
        left, top, width, height = parsed
        return [
            (left, top, width, height, page_size, _fragment_preview(node, bbox_dict))
        ]
    if isinstance(bbox, list) and bbox:
        if all(isinstance(item, dict) for item in bbox):
            return _raw_bboxes_from_fragments(
                node, cast(list[dict[str, object]], bbox), page_size
            )
        if len(bbox) < 4:
            return []
        left = _float_value(bbox[0])
        top = _float_value(bbox[1])
        right = _float_value(bbox[2])
        bottom = _float_value(bbox[3])
        if left is None or top is None or right is None or bottom is None:
            return []
        return [(left, top, right - left, bottom - top, page_size, None)]
    return []


def _raw_bboxes_from_fragments(
    node: dict[str, object],
    fragments: list[dict[str, object]],
    page_size: tuple[float, float] | None,
) -> list[RawBox]:
    by_geometry: dict[tuple[float, float, float, float], RawBox] = {}
    for item in fragments:
        parsed = _box_from_mapping(item)
        if parsed is None:
            continue
        left, top, width, height = parsed
        key = (round(left, 4), round(top, 4), round(width, 4), round(height, 4))
        preview = _fragment_preview(node, item)
        existing = by_geometry.get(key)
        if existing is not None:
            existing_preview = existing[5]
            if preview is not None and (
                existing_preview is None or len(preview) < len(existing_preview)
            ):
                by_geometry[key] = (left, top, width, height, page_size, preview)
            continue
        by_geometry[key] = (left, top, width, height, page_size, preview)
    return list(by_geometry.values())


def _box_from_mapping(
    mapping: dict[str, object],
) -> tuple[float, float, float, float] | None:
    left = _first_float(mapping, "x", "left", "top_left_x")
    top = _first_float(mapping, "y", "top", "top_left_y")
    width = _first_float(mapping, "w", "width")
    height = _first_float(mapping, "h", "height")
    right = _first_float(mapping, "right", "bottom_right_x")
    bottom = _first_float(mapping, "bottom", "bottom_right_y")
    if left is None or top is None:
        return None
    if width is None and right is not None:
        width = right - left
    if height is None and bottom is not None:
        height = bottom - top
    if width is None or height is None or width <= 0 or height <= 0:
        return None
    return left, top, width, height


def _first_float(mapping: dict[str, object], *keys: str) -> float | None:
    for key in keys:
        value = _float_value(mapping.get(key))
        if value is not None:
            return value
    return None


def _normalize_box(
    raw: RawBox,
    image_size: tuple[int, int] | None,
    page_size_hint: tuple[float, float] | None,
) -> tuple[float, float, float, float] | None:
    left, top, width, height, node_page_size, _ = raw
    if width <= 0 or height <= 0:
        return None
    if 0 <= left <= 1 and 0 <= top <= 1 and 0 < width <= 1 and 0 < height <= 1:
        return left, top, width, height
    page_size = node_page_size or page_size_hint
    if page_size is None and image_size is not None:
        page_size = float(image_size[0]), float(image_size[1])
    if page_size is None:
        return None
    page_width, page_height = page_size
    if page_width <= 0 or page_height <= 0:
        return None
    if _is_rotated_relative_to_image(page_width, page_height, image_size):
        return _normalize_rotated_box(left, top, width, height, page_width, page_height)
    return (
        left / page_width,
        top / page_height,
        width / page_width,
        height / page_height,
    )


def _is_rotated_relative_to_image(
    page_width: float,
    page_height: float,
    image_size: tuple[int, int] | None,
) -> bool:
    if image_size is None:
        return False
    image_width, image_height = image_size
    if image_width <= 0 or image_height <= 0:
        return False
    page_aspect = page_width / page_height
    image_aspect = image_width / image_height
    opposite_orientation = (page_width > page_height) != (image_width > image_height)
    reciprocal_aspect = abs((page_aspect * image_aspect) - 1.0) <= 0.08
    return opposite_orientation and reciprocal_aspect


def _normalize_rotated_box(
    left: float,
    top: float,
    width: float,
    height: float,
    page_width: float,
    page_height: float,
) -> tuple[float, float, float, float]:
    if page_width > page_height:
        return (
            top / page_height,
            1 - ((left + width) / page_width),
            height / page_height,
            width / page_width,
        )
    return (
        1 - ((top + height) / page_height),
        left / page_width,
        height / page_height,
        width / page_width,
    )


def _dict_value(value: object) -> dict[str, object]:
    if isinstance(value, Mapping):
        return cast(dict[str, object], value)
    return {}


def _float_value(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    return None
