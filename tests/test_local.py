import base64
import hashlib
import io
import json
import os
import re
import tempfile
import sys
import threading
import time
import unittest
import wave
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rendering import (SCENE_KINDS, STYLES, THEMES, animation_times, draw_frame, fitted_asset, font,
                       phase_starts, preview_png, split_captions, wrap_text)
from server import (Handler, ThreadingHTTPServer, ValidationError, build_share_text, caption_wav_path, cleanup_exports,
                    ensure_caption_wavs, load_ledger, quantized_duration, prune_export_intermediates, reap_jobs,
                    record_ledger, report_stats, run_streamed, scene_audio, scene_frames, gc_files, make_draft,
                    store_image, suggest_visual, timestamp, trim_by_mtime, validate_project, validate_visual)


def stub_scene_audio(narration, accessible):
    captions = split_captions(narration, accessible)
    segments = [quantized_duration(len(caption) / 5) for caption in captions]
    key = hashlib.sha1(f'{accessible}:{narration}'.encode('utf-8')).hexdigest()
    return {'key': key, 'url': f'/auditions/{key}.wav', 'duration': round(sum(segments), 2),
            'captions': captions, 'segments': segments}


def write_caption_wav(path, seconds, framerate=22050):
    path.parent.mkdir(exist_ok=True)
    with wave.open(str(path), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(framerate)
        audio.writeframes(b'\x01\x00' * int(seconds * framerate))


class DraftTests(unittest.TestCase):
    def test_draft_preserves_source(self):
        source = '验证码不外传：不要将短信验证码告诉陌生人。\n\n转账先核实：收到借钱消息，先联系本人核实。'
        scenes = make_draft(source)
        self.assertEqual(len(scenes), 2)
        self.assertEqual(scenes[0]['title'], '验证码不外传')
        self.assertEqual(''.join(scene['narration'] for scene in scenes), re.sub(r'\s+', '', source))
        self.assertTrue(all(scene['source'] == scene['narration'] for scene in scenes))
        self.assertTrue(all(not scene['reviewed'] for scene in scenes))

    def test_long_source_is_split_without_loss(self):
        source = '不要向陌生人提供银行卡密码和验证码。' * 40
        scenes = make_draft(source)
        self.assertEqual(''.join(s['narration'] for s in scenes), source)
        self.assertTrue(all(len(s['narration']) <= 200 for s in scenes))

    def test_reject_empty_short_overlong_or_many_sections(self):
        for source in ['', '注意诈骗', '字' * 1801, '\n'.join(['注意保护自己的个人信息。'] * 9)]:
            with self.subTest(source=source[:25]), self.assertRaises(ValidationError):
                make_draft(source)

    def test_export_requires_actual_boolean_review(self):
        scenes = make_draft('验证码不外传：不要将短信验证码告诉任何陌生人。')
        project = {'title': '反诈宣传', 'scenes': scenes, 'theme': 'warm', 'accessible': True}
        for value in [False, 'true', 1, None]:
            scenes[0]['reviewed'] = value
            with self.assertRaises(ValidationError):
                validate_project(project, require_review=True)
        scenes[0]['reviewed'] = True
        self.assertEqual(validate_project(project, True)['title'], '反诈宣传')

    def test_validation_rejects_invalid_fields(self):
        project = {'title': '反诈宣传', 'scenes': make_draft('验证码不外传：不要将短信验证码告诉任何陌生人。')}
        for key, value in [('theme', '../../file'), ('accessible', 'true'), ('scenes', []), ('title', '')]:
            with self.subTest(key=key), self.assertRaises(ValidationError):
                validate_project({**project, key: value})

    def test_caption_pages_fit_and_preserve_text(self):
        text = '陌生来电要核实，不要相信所谓的安全账户。' * 10
        for accessible in (False, True):
            pages = split_captions(text, accessible)
            self.assertEqual(''.join(pages), text)
            for page in pages:
                self.assertLessEqual(len(wrap_text(page, font(42 if accessible else 36, True), 1070)), 2)

    def test_punctuation_does_not_start_a_line(self):
        lines = wrap_text('先核实再转账，不轻信陌生来电。', font(42, True), 252)
        self.assertEqual(''.join(lines), '先核实再转账，不轻信陌生来电。')
        self.assertTrue(all(not line.startswith(('，', '。')) for line in lines))

    def test_timestamp(self):
        self.assertEqual(timestamp(61.25), '00:01:01,250')
        self.assertEqual(timestamp(0), '00:00:00,000')


class VisualTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        for module in ('server.ASSETS', 'rendering.ASSETS'):
            patcher = patch(module, Path(self.directory.name))
            patcher.start()
            self.addCleanup(patcher.stop)
        self.scene = make_draft('收到消息：陌生人发来刷单消息，不要急着相信。')[0]
        self.project = {'title': '反诈', 'scenes': [self.scene]}

    def encoded_image(self, image, image_format='PNG', **kwargs):
        buffer = io.BytesIO()
        image.save(buffer, format=image_format, **kwargs)
        return base64.b64encode(buffer.getvalue()).decode('ascii')

    def test_scenario_matching_preserves_narration(self):
        source = '收到消息：陌生人发来刷单消息，不要急着相信。\n识别垫付风险：对方要求先付款再返还，请警惕。\n主动核实：离开陌生链接，通过官方渠道核实。\n留证求助：保留聊天记录和凭证，及时报警。'
        scenes = make_draft(source)
        self.assertEqual([s['visual']['kind'] for s in scenes], ['message', 'transfer', 'verify', 'help'])
        self.assertEqual(''.join(s['narration'] for s in scenes), source.replace('\n', ''))
        self.assertTrue(all(s['visual']['text'] == s['title'] for s in scenes))

    def test_all_scenarios_are_distinct_and_match_preview(self):
        frames = set()
        for theme in ('warm', 'teal', 'bold'):
            for kind in SCENE_KINDS:
                self.scene['visual']['kind'] = kind
                self.scene['visual']['text'] = '请先核实，再决定是否操作。'
                image = draw_frame(self.scene, 0, 1, theme)
                preview = Image.open(io.BytesIO(preview_png(self.scene, 0, 1, theme, True)))
                self.assertEqual(image.tobytes(), preview.tobytes())
                self.assertEqual(image.size, (1280, 720))
                frames.add(image.tobytes())
        self.assertEqual(len(frames), 18)

    def test_invalid_visual_fields(self):
        for key, value in [('kind', 'unknown'), ('text', '字' * 61), ('fit', 'stretch'),
                           ('focusX', -1), ('focusY', 101), ('focusX', True),
                           ('imageId', '../../secret'), ('imageId', 'https://example.invalid/image.png'),
                           ('imageId', 'a' * 32)]:
            with self.subTest(key=key, value=value), self.assertRaises(ValidationError):
                validate_project({**self.project, 'scenes': [{**self.scene, 'visual': {**self.scene['visual'], key: value}}]})

    def test_import_fit_crop_and_metadata_removal(self):
        source = Image.new('RGB', (1200, 200), 'red')
        source.paste('blue', (600, 0, 1200, 200))
        asset = store_image(self.encoded_image(source))
        self.scene['visual']['imageId'] = asset['id']
        self.scene['visual']['focusX'] = 0
        left = draw_frame(self.scene, 0, 1)
        self.scene['visual']['focusX'] = 100
        right = draw_frame(self.scene, 0, 1)
        self.assertEqual(left.getpixel((900, 300)), (255, 0, 0))
        self.assertEqual(right.getpixel((900, 300)), (0, 0, 255))
        self.scene['visual']['fit'] = 'contain'
        contained = draw_frame(self.scene, 0, 1)
        self.assertNotEqual(contained.getpixel((900, 200)), right.getpixel((900, 200)))
        self.assertEqual(contained.tobytes(), Image.open(io.BytesIO(preview_png(self.scene, 0, 1, 'warm', True))).tobytes())
        self.assertEqual(validate_project(self.project)['scenes'][0]['visual']['imageId'], asset['id'])
        with Image.open(Path(self.directory.name) / f'{asset["id"]}.png') as stored:
            self.assertEqual(stored.info, {})

    def test_local_image_fit_result_is_cached(self):
        source = Image.new('RGB', (800, 400), 'red')
        asset = store_image(self.encoded_image(source))
        self.scene['visual']['imageId'] = asset['id']
        before = fitted_asset.cache_info()
        first = draw_frame(self.scene, 0, 1)
        mid = fitted_asset.cache_info()
        second = draw_frame(self.scene, 0, 1)
        after = fitted_asset.cache_info()
        self.assertEqual(mid.misses, before.misses + 1)
        self.assertEqual(after.hits, mid.hits + 1)
        self.assertEqual(first.tobytes(), second.tobytes())
        self.scene['visual']['focusX'] = 30
        draw_frame(self.scene, 0, 1)
        self.assertEqual(fitted_asset.cache_info().misses, after.misses + 1)

    def test_exif_orientation_and_transparency(self):
        original = Image.new('RGB', (80, 40), 'red')
        exif = Image.Exif()
        exif[274] = 6
        asset = store_image(self.encoded_image(original, 'JPEG', exif=exif))
        self.assertEqual((asset['width'], asset['height']), (40, 80))
        alpha = store_image(self.encoded_image(Image.new('RGBA', (100, 100), (0, 0, 0, 0))))
        with Image.open(Path(self.directory.name) / f'{alpha["id"]}.png') as image:
            self.assertEqual(image.getpixel((50, 50)), (255, 255, 255))

    def test_invalid_images_rejected(self):
        inputs = ['not base64', base64.b64encode(b'<svg></svg>').decode(),
                  base64.b64encode(b'x' * (4 * 1024 * 1024 + 1)).decode(),
                  self.encoded_image(Image.new('RGB', (10, 10))),
                  self.encoded_image(Image.new('RGB', (4001, 4000)))]
        for encoded in inputs:
            with self.subTest(length=len(encoded)), self.assertRaises(ValidationError):
                store_image(encoded)
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_animated_image_rejected(self):
        first = Image.new('RGB', (80, 80), 'red')
        second = Image.new('RGB', (80, 80), 'blue')
        with self.assertRaises(ValidationError):
            store_image(self.encoded_image(first, save_all=True, append_images=[second], duration=100))


class AnimationTests(unittest.TestCase):
    def setUp(self):
        patcher = patch('server.scene_audio', stub_scene_audio)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_animation_times_are_segment_relative_and_bounded(self):
        moments = animation_times(4.0, 3.0, 12.0)
        self.assertEqual(moments[0], 0)
        self.assertLessEqual(moments[-1], 3.0)
        self.assertTrue(all(0 <= m <= 3.0 for m in moments))
        self.assertEqual(moments, sorted(moments))

    def test_progressive_frames_differ(self):
        scene = make_draft('收到消息：陌生人发来刷单消息，不要急着相信。')[0]
        early = draw_frame(scene, 0, 1, progress=0.0)
        middle = draw_frame(scene, 0, 1, progress=0.4)
        late = draw_frame(scene, 0, 1, progress=1.0)
        region = (658, 120, 1216, 498)
        self.assertNotEqual(early.crop(region).tobytes(), late.crop(region).tobytes())
        self.assertNotEqual(middle.crop(region).tobytes(), late.crop(region).tobytes())

    def test_multi_caption_scene_frames_span_full_scene(self):
        long_text = '陌生来电要核实，不要相信所谓的安全账户。' * 6
        scene = make_draft('核实来电：' + long_text)[0]
        self.assertGreater(len(split_captions(scene['narration'], True)), 1)
        project = {'title': '反诈', 'theme': 'warm', 'style': 'illustration', 'accessible': True, 'scenes': [scene]}
        with tempfile.TemporaryDirectory() as directory, patch('server.PREVIEWS', Path(directory)):
            meta = scene_frames(project, 0)
            ats = [frame['at'] for frame in meta['frames']]
            self.assertEqual(ats[0], 0.0)
            self.assertEqual(ats[-1], 1.0)
            self.assertEqual(ats, sorted(ats))
            self.assertGreater(len({frame['url'] for frame in meta['frames']}), 3)
            cached = scene_frames(project, 0)
            self.assertEqual(cached['frames'], meta['frames'])


class NoirTests(unittest.TestCase):
    def setUp(self):
        patcher = patch('server.scene_audio', stub_scene_audio)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_noir_frames_differ_across_progress(self):
        scene = make_draft('收到消息：陌生人发来刷单消息，不要急着相信。', 'noir')[0]
        self.assertEqual(scene['visual']['kind'], 'stack')
        region = (658, 120, 1216, 498)
        early = draw_frame(scene, 0, 1, progress=0.0, style='noir')
        middle = draw_frame(scene, 0, 1, progress=0.5, style='noir')
        late = draw_frame(scene, 0, 1, progress=1.0, style='noir')
        self.assertNotEqual(early.crop(region).tobytes(), late.crop(region).tobytes())
        self.assertNotEqual(middle.crop(region).tobytes(), late.crop(region).tobytes())
        self.assertLess(sum(early.crop(region).convert('L').getdata()) / (558 * 378), 60)

    def test_noir_phases_drive_animation_times(self):
        phases = phase_starts('noir', 'stack')
        self.assertEqual(phases, (0, .22, .44, .66))
        moments = animation_times(0, 6, 12, phases)
        self.assertEqual(moments[0], 0)
        self.assertLessEqual(moments[-1], 6)
        self.assertEqual(moments, sorted(moments))

    def test_noir_cache_key_differs_from_illustration(self):
        scene = make_draft('核实来电：陌生来电要核实，不要相信安全账户。')[0]
        base = {'title': '反诈', 'theme': 'warm', 'accessible': True, 'scenes': [scene]}
        with tempfile.TemporaryDirectory() as directory, patch('server.PREVIEWS', Path(directory)):
            illustration = scene_frames({**base, 'style': 'illustration'}, 0)
            noir_scene = {**scene, 'visual': {**scene['visual'], 'kind': 'loop'}}
            noir = scene_frames({**base, 'style': 'noir', 'scenes': [noir_scene]}, 0)
            self.assertNotEqual(illustration['frames'][0]['url'], noir['frames'][0]['url'])

    def test_validate_visual_enforces_style_library(self):
        with self.assertRaises(ValidationError):
            validate_visual({'kind': 'message', 'text': 'x'}, '标题', '来源', 'noir')
        with self.assertRaises(ValidationError):
            validate_visual({'kind': 'stack', 'steps': ['a', 'b', 'c', 'd', 'e']}, '标题', '来源', 'noir')
        with self.assertRaises(ValidationError):
            validate_visual({'kind': 'battery', 'from': 101}, '标题', '来源', 'noir')
        clean = validate_visual({'kind': 'receipt', 'text': '代价单', 'keywords': ['在吗？', '在吗？', '抹掉']},
                                '标题', '来源', 'noir')
        self.assertEqual(clean['keywords'], ['在吗？', '抹掉'])
        self.assertEqual(clean['items'], [])

    def test_suggest_visual_noir_rules(self):
        self.assertEqual(suggest_visual('识别垫付风险', '要求先垫付资金', 'noir')['kind'], 'receipt')
        self.assertEqual(suggest_visual('收到一条刷单消息', '陌生人发来兼职消息', 'noir')['kind'], 'stack')
        self.assertEqual(suggest_visual('主动核实信息', '通过官方渠道核实', 'noir')['kind'], 'stack')

    def test_keywords_render_red_in_caption(self):
        scene = make_draft('收到消息：陌生人发来刷单消息，不要急着相信。', 'noir')[0]
        scene['visual']['keywords'] = ['刷单']
        with_keywords = draw_frame(scene, 0, 1, caption='陌生人发来刷单消息。', style='noir')
        scene['visual']['keywords'] = []
        without = draw_frame(scene, 0, 1, caption='陌生人发来刷单消息。', style='noir')
        region = (60, 527, 1220, 654)
        self.assertNotEqual(with_keywords.crop(region).tobytes(), without.crop(region).tobytes())


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.exports = Path(self.tmp.name) / 'exports'
        self.exports.mkdir()
        patcher = patch('server.EXPORTS', self.exports)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch('server.scene_audio', stub_scene_audio)
        patcher.start()
        self.addCleanup(patcher.stop)

    def make_job(self, name, complete=True, age=0.0, size=2048):
        directory = self.exports / name
        directory.mkdir()
        (directory / 'data.bin').write_bytes(b'x' * size)
        if complete:
            (directory / 'video.mp4').write_bytes(b'x' * size)
        stamp = time.time() - age * 3600
        os.utime(directory, (stamp, stamp))
        return directory

    def test_exports_keep_limit_grace_and_running(self):
        fresh_incomplete = self.make_job('b' * 32, complete=False, age=1)
        stale_incomplete = self.make_job('c' * 32, complete=False, age=48)
        running = self.make_job('d' * 32, complete=False, age=1)
        newest = self.make_job('a' * 32, age=1)
        middle = self.make_job('f' * 32, age=200)
        oldest = self.make_job('e' * 32, age=300)
        with patch('server.EXPORT_KEEP', 2), patch('server.JOBS', {'d' * 32: {'status': 'running'}}):
            self.assertGreater(cleanup_exports(), 0)
        self.assertTrue(fresh_incomplete.is_dir(), '半成品在宽限期内应保留')
        self.assertFalse(stale_incomplete.is_dir(), '过期半成品应删除')
        self.assertTrue(running.is_dir(), '制作中的任务目录不能删除')
        self.assertTrue(newest.is_dir() and middle.is_dir())
        self.assertFalse(oldest.is_dir(), '超出保留数量的旧成片应删除')

    def test_exports_capacity_cap_never_drops_newest(self):
        newest = self.make_job('a' * 32, size=4096)
        older = self.make_job('f' * 32, age=10, size=4096)
        with patch('server.EXPORT_MAX_BYTES', 100), patch('server.JOBS', {}):
            freed = cleanup_exports()
        self.assertTrue(newest.is_dir())
        self.assertFalse(older.is_dir())
        self.assertGreaterEqual(freed, 4096)

    def test_prune_keeps_only_deliverables(self):
        directory = self.make_job('a' * 32, size=10)
        for name in ('clip-000.mp4', 'frame-000-000.png', 'audio-000.wav', 'frames-000.txt', 'concat.txt'):
            (directory / name).write_bytes(b'x')
        # 成品包的每一项都必须留在保留名单里，否则会被 prune 立刻删掉。
        for name in ('subtitles.srt', 'script.txt', 'poster.png', 'share.txt', 'project.json', 'render.log'):
            (directory / name).write_text('x', encoding='utf-8')
        prune_export_intermediates(directory)
        self.assertEqual({f.name for f in directory.iterdir()},
                         {'video.mp4', 'subtitles.srt', 'script.txt', 'poster.png', 'share.txt',
                          'project.json', 'render.log'})

    def test_gc_files_deletes_named_paths_and_skips_running(self):
        assets = Path(self.tmp.name) / 'assets'
        assets.mkdir()
        (assets / ('a' * 32 + '.png')).write_bytes(b'png')
        finished = self.make_job('f' * 32)
        running = self.make_job('e' * 32, complete=False, age=1)
        jobs = {'e' * 32: {'status': 'running'}}
        with patch('server.ASSETS', assets), patch('server.JOBS', jobs):
            result = gc_files(['a' * 32, 'b' * 32], ['f' * 32, 'e' * 32])
            self.assertEqual(result['deleted'], {'assets': 1, 'exports': 1})
            self.assertEqual(result['skipped'], {'assets': 0, 'exports': 1})
            for assets_value, exports_value in [(['../server'], []), ([], ['a' * 31]), ([None], [])]:
                with self.assertRaises(ValidationError):
                    gc_files(assets_value, exports_value)
        self.assertFalse((assets / ('a' * 32 + '.png')).exists())
        self.assertFalse(finished.exists())
        self.assertTrue(running.is_dir())

    def test_trim_by_mtime_removes_oldest_first(self):
        base = Path(self.tmp.name) / 'previews'
        base.mkdir()
        directories = []
        for name, age in [('old', 1000), ('mid', 500), ('new', 0)]:
            directory = base / name
            directory.mkdir()
            (directory / 'meta.json').write_bytes(b'x' * 1000)
            stamp = time.time() - age
            os.utime(directory, (stamp, stamp))
            directories.append(directory)
        self.assertEqual(trim_by_mtime(base, 2500), 1000)
        self.assertFalse(directories[0].exists())
        self.assertTrue(directories[1].is_dir() and directories[2].is_dir())
        audio_base = Path(self.tmp.name) / 'auditions'
        audio_base.mkdir()
        for name, age in [('a.wav', 1000), ('b.wav', 0)]:
            file = audio_base / name
            file.write_bytes(b'x' * 900)
            stamp = time.time() - age
            os.utime(file, (stamp, stamp))
        self.assertEqual(trim_by_mtime(audio_base, 900), 900)
        self.assertFalse((audio_base / 'a.wav').exists())
        self.assertTrue((audio_base / 'b.wav').is_file())

    def test_preview_cache_hit_touches_directory_for_lru(self):
        scene = make_draft('核实来电：陌生来电要核实，不要相信安全账户。')[0]
        project = {'title': '反诈', 'theme': 'warm', 'style': 'illustration', 'accessible': True, 'scenes': [scene]}
        with tempfile.TemporaryDirectory() as directory, patch('server.PREVIEWS', Path(directory)):
            scene_frames(project, 0)
            cached = next(Path(directory).iterdir())
            past = time.time() - 7200
            os.utime(cached, (past, past))
            meta = scene_frames(project, 0)
            self.assertTrue(meta['frames'])
            self.assertGreater(cached.stat().st_mtime, past + 60)


class StreamProcessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log = Path(self.tmp.name) / 'render.log'

    def test_progress_lines_report_and_persist_to_log(self):
        script = ('import time\n'
                  'for i in range(3):\n'
                  '    print(f"PROGRESS {i + 1}/3", flush=True)\n'
                  '    time.sleep(0.02)\n')
        calls = []
        run_streamed([sys.executable, '-c', script], self.log,
                     lambda done, total: calls.append((done, total)), stall=15)
        self.assertEqual(calls, [(1, 3), (2, 3), (3, 3)])
        self.assertIn(b'PROGRESS 3/3', self.log.read_bytes())

    def test_stall_kills_silent_process(self):
        script = 'import time; print("ready", flush=True); time.sleep(30)'
        with self.assertRaisesRegex(RuntimeError, '没有进展'):
            run_streamed([sys.executable, '-c', script], self.log, stall=0.5)
        self.assertIn(b'ready', self.log.read_bytes())

    def test_nonzero_exit_raises(self):
        with self.assertRaisesRegex(RuntimeError, '合成失败'):
            run_streamed([sys.executable, '-c', 'raise SystemExit(3)'], self.log, stall=15)


class SceneAudioTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.audio = Path(self.tmp.name) / 'auditions'
        patcher = patch('server.AUDITIONS', self.audio)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_ensure_caption_wavs_batches_missing_and_reuses_cache(self):
        calls = []

        def fake_streamed(command, log=None, on_progress=None, stall=120):
            data = json.loads(Path(command[-1]).read_text(encoding='utf-8'))
            calls.append([segment['text'] for segment in data['segments']])
            for segment in data['segments']:
                write_caption_wav(Path(segment['path']), 0.5)
            return 0

        items = [(text, caption_wav_path(text, -2)) for text in ('甲乙丙。', '丁戊己。', '甲乙丙。')]
        with patch('server.run_streamed', fake_streamed):
            ensure_caption_wavs(items, -2)
            ensure_caption_wavs(items, -2)
        self.assertEqual(calls, [['甲乙丙。', '丁戊己。']])
        leftovers = [p.name for p in self.audio.iterdir() if p.name.startswith('speech-')]
        self.assertEqual(leftovers, [])

    def test_scene_audio_pads_captions_to_export_lengths(self):
        captions = ['第一条字幕内容。', '第二条字幕内容。']
        calls = []

        def fake_ensure(items, rate, log=None, on_progress=None):
            calls.append([text for text, _ in items])
            for number, (_, path) in enumerate(items):
                write_caption_wav(path, 1.0 + number)

        with patch('server.split_captions', lambda narration, accessible: list(captions)), \
                patch('server.ensure_caption_wavs', fake_ensure):
            media = scene_audio('整段配音文字', True)
            self.assertEqual(calls, [captions])
            self.assertEqual(media['captions'], captions)
            self.assertEqual(media['segments'], [quantized_duration(1.0), quantized_duration(2.0)])
            self.assertEqual(media['duration'], round(sum(media['segments']), 2))
            with wave.open(str(self.audio / f"{media['key']}.wav"), 'rb') as audio:
                self.assertEqual(audio.getnframes(),
                                 sum(int(round(duration * 22050)) for duration in media['segments']))
        with patch('server.split_captions', lambda narration, accessible: list(captions)), \
                patch('server.ensure_caption_wavs', lambda *a, **k: self.fail('cache hit must not resynthesize')):
            again = scene_audio('整段配音文字', True)
        self.assertEqual(again['key'], media['key'])
        self.assertEqual(again['segments'], media['segments'])

    def test_scene_audio_rejects_empty_captions(self):
        with patch('server.split_captions', lambda narration, accessible: []):
            with self.assertRaises(ValidationError):
                scene_audio('空', True)


class PreviewCacheTests(unittest.TestCase):
    def setUp(self):
        patcher = patch('server.scene_audio', stub_scene_audio)
        patcher.start()
        self.addCleanup(patcher.stop)

    def project(self, narration='核实来电：陌生来电要核实，不要相信安全账户。'):
        scene = make_draft(narration)[0]
        return {'title': '反诈', 'theme': 'warm', 'style': 'illustration', 'accessible': True, 'scenes': [scene]}, scene

    def test_reviewed_and_source_do_not_rebuild(self):
        project, scene = self.project()
        with tempfile.TemporaryDirectory() as directory, patch('server.PREVIEWS', Path(directory)):
            first = scene_frames(project, 0)
            before = {p.name for p in Path(directory).iterdir()}
            scene['reviewed'] = True
            scene['source'] = '换成另一段原资料，画面内容一个字都没变。'
            scene['id'] = '9'
            second = scene_frames(project, 0)
            self.assertEqual({p.name for p in Path(directory).iterdir()}, before)
            self.assertEqual(second['frames'], first['frames'])

    def test_index_and_narration_changes_rebuild(self):
        project, scene = self.project()
        with tempfile.TemporaryDirectory() as directory, patch('server.PREVIEWS', Path(directory)):
            scene_frames(project, 0)
            before = {p.name for p in Path(directory).iterdir()}
            project['scenes'] = [dict(scene, title='另一幕'), scene]
            scene_frames(project, 1)
            after = {p.name for p in Path(directory).iterdir()}
            self.assertEqual(len(after - before), 1)
            scene['narration'] = '转账前请务必通过官方渠道核实对方身份。'
            scene_frames(project, 1)
            self.assertEqual(len({p.name for p in Path(directory).iterdir()} - after), 1)

    def test_parallel_requests_render_once(self):
        project, _ = self.project()
        original = draw_frame
        calls = []

        def counting(*args, **kwargs):
            calls.append(threading.get_ident())
            return original(*args, **kwargs)

        with tempfile.TemporaryDirectory() as directory, patch('server.PREVIEWS', Path(directory)), \
                patch('server.draw_frame', counting):
            barrier = threading.Barrier(4)
            results = []

            def worker():
                barrier.wait()
                results.append(scene_frames(project, 0))

            threads = [threading.Thread(target=worker) for _ in range(4)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        self.assertEqual(len(results), 4)
        self.assertEqual(len({json.dumps(meta, sort_keys=True) for meta in results}), 1)
        self.assertEqual(len(calls), len(results[0]['frames']))

    def test_missing_frame_triggers_rebuild(self):
        project, _ = self.project()
        with tempfile.TemporaryDirectory() as directory, patch('server.PREVIEWS', Path(directory)):
            meta = scene_frames(project, 0)
            cached = next(Path(directory).iterdir())
            victim = cached / meta['frames'][0]['url'].rsplit('/', 1)[-1]
            victim.unlink()
            rebuilt = scene_frames(project, 0)
            self.assertTrue(victim.is_file())
            self.assertEqual(rebuilt['frames'], meta['frames'])

    def test_frames_follow_audio_segments(self):
        project, _ = self.project()
        fake = {'key': 'a' * 40, 'url': '/auditions/' + 'a' * 40 + '.wav', 'duration': 6.0,
                'captions': ['第一段字幕。', '第二段字幕。'], 'segments': [2.0, 4.0]}
        changed = {**fake, 'segments': [3.0, 3.0]}
        with tempfile.TemporaryDirectory() as directory, patch('server.PREVIEWS', Path(directory)):
            with patch('server.scene_audio', lambda narration, accessible: fake):
                meta = scene_frames(project, 0)
            self.assertEqual(meta['audio'], fake['url'])
            self.assertEqual(meta['duration'], 6.0)
            self.assertIn(0.3333, [frame['at'] for frame in meta['frames']])
            before = {p.name for p in Path(directory).iterdir()}
            with patch('server.scene_audio', lambda narration, accessible: changed):
                rebuilt = scene_frames(project, 0)
            self.assertEqual(len({p.name for p in Path(directory).iterdir()} - before), 1)
            self.assertIn(0.5, [frame['at'] for frame in rebuilt['frames']])

    def test_reap_jobs_keeps_running_and_recent(self):
        ids = [f'{index:032x}' for index in range(25)]
        jobs = {job_id: {'status': 'running' if index == 0 else 'completed'} for index, job_id in enumerate(ids)}
        with patch('server.JOBS', jobs):
            reap_jobs(keep=20)
            self.assertEqual(len(jobs), 21)
            self.assertEqual(jobs[ids[0]]['status'], 'running')
            self.assertNotIn(ids[4], jobs)
            self.assertIn(ids[5], jobs)
            self.assertIn(ids[24], jobs)


class ExportPackageTests(unittest.TestCase):
    """成品包的发布文案要能直接贴出去：要点、出处、话题、落款缺一不可。"""

    def project(self, source_info=None):
        source = '刷单返利是陷阱：陌生人邀请你点赞、刷单，承诺轻松赚钱。\n\n转账之前先核实：收到借钱消息，先联系本人核实。'
        data = {'title': '守住钱袋子 · 社区反诈提醒', 'scenes': make_draft(source)}
        if source_info is not None:
            data['sourceInfo'] = source_info
        return validate_project(data)

    def test_share_text_has_points_source_and_signature(self):
        info = {'name': '资料来源：公安部刑侦局《2026版防范电信网络诈骗宣传手册》',
                'url': 'https://mp.weixin.qq.com/s/example', 'publishedAt': '2026版（2026-11-25 访问）'}
        text = build_share_text(self.project(info), 42)
        self.assertTrue(text.startswith('守住钱袋子 · 社区反诈提醒\n\n【本期要点】\n· 刷单返利是陷阱'))
        self.assertIn('【记住一句话】\n转账之前先核实', text)
        self.assertNotIn('资料来源：资料来源：', text)
        self.assertIn('资料来源：公安部刑侦局《2026版防范电信网络诈骗宣传手册》', text)
        self.assertIn('资料日期：2026版（2026-11-25 访问）', text)
        self.assertIn('原文链接：https://mp.weixin.qq.com/s/example', text)
        self.assertIn('时长约 42 秒', text)
        self.assertIn('#全民反诈 #守住钱袋子 #社区科普', text)
        self.assertTrue(text.rstrip().endswith('—— 地球村 · 反诈宣传'))

    def test_share_text_without_source_keeps_topics(self):
        text = build_share_text(self.project())
        self.assertNotIn('资料来源', text)
        self.assertNotIn('时长约', text)
        self.assertIn('#全民反诈', text)

    def test_share_points_are_clipped_to_one_line(self):
        source = '重点提醒：' + '很' * 50 + '。第二段内容写在这里。'
        text = build_share_text(validate_project({'title': '长句测试', 'scenes': make_draft(source)}))
        point = next(line for line in text.splitlines() if line.startswith('· '))
        self.assertTrue(point.endswith('…'))
        self.assertLessEqual(len(point), 50)


class ReportTests(unittest.TestCase):
    """产出记录只增不减：删掉成片，累计数字也不能倒退。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.exports = Path(self.tmp.name) / 'exports'
        self.exports.mkdir()
        patcher = patch('server.EXPORTS', self.exports)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.project = validate_project({'title': '守住钱袋子 · 社区反诈提醒', 'style': 'illustration',
                                         'sourceInfo': {'name': '资料来源：公安部《20个防诈关键词》'},
                                         'scenes': make_draft('验证码不外传：不要将短信验证码告诉任何陌生人。')})
        self.noir_project = validate_project({'title': '夜色那一支', 'style': 'noir',
                                              'sourceInfo': {'name': '资料来源：公安部《20个防诈关键词》'},
                                              'scenes': make_draft('验证码不外传：不要将短信验证码告诉任何陌生人。', 'noir')})

    def test_ledger_accumulates_after_cleanup(self):
        record_ledger(self.project, 'a' * 32, 61.0, 2048)
        record_ledger(self.noir_project, 'b' * 32, 59.0, 1024)
        with patch('server.EXPORT_KEEP', 0), patch('server.JOBS', {}):
            cleanup_exports()
        self.assertTrue((self.exports / 'ledger.json').is_file(), '账本不能被清理逻辑删掉')
        stats = report_stats()
        self.assertEqual(stats['clips'], 2)
        self.assertEqual(stats['projects'], 2)
        self.assertEqual(stats['minutes'], 2.0)
        self.assertEqual(stats['bytes'], 3072)
        self.assertEqual(stats['withSource'], 2)
        self.assertEqual(stats['styles'], {'illustration': 1, 'noir': 1})
        self.assertEqual(len(stats['week']), 7)
        self.assertEqual(stats['week'][-1]['count'], 2)
        self.assertEqual([row['title'] for row in stats['latest']], ['夜色那一支', '守住钱袋子 · 社区反诈提醒'])

    def test_broken_ledger_is_ignored_instead_of_crashing(self):
        (self.exports / 'ledger.json').write_text('{ 半截', encoding='utf-8')
        self.assertEqual(load_ledger(), [])
        self.assertEqual(report_stats()['clips'], 0)
        record_ledger(self.project, 'c' * 32, 30.0, 512)
        self.assertEqual(report_stats()['clips'], 1)

    def test_ledger_keeps_only_recent_entries(self):
        with patch('server.LEDGER_KEEP', 3):
            for index in range(5):
                record_ledger({**self.project, 'title': f'第 {index} 支'}, f'{index:032x}', 10.0, 100)
        self.assertEqual([row['title'] for row in load_ledger()], ['第 2 支', '第 3 支', '第 4 支'])


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, path, body=None, headers=None):
        connection = HTTPConnection('127.0.0.1', self.server.server_port)
        base = {'Content-Type': 'application/json', 'X-Zhiying-Local': '1'}
        base.update(headers or {})
        connection.request('POST' if body is not None else 'GET', path, json.dumps(body) if body is not None else None, base)
        response = connection.getresponse()
        result = response.status, response.getheaders(), response.read()
        connection.close()
        return result

    def test_home_and_security_headers(self):
        status, headers, body = self.request('/')
        self.assertEqual(status, 200)
        self.assertIn('Content-Security-Policy', dict(headers))
        self.assertIn('知映'.encode(), body)

    def test_private_files_are_not_served(self):
        for path in ['/../server.py', '/server.py', '/exports/test/project.json', '/files/../../server.py']:
            self.assertEqual(self.request(path)[0], 404)

    def test_template_catalog_is_served_from_static_whitelist(self):
        status, headers, body = self.request('/templates.json')
        self.assertEqual(status, 200)
        self.assertIn('application/json', dict(headers)['Content-Type'])
        self.assertEqual(len(json.loads(body)['templates']), 12)

    def test_report_routes_serve_stats_and_card(self):
        status, headers, body = self.request('/api/report')
        self.assertEqual(status, 200)
        self.assertEqual(dict(headers)['Content-Type'], 'application/json; charset=utf-8')
        stats = json.loads(body)
        for key in ('clips', 'projects', 'minutes', 'bytes', 'withSource', 'styles', 'week', 'latest'):
            self.assertIn(key, stats)
        self.assertEqual(len(stats['week']), 7)
        status, headers, body = self.request('/api/report/card.png')
        self.assertEqual(status, 200)
        self.assertEqual(dict(headers)['Content-Type'], 'image/png')
        self.assertEqual(Image.open(io.BytesIO(body)).size, (1080, 1350))

    def test_finished_package_files_are_served(self):
        job_id = 'a' * 32
        with tempfile.TemporaryDirectory() as directory, patch('server.EXPORTS', Path(directory)):
            target = Path(directory) / job_id
            target.mkdir()
            Image.new('RGB', (32, 32), 'white').save(target / 'poster.png', format='PNG')
            (target / 'share.txt').write_text('守住钱袋子 · 发布文案', encoding='utf-8')
            status, headers, _ = self.request(f'/files/{job_id}/poster.png')
            self.assertEqual(status, 200)
            self.assertEqual(dict(headers)['Content-Type'], 'image/png')
            self.assertNotIn('Content-Disposition', dict(headers))
            status, headers, body = self.request(f'/files/{job_id}/share.txt')
            self.assertEqual(status, 200)
            self.assertIn('attachment', dict(headers)['Content-Disposition'])
            self.assertIn('发布文案'.encode(), body)
            self.assertEqual(self.request(f'/files/{job_id}/clip-000.mp4')[0], 404)

    def test_external_origin_and_host_are_rejected(self):
        self.assertEqual(self.request('/api/draft', {}, {'Origin': 'https://example.invalid'})[0], 403)
        self.assertEqual(self.request('/api/draft', {}, {'X-Zhiying-Local': ''})[0], 403)
        self.assertEqual(self.request('/', headers={'Host': 'example.invalid'})[0], 403)

    def test_invalid_input_and_unreviewed_export(self):
        self.assertEqual(self.request('/api/draft', {'source': ''})[0], 400)
        self.assertEqual(self.request('/api/draft', [1, 2])[0], 400)
        project = {'title': '测试', 'scenes': make_draft('验证码不外传：不要将短信验证码告诉任何陌生人。')}
        self.assertEqual(self.request('/api/export', project)[0], 400)

    def test_asset_import_and_private_paths(self):
        with tempfile.TemporaryDirectory() as directory, patch('server.ASSETS', Path(directory)):
            buffer = io.BytesIO()
            Image.new('RGB', (64, 64), 'green').save(buffer, format='PNG')
            encoded = base64.b64encode(buffer.getvalue()).decode()
            status, _, body = self.request('/api/assets', {'image': encoded})
            self.assertEqual(status, 201)
            asset = json.loads(body)
            status, headers, raw = self.request(f'/assets/{asset["id"]}.png')
            self.assertEqual(status, 200)
            self.assertEqual(dict(headers)['Content-Type'], 'image/png')
            self.assertEqual(Image.open(io.BytesIO(raw)).size, (64, 64))
            self.assertEqual(self.request('/assets/../server.py')[0], 404)
            self.assertEqual(self.request('/api/assets', {'image': encoded}, {'Origin': 'https://example.invalid'})[0], 403)

    def test_bad_image_endpoint_rejects_without_writing(self):
        with tempfile.TemporaryDirectory() as directory, patch('server.ASSETS', Path(directory)):
            for data in [{'image': 'invalid'}, {'image': None}, {'image': base64.b64encode(b'<svg/>').decode()}]:
                self.assertEqual(self.request('/api/assets', data)[0], 400)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_draft_and_real_preview(self):
        status, _, body = self.request('/api/draft', {'source': '验证码不外传：不要将短信验证码告诉任何陌生人。'})
        self.assertEqual(status, 200)
        project = {'title': '反诈宣传', 'scenes': json.loads(body)['scenes']}
        status, headers, body = self.request('/api/preview', project)
        self.assertEqual(status, 200)
        self.assertEqual(dict(headers)['Content-Type'], 'image/png')
        self.assertTrue(body.startswith(b'\x89PNG'))
        self.assertEqual(self.request('/api/preview', {**project, 'index': -1})[0], 400)

    def test_usage_gc_and_cleanup_routes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch('server.EXPORTS', root / 'exports'), patch('server.PREVIEWS', root / 'previews'), \
                 patch('server.AUDITIONS', root / 'auditions'), patch('server.ASSETS', root / 'assets'):
                status, _, body = self.request('/api/usage')
                self.assertEqual(status, 200)
                usage = json.loads(body)
                self.assertEqual(set(usage), {'exports', 'previews', 'auditions', 'assets'})
                self.assertEqual(usage['exports'], {'bytes': 0, 'files': 0, 'completed': 0})
                self.assertEqual(self.request('/api/gc', {'assets': ['bad']})[0], 400)
                self.assertEqual(self.request('/api/gc', {'assets': {'a': 1}})[0], 400)
                status, _, body = self.request('/api/gc', {'assets': ['a' * 32], 'exports': []})
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body)['deleted'], {'assets': 0, 'exports': 0})
                status, _, body = self.request('/api/cleanup', {})
                self.assertEqual(status, 200)
                result = json.loads(body)
                self.assertEqual(result['freed'], 0)
                self.assertEqual(set(result['usage']), {'exports', 'previews', 'auditions', 'assets'})

    def test_gc_route_requires_local_headers(self):
        self.assertEqual(self.request('/api/gc', {'assets': []}, {'X-Zhiying-Local': ''})[0], 403)


TEMPLATES_FILE = Path(__file__).resolve().parents[1] / 'static' / 'templates.json'


class TemplateLibraryTests(unittest.TestCase):
    """内置模板必须可溯源，并且能直接交给 make_draft 使用。"""

    @classmethod
    def setUpClass(cls):
        cls.catalog = json.loads(TEMPLATES_FILE.read_text(encoding='utf-8'))
        cls.templates = cls.catalog['templates']

    def test_sources_are_official_and_complete(self):
        self.assertEqual(set(self.catalog['sources']), {'handbook', 'keywords'})
        for kind, source in self.catalog['sources'].items():
            with self.subTest(kind=kind):
                self.assertTrue(source['note'].startswith('资料来源：'))
                self.assertRegex(source['date'], r'^\d{4}')
                self.assertRegex(source['url'], r'^https://(mp\.weixin\.qq\.com|www\.mps\.gov\.cn)/\S+$')

    def test_ten_handbook_cases_cover_official_shares(self):
        handbook = [item for item in self.templates if item['sourceKind'] == 'handbook']
        self.assertEqual(len(handbook), 10)
        shares = [item['share'] for item in handbook]
        self.assertEqual(shares, sorted(shares, reverse=True))
        self.assertAlmostEqual(sum(shares), 89.3, places=1)
        self.assertEqual(len({item['id'] for item in self.templates}), len(self.templates))
        for item in self.templates:
            with self.subTest(template=item['id']):
                self.assertRegex(item['id'], r'^[a-z]{2,20}$')
                self.assertIn(item['sourceKind'], self.catalog['sources'])
                self.assertIn(item['style'], STYLES)
                self.assertIn(item['theme'], THEMES)
                self.assertTrue(0 < len(item['title']) <= 40)
                self.assertTrue(item['tagline'].strip())
                self.assertTrue(item['audience'].strip())
                if item['sourceKind'] == 'handbook':
                    self.assertIsInstance(item['share'], float)
                else:
                    self.assertIsNone(item['share'])

    def test_audience_shares_add_up_to_one_hundred(self):
        # 人口占比抄错一个字就会误导选题，所以逐个校验到 0.1。
        for item in self.templates:
            with self.subTest(template=item['id']):
                if item['gender'] is None or item['age'] is None:
                    self.assertIsNone(item['gender'])
                    self.assertIsNone(item['age'])
                    continue
                self.assertAlmostEqual(item['gender']['female'] + item['gender']['male'], 100.0, places=1)
                self.assertAlmostEqual(item['age']['under18'] + item['age']['adult'] + item['age']['over60'], 100.0, places=1)

    def test_keywords_match_body_and_caption_limit(self):
        for item in self.templates:
            with self.subTest(template=item['id']):
                self.assertTrue(1 <= len(item['keywords']) <= 3)
                for word in item['keywords']:
                    self.assertTrue(1 <= len(word) <= 12)
                    self.assertIn(word, item['source'])

    def test_keywords_stay_inside_a_single_scene(self):
        # 页面只在本幕配音里找关键词；被分镜切断就自动标不红。
        for item in self.templates:
            with self.subTest(template=item['id']):
                narrations = [scene['narration'] for scene in make_draft(item['source'], item['style'])]
                for word in item['keywords']:
                    self.assertTrue(any(word in text for text in narrations), f'{word} 被切断到两幕')

    def test_every_template_becomes_a_reviewable_project(self):
        for item in self.templates:
            with self.subTest(template=item['id']):
                scenes = make_draft(item['source'], item['style'])
                self.assertTrue(1 <= len(scenes) <= 8)
                self.assertTrue(all(0 < len(scene['title']) <= 24 for scene in scenes))
                self.assertTrue(all(0 < len(scene['narration']) <= 300 for scene in scenes))
                # 原文一字不丢：成片配音拼接后必须等于模板正文（忽略空白）。
                joined = ''.join(scene['narration'] for scene in scenes)
                self.assertEqual(re.sub(r'\s+', '', joined), re.sub(r'\s+', '', item['source']))
                project = validate_project({'title': item['title'], 'theme': item['theme'], 'style': item['style'],
                                            'accessible': True, 'scenes': scenes})
                self.assertEqual(len(project['scenes']), len(scenes))

    def test_project_source_info_is_kept_for_export(self):
        scenes = make_draft('验证码不外传：不要将短信验证码告诉任何陌生人。')
        project = {'title': '反诈宣传', 'scenes': scenes}
        self.assertEqual(validate_project(project)['sourceInfo'], {'name': '', 'url': '', 'publishedAt': ''})
        info = {'name': '资料来源：公安部刑侦局《2026版防范电信网络诈骗宣传手册》· 十大高发类案',
                'url': 'https://mp.weixin.qq.com/s/bgOH2ceJ0rUWQX2_z9grlA', 'publishedAt': '2026版（2026-11-25 访问）'}
        self.assertEqual(validate_project({**project, 'sourceInfo': info})['sourceInfo'], info)
        for bad in ['javascript:alert(1)', 'file:///c:/secret', 'https://a b', ['https://www.mps.gov.cn/']]:
            with self.subTest(sourceInfo=bad), self.assertRaises(ValidationError):
                validate_project({**project, 'sourceInfo': bad})


if __name__ == '__main__':
    unittest.main(verbosity=2)
