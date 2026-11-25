import argparse
import base64
import binascii
import hashlib
import io
import json
import mimetypes
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
import wave
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import imageio_ffmpeg

from PIL import Image, ImageOps, UnidentifiedImageError

from rendering import (ASSETS, KIND_LABELS, NOIR_KINDS, SCENE_KINDS, STYLES, THEMES, animation_times,
                       draw_frame, phase_starts, preview_png, split_captions)

ROOT = Path(__file__).resolve().parent
EXPORTS = ROOT / 'exports'
AUDITIONS = ROOT / 'auditions'
PREVIEWS = ROOT / 'previews'
JOBS = {}
PREVIEW_LOCKS = {}
JOB_LOCK = threading.Lock()
PREVIEW_LOCKS_LOCK = threading.Lock()
SPEECH_LOCK = threading.Lock()
MAX_BODY = 48000
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_IMAGE_BODY = (MAX_IMAGE_BYTES + 2) // 3 * 4 + 1024
MAX_GC_IDS = 512
EXPORT_KEEP = 10
EXPORT_MAX_BYTES = 1024 ** 3
EXPORT_GRACE_SECONDS = 24 * 3600
EXPORT_KEEP_FILES = ('video.mp4', 'subtitles.srt', 'script.txt', 'render.log', 'project.json')
PREVIEW_MAX_BYTES = 256 * 1024 ** 2
AUDITION_MAX_BYTES = 128 * 1024 ** 2
PREVIEW_LOCKS_MAX = 4096
PREVIEW_LOCKS_KEEP = 3072
JOB_KEEP = 20


class ValidationError(ValueError):
    pass


def checked_text(value, label, maximum, minimum=1):
    if not isinstance(value, str):
        raise ValidationError(f'{label}必须是文字。')
    value = value.strip()
    if not minimum <= len(value) <= maximum:
        raise ValidationError(f'{label}需要 {minimum}–{maximum} 个字符。')
    if any(ord(char) < 32 and char not in '\n\r\t' for char in value):
        raise ValidationError(f'{label}包含不支持的控制字符。')
    return value


def default_visual(kind, text, style):
    visual = {'kind': kind, 'text': text, 'sub': '', 'imageId': None, 'imageName': '',
              'fit': 'cover', 'focusX': 50, 'focusY': 50, 'steps': [], 'interrupt': '',
              'items': [], 'from': 80, 'to': 20, 'target': 1.0, 'keywords': []}
    if style == 'noir':
        if kind == 'stack':
            visual['steps'] = ['停一下', '查来源', '问官方', '再决定']
        elif kind == 'receipt':
            visual['sub'] = '本地示意 · 2026'
            visual['items'] = [{'label': '垫付', 'value': '¥ 0'}, {'label': '损失', 'value': '全部'}]
        elif kind == 'loop':
            visual['sub'] = '次'
            visual['target'] = 3.0
        elif kind == 'title':
            visual['sub'] = 'ZHIYING · LOCAL'
    return visual


def suggest_visual(title, source, style='illustration'):
    if style == 'noir':
        rules = [('receipt', r'转账|垫付|付款|损失|钱'), ('stack', r'消息|在吗|打断|步骤|核实|思路'),
                 ('battery', r'精力|耐心|积蓄|消耗|电量'), ('loop', r'循环|反复|次数|耗时')]
        default = 'title'
    else:
        rules = [('help', r'求助|报警|证据|留证'), ('verify', r'核实|核验'),
                 ('transfer', r'转账|垫付|付款'), ('call', r'客服|来电|电话'),
                 ('message', r'消息|刷单|点赞|短信')]
        default = 'tip'
    kind = default
    for text in (title, source):
        matched = next((key for key, pattern in rules if re.search(pattern, text)), None)
        if matched:
            kind = matched
            break
    return default_visual(kind, title, style)


