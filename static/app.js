const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'zhiying-local-draft-v1';
const SAMPLE = `刷单返利是陷阱：陌生人邀请你点赞、刷单，承诺轻松赚钱，还要求先垫付资金，请提高警惕，不要转账。

警惕冒充客服：接到退款、理赔电话，不要按对方要求操作。请通过购物平台内的官方客服核实。

验证码不外传：不要把银行卡密码、短信验证码告诉他人，不要开启陌生人要求的屏幕共享。

转账之前先核实：遇到自称亲友、领导的人要求紧急转账，请使用原来保存的联系方式，向本人核实。

发现受骗及时求助：停止转账，保留聊天记录、转账凭证等证据，及时报警，并联系银行咨询止付措施。`;
const STORY = `收到一条刷单消息：陌生人发来兼职消息，声称点赞就能赚钱。遇到这类邀请，不要急着相信。

识别垫付风险：对方要求先垫付资金，再返还本金和佣金。这是需要警惕的危险信号。

停止转账操作：不要为了拿回所谓的收益继续转账，也不要透露银行卡密码和短信验证码。

主动核实信息：离开对方提供的聊天和链接，通过平台官方客服等独立渠道核实情况。

留证并及时求助：如果已经转账，保留聊天记录和转账凭证，及时报警，并联系银行咨询止付措施。`;
const KINDS = { message: '收到消息', call: '陌生来电', transfer: '转账风险', verify: '主动核实', help: '留证求助', tip: '重点提醒' };
const NOIR_KINDS = { title: '发光标题卡', battery: '能量电量表', stack: '思路叠层卡', receipt: '代价票据', loop: '循环与计数' };
const KIND_GLYPHS = { message: '···', call: '?', transfer: '!', verify: '✓', help: '≡', tip: 'i', title: 'Aa', battery: '▮', stack: '≣', receipt: '¥', loop: '∞' };
const KIND_HINTS = { message: '聊天与诱导', call: '未知身份', transfer: '停下再想想', verify: '独立联系', help: '保存与求助', tip: '记住这一点', title: '宋体发光大字', battery: '百分比隐喻', stack: '步骤与打断', receipt: '条目与代价', loop: '循环与计数' };
const STYLES = { illustration: '浅色插画', noir: '夜色发光' };
const STYLE_KIND_MAP = {
  noir: { message: 'stack', call: 'stack', transfer: 'receipt', verify: 'stack', help: 'receipt', tip: 'title' },
  illustration: { stack: 'message', receipt: 'transfer', title: 'tip', battery: 'transfer', loop: 'verify' },
};
function kindLabel(kind) { return KINDS[kind] || NOIR_KINDS[kind] || '重点提醒'; }
function styleKinds(style) { return style === 'noir' ? NOIR_KINDS : KINDS; }
function defaultVisual(kind, text, style) {
  const visual = { kind, text, sub: '', imageId: null, imageName: '', fit: 'cover', focusX: 50, focusY: 50, steps: [], interrupt: '', items: [], from: 80, to: 20, target: 1, keywords: [] };
  if (style === 'noir') {
    if (kind === 'stack') visual.steps = ['停一下', '查来源', '问官方', '再决定'];
    else if (kind === 'receipt') { visual.sub = '本地示意 · 2026'; visual.items = [{ label: '垫付', value: '¥ 0' }, { label: '损失', value: '全部' }]; }
    else if (kind === 'loop') { visual.sub = '次'; visual.target = 3; }
    else if (kind === 'title') visual.sub = 'ZHIYING · LOCAL';
  }
  return visual;
}
function convertVisual(visual, style) {
  const merged = { ...defaultVisual(visual.kind, visual.text, style), ...visual };
  if (styleKinds(style)[merged.kind]) return merged;
  const mapped = STYLE_KIND_MAP[style][merged.kind] || (style === 'noir' ? 'title' : 'tip');
  const fresh = defaultVisual(mapped, merged.text, style);
  fresh.keywords = merged.keywords || [];
  fresh.imageId = merged.imageId; fresh.imageName = merged.imageName; fresh.fit = merged.fit;
  fresh.focusX = merged.focusX; fresh.focusY = merged.focusY;
  if (mapped === 'stack' && merged.kind === 'message') fresh.interrupt = (merged.text || '').slice(0, 20);
  return fresh;
}
const DEMO = { title: '一条消息，要多一分警惕', narration: '陌生人的赚钱邀请，不要急着相信。', source: '本地演示画面', reviewed: false, visual: { kind: 'message', text: '收到陌生人的兼职邀请', imageId: null, imageName: '', fit: 'cover', focusX: 50, focusY: 50 } };
let state = { title: '守住钱袋子 · 社区反诈提醒', source: '', generatedSource: '', sourceInfo: { name: '', url: '', publishedAt: '' }, aspectRatio: '16:9', theme: 'warm', style: 'illustration', accessible: true, scenes: [], activeScene: 0, step: 1, jobId: null, result: null };
let busy = false;
let previewSequence = 0;
let previewUrl = null;
let previewTimer;
let toastTimer;
let pollTimer;
let playback = null;
let playbackRaf = 0;
let dragIndex = null;
let activeId = null;
let activeRevision = null;
let dirty = false;
let storeState = 'loading';
let saveError = null;
let saveTimer;
let saving = null;
let initializing = true;
const SAVED_TEXT = '已保存到本机项目库';
const UNSAVED_TEXT = '尚未保存，请先备份';
const thumbCache = new Map();
const auditionCache = new Map();
const sceneAudio = $('scene-audio');

function normalizeDraft(value) {
  const draft = { title: '守住钱袋子 · 社区反诈提醒', source: '', generatedSource: '', sourceInfo: { name: '', url: '', publishedAt: '' }, aspectRatio: '16:9', theme: 'warm', style: 'illustration', accessible: true, scenes: [], activeScene: 0, step: 1, jobId: null, result: null, ...value };
  draft.title = String(draft.title || '').slice(0, 40);
  draft.source = String(draft.source || '');
  draft.generatedSource = String(draft.generatedSource || '');
  if (!['warm', 'teal', 'bold'].includes(draft.theme)) draft.theme = 'warm';
  if (!STYLES[draft.style]) draft.style = 'illustration';
  if (!['16:9', '9:16'].includes(draft.aspectRatio)) draft.aspectRatio = '16:9';
  if (!draft.sourceInfo || typeof draft.sourceInfo !== 'object') draft.sourceInfo = { name: '', url: '', publishedAt: '' };
  draft.accessible = Boolean(draft.accessible);
  draft.scenes = Array.isArray(draft.scenes) ? draft.scenes.slice(0, 8) : [];
  for (const scene of draft.scenes) {
    scene.title = String(scene.title || '');
    scene.narration = String(scene.narration || '');
    scene.source = String(scene.source || '');
    if (!scene.visual) {
      scene.visual = defaultVisual(draft.style === 'noir' ? 'title' : 'tip', scene.title, draft.style);
      scene.reviewed = false;
      draft.result = null;
    } else {
      const converted = convertVisual(scene.visual, draft.style);
      if (converted.kind !== scene.visual.kind) scene.reviewed = false;
      scene.visual = converted;
    }
    scene.reviewed = Boolean(scene.reviewed);
  }
  draft.step = [1, 2, 3].includes(draft.step) ? draft.step : 1;
  draft.activeScene = Math.max(0, Math.min(Number(draft.activeScene) || 0, draft.scenes.length - 1));
  if (!draft.scenes.length || draft.source !== draft.generatedSource) draft.step = 1;
  if (!/^[a-f0-9]{32}$/.test(draft.jobId || '')) draft.jobId = null;
  if (draft.result && !/^\/files\/[a-f0-9]{32}\/video\.mp4$/.test(draft.result.video || '')) draft.result = null;
  return draft;
}

