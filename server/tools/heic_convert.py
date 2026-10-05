#!/usr/bin/env python3
# HEIC/HEIF -> JPEG 转换(供服务端附件预览调用)
# 用法: python3 heic_convert.py <input> <output> [quality] [max_dim]
#   quality  JPEG 质量 1-100, 默认 85
#   max_dim  最长边像素(等比缩小, 仅当原图更大时生效), 0=不缩放, 默认 0
# 依赖: pillow-heif(自带 libheif 1.2x + libde265, manylinux wheel 自包含)
import sys

from pillow_heif import register_heif_opener
from PIL import Image

register_heif_opener()

src, dst = sys.argv[1], sys.argv[2]
quality = int(sys.argv[3]) if len(sys.argv) > 3 else 85
max_dim = int(sys.argv[4]) if len(sys.argv) > 4 else 0

img = Image.open(src)
if max_dim and max(img.size) > max_dim:
    ratio = max_dim / float(max(img.size))
    img = img.resize((int(img.size[0] * ratio), int(img.size[1] * ratio)), Image.LANCZOS)
if img.mode != 'RGB':
    img = img.convert('RGB')
img.save(dst, 'JPEG', quality=quality)
print('OK %dx%d' % img.size)