def validate_visual(value, title, source, style='illustration'):
    if value is None:
        return suggest_visual(title, source, style)
    if not isinstance(value, dict):
        raise ValidationError('画面设置格式不正确。')
    kind = value.get('kind')
    registry = NOIR_KINDS if style == 'noir' else SCENE_KINDS
    if not isinstance(kind, str) or kind not in registry:
        raise ValidationError('请选择当前风格库中有效的道具类型。')
    text = checked_text(value.get('text', ''), '画面文字', 60, 0)
    sub = checked_text(value.get('sub', ''), '副标题文字', 40, 0)
    keywords = []
    raw_keywords = value.get('keywords', [])
    if not isinstance(raw_keywords, list) or len(raw_keywords) > 3:
        raise ValidationError('标红关键词最多 3 个。')
    for word in raw_keywords:
        word = checked_text(word, '标红关键词', 12)
        if word not in keywords:
            keywords.append(word)
    steps = []
    raw_steps = value.get('steps', [])
    if not isinstance(raw_steps, list) or len(raw_steps) > 4:
        raise ValidationError('叠层卡步骤最多 4 条。')
    for step in raw_steps:
        steps.append(checked_text(step, '叠层卡步骤', 14, 0))
    interrupt = checked_text(value.get('interrupt', ''), '打断文字', 20, 0)
    items = []
    raw_items = value.get('items', [])
    if not isinstance(raw_items, list) or len(raw_items) > 3:
        raise ValidationError('票据条目最多 3 条。')
    for item in raw_items:
        if not isinstance(item, dict):
            raise ValidationError('票据条目格式不正确。')
        items.append({'label': checked_text(item.get('label', ''), '票据条目名', 12, 0),
                      'value': checked_text(item.get('value', ''), '票据条目值', 12, 0)})
    numbers = {}
    for field in ('from', 'to'):
        number = value.get(field, 80 if field == 'from' else 20)
        if type(number) is not int or not 0 <= number <= 100:
            raise ValidationError('电量百分比应为 0–100 的整数。')
        numbers[field] = number
    target = value.get('target', 1.0)
    if type(target) not in (int, float) or not 0 <= target <= 9999:
        raise ValidationError('计数目标应为 0–9999 的数字。')
    fit = value.get('fit', 'cover')
    if fit not in ('cover', 'contain'):
        raise ValidationError('请选择有效的图片显示方式。')
    position = {}
    for field in ('focusX', 'focusY'):
        number = value.get(field, 50)
        if type(number) is not int or not 0 <= number <= 100:
            raise ValidationError('图片位置应为 0–100 的整数。')
        position[field] = number
    image_id = value.get('imageId')
    if image_id is not None:
        if not isinstance(image_id, str) or not re.fullmatch(r'[a-f0-9]{32}', image_id):
            raise ValidationError('本地图片编号无效，不支持外部链接或文件路径。')
        if not (ASSETS / f'{image_id}.png').is_file():
            raise ValidationError('本地图片已不存在，请重新选择图片或恢复情景插画。')
    image_name = checked_text(value.get('imageName', ''), '图片名称', 120, 0)
    return {'kind': kind, 'text': text, 'sub': sub, 'imageId': image_id, 'imageName': image_name,
            'fit': fit, **position, 'steps': steps, 'interrupt': interrupt, 'items': items,
            **numbers, 'target': round(float(target), 2), 'keywords': keywords}


def store_image(encoded):
    if not isinstance(encoded, str) or len(encoded) > MAX_IMAGE_BODY:
        raise ValidationError('请选择不超过 4 MB 的 PNG、JPEG 或 WebP 图片。')
    try:
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > MAX_IMAGE_BYTES:
            raise ValidationError('图片不能超过 4 MB。')
        with Image.open(io.BytesIO(raw)) as original:
            if original.format not in ('PNG', 'JPEG', 'WEBP') or getattr(original, 'n_frames', 1) != 1:
                raise ValidationError('仅支持静态 PNG、JPEG、WebP 图片，不支持 SVG 或动图。')
            if original.width * original.height > 16000000 or min(original.size) < 32:
                raise ValidationError('图片至少 32×32 像素，且总像素不能超过 1600 万。')
            source = ImageOps.exif_transpose(original).convert('RGBA')
            source.thumbnail((1920, 1920), Image.Resampling.LANCZOS)
            image = Image.new('RGB', source.size, '#FFFFFF')
            image.paste(source, mask=source.getchannel('A'))
    except (binascii.Error, UnidentifiedImageError, OSError, Image.DecompressionBombError, ValueError) as error:
        if isinstance(error, ValidationError):
            raise
        raise ValidationError('无法读取图片，请选择有效的静态 PNG、JPEG 或 WebP 文件。') from error
    image_id = uuid.uuid4().hex
    ASSETS.mkdir(exist_ok=True)
    image.save(ASSETS / f'{image_id}.png', format='PNG')
    return {'id': image_id, 'width': image.width, 'height': image.height}


