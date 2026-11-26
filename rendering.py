import io
import math
import re
import time
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

FONT_DIR = Path('C:/Windows/Fonts')
ASSETS = Path(__file__).resolve().parent / 'assets'
LOCAL_BOUNDS = (658, 120, 1216, 433)
SCENE_KINDS = {
    'message': '收到消息', 'call': '陌生来电', 'transfer': '转账风险',
    'verify': '主动核实', 'help': '留证求助', 'tip': '重点提醒',
}
NOIR_KINDS = {
    'title': '发光标题卡', 'battery': '能量电量表', 'stack': '思路叠层卡',
    'receipt': '代价票据', 'loop': '循环与计数',
}
KIND_LABELS = {**SCENE_KINDS, **NOIR_KINDS}
STYLES = {'illustration': '浅色插画', 'noir': '夜色发光'}
STYLE_KIND_MAP = {
    'noir': {'message': 'stack', 'call': 'stack', 'transfer': 'receipt',
             'verify': 'stack', 'help': 'receipt', 'tip': 'title'},
    'illustration': {'stack': 'message', 'receipt': 'transfer', 'title': 'tip',
                     'battery': 'transfer', 'loop': 'verify'},
}
NOIR_COLORS = {'bg': '#0E0C0A', 'ink': '#F2EDE2', 'accent': '#E0492E',
               'soft': '#191510', 'card': '#14110D', 'cream': '#E8D5A3', 'dim': '#7A7466'}
THEMES = {
    'warm': {'bg': '#F5F0E7', 'ink': '#233B34', 'accent': '#C5653D', 'soft': '#E9DDD0', 'card': '#FFFCF7'},
    'teal': {'bg': '#153D39', 'ink': '#F2F5E9', 'accent': '#A7DFC7', 'soft': '#2B514B', 'card': '#204A44'},
    'bold': {'bg': '#F6D973', 'ink': '#242D2A', 'accent': '#384B40', 'soft': '#E8C85D', 'card': '#FFF5CF'},
}


@lru_cache(maxsize=32)
def font(size, bold=False):
    return ImageFont.truetype(str(FONT_DIR / ('msyhbd.ttc' if bold else 'msyh.ttc')), size)


@lru_cache(maxsize=16)
def serif(size):
    return ImageFont.truetype(str(FONT_DIR / 'simsun.ttc'), size)


def phase_starts(style, kind):
    if style == 'noir':
        return {'title': (0, .35), 'battery': (0, .3, .6), 'stack': (0, .22, .44, .66),
                'receipt': (0, .3, .6), 'loop': (0, .25, .5)}.get(kind, (0, .28, .58))
    return (0, .28, .58)


def wrap_text(text, selected_font, width):
    lines, current = [], ''
    for char in text:
        if char == '\n':
            lines.append(current)
            current = ''
        elif current and selected_font.getlength(current + char) > width:
            if char in '，。！？；：、）》】」』,.!?;:' and len(current) > 1:
                lines.append(current[:-1])
                current = current[-1] + char
            else:
                lines.append(current)
                current = char
        else:
            current += char
    if current:
        lines.append(current)
    return lines


def split_captions(text, accessible=True):
    selected_font = font(42 if accessible else 36, True)
    lines = wrap_text(re.sub(r'\s+', ' ', text).strip(), selected_font, 1070)
    return [''.join(lines[i:i + 2]) for i in range(0, len(lines), 2)]


def text_block(draw, text, box, color, size=28, bold=False, max_lines=3):
    x, y, width, height = box
    text = re.sub(r'\s+', ' ', text).strip()
    while size > 16:
        selected_font = font(size, bold)
        lines = wrap_text(text, selected_font, width)
        if len(lines) <= max_lines and len(lines) * (size + 10) <= height:
            break
        size -= 1
    for row, line in enumerate(lines):
        draw.text((x, y + row * (size + 10)), line, font=selected_font, fill=color)


