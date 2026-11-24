'use strict';

const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

// Disposable contexts and in-memory fixtures keep user data untouched.
const origin = new URL(process.env.ZHIYING_URL || 'http://127.0.0.1:8765').origin;
const shots = process.env.SCREENSHOT_DIR ? path.resolve(process.env.SCREENSHOT_DIR) : null;
const SAVED = '已保存到本机项目库';
const UNSAVED = '尚未保存，请先备份';
const LEGACY = 'zhiying-local-draft-v1';
const tests = [];
const results = [];
const telemetry = { scriptErrors: [], externalRequests: [], consoleErrors: [], httpErrors: [] };
const screenshots = [];
const test = (name, run, options = {}) => tests.push({ name, run, options });

function draft(title = '项目库验收甲', source = '收到陌生转账请求时，不要着急操作，请通过官方渠道主动核实信息。') {
  return {
    title, source, generatedSource: source,
    sourceInfo: { name: '项目库验收来源', url: origin + '/', publishedAt: '2026-11-23' },
    aspectRatio: '16:9', theme: 'warm', style: 'illustration', accessible: true,
    scenes: [{ id: '1', title: '先核实再行动', narration: source, source, reviewed: true,
      visual: { kind: 'message', text: '独立渠道核实信息', sub: '', imageId: null, imageName: '', fit: 'cover', focusX: 50, focusY: 50,
        steps: [], interrupt: '', items: [], from: 80, to: 20, target: 1, keywords: [] } }],
    activeScene: 0, step: 1, jobId: null, result: null,
  };
}
function bundle(value = draft()) { return { format: 'zhiying-project', version: 1, draft: value, assets: [] }; }
const card = (page, id) => page.locator(`article.project-card[data-project-id="${id}"]`);
const action = (page, id, verb) => card(page, id).locator(`[data-project-action="${verb}"]`);
const idle = (page) => page.waitForFunction(() => !document.getElementById('library-open').disabled);
const saved = async (page) => {
  await page.waitForFunction((text) => document.getElementById('save-status').textContent === text, SAVED);
  await idle(page);
};
const unsaved = (page) => page.waitForFunction((text) => document.getElementById('save-status').textContent === text, UNSAVED);
const active = async (page) => { await saved(page); return page.evaluate(() => ProjectStore.getActive()); };
const projects = async (page) => { await saved(page); return page.evaluate(() => ProjectStore.list()); };
const toast = (page, pattern) => page.waitForFunction(({ source, flags }) => {
  const element = document.getElementById('toast');
  return !element.hidden && new RegExp(source, flags).test(element.textContent);
}, { source: pattern.source, flags: pattern.flags });
async function library(page, allowUnsaved = false) {
  await page.locator('#library-open').click();
  await page.locator('#project-library').waitFor({ state: 'visible' });
  await idle(page);
  if (!allowUnsaved) await saved(page);
}
async function openProject(page, id) {
  await action(page, id, 'open').click();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await saved(page);
  assert.equal((await active(page)).id, id);
}
async function newProject(page, title, source) {
  await library(page);
  await page.locator('#project-new').click();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await saved(page);
  assert.equal(await page.locator('#source-input').inputValue(), '', 'New project must not inherit source');
  assert.deepEqual((await active(page)).draft.scenes, []);
  await page.locator('#project-title').fill(title);
  await page.locator('#source-input').fill(source);
  await page.locator('#project-save').click();
  await saved(page);
  return active(page);
}
async function confirmed(page, accept, trigger) {
  const waiting = page.waitForEvent('dialog');
  const click = trigger();
  const dialog = await waiting;
  assert.equal(dialog.type(), 'confirm');
  const message = dialog.message();
  if (accept) await dialog.accept(); else await dialog.dismiss();
  await click;
  await idle(page);
  return message;
}
async function removeProject(page, id, accept = true) {
  return confirmed(page, accept, () => action(page, id, 'delete').click());
}
async function downloadJSON(page, trigger) {
  const waiting = page.waitForEvent('download');
  await trigger();
  const download = await waiting;
  const stream = await download.createReadStream();
  assert(stream, 'Download stream missing');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(await download.failure(), null);
  assert.match(download.suggestedFilename(), /\.zhiying\.json$/);
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(value.format, 'zhiying-project');
  assert.equal(value.version, 1);
  await idle(page);
  return value;
}
async function importJSON(page, value, viaButton = false) {
  const file = { name: '验收备份.zhiying.json', mimeType: 'application/json',
    buffer: Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) };
  if (viaButton) {
    const pending = page.waitForEvent('filechooser');
    await page.locator('#project-import-button').click();
    await (await pending).setFiles(file);
  } else {
    await page.locator('#project-import').setInputFiles(file);
  }
}
async function stableSnapshot(page, allowUnsaved = false) {
  // Failed saves are inspected against the last committed state.
  if (!allowUnsaved) await saved(page);
  return page.evaluate(async () => {
    const rows = await ProjectStore.list();
    const ids = [...new Set(rows.flatMap(row => row.draft.scenes.map(scene => scene.visual.imageId).filter(Boolean)))].sort();
    const assets = [];
    for (const id of ids) {
      const blob = await ProjectStore.getAsset(id);
      assets.push({ id, type: blob?.type, bytes: blob ? Array.from(new Uint8Array(await blob.arrayBuffer())) : null });
    }
    return { projects: rows.map(({ id, createdAt, draft }) => ({ id, createdAt, draft })).sort((a, b) => a.id.localeCompare(b.id)),
      activeId: (await ProjectStore.getActive())?.id || null, assets };
  });
}
async function assertCurrent(page, id) {
  assert.equal(await page.locator('.library-current-label').count(), 1);
  assert.equal(await card(page, id).locator('.library-current-label').textContent(), '当前项目');
  assert.match(await card(page, id).getAttribute('class'), /project-card-current/);
  assert.equal((await active(page)).id, id);
}
async function pngFixture(page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#af654d'; ctx.fillRect(0, 0, 48, 64);
    ctx.fillStyle = '#265344'; ctx.fillRect(48, 0, 48, 64);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name: '真实双色小图.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}
async function verifyThumbnail(page) {
  await page.waitForFunction(() => {
    const image = document.getElementById('asset-thumbnail');
    return !image.hidden && image.complete && image.naturalWidth === 96 && image.naturalHeight === 64;
  });
  assert.deepEqual(await page.locator('#asset-thumbnail').evaluate((image) => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    return [Array.from(ctx.getImageData(10, 10, 1, 1).data), Array.from(ctx.getImageData(80, 10, 1, 1).data)];
  }), [[175, 101, 77, 255], [38, 83, 68, 255]]);
}
async function uploadPNG(page) {
  await page.locator('#step-2').click();
  await page.locator('#tab-visual').click();
  const file = await pngFixture(page);
  await page.locator('#local-image').setInputFiles(file);
  await toast(page, /图片副本已保存在本机/);
  await saved(page);
  await verifyThumbnail(page);
  const record = await active(page);
  const id = record.draft.scenes[0].visual.imageId;
  assert.match(id, /^[a-f0-9]{32}$/);
  const blob = await page.evaluate(async (id) => {
    const value = await ProjectStore.getAsset(id);
    return { isBlob: value instanceof Blob, type: value?.type, size: value?.size,
      header: value ? Array.from(new Uint8Array(await value.arrayBuffer()).slice(0, 8)) : [] };
  }, id);
  assert.equal(blob.isBlob, true);
  assert.equal(blob.type, 'image/png');
  assert(blob.size > 0 && blob.size < 4 * 1024 * 1024);
  assert.deepEqual(blob.header, [137, 80, 78, 71, 13, 10, 26, 10]);
  return { record, id };
}
async function screenshot(page, name) {
  const file = shots ? path.join(shots, name + '.png') : undefined;
  const png = await page.screenshot({ ...(file ? { path: file } : {}), fullPage: true });
  screenshots.push({ name, path: file || '(in-memory; set SCREENSHOT_DIR to retain)', bytes: png.length });
}
async function noOverflow(page, label) {
  const geometry = await page.evaluate(() => ({ width: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth,
    overflowing: [...document.querySelectorAll('body *')].filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1);
    }).slice(0, 12).map(el => ({ tag: el.tagName, id: el.id, class: el.className, right: el.getBoundingClientRect().right })) }));
  assert(geometry.html <= geometry.width && geometry.body <= geometry.width, `${label}: ${JSON.stringify(geometry)}`);
}

