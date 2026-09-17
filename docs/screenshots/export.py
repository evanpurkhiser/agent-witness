"""Convert Chrome's PDF capture to a cropped SVG with outlined text.

Run with: uv run --with pymupdf python docs/screenshots/export.py INPUT.pdf OUTPUT.svg
"""

import sys
from pathlib import Path

import pymupdf

source, destination = sys.argv[1:]
with pymupdf.open(source) as document:
    page = document[0]
    # Chrome centers the CSS page on its PDF paper. Locate the 440px demo frame.
    frame = next(
        drawing['rect']
        for drawing in page.get_drawings()
        if abs(drawing['rect'].width - 330) < 0.1
    )
    page.set_cropbox(frame)
    svg = page.get_svg_image(text_as_path=True)
    svg = svg.replace('width="330" height="150.75"', 'width="440" height="201"', 1)
    svg = svg.replace('<svg ', '<svg role="img" ', 1)
    start = svg.index('>') + 1
    title = (
        '<title>Release signing request showing the reason, git command, '
        'SSH key, and approval timeout</title>'
    )
    svg = svg[:start] + title + svg[start:]
    Path(destination).write_text(svg)