def draw_scenario(im, visual, colors, progress=None):
    d = ImageDraw.Draw(im)
    ink, accent, soft, card = (colors[k] for k in ('ink', 'accent', 'soft', 'card'))
    kind = visual['kind']
    d.rounded_rectangle((658, 120, 1216, 498), radius=24, fill=soft)
    d.text((683, 140), SCENE_KINDS[kind], font=font(18, True), fill=ink)
    d.text((1008, 143), '情景示意 · 非真实记录', font=font(14), fill=ink)
    if kind == 'message':
        d.ellipse((687, 191, 744, 248), fill=accent)
        d.ellipse((706, 200, 725, 219), fill=card)
        d.rounded_rectangle((698, 222, 733, 241), radius=10, fill=card)
        d.rounded_rectangle((761, 190, 1188, 318), radius=15, fill=card)
        d.polygon([(763, 213), (747, 222), (763, 232)], fill=card)
        text_block(d, visual['text'], (781, 203, 386, 106), ink, 28, max_lines=3)
        d.rounded_rectangle((761, 331, 1188, 389), radius=12, fill=card, outline=accent, width=3)
        d.text((780, 345), '风险提示：陌生邀约，先核实', font=font(23, True), fill=ink)
        d.rounded_rectangle((864, 406, 1188, 470), radius=15, fill=ink)
        d.text((888, 424), '先停一下，核实来源', font=font(25, True), fill=card)
    elif kind == 'call':
        d.rounded_rectangle((693, 183, 856, 473), radius=25, fill=ink)
        d.rounded_rectangle((702, 193, 847, 462), radius=19, fill=card)
        d.rounded_rectangle((748, 204, 802, 209), radius=2, fill=soft)
        d.ellipse((742, 249, 807, 314), fill=soft)
        d.text((745, 259), '?', font=font(36, True), fill=accent)
        d.text((724, 336), '未知来电', font=font(24, True), fill=ink)
        d.ellipse((752, 398, 795, 441), fill=accent)
        d.line((762, 419, 785, 419), fill=card, width=5)
        text_block(d, visual['text'], (885, 206, 301, 176), ink, 31, True, 4)
        d.rounded_rectangle((883, 412, 1186, 457), radius=10, fill=card)
        d.text((908, 421), '不按陌生人指令操作', font=font(22), fill=ink)
    elif kind == 'transfer':
        d.rounded_rectangle((684, 184, 1189, 359), radius=18, fill=card)
        d.text((709, 204), '转账请求', font=font(20), fill=ink)
        text_block(d, visual['text'], (709, 247, 351, 94), ink, 28, True, 2)
        d.polygon([(1135, 233), (1175, 302), (1095, 302)], fill=accent)
        d.text((1128, 258), '!', font=font(25, True), fill=card)
        d.rounded_rectangle((686, 384, 1188, 466), radius=14, fill=ink)
        d.text((760, 402), '先停止转账，再核实', font=font(32, True), fill=card)
    elif kind == 'verify':
        for left, number, label in [(685, '不要这样', '跟随陌生链接'), (951, '换个做法', '独立联系官方')]:
            d.rounded_rectangle((left, 189, left + 237, 312), radius=15, fill=card)
            d.text((left + 17, 203), number, font=font(22, True), fill=accent)
            d.text((left + 17, 256), label, font=font(27, True), fill=ink)
        d.line((927, 250, 946, 250), fill=accent, width=4)
        d.polygon([(947, 250), (940, 243), (940, 257)], fill=accent)
        text_block(d, visual['text'], (697, 345, 478, 128), ink, 28, max_lines=3)
    elif kind == 'help':
        for left, label in [(687, '聊天记录'), (856, '转账凭证'), (1025, '联系信息')]:
            d.rounded_rectangle((left, 187, left + 154, 306), radius=12, fill=card)
            for row, width in [(0, 62), (1, 82), (2, 48)]:
                d.rounded_rectangle((left + 19, 205 + row * 13, left + 19 + width, 209 + row * 13), radius=2, fill=soft)
            d.text((left + 20, 267), label, font=font(22, True), fill=ink)
        text_block(d, visual['text'], (695, 336, 483, 101), ink, 27, max_lines=3)
        d.text((803, 460), '停止转账 · 保留证据 · 求助', font=font(20, True), fill=ink)
    else:
        d.rounded_rectangle((684, 183, 1188, 473), radius=20, fill=card)
        d.polygon([(735, 203), (764, 214), (760, 246), (735, 266), (710, 246), (706, 214)], fill=accent)
        d.line([(722, 234), (732, 244), (749, 222)], fill=card, width=4)
        d.text((783, 216), '给自己多一分保护', font=font(26, True), fill=ink)
        text_block(d, visual['text'], (711, 295, 450, 155), ink, 32, True, 3)

    if progress is not None:
        regions = {
            'message': [(680, 182, 1200, 324), (752, 327, 1198, 397), (855, 401, 1198, 482)],
            'call': [(686, 178, 863, 482), (878, 181, 1200, 402), (878, 405, 1200, 478)],
            'transfer': [(696, 198, 1080, 350), (1085, 225, 1182, 311), (680, 379, 1198, 478)],
            'verify': [(679, 182, 925, 320), (925, 182, 1198, 320), (684, 329, 1198, 485)],
            'help': [(680, 180, 848, 313), (850, 180, 1198, 313), (684, 328, 1198, 487)],
            'tip': [(680, 180, 1198, 280), (694, 285, 1175, 451), (690, 452, 1180, 475)],
        }[kind]
        complete = im.copy()
        for region, start in zip(regions, (0, .28, .58)):
            amount = max(0, min(1, (progress - start) / .08))
            if amount < 1:
                patch = complete.crop(region)
                background = Image.new('RGB', patch.size, card if kind == 'transfer' and start < .58 else soft)
                im.paste(Image.blend(background, patch, amount), region[:2])
        if kind in ('message', 'transfer') and progress >= .36:
            bounds = (757, 328, 1193, 393) if kind == 'message' else (682, 182, 1192, 361)
            ImageDraw.Draw(im).rounded_rectangle(bounds, radius=16, outline=accent, width=4)


