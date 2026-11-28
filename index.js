/**
 * 生成通知（本地服务版）+ 自定义完成音效
 *
 * 一、通知：通过 POST /notify 由 Caddy 转发到本机通知服务，弹出 macOS 右上角通知。
 *     不依赖浏览器通知权限，因此即使页面在后台、或生成直接失败也能提醒。
 *
 * 二、音效：替换酒馆的完成音效（#audio_message_sound，默认 sounds/message.mp3）。
 *     音频存 IndexedDB（Blob），不进 settings.json；音量可调，覆盖酒馆写死的 0.8。
 */

import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const TAG = '[生成通知]';
const VERSION = 'v3.6.0-2026-11-28';

// =====================================================================
// 一、生成通知（原逻辑，未改动）
// =====================================================================

// 保留原始 fetch 引用，供发通知使用（避免触发下面的包装逻辑）
const origFetch = window.fetch;

// 防重复：同一状态在 1.5 秒内只发一次（多标签页/重复事件时兜底）
let lastSent = { status: '', at: 0 };

function sendNotify(payload) {
	const now = Date.now();
	if (payload.status === lastSent.status && now - lastSent.at < 1500) {
		return;
	}
	lastSent = { status: payload.status, at: now };
	try {
		origFetch.call(window, '/notify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			keepalive: true,
		}).catch(() => { /* 通知失败不影响主流程 */ });
	} catch (err) {
		console.warn(TAG, '发送通知异常:', err);
	}
}

const state = {
	running: false,
	stopped: false,
	failed: false,
	failSoundPlayed: false,
	httpStatus: 0,
	startLen: 0,
};

// ---------- 包装 fetch：失败立即通知 ----------
window.fetch = async function (...args) {
	const input = args[0];
	const url = typeof input === 'string' ? input : (input && input.url) || '';
	const response = await origFetch.apply(this, args);

	const isGenerate = url.includes('/api/backends/') && url.includes('/generate');
	if (!isGenerate || !state.running) {
		return response;
	}

	state.httpStatus = response.status;

	if (!response.ok) {
		let detail = '';
		let errorCode = '';
		let rawBody = '';
		try {
			const clone = response.clone();
			const text = await clone.text();
			rawBody = String(text).slice(0, 6000);
			try {
				const parsed = JSON.parse(text);
				errorCode = String(parsed.code || (parsed.error && parsed.error.code) || '');
				detail = parsed.message
					|| (parsed.error && parsed.error.message)
					|| (typeof parsed.error === 'string' ? parsed.error : '')
					|| '';
			} catch {
				detail = String(text).slice(0, 300);
			}
		} catch {
			// 读不到就算了
		}
		state.failed = true;
		// 注意：不能在这里发声。如果连接监视器的重试包装在更内层，这里的 !ok 会被
		// 重试链中的每一次失败触发，连响好几声。改为等 GENERATION_ENDED（酒馆真正结束）再响一次。
		sendNotify({
			status: 'fail',
			code: response.status,
			errorCode,
			message: String(detail).slice(0, 300),
			url: String(url).slice(0, 300),
			body: rawBody,
		});
	}

	return response;
};

// ---------- 事件 ----------
eventSource.on(event_types.GENERATION_STARTED, () => {
	state.running = true;
	state.stopped = false;
	state.failed = false;
	state.failSoundPlayed = false;
	state.httpStatus = 0;
	try {
		const chat = globalThis.SillyTavern?.getContext?.()?.chat || [];
		state.startLen = chat.length;
	} catch {
		state.startLen = 0;
	}
});

eventSource.on(event_types.GENERATION_STOPPED, () => {
	state.stopped = true;
});

eventSource.on(event_types.GENERATION_ENDED, () => {
	if (!state.running) {
		return;
	}
	state.running = false;

	// 用户主动停止 -> 不打扰
	if (state.stopped) {
		return;
	}
	// 失败已在 fetch 层通知过，避免重复；但失败音效要在这里补一声（整个生成真正结束了）
	if (state.failed) {
		if (!state.failSoundPlayed) {
			state.failSoundPlayed = true;
			playFailSound();
		}
		return;
	}

	let produced = false;
	try {
		const chat = globalThis.SillyTavern?.getContext?.()?.chat || [];
		if (chat.length > state.startLen) {
			const last = chat[chat.length - 1];
			produced = !!(last && !last.is_user && last.mes);
		}
	} catch {
		produced = false;
	}

	if (produced) {
		sendNotify({ status: 'ok' });
	}
});