// Each case starts from a fresh context. Legacy setup is a fixture, not an app API.
test('01 旧草稿迁移、删除旧键、IDB 三表与 reload 不重复', async ({ page, note }) => {
  const initial = await active(page);
  assert.equal(initial.draft.title, '旧草稿迁移验收');
  assert.equal(initial.draft.scenes[0].reviewed, true);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), LEGACY), null);
  assert.equal((await projects(page)).length, 1);
  const stores = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('zhiying-project-library', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result; const names = [...db.objectStoreNames]; db.close(); resolve(names); };
  }));
  assert.deepEqual(stores, ['assets', 'meta', 'projects']);
  note('迁移内容、核对状态、旧键删除及三表正确');
  for (let index = 0; index < 2; index++) {
    await saved(page); await page.reload(); await saved(page);
    assert.equal((await projects(page)).length, 1);
    assert.equal((await active(page)).id, initial.id);
    assert.deepEqual((await active(page)).draft, initial.draft);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), LEGACY), null);
  }
}, { legacy: draft('旧草稿迁移验收') });

test('01A 旧草稿读取失败不创建空白项目，恢复后可重试迁移', async ({ page, note }) => {
  await unsaved(page); await idle(page);
  await library(page, true);
  await page.locator('#library-error').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#save-status').textContent(), UNSAVED);
  assert.deepEqual(await page.evaluate(() => ProjectStore.list()), []);
  assert.equal(await page.evaluate(() => ProjectStore.getActive()), undefined);
  const legacy = await page.evaluate(key => window.__realStorageGetItem.call(localStorage, key), LEGACY);
  assert(legacy);
  assert.equal(JSON.parse(legacy).title, '读取失败也必须保留的旧草稿');
  await page.evaluate(() => {
    Storage.prototype.getItem = window.__realStorageGetItem;
    delete window.__realStorageGetItem;
  });
  await page.locator('#library-retry').click(); await saved(page);
  const migrated = await active(page);
  assert.equal(migrated.draft.title, '读取失败也必须保留的旧草稿');
  assert.deepEqual(migrated.draft.scenes, draft('读取失败也必须保留的旧草稿').scenes);
  assert.equal((await projects(page)).length, 1);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), LEGACY), null);
  note('读取异常时项目库保持为空，旧键保留，重试只迁移一次');
  await page.reload(); await saved(page);
  assert.equal((await projects(page)).length, 1);
  assert.equal((await active(page)).id, migrated.id);
}, { legacy: draft('读取失败也必须保留的旧草稿'), failLegacyRead: true });

