'use strict';

// --- 設定 ---
const BAUD = 115200;
const DT = 0.1;              // サンプリング周期(s)
const PAGE_SIZE = 256;
const SAMPLES_PER_PAGE = 10;
const REF_SAMPLES = 10;      // 基準気圧の自動設定に使う先頭サンプル数（1秒分）

// --- 高度換算（標準大気の気温減率を用いた式） ---
const L = 0.0065;            // 気温減率 (K/m)
const G = 9.80665;           // 重力加速度 (m/s^2)
const R = 287.053;           // 乾燥空気の気体定数 (J/(kg·K))
const EXPONENT = R * L / G;  // ≒ 0.1903

function pressureToAltitude(p, refP, groundTempC) {
  const t0 = groundTempC + 273.15;
  return (t0 / L) * (1 - Math.pow(p / refP, EXPONENT));
}

// --- アプリの状態 ---
const state = {
  pressures: [],
  temps: [],
  altitudes: null,     // Convert を押すまでは null
  relative: null,      // 高度 - Offset
  convTemp: null,
  convRef: null,
  offset: 0,
  deviceSerial: null,
  view: [0, 0],        // 表示範囲のインデックス [from, to)
};

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = kind;
}

function nanmean(arr) {
  let s = 0, n = 0;
  for (const v of arr) if (!Number.isNaN(v)) { s += v; n++; }
  return n ? s / n : NaN;
}

function parseNum(str) {
  const v = parseFloat(String(str).trim());
  return Number.isFinite(v) ? v : null;
}

// ============================================================
// シリアル通信（Web Serial API）
// ============================================================

let port = null;

class SerialIO {
  constructor(reader, writer) {
    this.reader = reader;
    this.writer = writer;
    this.buf = new Uint8Array(0);
    this.pending = null;
    this.closed = false;
  }

  async write(str) {
    await this.writer.write(new TextEncoder().encode(str));
  }

  // 受信データをバッファに追加する。タイムアウトしたら false
  async fill(timeoutMs) {
    if (this.closed) return false;
    if (!this.pending) this.pending = this.reader.read();
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(() => r(null), timeoutMs); });
    const res = await Promise.race([this.pending, timeout]);
    clearTimeout(timer);
    if (res === null) return false;
    this.pending = null;
    if (res.done) { this.closed = true; return false; }
    const merged = new Uint8Array(this.buf.length + res.value.length);
    merged.set(this.buf);
    merged.set(res.value, this.buf.length);
    this.buf = merged;
    return true;
  }

  indexOf(marker) {
    const m = new TextEncoder().encode(marker);
    outer: for (let i = 0; i <= this.buf.length - m.length; i++) {
      for (let j = 0; j < m.length; j++) if (this.buf[i + j] !== m[j]) continue outer;
      return i;
    }
    return -1;
  }

  consume(n) { this.buf = this.buf.slice(n); }

  // marker を受信するまで読み捨てる。見つかったら true
  async waitFor(marker, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.indexOf(marker);
      if (i >= 0) { this.consume(i + marker.length); return true; }
      const remain = deadline - Date.now();
      if (remain <= 0 || !(await this.fill(remain))) return false;
    }
  }

  // 1行受信する（改行なしの文字列）。タイムアウトしたら null
  async readLine(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.buf.indexOf(0x0a);
      if (i >= 0) {
        const line = new TextDecoder().decode(this.buf.slice(0, i)).replace(/\r$/, '');
        this.consume(i + 1);
        return line;
      }
      const remain = deadline - Date.now();
      if (remain <= 0 || !(await this.fill(remain))) return null;
    }
  }

  async close() {
    try { await this.reader.cancel(); } catch (e) { /* 既に閉じている */ }
    try { this.reader.releaseLock(); } catch (e) { /* noop */ }
    try { this.writer.releaseLock(); } catch (e) { /* noop */ }
  }
}