// =====================================================================
// 一·五、失败音效
// =====================================================================
// 完成音效靠替换酒馆的 #audio_message_sound 实现，但酒馆在失败时根本不播那个音，
// 所以失败要自己发声：内置的「下降音」用 WebAudio 现场合成，不需要额外音频文件。
let failAudioCtx = null;

function synthFailTone(volume) {
	try {
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) { return; }
		failAudioCtx = failAudioCtx || new AC();
		const ctx = failAudioCtx;
		if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
		const t0 = ctx.currentTime + 0.01;
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = 'triangle';
		// 700Hz 滑到 330Hz：听感是「往下沉」的提示，不会和完成音效混淆
		osc.frequency.setValueAtTime(700, t0);
		osc.frequency.exponentialRampToValueAtTime(330, t0 + 0.26);
		gain.gain.setValueAtTime(0.0001, t0);
		gain.gain.exponentialRampToValueAtTime(Math.max(0.03, volume * 0.45), t0 + 0.03);
		gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.36);
		osc.connect(gain);
		gain.connect(ctx.destination);
		osc.start(t0);
		osc.stop(t0 + 0.38);
	} catch { /* 音频不可用就静默 */ }
}

function playFailSound(override) {
	const s = getSoundSettings();
	const choice = override || s.failSound || 'builtin';
	if (choice === 'off') { return; }
	if (choice === 'builtin') {
		synthFailTone(typeof s.volume === 'number' ? s.volume : 0.8);
		return;
	}
	if (!PRESETS.some((p) => p.id === choice)) { return; }
	try {
		const a = new Audio(presetUrl(choice));
		a.volume = typeof s.volume === 'number' ? s.volume : 0.8;
		a.play().catch(() => { /* 自动播放被拦就静默 */ });
	} catch { /* ignore */ }
}

// 二、自定义完成音效
// =====================================================================

const IDB_NAME = 'st-gen-notify';
const IDB_STORE = 'files';
const MAX_BYTES = 4 * 1024 * 1024;   // 4MB 上限，够放几十秒音频
const DEFAULT_SOUND = new URL('sounds/message.mp3', document.baseURI).href;

// ---------- 预置音效（Mixkit 免费授权，随扩展分发在 sounds/ 目录） ----------
const PRESETS = [
	{ id: 'positive', label: '正向提示' },
	{ id: 'happy-bells', label: '欢快铃铛' },
	{ id: 'magic-ring', label: '魔法铃声' },
	{ id: 'bell', label: '经典铃铛' },
	{ id: 'confirm', label: '简短确认' },
	{ id: 'marimba', label: '魔法木琴' },
	{ id: 'reward', label: '答对奖励' },
	{ id: 'doorbell', label: '门铃' },
	{ id: 'interface-start', label: '界面启动' },
	{ id: 'scifi-confirm', label: '科幻确认' },
	{ id: 'flute', label: '舒缓笛声' },
];
const presetUrl = (id) => new URL(`sounds/${id}.mp3`, import.meta.url).href;

let objectUrl = null;