test('02 新建/显式保存/打开隔离、40 字标题、当前标记和 active 持久', async ({ page, note }) => {
  const original = await active(page);
  const longTitle = '长'.repeat(48);
  const second = await newProject(page, longTitle, '乙项目专属资料：陌生客服要求共享屏幕时，请立即停止并向官方核实。');
  assert.notEqual(second.id, original.id);
  assert.equal(await page.locator('#project-title').getAttribute('maxlength'), '40');
  assert.equal(await page.locator('#project-title').inputValue(), longTitle.slice(0, 40));
  assert.equal(second.draft.title.length, 40);
  await library(page); await assertCurrent(page, second.id);
  assert.equal(await card(page, second.id).locator('.project-card-title').textContent(), longTitle.slice(0, 40));
  await openProject(page, original.id);
  assert.equal(await page.locator('#source-input').inputValue(), original.draft.source);
  assert.deepEqual((await active(page)).draft.scenes, original.draft.scenes);
  await library(page); await assertCurrent(page, original.id);
  await openProject(page, second.id);
  assert.equal(await page.locator('#source-input').inputValue(), second.draft.source);
  note('两个项目内容互不串写，标题截断 40 字，当前卡片正确');
  await saved(page); await page.reload(); await saved(page);
  assert.equal((await active(page)).id, second.id);
  assert.equal(await page.locator('#source-input').inputValue(), second.draft.source);
  await library(page); await assertCurrent(page, second.id);
  const all = await projects(page);
  assert.equal(all.length, 2);
  assert.deepEqual(all.find(row => row.id === original.id).draft, original.draft);
}, { legacy: draft() });

test('03 复制留在库、独立内容，清除 job/result/review', async ({ page, note }) => {
  const current = await active(page);
  const originalDraft = draft('复'.repeat(40));
  originalDraft.jobId = 'a'.repeat(32);
  originalDraft.result = { video: `/files/${'b'.repeat(32)}/video.mp4`, duration: 2, size: 128 };
  const original = await page.evaluate(value => ProjectStore.create(value), originalDraft);
  await library(page);
  await action(page, original.id, 'duplicate').click();
  await toast(page, /已创建独立副本/); await saved(page);
  assert.equal(await page.locator('#project-library').isVisible(), true);
  await assertCurrent(page, current.id);
  const copy = (await projects(page)).find(row => row.id !== original.id && row.id !== current.id);
  assert(copy);
  assert.notEqual(copy.id, original.id);
  assert(copy.draft.title.length <= 40);
  assert.equal(copy.draft.title, '复'.repeat(35) + ' · 副本');
  assert.equal(copy.draft.jobId, null); assert.equal(copy.draft.result, null);
  assert(copy.draft.scenes.every(scene => scene.reviewed === false));
  assert.equal(copy.draft.source, originalDraft.source);
  assert.deepEqual((await page.evaluate(id => ProjectStore.get(id), original.id)).draft, originalDraft);
  note('复制不激活，清除核对/任务/成片，原项目保留');
  await openProject(page, copy.id);
  await page.locator('#source-input').fill('副本单独修改资料，不应修改原来项目中的内容。');
  await saved(page);
  assert.deepEqual((await page.evaluate(id => ProjectStore.get(id), original.id)).draft, originalDraft);
});

test('04 删除取消与确认：非当前项目不影响当前', async ({ page }) => {
  const current = await active(page);
  const other = await page.evaluate(value => ProjectStore.create(value), draft('待删除项目'));
  await library(page);
  const before = await stableSnapshot(page);
  assert.match(await removeProject(page, other.id, false), /无法撤销/);
  assert.deepEqual(await stableSnapshot(page), before);
  await removeProject(page, other.id, true);
  await toast(page, /项目已从当前浏览器删除/);
  assert.equal(await card(page, other.id).count(), 0);
  assert.equal((await projects(page)).length, 1);
  await assertCurrent(page, current.id);
});

test('05 删除当前、删除最后一个空态并从空态新建', async ({ page, note }) => {
  const current = await active(page);
  const other = await page.evaluate(value => ProjectStore.create(value), draft('剩余项目'));
  await library(page);
  await removeProject(page, current.id);
  await toast(page, /项目已从当前浏览器删除/);
  assert.equal(await page.evaluate(() => ProjectStore.getActive()), undefined);
  assert.equal(await page.locator('.library-current-label').count(), 0);
  assert.equal(await page.locator('#current-project-name').textContent(), '未打开项目');
  assert.equal(await page.locator('#project-save').isDisabled(), true);
  assert.equal((await page.evaluate(() => ProjectStore.list())).length, 1);
  note('删当前不会误激活其他项目，保存按钮禁用');
  await removeProject(page, other.id);
  await page.locator('#library-empty').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#library-count').textContent(), '0 个项目');
  assert.equal(await page.locator('article.project-card').count(), 0);
  assert.deepEqual(await page.evaluate(() => ProjectStore.list()), []);
  await page.locator('#project-new').click(); await saved(page);
  await page.locator('#workspace').waitFor({ state: 'visible' });
  assert.equal((await projects(page)).length, 1);
  assert.equal((await active(page)).draft.source, '');
});

