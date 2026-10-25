#!/usr/bin/env python3
"""生成扩展图标（纯标准库，无第三方依赖）。

用法：python3 tools/make-icons.py
输出：icons/icon16.png, icon32.png, icon48.png, icon128.png
设计：B 站蓝圆角方块 + 白色小鱼剪影。
"""

import os
import struct
import zlib

SIZE = 128
BG = (0, 174, 236, 255)
FG = (255, 255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)

# 几何参数（128 坐标系）
RECT_RADIUS = 26
BODY = (54.0, 62.0, 31.0, 23.0)  # cx, cy, rx, ry
TAIL = [(78.0, 62.0), (110.0, 38.0), (110.0, 86.0)]
EYE = (40.0, 54.0, 4.2, 4.2)


def inside_rounded_rect(x, y, radius):
    if x < 0 or y < 0 or x > SIZE or y > SIZE:
        return False
    if x < radius and y < radius:
        return (x - radius) ** 2 + (y - radius) ** 2 <= radius ** 2
    if x > SIZE - radius and y < radius:
        return (x - (SIZE - radius)) ** 2 + (y - radius) ** 2 <= radius ** 2
    if x < radius and y > SIZE - radius:
        return (x - radius) ** 2 + (y - (SIZE - radius)) ** 2 <= radius ** 2
    if x > SIZE - radius and y > SIZE - radius:
        return (x - (SIZE - radius)) ** 2 + (y - (SIZE - radius)) ** 2 <= radius ** 2
    return True


def inside_ellipse(x, y, cx, cy, rx, ry):
    return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0


def inside_triangle(x, y, points):
    (x1, y1), (x2, y2), (x3, y3) = points
    d1 = (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2)
    d2 = (x - x3) * (y2 - y3) - (x2 - x3) * (y - y3)
    d3 = (x - x1) * (y3 - y1) - (x3 - x1) * (y - y1)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def sample(x, y):
    """返回该采样点的 RGBA。"""
    if not inside_rounded_rect(x, y, RECT_RADIUS):
        return TRANSPARENT

    in_body = inside_ellipse(x, y, *BODY)
    in_tail = inside_triangle(x, y, TAIL)
    if not (in_body or in_tail):
        return BG

    if inside_ellipse(x, y, *EYE):
        return BG
    return FG


def render(size):
    ss = 8 if size <= 48 else 4  # 小尺寸多采样，保证 16px 也干净
    scale = SIZE / size
    rows = []

    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) * scale
                    y = (py + (sy + 0.5) / ss) * scale
                    sr, sg, sb, sa = sample(x, y)
                    if sa:
                        r += sr * sa
                        g += sg * sa
                        b += sb * sa
                        a += sa
            if a == 0:
                row += bytes(4)
            else:
                row += bytes((round(r / a), round(g / a), round(b / a), round(a / (ss * ss))))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fp:
        fp.write(png)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "icons")
    os.makedirs(out_dir, exist_ok=True)

    for size in (16, 32, 48, 128):
        path = os.path.join(out_dir, f"icon{size}.png")
        write_png(path, size, render(size))
        print("written", os.path.relpath(path, root))


if __name__ == "__main__":
    main()