// ポートを開いて fn を実行し、終わったら必ず閉じる
async function withPort(fn) {
  await port.open({ baudRate: BAUD });
  const io = new SerialIO(port.readable.getReader(), port.writable.getWriter());
  try {
    return await fn(io);
  } finally {
    await io.close();
    try { await port.close(); } catch (e) { /* noop */ }
  }
}

// Android の Chrome は USB シリアルを Web Serial で列挙できない端末が多いため、
// WebUSB 上で USB CDC-ACM を扱う Google の web-serial-polyfill を使う
const IS_ANDROID = /Android/i.test(navigator.userAgent);
let serialApi = null;      // navigator.serial または polyfill の serial
let usingPolyfill = false;

async function initSerialApi() {
  if ('serial' in navigator && !IS_ANDROID) {
    serialApi = navigator.serial;
  } else if ('usb' in navigator) {
    try {
      serialApi = (await import('./vendor/web-serial-polyfill.js')).serial;
      usingPolyfill = true;
    } catch (e) {
      serialApi = null;
    }
  }
}

// polyfill 経由なら USB ディスクリプタのシリアル番号を直接読める
function usbSerialNumberOf(p) {
  return (p && p.device_ && p.device_.serialNumber) || null;
}

function describePort(p) {
  const info = p.getInfo();
  if (info.usbVendorId === undefined) return '選択済み';
  const hex = (v) => v.toString(16).toUpperCase().padStart(4, '0');
  return `USB ${hex(info.usbVendorId)}:${hex(info.usbProductId)}${usingPolyfill ? ' (WebUSB)' : ''}`;
}

function setPort(p) {
  port = p;
  $('portInfo').textContent = p ? describePort(p) : '未選択';
}

async function selectPort() {
  try {
    setPort(await serialApi.requestPort());
    setStatus('ポートを選択しました。');
  } catch (e) {
    if (e.name !== 'NotFoundError') setStatus(`ポート選択エラー: ${e.message}`, 'error');
  }
}

// 1ページ(256バイト)から気圧10個・温度10個を取り出す（リトルエンディアンのfloat）
function parsePage(page, pressures, temps) {
  const dv = new DataView(page.buffer, page.byteOffset, page.byteLength);
  for (let i = 0; i < SAMPLES_PER_PAGE; i++) {
    pressures.push(dv.getFloat32(i * 4, true));
    temps.push(dv.getFloat32(40 + i * 4, true));
  }
}

function isEndMarker(buf) {
  const m = new TextEncoder().encode('\n---END');
  if (buf.length < m.length) return false;
  for (let i = 0; i < m.length; i++) if (buf[i] !== m[i]) return false;
  return true;
}