test('06 清空取消/确认仅影响当前项目', async ({ page }) => {
  const current = await active(page);
  const other = await page.evaluate(value => ProjectStore.create(value), draft('不能被清空的项目'));
  const before = await stableSnapshot(page);
  await page.locator('#help-open').click();
  await confirmed(page, false, () => page.locator('#clear-draft').click());
  assert.deepEqual(await stableSnapshot(page), before);
  await confirmed(page, true, () => page.locator('#clear-draft').click());
  await saved(page);
  assert.equal(await page.locator('#help-dialog').isVisible(), false);
  const cleared = await active(page);
  assert.equal(cleared.id, current.id);
  assert.equal(cleared.draft.source, ''); assert.deepEqual(cleared.draft.scenes, []);
  assert.deepEqual((await page.evaluate(id => ProjectStore.get(id), other.id)).draft, other.draft);
}, { legacy: draft() });

test('07 备份真实下载解析、文件选择器导入新项目、清除核对和任务结果', async ({ page }) => {
  const original = await active(page);
  await library(page);
  const backup = await downloadJSON(page, () => action(page, original.id, 'backup').click());
  assert.equal(backup.draft.source, original.draft.source);
  assert.equal(backup.draft.scenes[0].reviewed, true);
  assert.deepEqual(backup.assets, []);
  assert.equal(backup.draft.jobId, null); assert.equal(backup.draft.result, null);
  const originalState = await stableSnapshot(page);
  // Imported jobs/results must be ignored even if supplied by an old backup.
  backup.draft.jobId = 'c'.repeat(32);
  backup.draft.result = { video: `/files/${'d'.repeat(32)}/video.mp4`, duration: 1, size: 1 };
  await importJSON(page, backup, true); await toast(page, /备份已作为新项目导入/); await saved(page);
  assert.equal(await page.locator('#project-library').isVisible(), true);
  await assertCurrent(page, original.id);
  const all = await projects(page);
  assert.equal(all.length, 2);
  const imported = all.find(row => row.id !== original.id);
  assert.equal(imported.draft.title, original.draft.title);
  assert.equal(imported.draft.source, original.draft.source);
  assert.equal(imported.draft.jobId, null); assert.equal(imported.draft.result, null);
  assert(imported.draft.scenes.every(scene => !scene.reviewed));
  assert.deepEqual((await stableSnapshot(page)).projects.find(row => row.id === original.id), originalState.projects[0]);
  await openProject(page, imported.id);
  assert.equal(await page.locator('#source-input').inputValue(), original.draft.source);
}, { legacy: draft() });