def make_draft(source, style='illustration'):
    source = checked_text(source, '资料', 1800, 20)
    paragraphs = [part.strip() for part in re.split(r'\n\s*\n|\n', source) if part.strip()]
    sections = []
    for paragraph in paragraphs:
        if len(paragraph) <= 200:
            sections.append(paragraph)
            continue
        sentences = re.findall(r'[^。！？!?；;]+[。！？!?；;]?|[。！？!?；;]', paragraph)
        current = ''
        for sentence in sentences:
            while len(sentence) > 200:
                if current:
                    sections.append(current)
                    current = ''
                sections.append(sentence[:200])
                sentence = sentence[200:]
            if current and len(current) + len(sentence) > 200:
                sections.append(current)
                current = ''
            current += sentence
        if current:
            sections.append(current)
    if len(sections) > 8:
        raise ValidationError('资料拆分后超过 8 幕，请精简至 8 个短段落以内；没有自动删掉任何内容。')
    scenes = []
    for index, section in enumerate(sections):
        heading = re.match(r'^([^：:。！？\n]{2,24})[：:]', section)
        title = heading.group(1) if heading else f'反诈提醒 {index + 1:02d}'
        scenes.append({'id': str(index + 1), 'title': title, 'narration': section,
                       'source': section, 'reviewed': False, 'visual': suggest_visual(title, section, style)})
    return scenes


def validate_project(data, require_review=False):
    if not isinstance(data, dict):
        raise ValidationError('项目格式不正确。')
    title = checked_text(data.get('title'), '作品名称', 40)
    theme = data.get('theme', 'warm')
    if not isinstance(theme, str) or theme not in THEMES:
        raise ValidationError('请选择有效的视觉模板。')
    style = data.get('style', 'illustration')
    if not isinstance(style, str) or style not in STYLES:
        raise ValidationError('请选择有效的渲染风格库。')
    accessible = data.get('accessible', True)
    if not isinstance(accessible, bool):
        raise ValidationError('适老模式参数不正确。')
    scenes = data.get('scenes')
    if not isinstance(scenes, list) or not 1 <= len(scenes) <= 8:
        raise ValidationError('需要 1–8 个分镜。')
    clean = []
    for i, scene in enumerate(scenes):
        if not isinstance(scene, dict):
            raise ValidationError('分镜格式不正确。')
        reviewed = scene.get('reviewed') is True
        if require_review and not reviewed:
            raise ValidationError(f'请先核对第 {i + 1} 幕的内容并勾选确认。')
        clean_scene = {'title': checked_text(scene.get('title'), f'第 {i + 1} 幕标题', 24),
                       'narration': checked_text(scene.get('narration'), f'第 {i + 1} 幕配音', 300),
                       'source': checked_text(scene.get('source'), f'第 {i + 1} 幕原资料', 300),
                       'reviewed': reviewed}
        clean_scene['visual'] = validate_visual(scene.get('visual'), clean_scene['title'], clean_scene['source'], style)
        clean.append(clean_scene)
    if sum(len(scene['narration']) for scene in clean) > 1800:
        raise ValidationError('全部配音合计不能超过 1800 字。')
    return {'title': title, 'theme': theme, 'style': style, 'accessible': accessible, 'scenes': clean}


def timestamp(seconds):
    milliseconds = round(seconds * 1000)
    hours, rest = divmod(milliseconds, 3600000)
    minutes, rest = divmod(rest, 60000)
    secs, ms = divmod(rest, 1000)
    return f'{hours:02}:{minutes:02}:{secs:02},{ms:03}'


def run_process(command, log, timeout=240):
    result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=timeout, creationflags=0x08000000)
    with log.open('ab') as output:
        output.write(result.stdout)
    if result.returncode:
        raise RuntimeError('本地配音或视频合成失败，请检查任务目录中的 render.log。')


def synthesize_wav(text, rate, wav_path, log):
    manifest = {'rate': rate, 'segments': [{'text': text, 'scene': 0, 'path': str(wav_path)}]}
    manifest_path = wav_path.with_suffix('.json')
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
    run_process(['powershell.exe', '-NoProfile', '-NonInteractive', '-File', str(ROOT / 'speech.ps1'),
                 '-Manifest', str(manifest_path)], log, timeout=120)