def animation_times(start, duration, scene_duration, phases=(0, .28, .58)):
    frames = {0, round(duration * 24)}
    for phase in phases:
        for step in range(5):
            frame = round(((phase + step * .02) * scene_duration - start) * 24)
            if 0 < frame < round(duration * 24):
                frames.add(frame)
    return [frame / 24 for frame in sorted(frames)]


@lru_cache(maxsize=8)
def fitted_asset(image_id, fit, focus_x, focus_y, soft):
    size = (LOCAL_BOUNDS[2] - LOCAL_BOUNDS[0], LOCAL_BOUNDS[3] - LOCAL_BOUNDS[1])
    with Image.open(ASSETS / f'{image_id}.png') as original:
        source = original.convert('RGB')
    if fit == 'cover':
        return ImageOps.fit(source, size, Image.Resampling.LANCZOS, centering=(focus_x / 100, focus_y / 100))
    fitted = ImageOps.contain(source, size, Image.Resampling.LANCZOS)
    image = Image.new('RGB', size, soft)
    image.paste(fitted, ((size[0] - fitted.width) // 2, (size[1] - fitted.height) // 2))
    return image


def draw_local_image(im, visual, colors):
    size = (LOCAL_BOUNDS[2] - LOCAL_BOUNDS[0], LOCAL_BOUNDS[3] - LOCAL_BOUNDS[1])
    image = fitted_asset(visual['imageId'], visual['fit'], visual['focusX'], visual['focusY'], colors['soft'])
    mask = Image.new('L', size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=20, fill=255)
    im.paste(image, LOCAL_BOUNDS[:2], mask)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((674, 134, 891, 163), radius=7, fill=colors['card'])
    d.text((685, 138), '本地配图 · 仅作情景示意', font=font(16), fill=colors['ink'])
    text_block(d, visual['text'], (664, 447, 548, 61), colors['ink'], 23, max_lines=2)


def draw_caption(d, lines, top, line_height, selected_font, ink, red, keywords):
    pattern = re.compile('(' + '|'.join(re.escape(word) for word in keywords) + ')') if keywords else None
    for row, line in enumerate(lines):
        parts = pattern.split(line) if pattern else [line]
        cursor = 640 - sum(selected_font.getlength(part) for part in parts) / 2
        for part in parts:
            d.text((cursor, top + row * line_height), part, font=selected_font,
                   fill=red if part in keywords else ink, anchor='lt')
            cursor += selected_font.getlength(part)


def draw_frame(scene, index, total, theme='warm', accessible=True, caption=None, progress=None, draft=False,
               style='illustration'):
    colors = NOIR_COLORS if style == 'noir' else THEMES[theme]
    visual = scene.get('visual', {'kind': 'tip', 'text': scene['title'], 'imageId': None})
    im = Image.new('RGB', (1280, 720), colors['bg'])
    d = ImageDraw.Draw(im)
    ink, accent, soft, card = (colors[k] for k in ('ink', 'accent', 'soft', 'card'))
    if style == 'noir':
        d.ellipse((560, 60, 1320, 580), fill=soft)
    else:
        d.ellipse((-160, 370, 490, 1030), fill=soft)
    d.rounded_rectangle((60, 38, 99, 77), radius=11, fill=ink)
    d.polygon([(74, 48), (74, 67), (88, 58)], fill=colors['bg'])
    d.text((112, 39), '知映  /  社区反诈小课堂', font=font(24, True), fill=ink)
    d.text((980, 45), '预演草稿 · 非发布成片' if draft else '本地制作 · 公益科普', font=font(18, True), fill=ink)
    d.rounded_rectangle((62, 123, 366, 164), radius=18, fill=soft)
    d.text((80, 131), f'{index + 1:02d} / {total:02d}   {KIND_LABELS[visual["kind"]]}', font=font(20, True), fill=ink)
    text_block(d, scene['title'], (62, 191, 540, 218), ink, 53, True, 3)
    d.rounded_rectangle((62, 420, 119, 426), radius=3, fill=accent)
    d.text((62, 451), '多一次核实，少一分风险', font=font(25), fill=ink)
    if visual.get('imageId'):
        draw_local_image(im, visual, colors)
    elif style == 'noir':
        im = draw_noir_scenario(im, visual, progress)
        d = ImageDraw.Draw(im)
    else:
        draw_scenario(im, visual, colors, progress)
    d.rounded_rectangle((60, 527, 1220, 654), radius=19, fill=card)
    caption = caption if caption is not None else split_captions(scene['narration'], accessible)[0]
    caption_font = font(42 if accessible else 36, True)
    lines = wrap_text(caption, caption_font, 1070)
    line_height = 53 if accessible else 47
    top = 590 - len(lines) * line_height / 2
    draw_caption(d, lines, top, line_height, caption_font, ink, accent, visual.get('keywords') or [])
    d.text((62, 674), '知映本地制作  ·  画面为示意，内容须经人工核对', font=font(17), fill=ink)
    d.text((1090, 674), '反诈宣传', font=font(17), fill=ink)
    d.rectangle((0, 711, 1280, 719), fill=soft)
    d.rectangle((0, 711, round(1280 * (index + 1) / total), 719), fill=accent)
    return im


def preview_png(scene, index, total, theme, accessible, style='illustration'):
    output = io.BytesIO()
    draw_frame(scene, index, total, theme, accessible, style=style).save(output, format='PNG')
    return output.getvalue()


def glow_composite(im, layer, amount, blur=6):
    if amount < 1:
        layer = layer.copy()
        layer.putalpha(layer.getchannel('A').point(lambda a: round(a * amount)))
    halo = layer.filter(ImageFilter.GaussianBlur(blur))
    out = Image.alpha_composite(im.convert('RGBA'), halo)
    out = Image.alpha_composite(out, layer)
    return out.convert('RGB')


def spaced_text(d, text, center, y, size, color, gap=6):
    selected = serif(size)
    cursor = center - (sum(selected.getlength(char) for char in text) + gap * (len(text) - 1)) / 2
    for char in text:
        d.text((cursor, y), char, font=selected, fill=color, anchor='lm')
        cursor += selected.getlength(char) + gap


def draw_noir_scenario(im, visual, progress):
    cream, red, dim = (NOIR_COLORS[k] for k in ('cream', 'accent', 'dim'))
    bg = NOIR_COLORS['bg']
    kind = visual['kind']
    p = 1 if progress is None else progress
    groups = []

    if kind == 'title':
        main = visual.get('text') or '重点提醒'
        sub = visual.get('sub') or ''
        size = 62
        while size > 28 and serif(size).getlength(main) > 520:
            size -= 2

        def main_card(d):
            d.text((937, 265), main, font=serif(size), fill=cream, anchor='mm')

        def sub_card(d):
            if sub:
                spaced_text(d, sub, 937, 340, 18, dim)
            d.line((837, 372, 1037, 372), fill=cream, width=2)

        groups = [(0, main_card), (.35, sub_card)]
    elif kind == 'battery':
        label = visual.get('text') or '精力'
        begin, end = visual.get('from', 80), visual.get('to', 20)
        pct = begin + (end - begin) * min(1, p / .9)
        color = red if pct < 30 else cream

        def shell(d):
            d.rounded_rectangle((770, 250, 1050, 330), radius=10, outline=cream, width=3)
            d.rectangle((1052, 272, 1068, 308), fill=cream)

        def charge(d):
            width = max(6, int(264 * pct / 100))
            d.rounded_rectangle((778, 258, 778 + width, 322), radius=6, fill=color)
            d.text((1090, 290), f'{round(pct)}%', font=font(38, True), fill=color, anchor='lm')

        def caption_label(d):
            d.text((937, 385), label, font=serif(32), fill=cream, anchor='mm')
            d.text((937, 430), '隐喻示意 · 非真实数据', font=font(16), fill=dim, anchor='mm')

        groups = [(0, shell), (.3, charge), (.6, caption_label)]
    elif kind == 'stack':
        steps = [step for step in (visual.get('steps') or []) if step][:4] or ['拆需求', '列提纲', '查数据', '写第一段']
        interrupt = visual.get('interrupt') or ''

        def slot_y(i):
            return 168 + i * 74

        def board(d):
            d.rounded_rectangle((740, 150, 1140, 470), radius=14, outline=cream, width=3)
            for i in range(4):
                d.rounded_rectangle((760, slot_y(i), 1120, slot_y(i) + 58), radius=8, outline=dim, width=2)

        def steps_pair(indices):
            def paint(d):
                for i in indices:
                    if i < len(steps):
                        d.text((940, slot_y(i) + 29), steps[i], font=serif(30), fill=cream, anchor='mm')
                        if i < len(steps) - 1:
                            d.line((940, slot_y(i) + 60, 940, slot_y(i) + 72), fill=dim, width=2)
            return paint

        def interruption(d):
            if interrupt:
                d.rounded_rectangle((762, 170, 1118, 224), radius=8, fill=bg)
                d.rounded_rectangle((760, 168, 1120, 226), radius=8, outline=red, width=3)
                d.text((940, 197), interrupt, font=serif(32), fill=red, anchor='mm')
            else:
                last = slot_y(len(steps) - 1)
                d.rounded_rectangle((760, last, 1120, last + 58), radius=8, outline=red, width=3)

        groups = [(0, board), (.22, steps_pair((0, 1))), (.44, steps_pair((2, 3))), (.66, interruption)]
    elif kind == 'receipt':
        head = visual.get('text') or '代价单'
        sub = visual.get('sub') or '本地示意 · 2026'
        items = [item for item in (visual.get('items') or []) if item.get('label')][:3]
        if not items:
            items = [{'label': '投入', 'value': '0'}, {'label': '代价', 'value': '全部'}]

        def row_y(i):
            return 285 + i * 52

        def paper(d):
            d.rounded_rectangle((770, 140, 1050, 440), radius=6, outline=cream, width=3)
            for y in range(152, 436, 22):
                d.ellipse((780, y, 786, y + 6), fill=dim)
                d.ellipse((1034, y, 1040, y + 6), fill=dim)
            d.text((910, 185), head, font=serif(34), fill=cream, anchor='mm')
            spaced_text(d, sub, 910, 222, 16, dim)
            d.line((800, 246, 1020, 246), fill=dim, width=2)

        def rows(d):
            for i, item in enumerate(items[:-1]):
                d.text((810, row_y(i)), item['label'], font=serif(26), fill=cream, anchor='lm')
                d.text((1010, row_y(i)), item['value'], font=serif(26), fill=cream, anchor='rm')

        def total_row(d):
            y = row_y(len(items) - 1)
            d.rounded_rectangle((790, y - 26, 1030, y + 26), radius=6, fill=red)
            d.text((810, y), items[-1]['label'], font=serif(26), fill='#FFD9CF', anchor='lm')
            d.text((1010, y), items[-1]['value'], font=serif(26), fill='#FFD9CF', anchor='rm')
            d.rounded_rectangle((740, 455, 1080, 495), radius=6, outline=cream, width=3)

        groups = [(0, paper), (.3, rows), (.6, total_row)]
    else:
        label = visual.get('text') or '耗能'
        unit = visual.get('sub') or 'J'
        target = visual.get('target', 1.0)

        def point(t):
            den = 1 + math.sin(t) ** 2
            return (937 + 130 * math.cos(t) / den, 300 + 130 * math.sin(t) * math.cos(t) / den)

        def ring(d):
            d.ellipse((787, 150, 1087, 450), outline=cream, width=2)
            d.line([point(i * math.pi / 32) for i in range(65)], fill=dim, width=1)

        def trail(d):
            count = 6 + int(20 * min(1, p / .85))
            for i in range(count):
                x, y = point(i / (count - 1) * math.pi * 1.15)
                radius = 5 if i == count - 1 else 3
                d.ellipse((x - radius, y - radius, x + radius, y + radius), fill=cream)

        def counter(d):
            d.text((937, 380), label, font=font(20), fill=dim, anchor='mm')
            d.text((937, 416), f'{target * min(1, p / .9):.2f} {unit}', font=font(36, True), fill=cream, anchor='mm')

        groups = [(0, ring), (.25, trail), (.5, counter)]

    for start, painter in groups:
        amount = 1 if progress is None else max(0, min(1, (progress - start) / .08))
        if amount <= 0:
            continue
        layer = Image.new('RGBA', im.size, (0, 0, 0, 0))
        painter(ImageDraw.Draw(layer))
        im = glow_composite(im, layer, amount)
    return im


REPORT_SIZE = (1080, 1350)


def report_card(stats):
    """一张 1080×1350 的产出记录卡：数字、风格分布、近 7 天趋势，可直接发群。"""
    width, height = REPORT_SIZE
    colors = THEMES['warm']
    dim, faint = '#7C8A7C', '#98A198'
    image = Image.new('RGB', (width, height), colors['bg'])
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((44, 44, width - 44, height - 44), radius=30, fill=colors['card'],
                           outline=colors['soft'], width=2)
    draw.text((92, 100), '知映 · 反诈短片产出记录', font=font(46, True), fill=colors['ink'])
    draw.text((92, 166), f'{time.strftime("%Y-%m-%d %H:%M", time.localtime())} 生成 · 仅统计本机产出',
              font=font(23), fill=faint)
    draw.line((92, 214, width - 92, 214), fill=colors['soft'], width=2)

    tiles = [('累计成片', f'{int(stats.get("clips") or 0)}', '支'),
             ('覆盖作品', f'{int(stats.get("projects") or 0)}', '个'),
             ('累计时长', f'{float(stats.get("minutes") or 0):.1f}', '分钟')]
    for index, (label, value, unit) in enumerate(tiles):
        left = 92 + index * 300
        draw.rounded_rectangle((left, 252, left + 272, 436), radius=22, fill=colors['bg'])
        draw.text((left + 28, 278), label, font=font(23), fill=dim)
        draw.text((left + 28, 312), value, font=font(76, True), fill=colors['ink'])
        draw.text((left + 30 + font(76, True).getlength(value), 372), unit, font=font(25), fill=colors['ink'])

    draw.text((92, 486), '风格分布', font=font(27, True), fill=colors['ink'])
    styles = stats.get('styles') or {}
    total = max(1, sum(int(value or 0) for value in styles.values()))
    y = 536
    for key, label in STYLES.items():
        count = int(styles.get(key) or 0)
        draw.text((92, y), label, font=font(23), fill=dim)
        draw.rounded_rectangle((300, y + 4, 860, y + 26), radius=11, fill=colors['bg'])
        bar = int(560 * count / total) if count else 0
        if bar:
            draw.rounded_rectangle((300, y + 4, 300 + max(bar, 14), y + 26), radius=11, fill=colors['accent'])
        draw.text((884, y), f'{count} 支', font=font(23), fill=colors['ink'])
        y += 46

    draw.text((92, 646), '近 7 天产出', font=font(27, True), fill=colors['ink'])
    week = stats.get('week') or []
    peak = max([int(item.get('count') or 0) for item in week] + [1])
    base = 930
    for index, item in enumerate(week):
        count = int(item.get('count') or 0)
        left = 104 + index * 120
        bar = int(210 * count / peak) if count else 0
        if bar:
            draw.rounded_rectangle((left, base - bar, left + 76, base), radius=10, fill=colors['accent'])
        else:
            draw.rounded_rectangle((left, base - 8, left + 76, base), radius=4, fill=colors['soft'])
        draw.text((left + 38, base - bar - 30), str(count), font=font(23, True), fill=colors['ink'], anchor='mm')
        draw.text((left + 38, base + 26), str(item.get('date') or '')[5:], font=font(21), fill=faint, anchor='mm')

    draw.line((92, 1000, width - 92, 1000), fill=colors['soft'], width=2)
    draw.text((92, 1030), f'其中 {int(stats.get("withSource") or 0)} 支标注了官方资料来源', font=font(23), fill=dim)
    draw.text((92, 1068), f'成片累计占用 {float(stats.get("bytes") or 0) / 1024 / 1024:.1f} MB；清理旧成片后累计数字仍保留',
              font=font(23), fill=dim)
    note = '数据来自本机 exports/ledger.json 账本，不上传任何内容；这张卡可以随短片一起发到群里。'
    for index, line in enumerate(wrap_text(note, font(21), width - 184)[:3]):
        draw.text((92, 1136 + index * 34), line, font=font(21), fill=faint)
    draw.text((width - 92, height - 92), '知映 ZHIYING · 本地公益工具', font=font(21), fill=faint, anchor='rs')
    return image



def report_png(stats):
    output = io.BytesIO()
    report_card(stats).save(output, format='PNG')
    return output.getvalue()