const invalidCases = [
  ['坏 JSON', () => '{broken json', /无法解析备份/],
  ['错误 format', () => ({ ...bundle(), format: 'other-project' }), /不支持这个项目备份格式或版本/],
  ['错误 version', () => ({ ...bundle(), version: 2 }), /不支持这个项目备份格式或版本/],
  ['路径穿越 imageId', () => { const b = bundle(); b.draft.scenes[0].visual.imageId = '../../secret'; return b; }, /项目内容格式不正确/],
  ['外部 URL imageId', () => { const b = bundle(); b.draft.scenes[0].visual.imageId = 'https://example.invalid/image.png'; return b; }, /项目内容格式不正确/],
  ['危险 source URL', () => { const b = bundle(); b.draft.sourceInfo.url = 'javascript:alert(1)'; return b; }, /项目内容格式不正确/],
  ['超过 40 字标题', () => bundle(draft('长'.repeat(41))), /项目内容格式不正确/],
  ['SVG MIME', () => imageBundle('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')), /图片格式不正确/],
  ['伪装 PNG 的 SVG', () => imageBundle('image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64')), /无法解码的图片|图片内容与声明的格式不一致/],
  ['非法 base64', () => imageBundle('image/png', '<not-base64>'), /图片格式不正确/],
  ['单图超过 4 MB', () => imageBundle('image/png', Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64')), /单张备份图片不能超过 4 MB/],
  ['备份超过 48 MB', () => Buffer.alloc(48 * 1024 * 1024 + 1, 32), /项目备份不能超过 48 MB/],
];
function imageBundle(mime, data) {
  const b = bundle(); const id = 'e'.repeat(32);
  b.draft.scenes[0].visual.imageId = id;
  b.assets = [{ id, mime, data }]; return b;
}
for (const [label, input, message] of invalidCases) {
  test(`拒绝导入：${label}，现有项目/active/图片不变`, async ({ page }) => {
    await library(page);
    const before = await stableSnapshot(page);
    await importJSON(page, input()); await toast(page, message); await idle(page); await saved(page);
    assert.deepEqual(await stableSnapshot(page), before);
    assert.equal(await page.locator('article.project-card').count(), before.projects.length);
    assert.equal(await page.locator('#project-library').isVisible(), true);
  }, { legacy: draft('拒绝导入前的有效项目') });
}

test('08 真实 PNG 原入口上传→IDB Blob→备份→导入→本地后端恢复→正确显示/reload', async ({ page, note, expectedHTTP }) => {
  const { record, id } = await uploadPNG(page);
  note('原图片上传成功，IDB 存真实 PNG Blob，缩略图尺寸和双色像素正确');
  await library(page);
  const backup = await downloadJSON(page, () => action(page, record.id, 'backup').click());
  assert.equal(backup.assets.length, 1);
  assert.equal(backup.assets[0].id, id);
  assert.equal(backup.assets[0].mime, 'image/png');
  assert.equal(Buffer.from(backup.assets[0].data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const before = await stableSnapshot(page);
  await importJSON(page, backup); await toast(page, /备份已作为新项目导入/); await saved(page);
  const imported = (await projects(page)).find(row => row.id !== record.id);
  assert(imported);
  const portableId = imported.draft.scenes[0].visual.imageId;
  assert.notEqual(portableId, id);
  assert.equal(await page.evaluate(async id => (await ProjectStore.getAsset(id)) instanceof Blob, portableId), true);
  assert.deepEqual((await stableSnapshot(page)).projects.find(row => row.id === record.id), before.projects[0]);
  assert.equal((await active(page)).id, record.id);
  assert.equal(imported.draft.scenes[0].reviewed, false);
  note('备份内嵌 PNG、导入独立项目及新图片 ID，原项目不变');
  // Imported browser-only image IDs recover from IndexedDB after the expected 404.
  expectedHTTP.add(origin + `/assets/${portableId}.png`);
  const uploaded = page.waitForResponse(response => response.url() === origin + '/api/assets' && response.request().method() === 'POST');
  await openProject(page, imported.id);
  assert.equal((await uploaded).ok(), true);
  const restored = await active(page);
  const backendId = restored.draft.scenes[0].visual.imageId;
  assert.match(backendId, /^[a-f0-9]{32}$/); assert.notEqual(backendId, portableId);
  await page.locator('#tab-visual').click(); await verifyThumbnail(page);
  assert.equal(await page.evaluate(async id => (await ProjectStore.getAsset(id)) instanceof Blob, backendId), true);
  await saved(page); await page.reload(); await saved(page);
  await page.locator('#tab-visual').click(); await verifyThumbnail(page);
  assert.equal((await active(page)).draft.scenes[0].visual.imageId, backendId);
}, { legacy: draft('图片往返项目') });

test('09 图片共用复制后删除原项目仍保留，删最后引用后回收', async ({ page, note }) => {
  const { record, id } = await uploadPNG(page);
  await library(page);
  await action(page, record.id, 'duplicate').click(); await toast(page, /已创建独立副本/); await saved(page);
  const copy = (await projects(page)).find(row => row.id !== record.id);
  assert.equal(copy.draft.scenes[0].visual.imageId, id);
  await removeProject(page, record.id); await toast(page, /项目已从当前浏览器删除/);
  assert.equal(await page.evaluate(async id => (await ProjectStore.getAsset(id)) instanceof Blob, id), true);
  await openProject(page, copy.id);
  await page.locator('#tab-visual').click(); await verifyThumbnail(page);
  note('删除图片原项目后，副本 IDB Blob 和图片显示均保留');
  await library(page); await removeProject(page, copy.id);
  await page.locator('#library-empty').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(id => ProjectStore.getAsset(id), id), undefined);
}, { legacy: draft('图片共享项目') });

test('10 同源双标签冲突不可静默覆盖，救援内存草稿并刷新恢复', async ({ page, context, note }) => {
  const original = await active(page);
  const second = await context.newPage(); await second.goto(origin); await saved(second);
  assert.equal((await active(second)).id, original.id);
  const latest = '标签甲已经保存的新资料：请勿向陌生人提供短信验证码。';
  await page.locator('#source-input').fill(latest); await saved(page);
  await second.locator('#project-title').fill('标签乙未保存的冲突草稿'); await unsaved(second);
  await library(second, true);
  assert.match(await second.locator('#library-error-message').textContent(), /其他标签页修改或删除/);
  const committed = await stableSnapshot(second, true);
  assert.equal(committed.projects[0].draft.source, latest);
  assert.equal(committed.projects[0].draft.title, original.draft.title);
  const rescue = await downloadJSON(second, () => second.locator('#project-rescue').click());
  assert.equal(rescue.draft.title, '标签乙未保存的冲突草稿');
  assert.equal(rescue.draft.source, original.draft.source);
  await second.locator('#project-new').click(); await toast(second, /当前修改尚未保存/); await idle(second);
  assert.deepEqual(await stableSnapshot(second, true), committed);
  await second.locator('#workspace-open').click(); await idle(second);
  assert.equal(await second.locator('#project-title').inputValue(), rescue.draft.title);
  note('冲突明确提示，磁盘内容未覆盖，阻止切项目并可下载内存草稿');
  const onDialog = dialog => dialog.accept(); second.on('dialog', onDialog);
  try { await second.reload(); } finally { second.off('dialog', onDialog); }
  await saved(second);
  assert.equal(await second.locator('#source-input').inputValue(), latest);
  assert.equal(await second.locator('#project-title').inputValue(), original.draft.title);
}, { legacy: draft('双标签原始项目') });

test('11 QuotaExceededError：未保存提示、阻止切换/删除、救援和重试', async ({ page, note }) => {
  const original = await active(page);
  const other = await page.evaluate(value => ProjectStore.create(value), draft('不能误打开的项目'));
  const before = await stableSnapshot(page);
  await page.evaluate(() => {
    window.__realSave = ProjectStore.save;
    ProjectStore.save = async () => { throw new DOMException('Acceptance quota injection', 'QuotaExceededError'); };
  });
  const memory = '空间不足时仍必须保留这份尚未保存的重要资料。';
  await page.locator('#source-input').fill(memory); await unsaved(page);
  await library(page, true);
  assert.equal(await page.locator('#library-error').isVisible(), true);
  assert.match(await page.locator('#library-error-message').textContent(), /空间不足|存储被禁用/);
  const rescue = await downloadJSON(page, () => page.locator('#project-rescue').click());
  assert.equal(rescue.draft.source, memory);
  for (const trigger of [() => page.locator('#project-new').click(), () => action(page, other.id, 'open').click(), () => action(page, other.id, 'delete').click()]) {
    await trigger(); await toast(page, /当前修改尚未保存/); await idle(page);
    assert.deepEqual(await stableSnapshot(page, true), before);
  }
  await page.locator('#workspace-open').click(); await idle(page);
  assert.equal(await page.locator('#source-input').inputValue(), memory);
  assert.equal(await page.locator('#save-status').textContent(), UNSAVED);
  note('配额错误不丢内存草稿，拒绝新建/打开/删除，救援备份正确');
  // Retry while the fault remains active, then restore the real store.
  await library(page, true);
  await page.evaluate(() => { ProjectStore.save = window.__realSave; delete window.__realSave; });
  await page.locator('#library-retry').click(); await saved(page);
  assert.equal((await active(page)).id, original.id);
  assert.equal((await active(page)).draft.source, memory);
  assert.equal(await page.locator('#library-error').isVisible(), false);
  await page.reload(); await saved(page);
  assert.equal(await page.locator('#source-input').inputValue(), memory);
}, { legacy: draft('配额错误验收') });

test('12 IDB 打开错误：旧键不删除，未保存救援、切换保留、取消/恢复重试', async ({ page, note }) => {
  await unsaved(page); await idle(page);
  assert(await page.evaluate(key => localStorage.getItem(key), LEGACY));
  await page.locator('#project-title').fill('IDB 打开失败时的内存草稿');
  await page.locator('#source-input').fill('存储被禁用时输入的资料也要能够导出救援，不可无声丢失。');
  await unsaved(page); await library(page, true);
  assert.equal(await page.locator('#library-error').isVisible(), true);
  const rescue = await downloadJSON(page, () => page.locator('#project-rescue').click());
  assert.equal(rescue.draft.title, 'IDB 打开失败时的内存草稿');
  assert.match(rescue.draft.source, /不可无声丢失/);
  await page.locator('#project-new').click(); await toast(page, /请先重试打开项目库/); await idle(page);
  await page.locator('#workspace-open').click(); await idle(page);
  assert.equal(await page.locator('#project-title').inputValue(), rescue.draft.title);
  await library(page, true);
  await confirmed(page, false, () => page.locator('#library-retry').click());
  await page.locator('#workspace-open').click(); await idle(page);
  assert.equal(await page.locator('#source-input').inputValue(), rescue.draft.source);
  note('打开失败不删除旧草稿，未保存资料可救援且切换/取消重试不丢');
  await page.evaluate(() => { IDBFactory.prototype.open = window.__realIDBOpen; });
  await library(page, true);
  const message = await confirmed(page, true, () => page.locator('#library-retry').click());
  assert.match(message, /先备份未保存/); await saved(page);
  assert.equal((await active(page)).draft.title, '打开失败前的旧草稿');
  assert.equal((await projects(page)).length, 1);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), LEGACY), null);
}, { legacy: draft('打开失败前的旧草稿'), failOpen: true });