def audition_scene(narration, accessible):
    rate = -2 if accessible else 0
    key = hashlib.sha1(f'{rate}:{narration}'.encode('utf-8')).hexdigest()
    wav_path = AUDITIONS / f'{key}.wav'
    with SPEECH_LOCK:
        if wav_path.is_file():
            os.utime(wav_path, None)
        else:
            AUDITIONS.mkdir(exist_ok=True)
            synthesize_wav(narration, rate, wav_path, AUDITIONS / f'{key}.log')
    with wave.open(str(wav_path), 'rb') as audio:
        duration = audio.getnframes() / audio.getframerate()
    return {'url': f'/auditions/{key}.wav', 'duration': round(duration, 2)}


def estimate_segment_duration(caption, accessible):
    speed = 3.3 if accessible else 4.5
    return round((len(caption) / speed + 0.30) * 24 + 0.5) / 24


def preview_lock(key):
    with PREVIEW_LOCKS_LOCK:
        if len(PREVIEW_LOCKS) > PREVIEW_LOCKS_MAX:
            for stale_key, stale_lock in list(PREVIEW_LOCKS.items()):
                if len(PREVIEW_LOCKS) <= PREVIEW_LOCKS_KEEP:
                    break
                if not stale_lock.locked():
                    PREVIEW_LOCKS.pop(stale_key, None)
        lock = PREVIEW_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            PREVIEW_LOCKS[key] = lock
        return lock


def read_scene_meta(directory, meta_path):
    try:
        meta = json.loads(meta_path.read_text(encoding='utf-8'))
        names = [frame['url'].rsplit('/', 1)[-1] for frame in meta['frames']]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if not names or not all((directory / name).is_file() for name in {names[0], names[-1]}):
        return None
    os.utime(directory, None)
    return meta