function idbOpen() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(IDB_NAME, 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(IDB_STORE)) {
				db.createObjectStore(IDB_STORE);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function idbRun(mode, fn) {
	const db = await idbOpen();
	try {
		return await new Promise((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, mode);
			const req = fn(tx.objectStore(IDB_STORE));
			tx.oncomplete = () => resolve(req ? req.result : undefined);
			tx.onerror = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

const idbGet = (key) => idbRun('readonly', (st) => st.get(key));
const idbSet = (key, val) => idbRun('readwrite', (st) => st.put(val, key));
const idbDel = (key) => idbRun('readwrite', (st) => st.delete(key));

function getSoundSettings() {
	if (!extension_settings.genNotify) {
		extension_settings.genNotify = {};
	}
	const s = extension_settings.genNotify;
	if (typeof s.volume !== 'number' || !Number.isFinite(s.volume)) {
		s.volume = 0.8;            // 与酒馆原生默认一致
	}
	if (typeof s.customName !== 'string') {
		s.customName = '';
	}
	if (typeof s.presetId !== 'string') {
		s.presetId = '';             // '' = 内置「叮」；'custom' = 自定义上传；其他 = 预置音效 id
	}
	if (typeof s.failSound !== 'string') {
		s.failSound = 'builtin';     // 'off' = 关闭；'builtin' = 合成下降音；其他 = 预置音效 id
	}
	return s;
}

// ---------- 与酒馆原生「仅当标签页不活跃时播放」联动 ----------
// 酒馆 playMessageSound(): if (play_sound_unfocused && browser_has_focus && !force) return;
// 本插件不自己发声，只提供一个「始终播放」的入口，直接改写酒馆的这项设置，
// 这样播放时机永远由酒馆统一管理，不会出现双响或漏响。
const NATIVE_UNFOCUSED_ID = 'play_sound_unfocused';

function isPlayUnfocused() {
	try {
		const pu = globalThis.SillyTavern?.getContext?.()?.powerUserSettings;
		if (pu) { return pu.play_sound_unfocused !== false; }
	} catch { /* ignore */ }
	return true;   // 读不到就按酒馆默认值处理
}

function setPlayUnfocused(value) {
	try {
		const c = globalThis.SillyTavern?.getContext?.();
		const pu = c?.powerUserSettings;
		if (!pu) { return false; }
		pu.play_sound_unfocused = !!value;
		const native = document.getElementById(NATIVE_UNFOCUSED_ID);
		if (native instanceof HTMLInputElement && native.checked !== !!value) {
			native.checked = !!value;
		}
		if (typeof c.saveSettingsDebounced === 'function') { c.saveSettingsDebounced(); }
		return true;
	} catch (err) {
		console.warn(TAG, '更新酒馆音效设置失败:', err);
		return false;
	}
}

/** 把插件里的「始终播放」勾选状态与酒馆设置对齐 */
function syncAlwaysPlayCheckbox() {
	const cb = document.querySelector('#stgn-sound .stgn-whenfocused');
	if (cb) { cb.checked = !isPlayUnfocused(); }
	refreshSoundOffHint();
}

/** 酒馆还有个总开关 play_message_sound；它关着的话，插件的「始终播放」也不会有声 */
function refreshSoundOffHint() {
	const hint = document.querySelector('#stgn-sound .stgn-soundoff');
	if (!hint) { return; }
	let enabled = true;
	try {
		const pu = globalThis.SillyTavern?.getContext?.()?.powerUserSettings;
		if (pu) { enabled = !!pu.play_message_sound; }
	} catch { /* 读不到就不提示 */ }
	hint.style.display = enabled ? 'none' : 'block';
}

/** 与酒馆原生复选框双向联动（它们可能后渲染，重复调用安全） */
function bindNativeSoundCheckbox() {
	const native = document.getElementById(NATIVE_UNFOCUSED_ID);
	if (native instanceof HTMLInputElement && !native.dataset.stgnLinked) {
		native.dataset.stgnLinked = '1';
		native.addEventListener('input', syncAlwaysPlayCheckbox);
	}
	// 酒馆的音效总开关：关掉时插件也发不出声，跟着提示
	const pms = document.getElementById('play_message_sound');
	if (pms instanceof HTMLInputElement && !pms.dataset.stgnLinked) {
		pms.dataset.stgnLinked = '1';
		pms.addEventListener('input', refreshSoundOffHint);
	}
}

function soundAudio() {
	const el = document.getElementById('audio_message_sound');
	return el instanceof HTMLAudioElement ? el : null;
}

/** 把音量挂到播放事件上：酒馆每次 play() 前都会把 volume 设回 0.8，这里再改回来 */
function hookVolume() {
	const audio = soundAudio();
	if (!audio || audio.dataset.stgnHooked) { return; }
	audio.dataset.stgnHooked = '1';
	audio.addEventListener('play', () => {
		try {
			audio.volume = getSoundSettings().volume;
		} catch { /* ignore */ }
	});
}

/** 应用当前选择的音效：自定义 > 预置 > 内置 */
async function applySound() {
	const audio = soundAudio();
	if (!audio) { return; }

	const s = getSoundSettings();

	// 自定义：才需要读 IndexedDB（预置/内置都跳过，省一次异步）
	let blob = null;
	if (s.presetId === 'custom') {
		try {
			blob = await idbGet('messageSound');
		} catch (err) {
			console.warn(TAG, '读取自定义音效失败:', err);
		}
	}

	if (objectUrl) {
		URL.revokeObjectURL(objectUrl);
		objectUrl = null;
	}

	const hasCustom = blob instanceof Blob && blob.size > 0;
	if (s.presetId === 'custom' && hasCustom) {
		objectUrl = URL.createObjectURL(blob);
		audio.src = objectUrl;
	} else if (s.presetId && PRESETS.some((p) => p.id === s.presetId)) {
		// 选了预置，或选了自定义但文件已丢（重装/清缓存）→ 落到预置
		audio.src = presetUrl(s.presetId);
	} else {
		audio.src = DEFAULT_SOUND;
	}
	try {
		audio.load();
	} catch { /* ignore */ }
	hookVolume();
	updateSoundUI();
}

function fmtSize(n) {
	if (n < 1024) { return `${n} B`; }
	if (n < 1024 * 1024) { return `${(n / 1024).toFixed(0)} KB`; }
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function updateSoundUI() {
	const s = getSoundSettings();
	const cur = document.querySelector('#stgn-sound .stgn-cur');
	if (cur) {
		if (s.presetId === 'custom') {
			cur.textContent = s.customName ? `自定义：${s.customName}` : '自定义音效';
		} else if (s.presetId) {
			const p = PRESETS.find((x) => x.id === s.presetId);
			cur.textContent = p ? `预置：${p.label}` : '内置「叮」';
		} else {
			cur.textContent = '内置「叮」';
		}
	}
	syncAlwaysPlayCheckbox();
	const vol = document.querySelector('#stgn-sound .stgn-vol');
	const volVal = document.querySelector('#stgn-sound .stgn-volval');
	if (vol) { vol.value = String(s.volume); }
	if (volVal) { volVal.textContent = `${Math.round(s.volume * 100)}%`; }
	// 预置 chip 高亮
	document.querySelectorAll('#stgn-sound .stgn-chip').forEach((c) => {
		c.classList.toggle('stgn-chip-on', c.dataset.preset === (s.presetId || ''));
	});
}

// ---------- 面板 ----------

const SOUND_CSS = `
#stgn-sound{margin-bottom:5px;color:inherit}
#stgn-sound.inline-drawer > .inline-drawer-toggle.inline-drawer-header{margin-bottom:0}
#stgn-sound > .inline-drawer-content{padding-top:5px}
#stgn-sound .inline-drawer-content{display:none;padding-bottom:8px}
#stgn-sound .stgn-head{display:flex;align-items:baseline;gap:8px}
#stgn-sound .stgn-head b{font-size:inherit;font-weight:700}
#stgn-sound .stgn-cur{font-size:11.5px;opacity:.55;font-weight:400}
#stgn-sound .stgn-failselect{flex:1;min-width:0;padding:3px 6px;border-radius:6px;
 background:color-mix(in srgb,var(--SmartThemeBodyColor,#fff) 10%,transparent);
 color:inherit;border:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,.15));font-size:12.5px}
#stgn-sound .stgn-row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
#stgn-sound button,
#stgn-sound .stgn-pick{
	background:color-mix(in srgb,var(--SmartThemeBodyColor,#fff) 10%,transparent);
	border:1px solid color-mix(in srgb,var(--SmartThemeBodyColor,#fff) 18%,transparent);
	color:inherit;border-radius:6px;padding:5px 12px;font-size:12.5px;cursor:pointer;
	display:inline-flex;align-items:center;line-height:1.4;
}
#stgn-sound button:hover,
#stgn-sound .stgn-pick:hover{background:color-mix(in srgb,var(--SmartThemeBodyColor,#fff) 18%,transparent)}
#stgn-sound .stgn-volrow{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:12.5px;opacity:.9}
#stgn-sound .stgn-vol{flex:1;max-width:180px;accent-color:var(--SmartThemeBodyColor,#888)}
#stgn-sound .stgn-volval{opacity:.6;min-width:38px}
#stgn-sound .stgn-hint{margin-top:6px;font-size:11.5px;line-height:1.65;opacity:.6}
#stgn-sound .stgn-chips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 2px}
#stgn-sound .stgn-chip{
	background:color-mix(in srgb,var(--SmartThemeBodyColor,#fff) 6%,transparent);
	border:1px solid color-mix(in srgb,var(--SmartThemeBodyColor,#fff) 16%,transparent);
	color:inherit;border-radius:999px;padding:3px 11px;font-size:12px;cursor:pointer;line-height:1.5;
}
#stgn-sound .stgn-chip:hover{background:color-mix(in srgb,var(--SmartThemeBodyColor,#fff) 16%,transparent)}
#stgn-sound .stgn-chip.stgn-chip-on{
	background:color-mix(in srgb,var(--SmartThemeBodyColor,#fff) 26%,transparent);
	border-color:color-mix(in srgb,var(--SmartThemeBodyColor,#fff) 55%,transparent);
	font-weight:600;
}
#stgn-sound .stgn-grplabel{font-size:11.5px;opacity:.6;margin:6px 0 2px}
#stgn-sound .stgn-toggle{display:flex;align-items:center;gap:7px;margin:2px 0 4px;font-size:12.5px;opacity:.9;cursor:pointer}
#stgn-sound .stgn-soundoff{display:none;margin:2px 0 6px;padding:6px 8px;border-radius:6px;font-size:11.5px;line-height:1.5;
 background:color-mix(in srgb,#f5a623 16%,transparent);border:1px solid color-mix(in srgb,#f5a623 40%,transparent)}
`;

function buildSoundPanel() {
	const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
	if (!host) {
		console.warn(TAG, '未找到扩展设置容器，跳过音效面板');
		return;
	}
	if (document.getElementById('stgn-sound')) { return; }

	if (!document.getElementById('stgn-style')) {
		const style = document.createElement('style');
		style.id = 'stgn-style';
		style.textContent = SOUND_CSS;
		document.head.appendChild(style);
	}

	const el = document.createElement('div');
	el.id = 'stgn-sound';
	el.className = 'inline-drawer';
	el.innerHTML = `
<div class="inline-drawer-toggle inline-drawer-header">
	<div class="stgn-head"><b>生成通知与音效</b><span class="stgn-cur">内置「叮」</span></div>
	<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content">
	<div class="stgn-grplabel">预置音效（点击选择并试听）</div>
	<div class="stgn-chips">
		<button type="button" class="stgn-chip" data-preset="">内置「叮」</button>
		${PRESETS.map((p) => `<button type="button" class="stgn-chip" data-preset="${p.id}">${p.label}</button>`).join('')}
	</div>
	<div class="stgn-grplabel">完成音效</div>
	<label class="stgn-toggle"><input type="checkbox" class="stgn-whenfocused"> 始终播放（与酒馆「仅当标签页不活跃时播放」联动）</label>
	<div class="stgn-soundoff">注意：酒馆「用户设置 → 音效 → 启用消息音效」当前是关闭的，需先打开，否则不会有声音。</div>
	<div class="stgn-grplabel">失败音效（生成失败时播放）</div>
	<div class="stgn-row">
		<select class="stgn-failselect">
			<option value="off">关闭</option>
			<option value="builtin">内置提示音（下降音）</option>
			${PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}
		</select>
		<button class="stgn-failtest" type="button">试听</button>
	</div>
	<div class="stgn-grplabel">自定义音频（完成音效）</div>
	<div class="stgn-row">
		<label class="stgn-pick">选择音频<input type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac" hidden></label>
		<button class="stgn-test" type="button">试听</button>
		<button class="stgn-reset" type="button">恢复默认</button>
	</div>
	<label class="stgn-volrow">音量
		<input type="range" class="stgn-vol" min="0" max="1" step="0.05" value="0.8">
		<span class="stgn-volval">80%</span>
	</label>
	<div class="stgn-hint">预置音效来自 Mixkit（免费授权，随扩展保存在本机）。自定义支持 mp3 / wav / ogg / m4a / aac / flac，建议 5 秒以内，只存在本机浏览器（IndexedDB），不进设置文件。</div>
</div>`;
	host.prepend(el);

	// ---------- 预置 chip：点选即生效并试听 ----------
	el.querySelectorAll('.stgn-chip').forEach((chip) => {
		chip.addEventListener('click', async () => {
			const id = chip.dataset.preset;
			const s = getSoundSettings();
			s.presetId = id;
			saveSettingsDebounced();
			await applySound();
			// 选完立即播一声，确认就是这个音
			try {
				const url = id ? presetUrl(id) : DEFAULT_SOUND;
				const a = new Audio(url);
				a.volume = s.volume;
				a.play();
			} catch { /* ignore */ }
		});
	});

	const alwaysPlay = el.querySelector('.stgn-whenfocused');
	syncAlwaysPlayCheckbox();
	bindNativeSoundCheckbox();
	refreshSoundOffHint();
	if (alwaysPlay) {
		alwaysPlay.addEventListener('change', () => {
			// 勾上「始终播放」= 关掉酒馆的「仅当标签页不活跃时播放」
			const ok = setPlayUnfocused(!alwaysPlay.checked);
			if (!ok) { alwaysPlay.checked = !isPlayUnfocused(); }   // 写不进去就回滚到真实状态
		});
	}
	// 每次展开面板时对齐一次（用户可能在酒馆原生设置里改过）
	const header = el.querySelector('.inline-drawer-toggle');
	if (header) {
		header.addEventListener('click', () => {
			bindNativeSoundCheckbox();
			syncAlwaysPlayCheckbox();
		});
	}

	const failSelect = el.querySelector('.stgn-failselect');
	const failTest = el.querySelector('.stgn-failtest');
	function syncFailSelect() {
		const s = getSoundSettings();
		if (failSelect) { failSelect.value = s.failSound || 'builtin'; }
	}
	syncFailSelect();
	if (failSelect) {
		failSelect.addEventListener('change', () => {
			getSoundSettings().failSound = failSelect.value;
			saveSettingsDebounced();
		});
	}
	if (failTest) {
		failTest.addEventListener('click', () => { playFailSound(failSelect ? failSelect.value : undefined); });
	}

	const fileInput = el.querySelector('input[type=file]');

	fileInput.addEventListener('change', async () => {
		const file = fileInput.files && fileInput.files[0];
		if (!file) { return; }
		if (file.size > MAX_BYTES) {
			alert(`音频太大（${fmtSize(file.size)}），请控制在 4 MB 以内。`);
			fileInput.value = '';
			return;
		}
		try {
			await idbSet('messageSound', file);
			const s = getSoundSettings();
			s.customName = file.name.replace(/\.[^.]+$/, '').slice(0, 40);
			s.presetId = 'custom';
			saveSettingsDebounced();
			await applySound();
			console.info(TAG, `已应用自定义音效：${file.name} (${fmtSize(file.size)})`);
		} catch (err) {
			console.error(TAG, '保存音效失败:', err);
			alert('保存失败：' + (err?.message || err));
		} finally {
			fileInput.value = '';
		}
	});

	el.querySelector('.stgn-test').addEventListener('click', async () => {
		try {
			const s = getSoundSettings();
			const vol = s.volume;
			let src = DEFAULT_SOUND;
			if (s.presetId === 'custom') {
				const blob = await idbGet('messageSound');
				if (blob instanceof Blob && blob.size > 0) {
					const url = URL.createObjectURL(blob);
					const a = new Audio(url);
					a.volume = vol;
					a.play().finally(() => setTimeout(() => URL.revokeObjectURL(url), 5000));
					return;
				}
			} else if (s.presetId) {
				src = presetUrl(s.presetId);
			}
			const a = new Audio(src);
			a.volume = vol;
			a.play();
		} catch (err) {
			console.warn(TAG, '试听失败:', err);
		}
	});

	el.querySelector('.stgn-reset').addEventListener('click', async () => {
		try {
			await idbDel('messageSound');
			const s = getSoundSettings();
			s.customName = '';
			s.presetId = '';
			saveSettingsDebounced();
			await applySound();
			console.info(TAG, '已恢复内置音效');
		} catch (err) {
			console.error(TAG, '恢复默认失败:', err);
		}
	});

	const vol = el.querySelector('.stgn-vol');
	vol.addEventListener('input', () => {
		const v = Math.min(1, Math.max(0, parseFloat(vol.value) || 0));
		const s = getSoundSettings();
		s.volume = v;
		el.querySelector('.stgn-volval').textContent = `${Math.round(v * 100)}%`;
		const audio = soundAudio();
		if (audio) { try { audio.volume = v; } catch { /* ignore */ } }
		saveSettingsDebounced();
	});

	getSoundSettings();
	applySound();
}

// =====================================================================
// 启动
// =====================================================================

jQuery(async () => {
	console.log(TAG, `已加载 ${VERSION}（本地通知服务 /notify；支持自定义完成音效）`);
	buildSoundPanel();
	hookVolume();
});