test('13 切换项目停止真实本机试听和连续预览', async ({ page, note }) => {
  const original = await active(page);
  const other = await page.evaluate(value => ProjectStore.create(value), draft('试听切换目标'));
  for (const button of ['#audition-scene', '#play-preview']) {
    await page.locator('#step-2').click();
    await page.locator(button).click();
    await page.waitForFunction(() => {
      const audio = document.getElementById('scene-audio');
      return audio.currentTime > 0.1 && !audio.paused && document.getElementById('preview-image').src.includes('/previews/');
    }, null, { timeout: 60000 });
    await saved(page);
    await library(page);
    assert.equal(await page.locator('#scene-audio').evaluate(audio => audio.paused && !audio.getAttribute('src')), true);
    assert.equal(await page.locator('#playback-badge').isVisible(), false);
    await openProject(page, other.id);
    assert.equal(await page.locator('#scene-audio').evaluate(audio => audio.paused && !audio.getAttribute('src')), true);
    assert.equal(await page.locator('#result-video').evaluate(video => video.paused && !video.getAttribute('src')), true);
    note(`${button} 实际播放后切库/切项目已停止并清理`);
    await library(page); await openProject(page, original.id);
  }
}, { legacy: draft('播放切换验收') });

async function smallVideo(page) {
  // A short generated WebM tests result cleanup without a real long export.
  return Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
    const ctx = canvas.getContext('2d'); const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = []; recorder.ondataavailable = event => chunks.push(event.data);
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    await new Promise(resolve => {
      let frame = 0;
      const timer = setInterval(() => {
        ctx.fillStyle = frame % 2 ? '#af654d' : '#265344'; ctx.fillRect(0, 0, 96, 64);
        if (++frame === 20) { clearInterval(timer); recorder.stop(); resolve(); }
      }, 100);
    });
    await stopped; stream.getTracks().forEach(track => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  }));
}