function randomHex32() { return crypto.randomUUID().replaceAll('-', ''); }

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function base64ToBytes(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function resolveImages() {
  const ids = [...new Set(state.scenes.map((scene) => scene.visual.imageId).filter(Boolean))];
  let changed = false;
  for (const id of ids) {
    const response = await fetch(`/assets/${id}.png`);
    if (response.ok) {
      if (storeState === 'ready' && !(await ProjectStore.getAsset(id))) await ProjectStore.putAsset(id, await response.blob());
      continue;
    }
    const blob = storeState === 'ready' ? await ProjectStore.getAsset(id) : null;
    if (blob) {
      const asset = await (await request('/api/assets', { image: await blobToBase64(blob) })).json();
      await ProjectStore.putAsset(asset.id, blob);
      for (const scene of state.scenes) if (scene.visual.imageId === id) scene.visual.imageId = asset.id;
      changed = true;
    } else {
      for (const scene of state.scenes) if (scene.visual.imageId === id) Object.assign(scene.visual, { imageId: null, imageName: '' });
      changed = true;
    }
  }
  if (changed) await flushSave();
}

async function migrateOrLoad() {
  let legacyRaw;
  try { legacyRaw = localStorage.getItem(STORAGE_KEY); }
  catch {
    // 旧键读取被禁用时，若项目库已有内容（例如迁移已完成），直接从项目库恢复。
    const active = await ProjectStore.getActive();
    if (active) {
      activeId = active.id;
      activeRevision = active.revision;
      state = normalizeDraft(active.draft);
      storeState = 'ready';
      saveError = null;
      return;
    }
    storeState = 'legacy-failed';
    saveError = { kind: 'legacy', message: '旧草稿读取失败，项目库保持为空；旧草稿仍保留在浏览器中，可重试迁移。' };
    return;
  }
  if (legacyRaw !== null) {
    let legacy;
    try {
      legacy = JSON.parse(legacyRaw);
      if (!legacy || typeof legacy !== 'object') throw new Error('invalid legacy draft');
    } catch {
      storeState = 'legacy-failed';
      saveError = { kind: 'legacy', message: '旧草稿读取失败，项目库保持为空；旧草稿仍保留在浏览器中，可重试迁移。' };
      return;
    }
    const record = await ProjectStore.create(normalizeDraft(legacy), { activate: true });
    localStorage.removeItem(STORAGE_KEY);
    activeId = record.id;
    activeRevision = record.revision;
    state = normalizeDraft(record.draft);
    storeState = 'ready';
    saveError = null;
    return;
  }
  const active = await ProjectStore.getActive();
  if (active) {
    activeId = active.id;
    activeRevision = active.revision;
    state = normalizeDraft(active.draft);
  } else {
    const record = await ProjectStore.create(normalizeDraft({}), { activate: true });
    activeId = record.id;
    activeRevision = record.revision;
    state = normalizeDraft(record.draft);
  }
  storeState = 'ready';
  saveError = null;
}

async function initStore() {
  try { await ProjectStore.open(); }
  catch {
    storeState = 'unopened';
    saveError = { kind: 'open', message: '无法打开本机项目库（存储被禁用或浏览器限制）；输入的内容仍保留在内存中，可下载救援备份。' };
  }
  if (storeState !== 'unopened') {
    try { await migrateOrLoad(); }
    catch {
      storeState = 'legacy-failed';
      saveError = { kind: 'quota', message: '浏览器存储空间不足或存储被禁用，旧草稿迁移未完成；旧草稿仍保留，可重试。' };
    }
  }
  if (storeState === 'ready') {
    await resolveImages();
    dirty = false;
    saveError = null;
  }
  initializing = false;
}

function notify(message, success = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('success', success);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}

function refreshStatus() {
  $('save-status').textContent = storeState === 'ready' && !dirty && !saveError ? SAVED_TEXT : UNSAVED_TEXT;
}

function refreshEntrances() {
  const blocked = busy || initializing;
  for (const id of ['library-open', 'workspace-open', 'project-new', 'project-import-button', 'library-retry', 'project-rescue']) $(id).disabled = blocked;
  $('project-save').disabled = blocked || !activeId || storeState !== 'ready';
  document.querySelectorAll('[data-project-action]').forEach((button) => { button.disabled = blocked; });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  if (storeState !== 'ready' || !activeId) return;
  saveTimer = setTimeout(() => { flushSave(); }, 300);
}

function save() {
  dirty = true;
  refreshStatus();
  scheduleSave();
}

function flushSave() {
  clearTimeout(saveTimer);
  if (storeState !== 'ready' || !activeId) { refreshStatus(); return Promise.resolve(false); }
  // 串行排队：上一次落盘期间的修改不能丢弃，必须接着再存一次。
  const attempt = async () => {
    try {
      const record = await ProjectStore.save(activeId, state, activeRevision);
      activeRevision = record.revision;
      dirty = false;
      saveError = null;
      refreshStatus();
      refreshEntrances();
      if (!$('project-library').hidden) renderLibrary();
      return true;
    } catch (error) {
      dirty = true;
      saveError = error.code === 'conflict' || error.code === 'missing'
        ? { kind: 'conflict', message: '其他标签页修改或删除了当前项目，已保存内容未被覆盖；未保存的修改仍在内存中，可下载救援备份后刷新恢复。' }
        : { kind: 'quota', message: '浏览器存储空间不足或存储被禁用，修改仍保留在内存中；可下载救援备份，释放空间后重试。' };
      refreshStatus();
      refreshEntrances();
      if (!$('project-library').hidden) renderLibrary();
      return false;
    }
  };
  saving = (saving || Promise.resolve()).then(attempt, attempt);
  return saving;
}

async function request(path, payload) {
  const response = await fetch(path, payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zhiying-Local': '1' }, body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const data = await response.json();
    const error = new Error(data.error || '本地请求失败，请重试。');
    error.status = response.status;
    throw error;
  }
  return response;
}

function payload() {
  return { title: state.title, theme: state.theme, style: state.style, accessible: state.accessible, scenes: state.scenes };
}

function reviewedCount() { return state.scenes.filter((s) => s.reviewed).length; }
function estimatedSeconds() {
  return Math.round(state.scenes.reduce((total, scene) => total + scene.narration.length, 0) / (state.accessible ? 3.3 : 4.5));
}
function displayDuration(seconds) {
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒` : `${Math.round(seconds)} 秒`;
}

function sceneSeconds(scene) {
  return scene.narration.length / (state.accessible ? 3.3 : 4.5);
}

function stopPlayback() {
  if (!playback) return;
  playback = null;
  cancelAnimationFrame(playbackRaf);
  sceneAudio.pause();
  sceneAudio.removeAttribute('src');
  sceneAudio.load();
  $('playback-badge').hidden = true;
  $('playback-status').textContent = '';
  updateTransport();
}

function updateTransport() {
  const canPlay = !busy && state.scenes.length > 0 && state.source === state.generatedSource && !state.result;
  $('play-preview').disabled = !canPlay;
  $('audition-scene').disabled = !canPlay;
  const playing = Boolean(playback);
  $('play-preview').querySelector('span').textContent = playing && playback.mode === 'continuous' ? '停止预览' : '连续预览';
  $('audition-scene').lastChild.textContent = playing && playback.mode === 'audition' ? '停止试听' : '试听本幕';
}

async function loadSceneMedia(index) {
  const scene = state.scenes[index];
  const auditionKey = `${state.accessible}:${scene.narration}`;
  let audition = auditionCache.get(auditionKey);
  const framesPromise = request('/api/frames', { ...payload(), index }).then((response) => response.json());
  if (!audition) {
    audition = await (await request('/api/audition', { narration: scene.narration, accessible: state.accessible })).json();
    auditionCache.set(auditionKey, audition);
  }
  const frames = await framesPromise;
  return { frames: frames.frames, audioUrl: audition.url, duration: audition.duration };
}

function frameForProgress(frames, progress) {
  let chosen = frames[0];
  for (const frame of frames) {
    if (frame.at <= progress + 0.0001) chosen = frame;
    else break;
  }
  return chosen;
}

async function playScene(index, mode) {
  stopPlayback();
  const token = { mode, index, cancelled: false };
  playback = token;
  updateTransport();
  $('playback-badge').hidden = false;
  $('playback-status').textContent = `正在准备第 ${index + 1} 幕本机配音…`;
  $('preview-image').hidden = false;
  $('result-video').hidden = true;
  let media;
  try {
    media = await loadSceneMedia(index);
  } catch (error) {
    if (playback === token) {
      stopPlayback();
      notify(error.status ? error.message : '无法生成本机试听，请确认本地服务运行中。');
    }
    return;
  }
  if (playback !== token) return;
  state.activeScene = index;
  renderEditor();
  updateNavigation();
  renderTimeline();
  save();
  token.frames = media.frames;
  token.frameUrl = null;
  sceneAudio.src = media.audioUrl;
  $('playback-status').textContent = mode === 'continuous' ? `连续预览 · 第 ${index + 1} / ${state.scenes.length} 幕` : `试听第 ${index + 1} 幕`;
  const tick = () => {
    if (playback !== token) return;
    const duration = sceneAudio.duration;
    if (duration > 0) {
      const frame = frameForProgress(token.frames, sceneAudio.currentTime / duration);
      if (frame.url !== token.frameUrl) {
        token.frameUrl = frame.url;
        $('preview-image').src = frame.url;
        $('preview-empty').hidden = true;
        document.querySelector('.preview-screen').classList.remove('invalid', 'loading');
      }
    }
    playbackRaf = requestAnimationFrame(tick);
  };
  sceneAudio.onended = () => {
    if (playback !== token) return;
    if (mode === 'continuous' && index + 1 < state.scenes.length) {
      playScene(index + 1, mode);
    } else {
      stopPlayback();
      schedulePreview();
    }
  };
  sceneAudio.onerror = () => {
    if (playback === token) {
      stopPlayback();
      notify('本机配音无法播放，请重试。');
    }
  };
  try {
    await sceneAudio.play();
    playbackRaf = requestAnimationFrame(tick);
  } catch {
    if (playback === token) {
      stopPlayback();
      notify('浏览器阻止了自动播放，请再点击一次试听或预览。');
    }
  }
}

function toggleContinuous() {
  if (busy || !state.scenes.length) return;
  if (playback && playback.mode === 'continuous') {
    stopPlayback();
    schedulePreview();
    return;
  }
  playScene(state.activeScene, 'continuous');
}

function toggleAudition() {
  if (busy || !state.scenes.length) return;
  if (playback && playback.mode === 'audition') {
    stopPlayback();
    schedulePreview();
    return;
  }
  playScene(state.activeScene, 'audition');
}

function clearResultDom() {
  const video = $('result-video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.hidden = true;
  $('export-success').hidden = true;
  for (const id of ['download-video', 'download-subtitles', 'download-script']) $(id).removeAttribute('href');
  $('preview-image').hidden = false;
  $('preview-title').textContent = '画面预览';
}

function invalidateResult() {
  stopPlayback();
  if (state.result) {
    state.result = null;
    state.jobId = null;
    $('result-video').pause();
    $('result-video').removeAttribute('src');
    $('result-video').load();
  }
  $('export-success').hidden = true;
  for (const id of ['download-video', 'download-subtitles', 'download-script']) $(id).removeAttribute('href');
  $('result-video').hidden = true;
  $('preview-image').hidden = false;
  $('preview-title').textContent = '画面预览';
}

function updateNavigation() {
  const hasScenes = state.scenes.length > 0 && state.source === state.generatedSource;
  for (let i = 1; i <= 3; i++) {
    $(`step-${i}`).classList.toggle('active', state.step === i);
    $(`step-${i}`).classList.toggle('done', state.step > i);
    $(`step-${i}`).setAttribute('aria-current', state.step === i ? 'step' : 'false');
    $(`step-${i}`).disabled = busy || (i > 1 && !hasScenes);
    $(`panel-${i}`).hidden = state.step !== i;
  }
  $('previous-scene').disabled = busy || state.activeScene === 0 || !hasScenes;
  $('next-scene').disabled = busy || !hasScenes || state.activeScene >= state.scenes.length - 1;
  $('move-earlier').disabled = busy || state.activeScene === 0 || !hasScenes;
  $('move-later').disabled = busy || !hasScenes || state.activeScene >= state.scenes.length - 1;
}

function setStep(step) {
  if (busy) return;
  if (step > 1 && (!state.scenes.length || state.source !== state.generatedSource)) {
    notify('请先根据当前资料整理分镜草稿。');
    return;
  }
  stopPlayback();
  state.step = step;
  updateNavigation();
  if (step === 2) renderEditor();
  if (step === 3) { renderExport(); refreshUsage(); }
  showOutputIfReady();
  save();
  document.querySelector('.workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderSceneList() {
  $('scene-list').replaceChildren();
  state.scenes.forEach((scene, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `scene-item${index === state.activeScene ? ' active' : ''}${scene.reviewed ? ' reviewed' : ''}`;
    button.setAttribute('aria-label', `第 ${index + 1} 幕 ${scene.title}，${scene.reviewed ? '已核对' : '待核对'}`);
    button.setAttribute('aria-pressed', String(index === state.activeScene));
    for (const [className, text] of [['scene-number', String(index + 1).padStart(2, '0')], ['scene-name', scene.title || '未命名分镜'], ['review-state', scene.reviewed ? '✓' : '○']]) {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      button.append(span);
    }
    const copy = document.createElement('span');
    copy.className = 'scene-copy';
    copy.append(button.querySelector('.scene-name'));
    const kind = document.createElement('small');
    kind.className = 'scene-kind';
    kind.textContent = `${kindLabel(scene.visual.kind)}${scene.visual.imageId ? ' · 本机图片' : ''}`;
    copy.append(kind);
    button.insertBefore(copy, button.querySelector('.review-state'));
    button.disabled = busy;
    button.addEventListener('click', () => selectScene(index));
    $('scene-list').append(button);
  });
  $('review-count').textContent = `${reviewedCount()} / ${state.scenes.length} 已核对`;
}

function renderEditor() {
  if (!state.scenes.length) return;
  const scene = state.scenes[state.activeScene];
  $('scene-title').value = scene.title;
  $('scene-narration').value = scene.narration;
  $('source-quote').textContent = scene.source;
  $('scene-reviewed').checked = Boolean(scene.reviewed);
  $('scene-label').textContent = `第 ${state.activeScene + 1} 幕`;
  $('narration-count').textContent = `${scene.narration.length} / 300 字`;
  renderVisualEditor();
  renderSceneList();
}

function renderVisualEditor() {
  const visual = state.scenes[state.activeScene].visual;
  $('kind-library-note').textContent = `当前风格库：${STYLES[state.style]} · 道具可自主更换`;
  renderKindPicker(visual);
  $('visual-text-row').hidden = state.style === 'noir' && visual.kind === 'stack';
  $('visual-text').value = visual.text;
  $('visual-text-count').textContent = `${visual.text.length} / 60 字`;
  renderPropParams(visual);
  const hasImage = /^[a-f0-9]{32}$/.test(visual.imageId || '');
  $('asset-thumbnail').hidden = !hasImage;
  if (hasImage) {
    const source = `/assets/${visual.imageId}.png`;
    if ($('asset-thumbnail').getAttribute('src') !== source) $('asset-thumbnail').src = source;
  } else {
    $('asset-thumbnail').removeAttribute('src');
  }
  $('asset-name').textContent = hasImage ? visual.imageName || '本机图片' : (state.style === 'noir' ? '正在使用发光道具' : '正在使用情景插画');
  $('asset-status').textContent = hasImage ? '本地副本已保存 · 不修改原文件' : 'PNG / JPEG / WebP，最大 4 MB';
  $('choose-image').textContent = hasImage ? '替换本机图片' : '选择本机图片';
  $('remove-image').hidden = !hasImage;
  $('image-adjustments').hidden = !hasImage;
  $('crop-controls').hidden = visual.fit !== 'cover';
  document.querySelectorAll('[name=image-fit]').forEach((input) => { input.checked = input.value === visual.fit; });
  $('image-focus-x').value = visual.focusX;
  $('image-focus-y').value = visual.focusY;
  $('focus-x-value').textContent = `${visual.focusX}%`;
  $('focus-y-value').textContent = `${visual.focusY}%`;
}

function renderKindPicker(visual) {
  const box = $('scenario-options');
  box.replaceChildren();
  for (const [kind, label] of Object.entries(styleKinds(state.style))) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.kind = kind;
    button.classList.toggle('selected', kind === visual.kind);
    button.setAttribute('aria-pressed', String(kind === visual.kind));
    const glyph = document.createElement('span');
    glyph.className = 'scenario-glyph';
    glyph.textContent = KIND_GLYPHS[kind] || 'i';
    const strong = document.createElement('strong');
    strong.textContent = label;
    const small = document.createElement('small');
    small.textContent = KIND_HINTS[kind] || '';
    button.append(glyph, strong, small);
    button.addEventListener('click', () => chooseKind(kind));
    box.append(button);
  }
}

function chooseKind(kind) {
  const scene = state.scenes[state.activeScene];
  if (scene.visual.kind === kind) return;
  const previous = scene.visual;
  const fresh = defaultVisual(kind, previous.text, state.style);
  fresh.keywords = previous.keywords || [];
  fresh.imageId = previous.imageId; fresh.imageName = previous.imageName; fresh.fit = previous.fit;
  fresh.focusX = previous.focusX; fresh.focusY = previous.focusY;
  scene.visual = fresh;
  renderVisualEditor();
  markSceneChanged();
  if (fresh.imageId) notify('已更换道具；当前仍使用本机图片，点击“恢复情景插画”可显示道具画面。', true);
}

function paramField(labelText, input) {
  const wrap = document.createElement('label');
  wrap.className = 'param-field';
  const span = document.createElement('span');
  span.className = 'field-label';
  span.textContent = labelText;
  wrap.append(span, input);
  return wrap;
}

function renderPropParams(visual) {
  const box = $('prop-params');
  box.replaceChildren();
  const changed = () => markSceneChanged();
  const textInput = (value, max, onInput) => {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = max;
    input.value = value || '';
    input.addEventListener('input', () => onInput(input.value));
    return input;
  };
  const numberInput = (value, min, max, step, onInput) => {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = min; input.max = max; input.step = step;
    input.value = value;
    input.addEventListener('input', () => {
      const number = Number(input.value);
      if (input.value !== '' && Number.isFinite(number)) onInput(Math.max(min, Math.min(max, number)));
    });
    return input;
  };
  if (state.style === 'noir') {
    if (visual.kind === 'title' || visual.kind === 'receipt' || visual.kind === 'loop') {
      const label = visual.kind === 'loop' ? '计数单位' : '副标题小字';
      box.append(paramField(label, textInput(visual.sub, 40, (value) => { visual.sub = value; changed(); })));
    }
    if (visual.kind === 'battery') {
      const row = document.createElement('div');
      row.className = 'param-row';
      row.append(paramField('起始百分比', numberInput(visual.from, 0, 100, 1, (value) => { visual.from = Math.round(value); changed(); })),
        paramField('结束百分比', numberInput(visual.to, 0, 100, 1, (value) => { visual.to = Math.round(value); changed(); })));
      box.append(row);
    }
    if (visual.kind === 'loop') {
      box.append(paramField('计数目标', numberInput(visual.target, 0, 9999, 0.5, (value) => { visual.target = value; changed(); })));
    }
    if (visual.kind === 'stack') {
      visual.steps = [...(visual.steps || []), '', '', '', ''].slice(0, 4);
      const row = document.createElement('div');
      row.className = 'param-row four';
      for (let i = 0; i < 4; i += 1) {
        row.append(paramField(`步骤 ${i + 1}`, textInput(visual.steps[i], 14, (value) => {
          visual.steps[i] = value;
          changed();
        })));
      }
      box.append(row);
      box.append(paramField('红色打断文字（覆盖第一步，可留空）', textInput(visual.interrupt, 20, (value) => { visual.interrupt = value; changed(); })));
    }
    if (visual.kind === 'receipt') {
      visual.items = [...(visual.items || []), { label: '', value: '' }, { label: '', value: '' }, { label: '', value: '' }].slice(0, 3);
      for (let i = 0; i < 3; i += 1) {
        const row = document.createElement('div');
        row.className = 'param-row';
        const item = visual.items[i];
        row.append(paramField(`条目 ${i + 1} 名称`, textInput(item.label, 12, (value) => {
          visual.items[i] = { label: value, value: visual.items[i].value };
          changed();
        })), paramField('条目值', textInput(item.value, 12, (value) => {
          visual.items[i] = { label: visual.items[i].label, value };
          changed();
        })));
        box.append(row);
      }
      const note = document.createElement('p');
      note.className = 'micro-note';
      note.textContent = '最后一条会以红色警示带显示；留空名称的条目不显示。';
      box.append(note);
    }
  }
  box.append(paramField('字幕标红关键词（空格或逗号分隔，最多 3 个）', textInput((visual.keywords || []).join(' '), 40, (value) => {
    visual.keywords = value.split(/[,，\s]+/).filter(Boolean).slice(0, 3).map((word) => word.slice(0, 12));
    changed();
  })));
}

function markSceneChanged() {
  state.scenes[state.activeScene].reviewed = false;
  $('scene-reviewed').checked = false;
  invalidateResult();
  renderSceneList();
  schedulePreview();
  save();
}

function setEditorTab(tab) {
  for (const name of ['script', 'visual']) {
    const selected = name === tab;
    $(`tab-${name}`).classList.toggle('selected', selected);
    $(`tab-${name}`).setAttribute('aria-selected', String(selected));
    $(`tab-${name}`).tabIndex = selected ? 0 : -1;
    $(`edit-${name}`).hidden = !selected;
  }
}

function reorderScene(from, to) {
  if (busy || from === to || from < 0 || to < 0 || from >= state.scenes.length || to >= state.scenes.length) return;
  const scene = state.scenes.splice(from, 1)[0];
  state.scenes.splice(to, 0, scene);
  state.activeScene = to;
  state.scenes.forEach((item) => { item.reviewed = false; });
  invalidateResult();
  renderEditor();
  updateNavigation();
  schedulePreview();
  save();
  notify('分镜顺序已调整，请重新核对整体表达。', true);
}

function moveScene(offset) {
  reorderScene(state.activeScene, state.activeScene + offset);
}

function selectScene(index) {
  if (busy || index < 0 || index >= state.scenes.length) return;
  stopPlayback();
  state.activeScene = index;
  renderEditor();
  updateNavigation();
  schedulePreview();
  save();
}

function sceneKey(scene, index) {
  return JSON.stringify([index, state.theme, state.style, state.accessible, scene.title, scene.narration, scene.visual]);
}

function loadThumbnail(img, scene, index) {
  const key = sceneKey(scene, index);
  const cached = thumbCache.get(key);
  if (cached) {
    img.src = cached;
    return;
  }
  if (state.scenes.some((item) => !item.title.trim() || !item.narration.trim())) return;
  request('/api/preview', { ...payload(), index }).then((response) => response.blob()).then((blob) => {
    const url = URL.createObjectURL(blob);
    thumbCache.set(key, url);
    if (thumbCache.size > 40) {
      const oldest = thumbCache.keys().next().value;
      URL.revokeObjectURL(thumbCache.get(oldest));
      thumbCache.delete(oldest);
    }
    if (img.isConnected && sceneKey(state.scenes[index], index) === key) img.src = url;
  }).catch(() => {});
}

function renderTimeline() {
  const timeline = $('preview-timeline');
  timeline.replaceChildren();
  state.scenes.forEach((scene, index) => {
    const card = document.createElement('div');
    card.className = `timeline-card${index === state.activeScene ? ' active' : ''}`;
    card.setAttribute('role', 'button');
    card.tabIndex = busy ? -1 : 0;
    card.setAttribute('aria-label', `第 ${index + 1} 幕 ${scene.title}，${scene.reviewed ? '已核对' : '待核对'}，可拖动排序`);
    card.setAttribute('aria-disabled', String(busy));
    card.draggable = !busy;
    const thumb = document.createElement('img');
    thumb.className = 'timeline-thumb';
    thumb.alt = '';
    loadThumbnail(thumb, scene, index);
    const meta = document.createElement('div');
    meta.className = 'timeline-meta';
    const num = document.createElement('span');
    num.className = 'timeline-num';
    num.textContent = String(index + 1).padStart(2, '0');
    const title = document.createElement('span');
    title.className = 'timeline-title';
    title.textContent = scene.title || '未命名';
    meta.append(num, title);
    const sub = document.createElement('div');
    sub.className = 'timeline-sub';
    const kind = document.createElement('span');
    kind.textContent = `${kindLabel(scene.visual.kind)} · 约${Math.max(1, Math.round(sceneSeconds(scene)))}秒`;
    const mark = document.createElement('span');
    mark.className = scene.reviewed ? 'reviewed-mark' : '';
    mark.textContent = scene.reviewed ? '✓ 已核对' : '○ 待核对';
    sub.append(kind, mark);
    card.append(thumb, meta, sub);
    card.addEventListener('click', () => { if (!busy) selectScene(index); });
    card.addEventListener('keydown', (event) => {
      if (busy) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectScene(index); }
      if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); reorderScene(index, index - 1); }
      if (event.key === 'ArrowRight' && index < state.scenes.length - 1) { event.preventDefault(); reorderScene(index, index + 1); }
    });
    card.addEventListener('dragstart', (event) => {
      if (busy) return event.preventDefault();
      dragIndex = index;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      dragIndex = null;
      card.classList.remove('dragging');
      timeline.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
    card.addEventListener('dragover', (event) => {
      if (busy || dragIndex === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      card.classList.add('drop-target');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      card.classList.remove('drop-target');
      const from = dragIndex;
      if (from !== null && from !== index) reorderScene(from, index);
    });
    timeline.append(card);
  });
  $('preview-position').textContent = state.result && state.step === 3
    ? `完整成片 · ${state.scenes.length} 个分镜`
    : state.scenes.length ? `${String(state.activeScene + 1).padStart(2, '0')} / ${String(state.scenes.length).padStart(2, '0')} 幕` : '示例画面 · 非最终视频';
  $('estimated-time').textContent = state.result && state.step === 3
    ? `成片 ${displayDuration(state.result.duration)}`
    : state.scenes.length ? `预计 ${displayDuration(estimatedSeconds())}` : '时长随资料变化';
  $('voice-label').textContent = state.accessible ? '慢速中文配音' : '标准中文配音';
  $('voice-label').parentElement.nextElementSibling.lastChild.textContent = state.accessible ? '大字幕' : '标准字幕';
  updateTransport();
}

function schedulePreview() {
  clearTimeout(previewTimer);
  const sequence = ++previewSequence;
  renderTimeline();
  document.querySelector('.preview-screen').classList.add('loading');
  previewTimer = setTimeout(() => updatePreview(sequence), 220);
}

function previewError(message) {
  document.querySelector('.preview-screen').classList.add('invalid');
  $('preview-empty').textContent = message;
  $('preview-empty').hidden = false;
  $('preview-caption').textContent = message;
}

async function updatePreview(sequence) {
  if (playback) return;
  try {
    const scenes = state.scenes.length ? state.scenes : [DEMO];
    if (scenes.some((scene) => !scene.title.trim() || !scene.narration.trim())) {
      previewError('请补齐所有分镜的标题和配音后查看更新');
      return;
    }
    const response = await request('/api/preview', { ...payload(), title: state.title.trim() || '未命名短片', scenes, index: state.scenes.length ? state.activeScene : 0 });
    const blob = await response.blob();
    if (sequence !== previewSequence || playback) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    $('preview-image').src = previewUrl;
    $('preview-empty').hidden = true;
    document.querySelector('.preview-screen').classList.remove('invalid');
    $('preview-caption').textContent = '画面与导出一致；当前预览显示第一段字幕';
    showOutputIfReady();
  } catch (error) {
    if (sequence === previewSequence) previewError(error.status ? error.message : '画面暂时无法更新，请确认本地服务仍在运行');
  } finally {
    if (sequence === previewSequence) document.querySelector('.preview-screen').classList.remove('loading');
  }
}

function renderExport() {
  $('export-title').textContent = state.title;
  $('export-meta').textContent = `${state.scenes.length} 个分镜 · 预计 ${displayDuration(estimatedSeconds())} · ${state.accessible ? '适老模式' : '标准模式'}`;
  const remaining = state.scenes.length - reviewedCount();
  $('export-review').textContent = remaining ? `还有 ${remaining} 幕待核对，确认后才能开始合成` : '全部分镜已经人工确认';
  $('export-button').disabled = busy || remaining > 0;
  $('export-button').hidden = Boolean(state.result);
  if (!busy && !state.result) $('export-button').textContent = state.jobId ? '重新连接制作任务' : '开始本地合成';
  showOutputIfReady();
}

function showOutputIfReady() {
  const visible = Boolean(state.result && state.step === 3);
  $('result-video').hidden = !visible;
  $('preview-image').hidden = visible;
  $('preview-title').textContent = visible ? '成片播放' : '画面预览';
  $('previous-scene').hidden = visible;
  $('next-scene').hidden = visible;
  $('preview-timeline').hidden = visible;
  $('preview-position').parentElement.classList.toggle('full-film-label', visible);
  if (!visible) {
    $('result-video').pause();
    renderTimeline();
    return;
  }
  $('preview-position').textContent = `完整成片 · ${state.scenes.length} 个分镜`;
  const result = state.result;
  $('export-success').hidden = false;
  $('render-progress').hidden = true;
  $('export-button').hidden = true;
  $('result-details').textContent = `${displayDuration(result.duration)} · ${(result.size / 1024 / 1024).toFixed(1)} MB · 已保存到本机`;
  if ($('result-video').getAttribute('src') !== result.video) $('result-video').src = result.video;
  $('download-video').href = result.video;
  $('download-subtitles').href = result.video.replace('video.mp4', 'subtitles.srt');
  $('download-script').href = result.video.replace('video.mp4', 'script.txt');
  $('preview-caption').textContent = '点击播放器播放，可拖动进度并调节音量';
  $('estimated-time').textContent = `成片 ${displayDuration(result.duration)}`;
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function refreshUsage() {
  const row = $('storage-row');
  try {
    const usage = await (await request('/api/usage')).json();
    $('storage-summary').textContent = `本机占用：成片 ${formatBytes(usage.exports.bytes)}（${usage.exports.completed} 支已完成）· `
      + `预览缓存 ${formatBytes(usage.previews.bytes)} · 配音缓存 ${formatBytes(usage.auditions.bytes)} · 图片副本 ${formatBytes(usage.assets.bytes)}`;
    row.hidden = false;
  } catch (error) {
    row.hidden = true;
  }
}

function setBusy(value) {
  busy = value;
  if (value) stopPlayback();
  document.querySelectorAll('.workspace button, .workspace input, .workspace textarea, #clear-draft').forEach((element) => { element.disabled = value; });
  document.querySelectorAll('[data-project-action]').forEach((button) => { button.disabled = value; });
  updateNavigation();
  updateTransport();
  refreshEntrances();
  if (!value) {
    if (state.scenes.length) { renderVisualEditor(); renderTimeline(); }
    renderExport();
  }
}

async function pollJob() {
  clearTimeout(pollTimer);
  if (!state.jobId) return;
  try {
    const job = await (await request(`/api/jobs/${state.jobId}`)).json();
    $('render-progress').hidden = false;
    $('progress-message').textContent = job.message;
    $('progress-value').textContent = `${job.progress}%`;
    $('progress-bar').value = job.progress;
    if (job.status === 'completed') {
      state.result = job;
      state.jobId = null;
      setBusy(false);
      save();
      notify('视频已生成，可直接播放或下载 MP4。', true);
      return;
    }
    if (job.status === 'failed') {
      state.jobId = null;
      setBusy(false);
      save();
      notify(job.message);
      return;
    }
    pollTimer = setTimeout(pollJob, 1200);
  } catch (error) {
    if (error.status === 404) state.jobId = null;
    setBusy(false);
    save();
    $('progress-message').textContent = '连接中断，任务可能仍在本机运行。';
    notify(error.status === 404 ? '服务已重启，任务记录已清空；已有导出文件仍在 exports 目录。' : '无法连接本地服务，请恢复服务后点击“重新连接制作任务”。');
  }
}

$('source-input').value = state.source;
$('project-title').value = state.title;
$('source-count').textContent = state.source.length;
$('accessible-mode').checked = state.accessible;

$('source-input').addEventListener('input', (event) => {
  state.source = event.target.value;
  $('source-count').textContent = state.source.length;
  invalidateResult();
  updateNavigation();
  save();
});
$('project-title').addEventListener('input', (event) => {
  state.title = event.target.value.slice(0, 40);
  event.target.value = state.title;
  invalidateResult();
  save();
});
$('sample-button').addEventListener('click', () => {
  if (state.source.trim() && state.source !== SAMPLE && !confirm('用反诈示例替换当前资料？现有资料将被替换。')) return;
  state.source = SAMPLE;
  $('source-input').value = SAMPLE;
  $('source-count').textContent = SAMPLE.length;
  invalidateResult();
  updateNavigation();
  save();
  notify('已填入演示资料，请在下一步逐幕核对。', true);
});

function renderTheme() {
  document.querySelectorAll('[data-theme]').forEach((button) => {
    button.classList.toggle('selected', state.theme === button.dataset.theme);
    button.setAttribute('aria-pressed', String(state.theme === button.dataset.theme));
  });
}
document.querySelectorAll('[data-theme]').forEach((button) => button.addEventListener('click', () => {
  state.theme = button.dataset.theme;
  renderTheme();
  invalidateResult();
  schedulePreview();
  save();
}));
$('accessible-mode').addEventListener('change', (event) => {
  state.accessible = event.target.checked;
  invalidateResult();
  schedulePreview();
  save();
});

function renderStyle() {
  document.querySelectorAll('[data-style]').forEach((button) => {
    button.classList.toggle('selected', state.style === button.dataset.style);
    button.setAttribute('aria-pressed', String(state.style === button.dataset.style));
  });
  $('theme-row').hidden = state.style === 'noir';
  $('noir-note').hidden = state.style !== 'noir';
}
function switchStyle(next) {
  if (busy || next === state.style || !STYLES[next]) return;
  state.style = next;
  state.scenes.forEach((scene) => {
    scene.visual = convertVisual(scene.visual, next);
    scene.reviewed = false;
  });
  invalidateResult();
  renderStyle();
  if (state.scenes.length) renderEditor();
  updateNavigation();
  schedulePreview();
  save();
  notify(`已切换到「${STYLES[next]}」风格库；道具已按映射转换，全部核对状态已重置。`, true);
}
document.querySelectorAll('[data-style]').forEach((button) => button.addEventListener('click', () => switchStyle(button.dataset.style)));

$('story-button').addEventListener('click', () => {
  if (state.source.trim() && state.source !== STORY && !confirm('用刷单情景示例替换当前资料？原有分镜会保留，直到你确认重新整理。')) return;
  state.source = STORY;
  $('source-input').value = STORY;
  $('source-count').textContent = STORY.length;
  invalidateResult();
  updateNavigation();
  save();
  notify('已载入五幕情景示例，点击整理分镜即可编辑画面。', true);
});

for (const tab of ['script', 'visual']) {
  $(`tab-${tab}`).addEventListener('click', () => setEditorTab(tab));
  $(`tab-${tab}`).addEventListener('keydown', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 'script' : event.key === 'End' ? 'visual' : tab === 'script' ? 'visual' : 'script';
      setEditorTab(next);
      $(`tab-${next}`).focus();
    }
  });
}
$('move-earlier').addEventListener('click', () => moveScene(-1));
$('move-later').addEventListener('click', () => moveScene(1));
$('visual-text').addEventListener('input', (event) => {
  state.scenes[state.activeScene].visual.text = event.target.value;
  $('visual-text-count').textContent = `${event.target.value.length} / 60 字`;
  markSceneChanged();
});
$('choose-image').addEventListener('click', () => $('local-image').click());
$('local-image').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || busy) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return notify('请选择静态 PNG、JPEG 或 WebP 图片，不支持 SVG 或其他格式。');
  if (file.size > 4 * 1024 * 1024) return notify('图片不能超过 4 MB，请先缩小图片。');
  const scene = state.scenes[state.activeScene];
  setBusy(true);
  $('asset-status').textContent = '正在本机检查图片并保存副本…';
  try {
    const image = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('无法读取所选文件，请重新选择。'));
      reader.readAsDataURL(file);
    });
    const asset = await (await request('/api/assets', { image })).json();
    if (storeState === 'ready') await ProjectStore.putAsset(asset.id, file);
    Object.assign(scene.visual, { imageId: asset.id, imageName: file.name.slice(0, 120), fit: 'cover', focusX: 50, focusY: 50 });
    markSceneChanged();
    notify('图片副本已保存在本机，可调整取景；请重新核对这一幕。', true);
  } catch (error) {
    notify(error.message);
  } finally {
    setBusy(false);
    renderSceneList();
  }
});
$('remove-image').addEventListener('click', () => {
  Object.assign(state.scenes[state.activeScene].visual, { imageId: null, imageName: '', fit: 'cover', focusX: 50, focusY: 50 });
  renderVisualEditor();
  markSceneChanged();
});
document.querySelectorAll('[name=image-fit]').forEach((input) => input.addEventListener('change', () => {
  state.scenes[state.activeScene].visual.fit = input.value;
  renderVisualEditor();
  markSceneChanged();
}));
for (const [id, field, output] of [['image-focus-x', 'focusX', 'focus-x-value'], ['image-focus-y', 'focusY', 'focus-y-value']]) {
  $(id).addEventListener('input', (event) => {
    state.scenes[state.activeScene].visual[field] = Number(event.target.value);
    $(output).textContent = `${event.target.value}%`;
    markSceneChanged();
  });
}
$('center-image').addEventListener('click', () => {
  Object.assign(state.scenes[state.activeScene].visual, { focusX: 50, focusY: 50 });
  renderVisualEditor();
  markSceneChanged();
});
$('asset-thumbnail').addEventListener('error', () => {
  $('asset-status').textContent = '图片不存在或无法读取，请重新选择或恢复情景插画。';
});

$('generate-button').addEventListener('click', async () => {
  if (!state.title.trim()) return notify('请先填写作品名称。');
  if (state.source.trim().length < 20) return notify('请填写至少 20 字的资料，或点击“填入反诈示例”。');
  if (state.scenes.length && !confirm('重新整理将替换当前分镜及核对状态，继续吗？')) return;
  setBusy(true);
  try {
    const data = await (await request('/api/draft', { source: state.source, style: state.style })).json();
    state.scenes = data.scenes;
    state.generatedSource = state.source;
    state.activeScene = 0;
    invalidateResult();
    setBusy(false);
    renderEditor();
    setStep(2);
    schedulePreview();
    notify(`已整理为 ${state.scenes.length} 幕，原文已保留，请逐幕核对。`, true);
  } catch (error) {
    setBusy(false);
    notify(error.message);
  }
});

for (const [id, key] of [['scene-title', 'title'], ['scene-narration', 'narration']]) {
  $(id).addEventListener('input', (event) => {
    const scene = state.scenes[state.activeScene];
    scene[key] = event.target.value;
    scene.reviewed = false;
    $('scene-reviewed').checked = false;
    $('narration-count').textContent = `${scene.narration.length} / 300 字`;
    invalidateResult();
    renderSceneList();
    schedulePreview();
    save();
  });
}
$('scene-reviewed').addEventListener('change', (event) => {
  const scene = state.scenes[state.activeScene];
  if (event.target.checked && (!scene.title.trim() || !scene.narration.trim())) {
    event.target.checked = false;
    return notify('请先填写本幕标题和配音。');
  }
  scene.reviewed = event.target.checked;
  invalidateResult();
  renderSceneList();
  save();
});

$('export-button').addEventListener('click', async () => {
  if (state.jobId) {
    setBusy(true);
    return pollJob();
  }
  if (!state.title.trim()) return notify('请返回资料页填写作品名称。');
  setBusy(true);
  $('render-progress').hidden = false;
  $('progress-bar').value = 0;
  $('progress-value').textContent = '0%';
  $('progress-message').textContent = '准备本地合成…';
  try {
    const result = await (await request('/api/export', payload())).json();
    state.jobId = result.id;
    save();
    await pollJob();
  } catch (error) {
    $('render-progress').hidden = true;
    setBusy(false);
    notify(error.message);
  }
});

document.querySelectorAll('[data-step]').forEach((button) => button.addEventListener('click', () => setStep(Number(button.dataset.step))));
let cleaningUp = false;
$('cleanup-button').addEventListener('click', async () => {
  if (busy || cleaningUp) return;
  if (!confirm('清理本机运行文件？\n\n将删除：超出保留上限的旧成片、未完成的半成品、超出容量上限的预览与配音缓存。\n不会删除：项目资料、图片副本和最近保留的成片。')) return;
  cleaningUp = true;
  $('cleanup-button').disabled = true;
  try {
    const result = await (await request('/api/cleanup', {})).json();
    notify(`已清理本机运行文件 ${formatBytes(result.freed)}。`, true);
    await refreshUsage();
  } catch (error) {
    notify(error instanceof TypeError ? '无法连接本地服务，请确认服务运行后重试。' : error.message);
  }
  $('cleanup-button').disabled = false;
  cleaningUp = false;
});
$('previous-scene').addEventListener('click', () => selectScene(state.activeScene - 1));
$('next-scene').addEventListener('click', () => selectScene(state.activeScene + 1));
$('play-preview').addEventListener('click', toggleContinuous);
$('audition-scene').addEventListener('click', toggleAudition);
$('back-source').addEventListener('click', () => setStep(1));
$('to-export').addEventListener('click', () => setStep(3));
$('back-scenes').addEventListener('click', () => setStep(2));
$('help-open').addEventListener('click', () => $('help-dialog').showModal());
$('help-close').addEventListener('click', () => $('help-dialog').close());
$('clear-draft').addEventListener('click', async () => {
  if (busy || !confirm('清空当前项目里的资料和分镜草稿？不会删除已导出的视频，也不会影响其他项目。')) return;
  state.source = '';
  state.generatedSource = '';
  state.scenes = [];
  state.activeScene = 0;
  state.step = 1;
  state.jobId = null;
  state.result = null;
  invalidateResult();
  applyStateToUi();
  dirty = true;
  refreshStatus();
  $('help-dialog').close();
  await flushSave();
});
$('result-video').addEventListener('error', () => {
  if ($('result-video').hidden) return;
  state.result = null;
  state.jobId = null;
  clearResultDom();
  renderExport();
  save();
  notify('成片文件已被清理或移动，无法载入；可返回修改后重新合成。');
});

function applyStateToUi() {
  $('source-input').value = state.source;
  $('project-title').value = state.title;
  $('source-count').textContent = state.source.length;
  $('accessible-mode').checked = state.accessible;
  renderStyle();
  renderTheme();
  renderSceneList();
  if (state.scenes.length) renderEditor();
  else {
    $('scene-title').value = '';
    $('scene-narration').value = '';
    $('source-quote').textContent = '';
    $('scene-reviewed').checked = false;
    $('narration-count').textContent = '0 / 300 字';
  }
  updateNavigation();
  renderExport();
  schedulePreview();
  showOutputIfReady();
}

async function renderLibrary() {
  const rows = storeState === 'ready' ? await ProjectStore.list() : [];
  $('library-count').textContent = `${rows.length} 个项目`;
  $('library-empty').hidden = rows.length > 0;
  $('current-project-name').textContent = activeId ? (rows.find((row) => row.id === activeId)?.draft.title || '未命名短片') : '未打开项目';
  const hasError = storeState !== 'ready' || Boolean(saveError);
  $('library-error').hidden = !hasError;
  $('library-error-message').textContent = saveError ? saveError.message : '项目库暂时不可用，请重试。';
  const list = $('library-list');
  list.replaceChildren();
  for (const row of rows) {
    const card = document.createElement('article');
    card.className = `project-card${row.id === activeId ? ' project-card-current' : ''}`;
    card.dataset.projectId = row.id;
    const head = document.createElement('div');
    head.className = 'project-card-head';
    const title = document.createElement('strong');
    title.className = 'project-card-title';
    title.textContent = row.draft.title || '未命名短片';
    head.append(title);
    if (row.id === activeId) {
      const current = document.createElement('span');
      current.className = 'library-current-label';
      current.textContent = '当前项目';
      head.append(current);
    }
    const meta = document.createElement('small');
    meta.className = 'project-card-meta';
    meta.textContent = `${row.draft.scenes.length} 幕 · ${STYLES[row.draft.style] || '浅色插画'} · 更新于 ${new Date(row.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    const actions = document.createElement('div');
    actions.className = 'project-card-actions';
    for (const [verb, label] of [['open', '打开'], ['duplicate', '复制'], ['backup', '备份'], ['delete', '删除']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = verb === 'delete' ? 'text-button danger' : 'text-button';
      button.dataset.projectAction = verb;
      button.textContent = label;
      button.disabled = busy || initializing;
      button.addEventListener('click', () => projectAction(verb, row.id));
      actions.append(button);
    }
    card.append(head, meta, actions);
    list.append(card);
  }
  refreshEntrances();
}

async function openLibrary() {
  if (busy || initializing) return;
  stopPlayback();
  $('result-video').pause();
  await flushSave();
  await renderLibrary();
  $('workspace').hidden = true;
  $('project-library').hidden = false;
}

function closeLibrary() {
  $('project-library').hidden = true;
  $('workspace').hidden = false;
}

function guardSwitch() {
  if (storeState !== 'ready') { notify('请先重试打开项目库。'); return false; }
  if (dirty) { notify('当前修改尚未保存，请先保存或下载救援备份。'); return false; }
  return true;
}

async function projectAction(verb, id) {
  if (busy || initializing) return;
  if (storeState !== 'ready') return notify('请先重试打开项目库。');
  if (verb === 'backup') return backupProject(id);
  if (!guardSwitch()) return;
  if (verb === 'open') return openProject(id);
  if (verb === 'duplicate') return duplicateProject(id);
  if (verb === 'delete') return deleteProject(id);
}

async function openProject(id) {
  const record = await ProjectStore.get(id);
  if (!record) return notify('该项目已不存在，请刷新项目库。');
  stopPlayback();
  clearResultDom();
  await ProjectStore.activate(id);
  activeId = id;
  activeRevision = record.revision;
  state = normalizeDraft(record.draft);
  await resolveImages();
  dirty = false;
  saveError = null;
  closeLibrary();
  applyStateToUi();
  refreshStatus();
  refreshEntrances();
}

async function duplicateProject(id) {
  const record = await ProjectStore.get(id);
  if (!record) return;
  const copy = normalizeDraft(structuredClone(record.draft));
  copy.title = `${copy.title.slice(0, 35)} · 副本`;
  copy.jobId = null;
  copy.result = null;
  copy.scenes.forEach((scene) => { scene.reviewed = false; });
  await ProjectStore.create(copy);
  await renderLibrary();
  notify('已创建独立副本，核对状态已重置。', true);
}

async function deleteProject(id) {
  const record = await ProjectStore.get(id);
  if (!record) return;
  if (!confirm(`删除项目「${record.draft.title}」？删除后无法撤销，本项目的成片与未被其他项目引用的图片副本也会清理。`)) return;
  const orphanAssets = new Set((record.draft.scenes || []).map((scene) => scene.visual?.imageId).filter(Boolean));
  const jobId = /^[a-f0-9]{32}$/.test(record.draft.jobId || '') ? record.draft.jobId : null;
  await ProjectStore.remove(id);
  const rows = await ProjectStore.list();
  for (const row of rows) for (const scene of row.draft.scenes || []) orphanAssets.delete(scene.visual?.imageId);
  try {
    await request('/api/gc', { assets: [...orphanAssets], exports: jobId ? [jobId] : [] });
  } catch (error) {
    // 服务端不可用时仅清掉浏览器副本；磁盘孤儿文件由启动清理兜底。
  }
  if (activeId === id) {
    activeId = null;
    activeRevision = null;
    state = normalizeDraft({});
    dirty = false;
    saveError = null;
    stopPlayback();
    clearResultDom();
    applyStateToUi();
  }
  await renderLibrary();
  refreshStatus();
  refreshEntrances();
  notify('项目已从当前浏览器删除。', true);
}

async function buildBundle(draft) {
  const clean = normalizeDraft(structuredClone(draft));
  clean.jobId = null;
  clean.result = null;
  const ids = [...new Set(clean.scenes.map((scene) => scene.visual.imageId).filter(Boolean))];
  const assets = [];
  for (const id of ids) {
    const blob = await ProjectStore.getAsset(id);
    if (blob) assets.push({ id, mime: blob.type, data: await blobToBase64(blob) });
  }
  return { format: 'zhiying-project', version: 1, draft: clean, assets };
}

function downloadBundle(bundle) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(bundle.draft.title || '知映项目').slice(0, 40)}.zhiying.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function backupProject(id) {
  const record = await ProjectStore.get(id);
  if (!record) return;
  downloadBundle(await buildBundle(record.draft));
}

function validateImportDraft(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.title !== 'string' || value.title.length > 40) return null;
  if (typeof value.source !== 'string' || typeof value.generatedSource !== 'string') return null;
  if (!STYLES[value.style] || !['warm', 'teal', 'bold'].includes(value.theme)) return null;
  if (typeof value.accessible !== 'boolean' || !['16:9', '9:16'].includes(value.aspectRatio)) return null;
  if (value.sourceInfo && (typeof value.sourceInfo !== 'object' || (value.sourceInfo.url && !/^https?:\/\//.test(value.sourceInfo.url)))) return null;
  if (!Array.isArray(value.scenes) || value.scenes.length > 8) return null;
  for (const scene of value.scenes) {
    if (!scene || typeof scene !== 'object') return null;
    if (!['title', 'narration', 'source'].every((key) => typeof scene[key] === 'string')) return null;
    if (typeof scene.reviewed !== 'boolean') return null;
    const visual = scene.visual;
    if (!visual || typeof visual !== 'object' || !styleKinds(value.style)[visual.kind]) return null;
    if (!(visual.imageId === null || /^[a-f0-9]{32}$/.test(visual.imageId || ''))) return null;
    if (!['text', 'sub', 'interrupt', 'imageName'].every((key) => typeof visual[key] === 'string')) return null;
    if (!['cover', 'contain'].includes(visual.fit)) return null;
    if (!Array.isArray(visual.steps) || !visual.steps.every((step) => typeof step === 'string')) return null;
    if (!Array.isArray(visual.items) || !visual.items.every((item) => item && typeof item.label === 'string' && typeof item.value === 'string')) return null;
    if (!Array.isArray(visual.keywords) || !visual.keywords.every((word) => typeof word === 'string')) return null;
    if (![visual.from, visual.to, visual.target, visual.focusX, visual.focusY].every((number) => typeof number === 'number' && Number.isFinite(number))) return null;
  }
  return value;
}

async function importBundleFile(file) {
  if (busy || initializing) return;
  if (file.size > 48 * 1024 * 1024) return notify('项目备份不能超过 48 MB。');
  let value;
  try { value = JSON.parse(await file.text()); } catch { return notify('无法解析备份，请确认文件完整。'); }
  if (!value || value.format !== 'zhiying-project' || value.version !== 1) return notify('不支持这个项目备份格式或版本。');
  const draft = validateImportDraft(value.draft);
  if (!draft || !Array.isArray(value.assets)) return notify('项目内容格式不正确，已拒绝导入。');
  const prepared = [];
  for (const asset of value.assets) {
    if (!asset || !/^[a-f0-9]{32}$/.test(asset.id || '') || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime) || typeof asset.data !== 'string') return notify('图片格式不正确，仅支持 PNG / JPEG / WebP 备份。');
    let bytes;
    try { bytes = base64ToBytes(asset.data); } catch { return notify('图片格式不正确，无法解析图片数据。'); }
    if (bytes.length > 4 * 1024 * 1024) return notify('单张备份图片不能超过 4 MB。');
    const blob = new Blob([bytes], { type: asset.mime });
    try { const bitmap = await createImageBitmap(blob); bitmap.close(); } catch { return notify('无法解码的图片，或图片内容与声明的格式不一致。'); }
    prepared.push({ id: asset.id, blob });
  }
  if (storeState !== 'ready') return notify('请先重试打开项目库。');
  const clean = normalizeDraft(structuredClone(draft));
  clean.jobId = null;
  clean.result = null;
  clean.scenes.forEach((scene) => { scene.reviewed = false; });
  const provided = new Set(prepared.map((asset) => asset.id));
  for (const scene of clean.scenes) {
    if (scene.visual.imageId && !provided.has(scene.visual.imageId)) return notify('项目内容格式不正确，备份缺少图片副本。');
  }
  const idMap = new Map();
  for (const asset of prepared) {
    const newId = randomHex32();
    idMap.set(asset.id, newId);
    await ProjectStore.putAsset(newId, asset.blob);
  }
  for (const scene of clean.scenes) if (scene.visual.imageId) scene.visual.imageId = idMap.get(scene.visual.imageId);
  await ProjectStore.create(clean);
  await renderLibrary();
  notify('备份已作为新项目导入，核对状态已重置。', true);
}

$('project-save').addEventListener('click', () => { if (!busy) flushSave(); });
$('library-open').addEventListener('click', openLibrary);
$('workspace-open').addEventListener('click', () => { if (!busy && !initializing) closeLibrary(); });
$('project-new').addEventListener('click', async () => {
  if (busy || initializing) return;
  if (!guardSwitch()) return;
  const record = await ProjectStore.create(normalizeDraft({}), { activate: true });
  activeId = record.id;
  activeRevision = record.revision;
  state = normalizeDraft(record.draft);
  dirty = false;
  saveError = null;
  stopPlayback();
  clearResultDom();
  closeLibrary();
  applyStateToUi();
  refreshStatus();
  refreshEntrances();
});
$('project-import-button').addEventListener('click', () => { if (!busy && !initializing) $('project-import').click(); });
$('project-import').addEventListener('change', (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (file) importBundleFile(file);
});
$('project-rescue').addEventListener('click', async () => { if (!busy && !initializing) downloadBundle(await buildBundle(state)); });
$('library-retry').addEventListener('click', async () => {
  if (busy || initializing) return;
  if (storeState === 'ready') { await flushSave(); return; }
  if (dirty && !confirm('重试会重新打开项目库并载入已保存内容；当前修改尚未保存，请先备份未保存草稿。继续重试？')) return;
  try { await ProjectStore.open(); }
  catch {
    storeState = 'unopened';
    saveError = { kind: 'open', message: '无法打开本机项目库（存储被禁用或浏览器限制）；输入的内容仍保留在内存中，可下载救援备份。' };
    await renderLibrary();
    refreshStatus();
    return;
  }
  try { await migrateOrLoad(); }
  catch {
    storeState = 'legacy-failed';
    saveError = { kind: 'quota', message: '浏览器存储空间不足或存储被禁用，旧草稿迁移未完成；旧草稿仍保留，可重试。' };
  }
  if (storeState === 'ready') {
    await resolveImages();
    dirty = false;
    saveError = null;
    stopPlayback();
    clearResultDom();
    applyStateToUi();
  }
  await renderLibrary();
  refreshStatus();
  refreshEntrances();
});

setEditorTab('script');
refreshEntrances();
initStore().then(() => {
  applyStateToUi();
  refreshStatus();
  refreshEntrances();
  if (state.jobId) {
    state.step = 3;
    setBusy(true);
    pollJob();
  }
});