def scene_frames(project, index):
    scene = project['scenes'][index]
    total = len(project['scenes'])
    render_fields = {field: scene[field] for field in ('title', 'narration', 'visual')}
    key = hashlib.sha1(json.dumps({'scene': render_fields, 'theme': project['theme'], 'style': project['style'],
                                   'accessible': project['accessible'], 'index': index, 'total': total},
                                  ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
    directory = PREVIEWS / key
    meta_path = directory / 'meta.json'
    meta = read_scene_meta(directory, meta_path)
    if meta is not None:
        return meta
    with preview_lock(key):
        meta = read_scene_meta(directory, meta_path)
        if meta is not None:
            return meta
        captions = split_captions(scene['narration'], project['accessible'])
        segments, start = [], 0.0
        for caption in captions:
            duration = estimate_segment_duration(caption, project['accessible'])
            segments.append((caption, start, duration))
            start += duration
        scene_duration = start
        phases = phase_starts(project['style'], scene['visual']['kind'])
        directory.mkdir(parents=True, exist_ok=True)
        frames, number = [], 0
        for caption, seg_start, seg_duration in segments:
            for moment in animation_times(seg_start, seg_duration, scene_duration, phases):
                progress = (seg_start + moment) / scene_duration
                filename = f'frame-{number:03d}.png'
                draw_frame(scene, index, total, project['theme'], project['accessible'],
                           caption, progress=progress, draft=True, style=project['style']).save(directory / filename)
                frames.append({'at': round(progress, 4), 'url': f'/previews/{key}/{filename}'})
                number += 1
        meta = {'duration': round(scene_duration, 2), 'frames': frames}
        temp_path = meta_path.with_name('meta.json.tmp')
        temp_path.write_text(json.dumps(meta, ensure_ascii=False), encoding='utf-8')
        os.replace(temp_path, meta_path)
        return meta


def running_job_ids():
    with JOB_LOCK:
        return {job_id for job_id, job in JOBS.items() if job.get('status') == 'running'}


def reap_jobs(keep=JOB_KEEP):
    finished = [job_id for job_id, job in JOBS.items() if job.get('status') != 'running']
    for job_id in finished[:max(0, len(finished) - keep)]:
        JOBS.pop(job_id, None)


def dir_bytes(path):
    total = 0
    for file in path.rglob('*'):
        try:
            if file.is_file():
                total += file.stat().st_size
        except OSError:
            continue
    return total


def prune_export_intermediates(directory):
    for file in directory.iterdir():
        if file.is_file() and file.name not in EXPORT_KEEP_FILES:
            file.unlink(missing_ok=True)


def cleanup_exports(protected=None):
    protected = running_job_ids() if protected is None else protected
    if not EXPORTS.is_dir():
        return 0
    now = time.time()
    freed = 0
    completed = []
    for directory in EXPORTS.iterdir():
        if not directory.is_dir() or not re.fullmatch(r'[a-f0-9]{32}', directory.name) or directory.name in protected:
            continue
        try:
            modified = directory.stat().st_mtime
            size = dir_bytes(directory)
        except OSError:
            continue
        if not (directory / 'video.mp4').is_file():
            if now - modified > EXPORT_GRACE_SECONDS:
                shutil.rmtree(directory, ignore_errors=True)
                freed += size
            continue
        completed.append((modified, size, directory))
    completed.sort(key=lambda item: item[0], reverse=True)
    kept_bytes = 0
    for index, (_, size, directory) in enumerate(completed):
        if index and (index >= EXPORT_KEEP or kept_bytes >= EXPORT_MAX_BYTES):
            shutil.rmtree(directory, ignore_errors=True)
            freed += size
        else:
            kept_bytes += size
    return freed


def trim_by_mtime(base, maximum):
    freed = 0
    if not base.is_dir():
        return freed
    entries, total = [], 0
    for path in base.iterdir():
        try:
            size = dir_bytes(path) if path.is_dir() else path.stat().st_size
            entries.append((path.stat().st_mtime, size, path))
            total += size
        except OSError:
            continue
    entries.sort()
    for _, size, path in entries:
        if total <= maximum:
            break
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)
        total -= size
        freed += size
    return freed


def cleanup_all():
    freed = cleanup_exports()
    freed += trim_by_mtime(PREVIEWS, PREVIEW_MAX_BYTES)
    freed += trim_by_mtime(AUDITIONS, AUDITION_MAX_BYTES)
    return freed


def dir_usage(base):
    files, total = 0, 0
    if base.is_dir():
        for file in base.rglob('*'):
            try:
                if file.is_file():
                    files += 1
                    total += file.stat().st_size
            except OSError:
                continue
    return {'bytes': total, 'files': files}


def usage_stats():
    usage = {'exports': dir_usage(EXPORTS), 'previews': dir_usage(PREVIEWS),
             'auditions': dir_usage(AUDITIONS), 'assets': dir_usage(ASSETS)}
    completed = 0
    if EXPORTS.is_dir():
        completed = sum(1 for directory in EXPORTS.iterdir()
                        if directory.is_dir() and (directory / 'video.mp4').is_file())
    usage['exports']['completed'] = completed
    return usage


def gc_files(asset_ids, export_ids):
    deleted = {'assets': 0, 'exports': 0}
    skipped = {'assets': 0, 'exports': 0}
    for image_id in asset_ids:
        if not isinstance(image_id, str) or not re.fullmatch(r'[a-f0-9]{32}', image_id):
            raise ValidationError('图片编号不正确。')
        path = ASSETS / f'{image_id}.png'
        try:
            if path.is_file():
                path.unlink()
                deleted['assets'] += 1
        except OSError:
            skipped['assets'] += 1
    protected = running_job_ids()
    for job_id in export_ids:
        if not isinstance(job_id, str) or not re.fullmatch(r'[a-f0-9]{32}', job_id):
            raise ValidationError('成片任务编号不正确。')
        if job_id in protected:
            skipped['exports'] += 1
            continue
        path = EXPORTS / job_id
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
            if path.exists():
                skipped['exports'] += 1
            else:
                deleted['exports'] += 1
    return {'deleted': deleted, 'skipped': skipped}


def render_job(job_id, project):
    job = JOBS[job_id]
    directory = EXPORTS / job_id
    directory.mkdir()
    log = directory / 'render.log'
    try:
        segments = []
        for index, scene in enumerate(project['scenes']):
            for caption in split_captions(scene['narration'], project['accessible']):
                segments.append({'text': caption, 'scene': index,
                                 'path': str(directory / f'audio-{len(segments):03d}.wav')})
        manifest = {'rate': -2 if project['accessible'] else 0, 'segments': segments}
        (directory / 'speech.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
        (directory / 'project.json').write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding='utf-8')
        job.update(progress=8, message='正在用本机中文语音生成配音…')
        run_process(['powershell.exe', '-NoProfile', '-NonInteractive', '-File', str(ROOT / 'speech.ps1'),
                     '-Manifest', str(directory / 'speech.json')], log)
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        for segment in segments:
            with wave.open(segment['path'], 'rb') as audio:
                segment['duration'] = round((audio.getnframes() / audio.getframerate() + 0.30) * 24 + 0.5) / 24
        scene_durations, scene_starts = {}, {}
        elapsed = 0.0
        for segment in segments:
            scene = segment['scene']
            if scene not in scene_starts:
                scene_starts[scene] = elapsed
            segment['offset'] = elapsed - scene_starts[scene]
            scene_durations[scene] = scene_durations.get(scene, 0.0) + segment['duration']
            elapsed += segment['duration']
        duration, subtitles, clips = 0.0, [], []
        for index, segment in enumerate(segments):
            scene_index = segment['scene']
            segment_duration = segment['duration']
            scene_duration = scene_durations[scene_index]
            seg_start = segment['offset']
            clip = directory / f'clip-{index:03d}.mp4'
            moments = animation_times(seg_start, segment_duration, scene_duration,
                                      phase_starts(project['style'], project['scenes'][scene_index]['visual']['kind']))
            entries, last_name = [], None
            for k, moment in enumerate(moments):
                progress = (seg_start + moment) / scene_duration
                name = f'frame-{index:03d}-{k:03d}.png'
                draw_frame(project['scenes'][scene_index], scene_index, len(project['scenes']),
                           project['theme'], project['accessible'], segment['text'],
                           progress=progress, style=project['style']).save(directory / name)
                hold = (moments[k + 1] - moment) if k + 1 < len(moments) else segment_duration - moment
                entries.append(f"file '{name}'\nduration {hold:.6f}")
                last_name = name
            entries.append(f"file '{last_name}'")
            frames_list = directory / f'frames-{index:03d}.txt'
            frames_list.write_text('ffconcat version 1.0\n' + '\n'.join(entries), encoding='utf-8')
            job.update(progress=20 + int(index / len(segments) * 68),
                       message=f'正在合成动态画面与字幕 {index + 1} / {len(segments)}…')
            run_process([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0',
                         '-i', str(frames_list), '-i', segment['path'], '-t', f'{segment_duration:.6f}',
                         '-r', '24', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
                         '-threads', '2', '-c:a', 'aac', '-b:a', '128k', '-af', 'apad',
                         '-movflags', '+faststart', str(clip)], log)
            subtitles.append(f'{index + 1}\n{timestamp(duration)} --> {timestamp(duration + segment_duration)}\n{segment["text"]}\n')
            duration += segment_duration
            clips.append(f"file '{clip.name}'")
        (directory / 'concat.txt').write_text('\n'.join(clips), encoding='utf-8')
        job.update(progress=92, message='正在封装 MP4 并生成字幕文件…')
        output = directory / 'video.mp4'
        run_process([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1',
                     '-i', str(directory / 'concat.txt'), '-c', 'copy', '-movflags', '+faststart', str(output)], log)
        (directory / 'subtitles.srt').write_text('\n'.join(subtitles), encoding='utf-8-sig')
        script = project['title'] + '\n\n' + '\n\n'.join(
            f'{i + 1:02d} {scene["title"]}\n{scene["narration"]}\n原资料：{scene["source"]}\n'
            f'渲染风格：{STYLES[project["style"]]}\n'
            f'情景类型：{KIND_LABELS[scene["visual"]["kind"]]}（示意画面）\n'
            f'画面文字：{scene["visual"]["text"]}\n'
            f'画面素材：{scene["visual"]["imageName"] if scene["visual"]["imageId"] else "本地情景插画"}'
            for i, scene in enumerate(project['scenes']))
        (directory / 'script.txt').write_text(script, encoding='utf-8-sig')
        prune_export_intermediates(directory)
        job.update(status='completed', progress=100, message='制作完成，视频已保存在本机。',
                   duration=round(duration, 1), size=output.stat().st_size,
                   video=f'/files/{job_id}/video.mp4', subtitles=f'/files/{job_id}/subtitles.srt',
                   script=f'/files/{job_id}/script.txt')
        cleanup_exports(protected={job_id})
    except Exception as error:
        with log.open('a', encoding='utf-8') as output:
            output.write(f'\n{type(error).__name__}: {error}\n')
        job.update(status='failed', message='本地制作失败。请检查中文语音、磁盘空间及任务目录内的 render.log，然后重试。')


class Handler(BaseHTTPRequestHandler):
    server_version = 'ZhiyingLocal/1.0'

    def send_bytes(self, content, content_type, status=200, extra=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'")
        if extra:
            for key, value in extra.items():
                self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def json_response(self, value, status=200):
        self.send_bytes(json.dumps(value, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8', status)

    def valid_host(self):
        port = self.server.server_port
        return self.headers.get('Host') in (f'127.0.0.1:{port}', f'localhost:{port}')

    def do_GET(self):
        if not self.valid_host():
            return self.json_response({'error': '仅支持本机访问。'}, 403)
        path = urlsplit(self.path).path
        if path == '/api/status':
            return self.json_response({'local': True, 'engine': '本地规则分镜 + Windows 离线中文配音',
                                       'ffmpeg': Path(imageio_ffmpeg.get_ffmpeg_exe()).is_file()})
        if path == '/api/usage':
            return self.json_response(usage_stats())
        match = re.fullmatch(r'/assets/([a-f0-9]{32})\.png', path)
        if match:
            filename = ASSETS / f'{match.group(1)}.png'
            if not filename.is_file():
                return self.json_response({'error': '本地图片不存在。'}, 404)
            return self.send_bytes(filename.read_bytes(), 'image/png')
        match = re.fullmatch(r'/api/jobs/([a-f0-9]{32})', path)
        if match:
            job = JOBS.get(match.group(1))
            return self.json_response(job if job else {'error': '制作任务不存在，请重新制作。'}, 200 if job else 404)
        match = re.fullmatch(r'/files/([a-f0-9]{32})/(video\.mp4|subtitles\.srt|script\.txt)', path)
        if match:
            filename = EXPORTS / match.group(1) / match.group(2)
            if not filename.is_file():
                return self.json_response({'error': '文件尚未生成。'}, 404)
            return self.send_media(filename)
        match = re.fullmatch(r'/auditions/([a-f0-9]{40})\.wav', path)
        if match:
            filename = AUDITIONS / f'{match.group(1)}.wav'
            if not filename.is_file():
                return self.json_response({'error': '试听音频不存在，请重新试听。'}, 404)
            return self.send_media(filename)
        match = re.fullmatch(r'/previews/([a-f0-9]{40})/(frame-\d{3}\.png)', path)
        if match:
            filename = PREVIEWS / match.group(1) / match.group(2)
            if not filename.is_file():
                return self.json_response({'error': '预览画面不存在。'}, 404)
            return self.send_bytes(filename.read_bytes(), 'image/png')
        static_files = {'/': 'index.html', '/app.js': 'app.js', '/project-store.js': 'project-store.js', '/styles.css': 'styles.css', '/favicon.svg': 'favicon.svg'}
        if path not in static_files:
            return self.json_response({'error': '找不到这个页面。'}, 404)
        filename = ROOT / 'static' / static_files[path]
        content_type = mimetypes.guess_type(filename.name)[0] or 'application/octet-stream'
        self.send_bytes(filename.read_bytes(), content_type + ('; charset=utf-8' if content_type.startswith('text/') else ''))

    def send_media(self, filename):
        size = filename.stat().st_size
        start, end, status = 0, size - 1, 200
        range_header = self.headers.get('Range')
        if range_header:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', range_header)
            if not match or not any(match.groups()):
                return self.send_bytes(b'', 'text/plain', 416, {'Content-Range': f'bytes */{size}'})
            if match.group(1):
                start = int(match.group(1))
                end = min(int(match.group(2)), size - 1) if match.group(2) else size - 1
            else:
                suffix = int(match.group(2))
                start = max(0, size - suffix)
            if start > end or start >= size:
                return self.send_bytes(b'', 'text/plain', 416, {'Content-Range': f'bytes */{size}'})
            status = 206
        content_type = {'mp4': 'video/mp4', 'wav': 'audio/wav', 'srt': 'application/x-subrip; charset=utf-8', 'txt': 'text/plain; charset=utf-8'}[filename.suffix[1:]]
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if filename.suffix != '.mp4':
            self.send_header('Content-Disposition', f'attachment; filename="{filename.name}"')
        if status == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()
        with filename.open('rb') as file:
            file.seek(start)
            remaining = end - start + 1
            try:
                while remaining:
                    chunk = file.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    def do_POST(self):
        origin = self.headers.get('Origin')
        allowed_origins = {f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}'}
        if not self.valid_host() or (origin and origin not in allowed_origins) or self.headers.get('X-Zhiying-Local') != '1':
            return self.json_response({'error': '仅接受本地工作台请求。'}, 403)
        if self.headers.get_content_type() != 'application/json':
            return self.json_response({'error': '请求必须为 JSON。'}, 415)
        try:
            path = urlsplit(self.path).path
            length = int(self.headers.get('Content-Length', '0'))
            limit = MAX_IMAGE_BODY if path == '/api/assets' else MAX_BODY
            if not 0 < length <= limit:
                return self.json_response({'error': '提交的内容过大或为空。'}, 413)
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValidationError('请求格式不正确。')
            if path == '/api/assets':
                return self.json_response(store_image(data.get('image')), 201)
            if path == '/api/gc':
                assets, exports = data.get('assets', []), data.get('exports', [])
                if not isinstance(assets, list) or not isinstance(exports, list):
                    raise ValidationError('待清理列表格式不正确。')
                if len(assets) > MAX_GC_IDS or len(exports) > MAX_GC_IDS:
                    raise ValidationError('待清理列表过长，请分批清理。')
                return self.json_response(gc_files(assets, exports))
            if path == '/api/cleanup':
                return self.json_response({'freed': cleanup_all(), 'usage': usage_stats()})
            if path == '/api/draft':
                style = data.get('style', 'illustration')
                if not isinstance(style, str) or style not in STYLES:
                    raise ValidationError('请选择有效的渲染风格库。')
                return self.json_response({'scenes': make_draft(data.get('source'), style)})
            if path == '/api/audition':
                narration = checked_text(data.get('narration'), '配音', 300)
                accessible = data.get('accessible', True)
                if not isinstance(accessible, bool):
                    raise ValidationError('适老模式参数不正确。')
                return self.json_response(audition_scene(narration, accessible))
            if path == '/api/frames':
                project = validate_project(data)
                index = data.get('index', 0)
                if type(index) is not int or not 0 <= index < len(project['scenes']):
                    raise ValidationError('分镜序号不正确。')
                return self.json_response(scene_frames(project, index))
            if path == '/api/preview':
                project = validate_project(data)
                index = data.get('index', 0)
                if type(index) is not int or not 0 <= index < len(project['scenes']):
                    raise ValidationError('分镜序号不正确。')
                return self.send_bytes(preview_png(project['scenes'][index], index, len(project['scenes']),
                                                   project['theme'], project['accessible'], project['style']), 'image/png')
            if path == '/api/export':
                project = validate_project(data, require_review=True)
                with JOB_LOCK:
                    if any(job['status'] == 'running' for job in JOBS.values()):
                        return self.json_response({'error': '已有视频正在制作，请等待完成后再试。'}, 409)
                    job_id = uuid.uuid4().hex
                    JOBS[job_id] = {'id': job_id, 'status': 'running', 'progress': 0, 'message': '已进入本地制作队列…'}
                    reap_jobs()
                threading.Thread(target=render_job, args=(job_id, project), daemon=True).start()
                return self.json_response({'id': job_id}, 202)
            return self.json_response({'error': '接口不存在。'}, 404)
        except (ValidationError, json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
            self.json_response({'error': str(error) if isinstance(error, ValidationError) else '请求内容不正确。'}, 400)
        except Exception as error:
            print(f'Local request failed: {error}', flush=True)
            self.json_response({'error': '本地服务处理失败，请查看服务窗口。'}, 500)

    def log_message(self, fmt, *args):
        if '/api/jobs/' not in str(args[0]):
            super().log_message(fmt, *args)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--open', action='store_true')
    args = parser.parse_args()
    EXPORTS.mkdir(exist_ok=True)
    try:
        cleanup_all()
    except OSError as error:
        print(f'Startup cleanup skipped: {error}', flush=True)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    address = f'http://127.0.0.1:{args.port}'
    print(f'Zhiying local studio: {address}', flush=True)
    print('Local only. Press Ctrl+C to stop.', flush=True)
    if args.open:
        webbrowser.open(address)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