test('14 切换项目停止成片结果预览并清理旧下载链接（短媒体夹具）', async ({ page }) => {
  const initial = await active(page);
  const media = await smallVideo(page);
  const videoPath = `/files/${'f'.repeat(32)}/video.mp4`;
  await page.route(origin + videoPath, route => route.fulfill({ status: 200, contentType: 'video/webm', body: media }));
  const fixture = draft('带成片的项目'); fixture.step = 3;
  fixture.result = { video: videoPath, duration: 2, size: media.length };
  const movie = await page.evaluate(value => ProjectStore.create(value), fixture);
  await library(page); await openProject(page, movie.id);
  await page.waitForFunction(() => document.getElementById('result-video').readyState >= 2);
  await page.locator('#result-video').evaluate(async video => { video.muted = true; video.loop = true; await video.play(); });
  await page.waitForFunction(() => document.getElementById('result-video').currentTime > 0.1);
  await library(page);
  assert.equal(await page.locator('#result-video').evaluate(video => video.paused), true);
  await openProject(page, initial.id);
  assert.equal(await page.locator('#result-video').evaluate(video => video.paused && !video.getAttribute('src')), true);
  assert.equal(await page.locator('#export-success').isVisible(), false);
  for (const id of ['download-video', 'download-script', 'download-subtitles']) assert.equal(await page.locator('#' + id).getAttribute('href'), null);
});

async function heldPOST(page, endpoint, trigger, during, response) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let seen;
  const arrived = new Promise(resolve => { seen = resolve; });
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  let received = false;
  let routeError;
  const handler = async route => {
    received = true; seen();
    try {
      assert.equal(route.request().method(), 'POST');
      await gate;
      if (response) await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
      else await route.continue();
    } catch (error) {
      routeError = error;
    } finally { finish(); }
  };
  await page.route(origin + endpoint, handler);
  let timeout;
  try {
    await trigger();
    await Promise.race([arrived, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`POST ${endpoint} was not reached`)), 12000); })]);
    clearTimeout(timeout);
    await during();
  } finally {
    clearTimeout(timeout); release();
    // Do not unroute/close the context while its asynchronous handler is alive.
    if (received) await completed;
    await page.unroute(origin + endpoint, handler);
  }
  if (routeError) throw routeError;
}
async function disabledEntrances(page) {
  for (const id of ['library-open', 'workspace-open', 'project-new', 'project-save', 'project-import-button', 'library-retry', 'project-rescue', 'clear-draft']) {
    assert.equal(await page.locator('#' + id).isDisabled(), true, `${id} must be disabled while busy`);
  }
  const actions = await page.locator('[data-project-action]').evaluateAll(buttons => buttons.map(button => button.disabled));
  assert(actions.length >= 4 && actions.every(Boolean), 'Existing library card actions must all be disabled');
}

test('15 可控 POST 忙碌期间禁用项目入口：整理、图片上传、合成提交（不导长视频）', async ({ page, note }) => {
  await page.locator('#source-input').fill(draft().source); await saved(page);
  await library(page); await page.locator('#workspace-open').click(); await idle(page);
  await heldPOST(page, '/api/draft', () => page.locator('#generate-button').click(), () => disabledEntrances(page));
  await page.locator('#panel-2').waitFor({ state: 'visible' }); await saved(page);
  note('整理分镜 POST 未返回期间入口均禁用');
  await page.locator('#tab-visual').click();
  const file = await pngFixture(page);
  await heldPOST(page, '/api/assets', () => page.locator('#local-image').setInputFiles(file), () => disabledEntrances(page));
  await toast(page, /图片副本已保存在本机/); await saved(page); await verifyThumbnail(page);
  note('图片上传 POST 未返回期间入口均禁用');
  await page.locator('#tab-script').click();
  const count = await page.locator('.scene-item').count();
  for (let index = 0; index < count; index++) { await page.locator('.scene-item').nth(index).click(); await page.locator('#scene-reviewed').check(); }
  await saved(page); await page.locator('#to-export').click(); await saved(page);
  const jobId = '9'.repeat(32);
  await page.route(origin + '/api/jobs/' + jobId, route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'failed', message: '验收模拟任务结束，没有调用真实视频合成', progress: 0 }) }));
  await heldPOST(page, '/api/export', () => page.locator('#export-button').click(), () => disabledEntrances(page), { id: jobId });
  await toast(page, /验收模拟任务结束/); await saved(page);
  assert.equal((await active(page)).draft.jobId, null);
  assert.equal(await page.locator('#library-open').isDisabled(), false);
  note('合成提交期间入口禁用；通过模拟任务结束避免真实视频导出');
});

for (const width of [320, 390, 768, 1440]) {
  test(`布局 ${width}px：项目库和编辑页无横向溢出`, async ({ page, note }) => {
    await page.evaluate(async () => {
      const original = (await ProjectStore.getActive()).draft;
      await ProjectStore.create({ ...structuredClone(original), title: 'X'.repeat(40), style: 'noir', scenes: [] });
      await ProjectStore.create({ ...structuredClone(original), title: '手机竖屏项目', aspectRatio: '9:16' });
    });
    await library(page);
    if (width === 1440 || width === 390) await screenshot(page, `project-library-${width}`);
    await noOverflow(page, `library ${width}`); note('项目库无横向溢出');
    const current = await active(page); await openProject(page, current.id);
    await noOverflow(page, `source editor ${width}`);
    await page.locator('#step-2').click(); await page.locator('#tab-visual').click(); await saved(page);
    await noOverflow(page, `visual editor ${width}`);
  }, { legacy: draft('长'.repeat(40)), width });
}