async function readDevice() {
  if (!port) { await selectPort(); if (!port) return; }
  setBusy(true);
  setStatus('読み出し中…');
  try {
    const result = await withPort(async (io) => {
      await io.write('R');
      // 待機中のデバイスはセンサ初期化後に応答するので少し待つ
      if (!(await io.waitFor('---START_DATA---\r\n', 15000))) {
        throw new Error('デバイスから応答がありません。');
      }
      const pressures = [], temps = [];
      for (;;) {
        if (isEndMarker(io.buf)) break;
        if (io.buf.length >= PAGE_SIZE) {
          const page = io.buf.slice(0, PAGE_SIZE);
          if (page[0] === 0xff && page[1] === 0xff && page[2] === 0xff && page[3] === 0xff) break;
          parsePage(page, pressures, temps);
          io.consume(PAGE_SIZE);
          if (pressures.length % 5000 === 0) setStatus(`読み出し中… ${pressures.length} samples`);
          continue;
        }
        if (!(await io.fill(3000))) break;
      }
      await io.waitFor('---END_DATA---\r\n', 1000);

      // シリアル番号を問い合わせる（'I' コマンドに "SN:xxxx" で応答するファームウェアのみ）
      let sn = null;
      await io.write('I');
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        const line = await io.readLine(deadline - Date.now());
        if (line === null) break;
        if (line.startsWith('SN:')) { sn = line.slice(3).trim(); break; }
      }
      return { pressures, temps, sn };
    });

    result.sn = result.sn || usbSerialNumberOf(port);
    setDeviceSerial(result.sn);
    const snText = result.sn || '取得できませんでした';
    if (result.pressures.length) {
      setData(result.pressures, result.temps);
      setStatus(`${result.pressures.length} samples を読み出しました。 S/N: ${snText}`, 'ok');
    } else {
      setStatus(`デバイスにデータがありません。 S/N: ${snText}`);
    }
  } catch (e) {
    setStatus(`Serial Error: ${e.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function eraseDevice() {
  if (!port) { await selectPort(); if (!port) return; }
  if (!confirm('Flashメモリのデータを全て消去しますか？\nこの操作は取り消せません。')) return;
  setBusy(true);
  setStatus('消去中…（使用済み領域が多いと十数秒かかります）');
  try {
    // 消去完了の応答を待つ
    const done = await withPort(async (io) => {
      await io.write('E');
      return io.waitFor('Erased.', 60000);
    });
    if (done) {
      setStatus('消去が完了しました。', 'ok');
      // 消去後は現在のグラフもクリアする
      setData([], []);
      $('refIn').value = '';
    } else {
      setStatus('消去完了の応答がありませんでした。再度読み出して確認してください。', 'error');
    }
  } catch (e) {
    setStatus(`Serial Error: ${e.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  for (const id of ['btnPort', 'btnRead', 'btnErase']) $(id).disabled = busy || !serialApi;
  document.body.style.cursor = busy ? 'progress' : '';
}

function setDeviceSerial(sn) {
  state.deviceSerial = sn || null;
  $('snBox').value = state.deviceSerial || '-';
}

// ============================================================
// データ処理
// ============================================================

// 新しいデータを読み込んだら、変換結果をリセットして基準気圧を自動設定する
function setData(pressures, temps) {
  state.pressures = pressures;
  state.temps = temps;
  state.altitudes = null;
  state.relative = null;
  state.convTemp = null;
  state.convRef = null;
  state.offset = 0;
  $('offsetIn').value = '0.0';
  const ref = nanmean(pressures.slice(0, REF_SAMPLES));
  $('refIn').value = Number.isNaN(ref) ? '' : ref.toFixed(4);
  updateView();
}

function convert(silent = false) {
  if (!state.pressures.length) { if (!silent) setStatus('気圧データがありません。', 'error'); return false; }
  const t = parseNum($('tempIn').value);
  if (t === null) { setStatus('外気温(°C)を数値で入力してください。', 'error'); return false; }
  const ref = parseNum($('refIn').value);
  if (ref === null || ref <= 0) { setStatus('基準気圧(hPa)を正の数値で入力してください。', 'error'); return false; }
  state.convTemp = t;
  state.convRef = ref;
  state.altitudes = state.pressures.map((p) => pressureToAltitude(p, ref, t));
  applyOffset();
  if (!silent) setStatus(`高度に変換しました（T=${t}°C, Ref=${ref}hPa）。`, 'ok');
  return true;
}

function applyOffset() {
  const v = parseNum($('offsetIn').value);
  state.offset = v === null ? 0 : v;
  if (v === null) $('offsetIn').value = '0.0';
  state.relative = state.altitudes ? state.altitudes.map((a) => a - state.offset) : null;
  updateView();
}

function calcRange(n) {
  const f = parseNum($('fromIn').value);
  const t = parseNum($('toIn').value);
  let from = f === null ? 0 : Math.max(0, Math.round(f / DT));
  let to = t === null ? n : Math.min(n, Math.round(t / DT) + 1);
  if (from >= to) { from = 0; to = n; }
  return [from, to];
}

function updateView() {
  state.view = calcRange(state.pressures.length);
  $('chartT').style.display = $('showTemp').checked ? '' : 'none';
  const altLabel = state.altitudes
    ? `T=${fmt(state.convTemp, 1)}°C, Ref=${fmt(state.convRef, 2)}hPa, Offset=${fmt(state.offset, 2)}m`
    : '';
  charts.p.setData(state.pressures, state.view);
  charts.t.setData(state.temps, state.view);
  charts.h.setData(state.relative || [], state.view, altLabel);
  for (const c of Object.values(charts)) c.resize();
}

function fmt(v, d) { return Number.isFinite(v) ? v.toFixed(d) : '-'; }

// ============================================================
// CSV（デスクトップ版 KT_ALT_Reader と同じ形式）
// ============================================================

function csvNum(v, digits) {
  if (Number.isNaN(v)) return 'nan';
  return String(Number(v.toFixed(digits)));
}

function saveCsv() {
  if (!state.pressures.length) { setStatus('保存するデータがありません。', 'error'); return; }
  const lines = [];
  if (state.deviceSerial) lines.push(`# DeviceSerial=${state.deviceSerial}`);
  if (state.altitudes) {
    // 変換条件をヘッダに残す
    lines.push(`# OutsideTemp(C)=${state.convTemp}`);
    lines.push(`# RefPressure(hPa)=${state.convRef}`);
    lines.push(`# Offset(m)=${state.offset}`);
  }
  lines.push('Index,Time(s),Pressure(hPa),BMPTemp(C),Altitude(m),Relative(m)');
  for (let i = 0; i < state.pressures.length; i++) {
    const row = [i, csvNum(i * DT, 1), csvNum(state.pressures[i], 5), csvNum(state.temps[i], 3)];
    if (state.altitudes) row.push(csvNum(state.altitudes[i], 3), csvNum(state.altitudes[i] - state.offset, 3));
    else row.push('', '');
    lines.push(row.join(','));
  }
  const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  a.download = `alt_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.csv`;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  setStatus(`${a.download} を保存しました。`, 'ok');
}

function parseCsvValue(s) {
  return s.trim().toLowerCase() === 'nan' ? NaN : parseFloat(s);
}

function loadCsvText(text) {
  const meta = {};
  const pressures = [], temps = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const body = line.slice(1).trim();
      const eq = body.indexOf('=');
      if (eq >= 0) meta[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const cols = line.split(',');
    if (cols[0] === 'Index') continue;
    pressures.push(parseCsvValue(cols[2]));
    temps.push(parseCsvValue(cols[3]));
  }
  setData(pressures, temps);
  setDeviceSerial(meta.DeviceSerial);
  // 変換条件が保存されていれば復元して変換まで行う
  if ('OutsideTemp(C)' in meta && 'RefPressure(hPa)' in meta) {
    $('tempIn').value = meta['OutsideTemp(C)'];
    $('refIn').value = meta['RefPressure(hPa)'];
    if ('Offset(m)' in meta) $('offsetIn').value = meta['Offset(m)'];
    convert(true);
  }
  return pressures.length;
}

async function openCsv(file) {
  try {
    const n = loadCsvText(await file.text());
    setStatus(`${file.name} を開きました（${n} samples）。`, 'ok');
  } catch (e) {
    setStatus(`File Error: ${e.message}`, 'error');
  }
}

// ============================================================
// グラフ（Canvas。上: 気圧、中: BMP温度、下: 高度。横軸と十字線を共有）
// ============================================================

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function niceStep(range, target) {
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  const nice = r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10;
  return nice * mag;
}

function stepDecimals(step) {
  return Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
}

class Chart {
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;   // { title, unit, color, digits, emptyText, zeroLine }
    this.base = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    el.append(this.base, this.overlay);
    this.ys = [];
    this.view = [0, 0];
    this.subtitle = '';
    this.pad = { l: 72, r: 16, t: 26, b: opts.xLabel ? 42 : 24 };
    new ResizeObserver(() => this.resize()).observe(el);
  }

  setData(ys, view, subtitle = '') {
    this.ys = ys;
    this.view = view;
    this.subtitle = subtitle;
  }

  get hasData() { return this.ys.length > 0 && this.view[1] > this.view[0]; }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    for (const c of [this.base, this.overlay]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.w = w; this.h = h;
    this.draw();
  }

  plotRect() {
    return { l: this.pad.l, t: this.pad.t, w: this.w - this.pad.l - this.pad.r, h: this.h - this.pad.t - this.pad.b };
  }

  xOf(i) {
    const r = this.plotRect();
    const [i0, i1] = this.view;
    const span = Math.max(i1 - 1 - i0, 1);
    return r.l + ((i - i0) / span) * r.w;
  }

  idxAt(px) {
    const r = this.plotRect();
    if (px < r.l - 4 || px > r.l + r.w + 4) return null;
    const [i0, i1] = this.view;
    const span = Math.max(i1 - 1 - i0, 1);
    const i = Math.round(i0 + ((px - r.l) / r.w) * span);
    return Math.min(i1 - 1, Math.max(i0, i));
  }

  yOf(v) {
    const r = this.plotRect();
    return r.t + (1 - (v - this.yMin) / (this.yMax - this.yMin)) * r.h;
  }

  draw() {
    if (!this.w) return;
    const ctx = this.base.getContext('2d');
    const r = this.plotRect();
    const textPrimary = cssVar('--text-primary'), textSecondary = cssVar('--text-secondary');
    const textMuted = cssVar('--text-muted'), grid = cssVar('--grid');
    ctx.clearRect(0, 0, this.w, this.h);
    this.overlay.getContext('2d').clearRect(0, 0, this.w, this.h);

    // タイトル
    ctx.font = '600 13px "Segoe UI", sans-serif';
    ctx.fillStyle = textPrimary;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText(`${this.opts.title} (${this.opts.unit})`, r.l, 16);
    if (this.subtitle) {
      const tw = ctx.measureText(`${this.opts.title} (${this.opts.unit})`).width;
      ctx.font = '12px "Segoe UI", sans-serif';
      ctx.fillStyle = textSecondary;
      ctx.fillText(this.subtitle, r.l + tw + 12, 16);
    }

    // 表示範囲の最小・最大（NaN は除く）
    const [i0, i1] = this.view;
    let min = Infinity, max = -Infinity;
    if (this.hasData) {
      for (let i = i0; i < i1; i++) {
        const v = this.ys[i];
        if (Number.isNaN(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    this.valid = Number.isFinite(min);

    // 枠線
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(r.l + 0.5, r.t + 0.5, r.w - 1, r.h - 1);

    if (!this.valid) {
      ctx.font = '13px "Segoe UI", sans-serif';
      ctx.fillStyle = textMuted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.opts.emptyText, r.l + r.w / 2, r.t + r.h / 2);
      return;
    }

    if (max - min < 1e-9) { const d = Math.max(Math.abs(max) * 1e-4, 0.01); min -= d; max += d; }
    const padY = (max - min) * 0.06;
    this.yMin = min - padY;
    this.yMax = max + padY;

    // Y軸の目盛りとグリッド
    const yStep = niceStep(this.yMax - this.yMin, Math.max(3, Math.floor(r.h / 40)));
    const yDec = stepDecimals(yStep);
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.fillStyle = textSecondary;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(this.yMin / yStep) * yStep; v <= this.yMax; v += yStep) {
      const y = Math.round(this.yOf(v)) + 0.5;
      ctx.strokeStyle = grid;
      ctx.beginPath(); ctx.moveTo(r.l, y); ctx.lineTo(r.l + r.w, y); ctx.stroke();
      ctx.fillText(v.toFixed(yDec), r.l - 6, y);
    }

    // X軸（時間 s）の目盛り
    const tSpan = Math.max((i1 - 1 - i0) * DT, DT);
    const xStep = niceStep(tSpan, Math.max(2, Math.floor(r.w / 90)));
    const xDec = stepDecimals(xStep);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let t = Math.ceil((i0 * DT) / xStep) * xStep; t <= (i1 - 1) * DT + 1e-9; t += xStep) {
      const x = Math.round(this.xOf(t / DT)) + 0.5;
      ctx.strokeStyle = grid;
      ctx.beginPath(); ctx.moveTo(x, r.t); ctx.lineTo(x, r.t + r.h); ctx.stroke();
      ctx.fillText(t.toFixed(xDec), x, r.t + r.h + 5);
    }
    if (this.opts.xLabel) {
      ctx.fillStyle = textMuted;
      ctx.fillText(this.opts.xLabel, r.l + r.w / 2, r.t + r.h + 22);
    }

    // 0m の基準線
    if (this.opts.zeroLine && this.yMin < 0 && this.yMax > 0) {
      const y = Math.round(this.yOf(0)) + 0.5;
      ctx.save();
      ctx.strokeStyle = textMuted;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(r.l, y); ctx.lineTo(r.l + r.w, y); ctx.stroke();
      ctx.restore();
    }

    // データ線（点数が多いときは1pxごとに最小・最大へ間引く）
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.l, r.t, r.w, r.h);
    ctx.clip();
    ctx.strokeStyle = cssVar(this.opts.color);
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const n = i1 - i0;
    let penDown = false;
    if (n <= r.w * 2) {
      for (let i = i0; i < i1; i++) {
        const v = this.ys[i];
        if (Number.isNaN(v)) { penDown = false; continue; }
        const x = this.xOf(i), y = this.yOf(v);
        if (penDown) ctx.lineTo(x, y); else { ctx.moveTo(x, y); penDown = true; }
      }
    } else {
      const cols = Math.ceil(r.w);
      for (let c = 0; c < cols; c++) {
        const a = i0 + Math.floor((c / cols) * n);
        const b = i0 + Math.floor(((c + 1) / cols) * n);
        let lo = Infinity, hi = -Infinity;
        for (let i = a; i < Math.max(b, a + 1); i++) {
          const v = this.ys[i];
          if (Number.isNaN(v)) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (!Number.isFinite(lo)) { penDown = false; continue; }
        const x = r.l + c + 0.5;
        if (penDown) ctx.lineTo(x, this.yOf(hi)); else { ctx.moveTo(x, this.yOf(hi)); penDown = true; }
        ctx.lineTo(x, this.yOf(lo));
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  // 十字線（縦線＋点）を描く。idx が null なら消す
  drawCursor(idx) {
    const ctx = this.overlay.getContext('2d');
    ctx.clearRect(0, 0, this.w || 0, this.h || 0);
    if (idx === null || !this.valid || this.el.style.display === 'none') return;
    const r = this.plotRect();
    const x = Math.round(this.xOf(idx)) + 0.5;
    ctx.strokeStyle = cssVar('--text-muted');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, r.t); ctx.lineTo(x, r.t + r.h); ctx.stroke();
    const v = this.ys[idx];
    if (v === undefined || Number.isNaN(v)) return;
    const y = this.yOf(v);
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = cssVar(this.opts.color);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = cssVar('--surface');
    ctx.stroke();
  }
}

const charts = {
  p: new Chart($('chartP'), { title: 'Pressure', unit: 'hPa', color: '--series-1', emptyText: 'Read Device または Open CSV でデータを読み込んでください' }),
  t: new Chart($('chartT'), { title: 'BMP Temp (debug)', unit: '°C', color: '--series-2', emptyText: 'データなし' }),
  h: new Chart($('chartH'), { title: 'Altitude', unit: 'm', color: '--series-3', zeroLine: true, xLabel: 'Time (s)', emptyText: '外気温を入力して Convert を押してください' }),
};

// --- ホバー: 全グラフに十字線、カーソル付近に値を表示 ---
function showTooltip(idx, clientX, clientY) {
  const tip = $('tooltip');
  const row = (color, k, v) =>
    `<div class="row">${color ? `<span class="sw" style="background:var(${color})"></span>` : '<span class="sw"></span>'}<span class="k">${k}</span><span>${v}</span></div>`;
  let html = row(null, 't', `${(idx * DT).toFixed(1)} s`);
  html += row('--series-1', 'P', `${fmt(state.pressures[idx], 4)} hPa`);
  html += row('--series-2', 'BMP T', `${fmt(state.temps[idx], 2)} °C`);
  if (state.altitudes) {
    html += row('--series-3', 'abs', `${fmt(state.altitudes[idx], 2)} m`);
    html += row('--series-3', 'rel', `${fmt(state.relative[idx], 2)} m`);
  }
  tip.innerHTML = html;
  tip.style.display = 'block';
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = clientX + 16, y = clientY + 16;
  if (x + tw > window.innerWidth - 8) x = clientX - tw - 16;
  if (y + th > window.innerHeight - 8) y = clientY - th - 16;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function hideCursor() {
  for (const c of Object.values(charts)) c.drawCursor(null);
  $('tooltip').style.display = 'none';
}

for (const c of Object.values(charts)) {
  c.overlay.addEventListener('mousemove', (e) => {
    if (!state.pressures.length) return hideCursor();
    const idx = c.idxAt(e.offsetX);
    if (idx === null) return hideCursor();
    for (const other of Object.values(charts)) other.drawCursor(idx);
    showTooltip(idx, e.clientX, e.clientY);
  });
  c.overlay.addEventListener('mouseleave', hideCursor);
}

// ダークモード切替時は色を読み直して再描画
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  for (const c of Object.values(charts)) c.draw();
});

// ============================================================
// UI の結線
// ============================================================

$('btnPort').onclick = selectPort;
$('btnRead').onclick = readDevice;
$('btnErase').onclick = eraseDevice;
$('btnConvert').onclick = () => convert();
$('btnOffset').onclick = () => { if (state.altitudes) applyOffset(); };
$('btnRange').onclick = updateView;
$('btnRangeReset').onclick = () => { $('fromIn').value = ''; $('toIn').value = ''; updateView(); };
$('showTemp').onchange = updateView;
$('btnSave').onclick = saveCsv;
$('btnOpen').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  const f = e.target.files[0];
  if (f) openCsv(f);
  e.target.value = '';
};
$('btnCopy').onclick = async () => {
  if (!state.deviceSerial) return;
  try {
    await navigator.clipboard.writeText(state.deviceSerial);
    setStatus('シリアル番号をコピーしました。', 'ok');
  } catch (e) {
    $('snBox').select();
    document.execCommand('copy');
  }
};
for (const [input, btn] of [['tempIn', 'btnConvert'], ['refIn', 'btnConvert'], ['offsetIn', 'btnOffset'], ['fromIn', 'btnRange'], ['toIn', 'btnRange']]) {
  $(input).addEventListener('keydown', (e) => { if (e.key === 'Enter') $(btn).click(); });
}

setBusy(false);  // 初期化が終わるまではボタンを無効にしておく
initSerialApi().then(async () => {
  setBusy(false);
  if (!serialApi) {
    $('unsupported').style.display = 'block';
    return;
  }
  // 以前に許可したポートが1つだけなら自動で選択しておく
  const ports = await serialApi.getPorts();
  if (ports.length === 1) setPort(ports[0]);
  if (usingPolyfill) {
    navigator.usb.addEventListener('disconnect', (e) => {
      if (port && port.device_ === e.device) { setPort(null); setStatus('デバイスが切断されました。'); }
    });
  } else {
    navigator.serial.addEventListener('disconnect', (e) => {
      if (e.target === port) { setPort(null); setStatus('デバイスが切断されました。'); }
    });
  }
});

updateView();
