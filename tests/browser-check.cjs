const { chromium } = require('D:/Users/smjht/xiangmu/tianchi/.tools/browser-check/node_modules/playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const shots = path.resolve(root, '../截图');
const origin = 'http://127.0.0.1:8765';
const checks = [];
const check = (label) => { checks.push(label); console.log(`PASS ${label}`); };

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    const external = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', (request) => { if (!request.url().startsWith(origin) && !request.url().startsWith('blob:') && !request.url().startsWith('data:')) external.push(request.url()); });
    await page.goto(origin);
    await page.waitForFunction(() => document.getElementById('preview-image').naturalWidth === 1280);
    await page.screenshot({ path: path.join(shots, '知映-v03-01-本地工作台.png'), fullPage: true });
    assert.equal(await page.locator('#step-2').isDisabled(), true);
    await page.locator('#generate-button').click();
    await page.getByRole('alert').filter({ hasText: '至少 20 字' }).waitFor();
    check('Empty input is rejected; later steps are locked');

    await page.locator('#help-open').click();
    assert.equal(await page.locator('#help-dialog').isVisible(), true);
    await page.locator('#help-close').click();
    check('Usage guide opens and closes');

    for (const theme of ['teal', 'bold', 'warm']) {
      const oldImage = await page.locator('#preview-image').getAttribute('src');
      await page.locator(`[data-theme="${theme}"]`).click();
      await page.waitForFunction((previous) => document.getElementById('preview-image').src !== previous, oldImage);
      assert.equal(await page.locator(`[data-theme="${theme}"]`).getAttribute('aria-pressed'), 'true');
    }
    await page.locator('#accessible-mode').uncheck({ force: true });
    assert.equal(await page.locator('#voice-label').textContent(), '标准中文配音');
    await page.locator('#accessible-mode').check({ force: true });
    check('All three themes and accessible voice setting work');

    await page.locator('#sample-button').click();
    assert.match(await page.locator('#source-input').inputValue(), /验证码/);
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#story-button').click();
    assert.match(await page.locator('#source-input').inputValue(), /收到一条刷单消息/);
    await page.screenshot({ path: path.join(shots, '知映-v03-02-反诈资料.png'), fullPage: true });
    await page.locator('#generate-button').click();
    await page.locator('#panel-2').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.scene-item').count(), 5);
    await page.locator('#to-export').click();
    assert.equal(await page.locator('#export-button').isDisabled(), true);
    await page.locator('#back-scenes').click();
    check('Example creates five scenes; unreviewed scenes block export');

    await page.locator('#scene-reviewed').check();
    const narration = await page.locator('#scene-narration').inputValue();
    await page.locator('#scene-narration').fill(narration + '请先核实。');
    assert.equal(await page.locator('#scene-reviewed').isChecked(), false);
    await page.locator('#scene-narration').fill('');
    await page.locator('#scene-reviewed').check().catch(() => {});
    assert.equal(await page.locator('#scene-reviewed').isChecked(), false);
    await page.locator('#scene-narration').fill(narration);
    check('Editing invalidates review; empty narration cannot be approved');

    const waitPreview = () => page.waitForFunction(() => {
      const screen = document.querySelector('.preview-screen');
      const image = document.getElementById('preview-image');
      return !screen.classList.contains('loading') && !screen.classList.contains('invalid') && image.complete && image.naturalWidth === 1280;
    });
    const draftValue = () => page.evaluate(() => JSON.parse(localStorage.getItem('zhiying-local-draft-v1')));
    assert.deepEqual((await draftValue()).scenes.map((scene) => scene.visual.kind), ['message', 'transfer', 'transfer', 'verify', 'help']);
    await page.locator('#tab-visual').click();
    const scenarioFrames = new Set();
    for (const kind of ['message', 'call', 'transfer', 'verify', 'help', 'tip']) {
      await page.locator(`[data-kind="${kind}"]`).click();
      await waitPreview();
      assert.equal(await page.locator(`[data-kind="${kind}"]`).getAttribute('aria-pressed'), 'true');
      const pixels = await page.locator('#preview-image').evaluate((image) => {
        const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
        canvas.getContext('2d').drawImage(image, 0, 0);
        return canvas.toDataURL();
      });
      scenarioFrames.add(pixels);
    }
    assert.equal(scenarioFrames.size, 6);
    await page.locator('[data-kind="message"]').click();
    await page.locator('#scene-reviewed').check();
    await page.locator('#visual-text').fill('陌生消息：点赞就能赚钱？先核实！');
    assert.equal(await page.locator('#scene-reviewed').isChecked(), false);
    await waitPreview();
    check('Six distinct scenarios render; visual text edits reset review');
    await page.locator('#visual-text').scrollIntoViewIfNeeded();
    const previewPosition = await page.locator('.preview-inner').boundingBox();
    assert(previewPosition.y >= 20 && previewPosition.y < 100, `Preview should stay visible while editing, y=${previewPosition.y}`);
    check('Desktop preview stays visible while scrolling the visual editor');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(shots, '知映-v03-06-情景画面编辑.png'), fullPage: true });

    const originalTitle = (await draftValue()).scenes[0].title;
    await page.locator('#scene-reviewed').check();
    await page.locator('#move-later').click();
    assert.equal((await draftValue()).scenes[1].title, originalTitle);
    assert.equal((await draftValue()).scenes.filter((scene) => scene.reviewed).length, 0);
    await page.locator('#move-earlier').click();
    assert.equal((await draftValue()).scenes[0].title, originalTitle);
    assert.equal(await page.locator('#move-earlier').isDisabled(), true);
    check('Scene reorder preserves content and invalidates all reviews');

    await page.locator('.scene-item').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.timeline-card').length === 5);
    await page.waitForFunction(() => [...document.querySelectorAll('.timeline-thumb')].every((img) => img.complete && img.naturalWidth === 1280));
    assert.equal(await page.locator('.timeline-card').count(), 5);
    check('Visual timeline shows five scene thumbnails');

    const orderTitles = () => page.evaluate(() => JSON.parse(localStorage.getItem('zhiying-local-draft-v1')).scenes.map((s) => s.title));
    const beforeDrag = await orderTitles();
    await page.locator('.timeline-card').first().focus();
    await page.keyboard.press('ArrowRight');
    assert.equal((await orderTitles())[1], beforeDrag[0]);
    await page.locator('.timeline-card').nth(1).focus();
    await page.keyboard.press('ArrowLeft');
    assert.deepEqual(await orderTitles(), beforeDrag);
    await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.timeline-card')];
      const dt = new DataTransfer();
      cards[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      cards[2].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      cards[2].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      cards[0].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    });
    assert.equal((await orderTitles())[2], beforeDrag[0]);
    assert.equal((await draftValue()).scenes.filter((s) => s.reviewed).length, 0);
    await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.timeline-card')];
      const dt = new DataTransfer();
      cards[2].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      cards[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      cards[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      cards[2].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    });
    assert.deepEqual(await orderTitles(), beforeDrag);
    check('Timeline drag and keyboard reorder preserve content and reset reviews');

    await page.locator('.scene-item').first().click();
    await page.locator('#audition-scene').click();
    await page.locator('#playback-badge').waitFor({ state: 'visible' });
    await page.waitForFunction(() => { const a = document.getElementById('scene-audio'); return a.currentTime > 0.3 && a.src.includes('/auditions/'); });
    await page.waitForFunction(() => document.getElementById('preview-image').src.includes('/previews/'));
    await page.locator('#audition-scene').click();
    await page.waitForFunction(() => document.getElementById('playback-badge').hidden);
    check('Per-scene offline audition plays audio and animates frames');

    await page.locator('#play-preview').click();
    await page.locator('#playback-badge').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('preview-image').src.includes('/previews/'));
    const firstFrame = await page.locator('#preview-image').getAttribute('src');
    await page.waitForFunction((previous) => { const img = document.getElementById('preview-image'); return img.src.includes('/previews/') && img.src !== previous; }, firstFrame);
    await page.waitForFunction(() => /02 \/ 05/.test(document.getElementById('preview-position').textContent), { timeout: 30000 });
    await page.screenshot({ path: path.join(shots, '知映-v03-10-连续预览.png'), fullPage: true });
    await page.locator('#play-preview').click();
    await page.waitForFunction(() => document.getElementById('playback-badge').hidden);
    await page.locator('.scene-item').first().click();
    check('Continuous preview animates frames and advances across scenes');

    await page.locator('.scene-item').nth(2).click();
    await page.locator('#local-image').setInputFiles({ name: 'blocked.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
    await page.getByRole('alert').filter({ hasText: '不支持 SVG' }).waitFor();
    assert.equal((await draftValue()).scenes[2].visual.imageId, null);
    await page.locator('#local-image').setInputFiles({ name: 'too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(4 * 1024 * 1024 + 1) });
    await page.getByRole('alert').filter({ hasText: '不能超过 4 MB' }).waitFor();
    check('Unsupported and oversized image selections are rejected without changing the scene');

    const imageData = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 240;
      const context = canvas.getContext('2d');
      context.fillStyle = '#af654d'; context.fillRect(0, 0, 600, 240);
      context.fillStyle = '#265344'; context.fillRect(600, 0, 600, 240);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const imageFile = { name: '本地取景测试.png', mimeType: 'image/png', buffer: Buffer.from(imageData, 'base64') };
    await page.locator('#local-image').setInputFiles(imageFile);
    await page.waitForFunction(() => document.getElementById('asset-thumbnail').naturalWidth > 0 && !document.getElementById('choose-image').disabled);
    await waitPreview();
    const firstImageId = (await draftValue()).scenes[2].visual.imageId;
    assert.match(firstImageId, /^[a-f0-9]{32}$/);
    const setRange = async (id, value) => {
      await page.locator(id).evaluate((input, next) => { input.value = next; input.dispatchEvent(new Event('input', { bubbles: true })); }, String(value));
      await waitPreview();
    };
    const centerPixel = () => page.locator('#preview-image').evaluate((image) => {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(900, 300, 1, 1).data).slice(0, 3);
    });
    await setRange('#image-focus-x', 0);
    assert.deepEqual(await centerPixel(), [175, 101, 77]);
    await setRange('#image-focus-x', 100);
    assert.deepEqual(await centerPixel(), [38, 83, 68]);
    await page.locator('[name=image-fit][value=contain]').check();
    await waitPreview();
    assert.equal(await page.locator('#crop-controls').isVisible(), false);
    await page.locator('[name=image-fit][value=cover]').check();
    await page.locator('#center-image').click();
    assert.equal((await draftValue()).scenes[2].visual.focusX, 50);
    await page.reload();
    await page.locator('#tab-visual').click();
    await page.waitForFunction(() => document.getElementById('asset-thumbnail').naturalWidth > 0);
    assert.equal((await draftValue()).scenes[2].visual.imageId, firstImageId);
    await page.locator('#remove-image').click();
    await waitPreview();
    assert.equal((await draftValue()).scenes[2].visual.imageId, null);
    assert.equal(await page.locator('#asset-thumbnail').isVisible(), false);
    check('Local images import, crop, fit, persist across reload and restore to illustration');

    const poster = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 600;
      const context = canvas.getContext('2d');
      context.fillStyle = '#204c40'; context.fillRect(0, 0, 960, 600);
      context.fillStyle = '#a6c5a7'; context.beginPath(); context.arc(850, 80, 240, 0, Math.PI * 2); context.fill();
      context.fillStyle = '#faf4df'; context.font = 'bold 66px Microsoft YaHei'; context.fillText('先核实，再行动', 58, 250);
      context.font = '30px Microsoft YaHei'; context.fillText('不轻信 / 不透露 / 不转账', 63, 327);
      context.font = '23px Microsoft YaHei'; context.fillText('社区反诈宣传 · 本地演示素材', 63, 530);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.locator('#local-image').setInputFiles({ name: '社区反诈演示.png', mimeType: 'image/png', buffer: Buffer.from(poster, 'base64') });
    await page.waitForFunction(() => document.getElementById('asset-thumbnail').naturalWidth === 960 && !document.getElementById('choose-image').disabled);
    await page.locator('[name=image-fit][value=contain]').check();
    await page.locator('#visual-text').fill('给自己留一点时间，核实后再决定。');
    await waitPreview();
    const secondImageId = (await draftValue()).scenes[2].visual.imageId;
    assert.notEqual(secondImageId, firstImageId);
    await page.screenshot({ path: path.join(shots, '知映-v03-07-本机图片编辑.png'), fullPage: true });
    check('Replacement local picture and caption render correctly without external requests');
    await page.locator('#tab-script').click();

    for (let index = 0; index < 5; index++) {
      await page.locator('.scene-item').nth(index).click();
      await page.locator('#scene-reviewed').check();
    }
    assert.match(await page.locator('#review-count').textContent(), /5 \/ 5/);
    await page.locator('.scene-item').first().click();
    await page.screenshot({ path: path.join(shots, '知映-v03-03-分镜核对.png'), fullPage: true });
    await page.reload();
    await page.locator('#panel-2').waitFor({ state: 'visible' });
    assert.match(await page.locator('#review-count').textContent(), /5 \/ 5/);
    check('Draft edits and review status survive reload');

    await page.locator('#to-export').click();
    await page.locator('#export-button').click();
    assert.equal(await page.locator('#back-scenes').isDisabled(), true);
    await page.waitForFunction(() => /^[a-f0-9]{32}$/.test(JSON.parse(localStorage.getItem('zhiying-local-draft-v1')).jobId || ''));
    await page.reload();
    await page.locator('#panel-3').waitFor({ state: 'visible' });
    await page.locator('#export-success').waitFor({ state: 'visible', timeout: 240000 });
    await page.waitForFunction(() => document.getElementById('result-video').readyState >= 1);
    const media = await page.locator('#result-video').evaluate(async (video) => {
      video.muted = true;
      await video.play();
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, src: video.getAttribute('src') };
    });
    assert.equal(media.width, 1280);
    assert.equal(media.height, 720);
    assert(media.duration > 30);
    await page.waitForFunction(() => document.getElementById('result-video').currentTime > 0.7);
    await page.locator('#result-video').evaluate((video) => { video.pause(); video.currentTime = video.duration / 2; });
    await page.waitForFunction(() => { const video = document.getElementById('result-video'); return !video.seeking && video.currentTime > video.duration / 3; });
    assert.equal(await page.locator('#preview-timeline').isVisible(), false);
    assert.match(await page.locator('#preview-position').textContent(), /完整成片/);
    check('Real 720p MP4 survives reload, plays and seeks in the browser');

    const grabFrame = (time) => page.locator('#result-video').evaluate(async (video, t) => {
      video.pause();
      video.currentTime = t;
      await new Promise((resolve) => { video.onseeked = resolve; });
      const canvas = document.createElement('canvas'); canvas.width = 558; canvas.height = 378;
      canvas.getContext('2d').drawImage(video, 658, 120, 558, 378, 0, 0, 558, 378);
      return canvas.toDataURL();
    }, time);
    const earlyFrame = await grabFrame(0.4);
    const laterFrame = await grabFrame(6.0);
    assert.notEqual(earlyFrame, laterFrame);
    check('Exported MP4 contains real scenario animation within a scene');

    for (const [id, name] of [['download-video', 'demo-v03-情景反诈.mp4'], ['download-subtitles', 'demo-v03-情景反诈.srt'], ['download-script', 'demo-v03-情景反诈脚本.txt']]) {
      const pendingDownload = page.waitForEvent('download');
      await page.locator(`#${id}`).click();
      const download = await pendingDownload;
      await download.saveAs(path.join(root, 'exports', name));
      assert.equal(await download.failure(), null);
      assert((await fs.stat(path.join(root, 'exports', name))).size > 0);
    }
    check('MP4, SRT and script downloads complete successfully');
    await page.screenshot({ path: path.join(shots, '知映-v03-04-成片导出.png'), fullPage: true });
    const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('zhiying-local-draft-v1')));

    await page.locator('#back-scenes').click();
    await page.locator('#tab-visual').click();
    await page.locator('#visual-text').fill('修改成片中的画面提示');
    assert.equal(await page.locator('#scene-reviewed').isChecked(), false);
    assert.equal((await draftValue()).result, null);
    await page.locator('#tab-script').click();
    await page.locator('#scene-title').fill('刷单返利，先核实再行动');
    assert.equal(await page.locator('#scene-reviewed').isChecked(), false);
    await page.locator('#to-export').click();
    assert.equal(await page.locator('#export-success').isVisible(), false);
    assert.equal(await page.locator('#export-button').isDisabled(), true);
    check('Editing after export invalidates stale video and requires review');

    const darkScore = () => page.locator('#preview-image').evaluate((image) => {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const data = context.getImageData(658, 120, 558, 378).data;
      let total = 0;
      for (let i = 0; i < data.length; i += 4) total += (data[i] + data[i + 1] + data[i + 2]) / 3;
      return total / (data.length / 4);
    });
    await page.locator('#step-1').click();
    await page.screenshot({ path: path.join(shots, '知映-v04-01-风格库.png'), fullPage: true });
    await page.locator('[data-style="noir"]').click();
    assert.equal(await page.locator('#theme-row').isVisible(), false);
    assert.equal(await page.locator('#noir-note').isVisible(), true);
    assert.equal((await draftValue()).style, 'noir');
    assert.deepEqual((await draftValue()).scenes.map((scene) => scene.visual.kind), ['stack', 'receipt', 'receipt', 'stack', 'receipt']);
    assert.equal((await draftValue()).scenes.filter((scene) => scene.reviewed).length, 0);
    assert.equal((await draftValue()).scenes[0].visual.interrupt, (await draftValue()).scenes[0].visual.text.slice(0, 20));
    await page.locator('#step-2').click();
    await page.locator('#tab-visual').click();
    assert.equal(await page.locator('#scenario-options button').count(), 5);
    assert.equal(await page.locator('[data-kind="stack"]').getAttribute('aria-pressed'), 'true');
    await waitPreview();
    assert((await darkScore()) < 60, 'noir prop area should be dark');
    check('Style library switch maps props, resets reviews and renders noir');

    await page.locator('[data-kind="battery"]').click();
    await page.getByLabel('起始百分比').fill('90');
    await page.getByLabel('结束百分比').fill('15');
    await page.getByLabel(/字幕标红关键词/).fill('刷单 垫付');
    await waitPreview();
    let visual = (await draftValue()).scenes[0].visual;
    assert.equal(visual.kind, 'battery');
    assert.equal(visual.from, 90);
    assert.equal(visual.to, 15);
    assert.deepEqual(visual.keywords, ['刷单', '垫付']);
    assert.equal((await draftValue()).scenes[0].reviewed, false);
    await page.locator('[data-kind="receipt"]').click();
    await page.getByLabel('条目 2 名称').fill('');
    await page.getByLabel('条目 1 名称').fill('垫付');
    await page.getByLabel('条目值', { exact: true }).nth(0).fill('¥ 200');
    await page.getByLabel('条目 3 名称').fill('损失');
    await page.getByLabel('条目值', { exact: true }).nth(2).fill('全部');
    await waitPreview();
    visual = (await draftValue()).scenes[0].visual;
    assert.deepEqual(visual.items.filter((item) => item.label), [{ label: '垫付', value: '¥ 200' }, { label: '损失', value: '全部' }]);
    await page.locator('[data-kind="loop"]').click();
    await page.getByLabel('计数目标').fill('2.5');
    await page.getByLabel('计数单位').fill('次');
    await waitPreview();
    await page.locator('[data-kind="title"]').click();
    await page.getByLabel('副标题小字').fill('SHUADAN · 2026');
    await waitPreview();
    await page.screenshot({ path: path.join(shots, '知映-v04-02-夜色道具编辑.png'), fullPage: true });
    await page.locator('[data-kind="stack"]').click();
    await page.getByLabel(/红色打断文字/).fill('在吗？');
    await waitPreview();
    visual = (await draftValue()).scenes[0].visual;
    assert.equal(visual.kind, 'stack');
    assert.equal(visual.interrupt, '在吗？');
    assert.deepEqual(visual.keywords, ['刷单', '垫付']);
    check('Prop library picker and per-prop parameters are user-editable');

    await page.locator('#audition-scene').click();
    await page.locator('#playback-badge').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('preview-image').src.includes('/previews/'));
    const noirFirst = await page.locator('#preview-image').getAttribute('src');
    await page.waitForFunction((previous) => { const img = document.getElementById('preview-image'); return img.src.includes('/previews/') && img.src !== previous; }, noirFirst);
    await page.screenshot({ path: path.join(shots, '知映-v04-03-夜色预览.png'), fullPage: true });
    await page.locator('#audition-scene').click();
    await page.waitForFunction(() => document.getElementById('playback-badge').hidden);
    check('Noir preview animates glow props with offline audition');

    for (let index = 0; index < 5; index++) {
      await page.locator('.scene-item').nth(index).click();
      await page.locator('#scene-reviewed').check();
    }
    await page.locator('#to-export').click();
    await page.locator('#export-button').click();
    await page.waitForFunction(() => /^[a-f0-9]{32}$/.test(JSON.parse(localStorage.getItem('zhiying-local-draft-v1')).jobId || ''));
    await page.reload();
    await page.locator('#panel-3').waitFor({ state: 'visible' });
    await page.locator('#export-success').waitFor({ state: 'visible', timeout: 240000 });
    assert.equal((await draftValue()).style, 'noir');
    await page.waitForFunction(() => document.getElementById('result-video').readyState >= 1);
    const noirMedia = await page.locator('#result-video').evaluate(async (video) => {
      video.muted = true;
      await video.play();
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
    });
    assert.equal(noirMedia.width, 1280);
    assert(noirMedia.duration > 30);
    const noirEarly = await grabFrame(0.4);
    const noirLater = await grabFrame(6.0);
    assert.notEqual(noirEarly, noirLater);
    const videoDark = await page.locator('#result-video').evaluate((video) => {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const context = canvas.getContext('2d'); context.drawImage(video, 0, 0);
      const data = context.getImageData(0, 0, 1280, 720).data;
      let total = 0;
      for (let i = 0; i < data.length; i += 4) total += (data[i] + data[i + 1] + data[i + 2]) / 3;
      return total / (data.length / 4);
    });
    assert(videoDark < 80, `noir export should stay dark, got ${videoDark}`);
    for (const [id, name] of [['download-video', 'demo-v04-夜色反诈.mp4'], ['download-subtitles', 'demo-v04-夜色反诈.srt'], ['download-script', 'demo-v04-夜色反诈脚本.txt']]) {
      const pendingDownload = page.waitForEvent('download');
      await page.locator(`#${id}`).click();
      const download = await pendingDownload;
      await download.saveAs(path.join(root, 'exports', name));
      assert.equal(await download.failure(), null);
    }
    await page.screenshot({ path: path.join(shots, '知映-v04-04-夜色成片.png'), fullPage: true });
    check('Noir style exports real animated dark MP4 and survives reload');

    await page.locator('#back-scenes').click();
    await page.locator('#step-1').click();
    await page.locator('[data-style="illustration"]').click();
    assert.equal(await page.locator('#theme-row').isVisible(), true);
    assert.deepEqual((await draftValue()).scenes.map((scene) => scene.visual.kind), ['message', 'transfer', 'transfer', 'message', 'transfer']);
    assert.equal((await draftValue()).scenes.filter((scene) => scene.reviewed).length, 0);
    check('Switching back to illustration restores mapped props and theme picker');

    const mobile = await context.newPage();
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.goto(origin);
    await mobile.locator('#step-1').click();
    await mobile.waitForFunction(() => document.getElementById('preview-image').naturalWidth === 1280);
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false);
    await mobile.screenshot({ path: path.join(shots, '知映-v03-05-手机布局.png'), fullPage: true });
    await mobile.locator('#step-2').click();
    await mobile.locator('#tab-visual').click();
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await mobile.screenshot({ path: path.join(shots, '知映-v03-08-手机画面编辑.png'), fullPage: true });
    await mobile.locator('#step-1').click();
    await mobile.locator('[data-style="noir"]').click();
    await mobile.locator('#step-2').click();
    await mobile.locator('#tab-visual').click();
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await mobile.screenshot({ path: path.join(shots, '知映-v04-05-手机夜色编辑.png'), fullPage: true });
    await mobile.locator('#step-1').click();
    await mobile.locator('[data-style="illustration"]').click();
    check('390px mobile source and visual editors have no horizontal overflow');
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    check('No browser errors and no external page requests');
    await fs.writeFile(path.join(__dirname, 'browser-result.json'), JSON.stringify({ checks, media, noirMedia, jobId: draft.result.id, browserErrors: errors, externalRequests: external }, null, 2));
    console.log(JSON.stringify({ checks: checks.length, media, noirMedia, jobId: draft.result.id, screenshots: shots }, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
