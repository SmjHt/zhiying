import base64
import io
import json
import re
import tempfile
import sys
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rendering import (SCENE_KINDS, animation_times, draw_frame, font, phase_starts, preview_png,
                       split_captions, wrap_text)
from server import (Handler, ThreadingHTTPServer, ValidationError, make_draft, scene_frames, store_image,
                    suggest_visual, timestamp, validate_project, validate_visual)


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


if __name__ == '__main__':
    unittest.main(verbosity=2)