(async () => {
  if (shots) await fs.mkdir(shots, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    for (const entry of tests) {
      const started = Date.now();
      const context = await browser.newContext({ baseURL: origin, viewport: { width: entry.options.width || 1440, height: entry.options.width < 768 ? 844 : 1000 }, acceptDownloads: true, serviceWorkers: 'block' });
      context.setDefaultTimeout(12000); context.setDefaultNavigationTimeout(25000);
      const expectedHTTP = new Set();
      const localErrors = []; const external = []; const localConsole = []; const http = [];
      context.on('page', page => {
        page.on('pageerror', error => { const item = { test: entry.name, message: error.message }; localErrors.push(item); telemetry.scriptErrors.push(item); });
        page.on('console', message => {
          if (message.type() === 'error') { const item = { test: entry.name, message: message.text(), url: message.location().url }; localConsole.push(item); telemetry.consoleErrors.push(item); }
        });
      });
      context.on('request', request => {
        const url = request.url();
        if (!url.startsWith('data:') && !url.startsWith('blob:') && new URL(url).origin !== origin) {
          const item = { test: entry.name, url }; external.push(item); telemetry.externalRequests.push(item);
        }
      });
      context.on('response', response => {
        if (response.status() >= 400) { const item = { test: entry.name, url: response.url(), status: response.status() }; http.push(item); telemetry.httpErrors.push(item); }
      });
      // Enforce locality as well as reporting any attempted external requests.
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
      if (entry.options.legacy || entry.options.failOpen) {
        await context.addInitScript(({ legacy, failOpen, failLegacyRead, origin, key }) => {
          if (location.origin !== origin) return;
          if (legacy && !localStorage.getItem('__project_library_acceptance_seeded')) {
            localStorage.setItem(key, JSON.stringify(legacy));
            localStorage.setItem('__project_library_acceptance_seeded', '1');
          }
          if (failOpen) {
            window.__realIDBOpen = IDBFactory.prototype.open;
            IDBFactory.prototype.open = function (name, ...args) {
              if (name === 'zhiying-project-library') throw new DOMException('Acceptance open injection', 'UnknownError');
              return window.__realIDBOpen.call(this, name, ...args);
            };
          }
          if (failLegacyRead) {
            window.__realStorageGetItem = Storage.prototype.getItem;
            Storage.prototype.getItem = function (storageKey) {
              if (storageKey === key) throw new DOMException('Acceptance legacy read injection', 'SecurityError');
              return window.__realStorageGetItem.call(this, storageKey);
            };
          }
        }, { legacy: entry.options.legacy, failOpen: entry.options.failOpen, failLegacyRead: entry.options.failLegacyRead, origin, key: LEGACY });
      }
      const page = await context.newPage();
      const checkpoints = [];
      const note = message => { checkpoints.push(message); console.log(`  OK ${message}`); };
      let failure;
      try {
        await page.goto(origin);
        if (!entry.options.failOpen && !entry.options.failLegacyRead) await saved(page);
        await entry.run({ page, context, note, expectedHTTP });
        assert.deepEqual(localErrors, [], 'Unexpected browser script errors');
        assert.deepEqual(external, [], 'External requests attempted');
        assert.deepEqual(http.filter(item => !expectedHTTP.has(item.url)), [], 'Unexpected HTTP errors');
        assert.deepEqual(localConsole.filter(item => !expectedHTTP.has(item.url)), [], 'Unexpected console errors');
      } catch (error) {
        failure = { message: error.message, stack: error.stack };
        const diagnostic = await page.evaluate(() => ({ url: location.href,
          status: document.getElementById('save-status')?.textContent,
          toast: document.getElementById('toast')?.textContent,
          title: document.getElementById('project-title')?.value,
          libraryVisible: !document.getElementById('project-library')?.hidden,
          libraryCount: document.getElementById('library-count')?.textContent,
          storageError: document.getElementById('library-error-message')?.textContent })).catch(() => ({}));
        failure.diagnostic = diagnostic;
        console.error(`FAIL ${entry.name}\n${error.stack}\nSTATE ${JSON.stringify(diagnostic)}`);
      } finally {
        await context.close();
      }
      const result = { name: entry.name, status: failure ? 'FAIL' : 'PASS', durationMs: Date.now() - started, checkpoints,
        ...(failure ? { failure } : {}), scriptErrors: localErrors, externalRequests: external,
        unexpectedHTTP: http.filter(item => !expectedHTTP.has(item.url)),
        unexpectedConsole: localConsole.filter(item => !expectedHTTP.has(item.url)) };
      results.push(result);
      if (!failure) console.log(`PASS ${entry.name} (${result.durationMs}ms)`);
    }
  } finally { await browser.close(); }
  // A final independent audit prevents errors in failed cases from being hidden.
  const auditFailures = results.flatMap(result => [...result.scriptErrors, ...result.externalRequests, ...result.unexpectedHTTP, ...result.unexpectedConsole]);
  results.push({ name: '全场景脚本错误/外部请求/非预期网络与控制台错误审计', status: auditFailures.length ? 'FAIL' : 'PASS', errors: auditFailures });
  const summary = { origin, tests: results.length, passed: results.filter(result => result.status === 'PASS').length,
    failed: results.filter(result => result.status === 'FAIL').length,
    scriptErrors: telemetry.scriptErrors.length, externalRequests: telemetry.externalRequests.length,
    expectedHTTP: telemetry.httpErrors.filter(item => !results.find(result => result.name === item.test)?.unexpectedHTTP.some(error => error.url === item.url)),
    screenshots, results };
  console.log('PROJECT_LIBRARY_RESULT ' + JSON.stringify(summary, null, 2));
  process.exitCode = summary.failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
