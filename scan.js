/*** 参数 ***/
const INTERVAL = 160;              // 解码节流
const SAMPLE = 960;              // ROI 采样像素
const THRESH = 0.30;             // ✅ 触发门槛：二维码边长 / 扫描框边长 < 0.30
const MIN_OK = 0.06;             // 太小（<6%）可能不稳
const STABLE_NEED = 2;             // 连续帧数
// 扫描框大小（原来一半）：用于“真实框边长”的计算
const ROI_SCALE = 0.46;

let stream = null, loopTimer = null, paused = false, torchOn = false, facing = 'environment';
let usingDetector = false, detector = null, imageCapture = null, curDeviceId = null;
let stableCount = 0;

const root = document.getElementById('root');
const blocker = document.getElementById('blocker');
const v = document.getElementById('v');
const engine = document.getElementById('engine');
const meta = document.getElementById('meta');
const gating = document.getElementById('gating');
const resBox = document.getElementById('result');
const tips = document.getElementById('tips');
const btnFacing = document.getElementById('toggleFacing');
const btnTorch = document.getElementById('torch');
const btnResume = document.getElementById('resume');
const gallery = document.getElementById('gallery');

/* —— OS 检测：HarmonyOS 不支持 —— */
(function detectOS() {
    const ua = navigator.userAgent || navigator.vendor || '';
    const isAndroid = /Android/i.test(ua);
    const isIOS = /(iPhone|iPad|iPod)/i.test(ua);
    const isHarmony = /HarmonyOS|OpenHarmony/i.test(ua);
    if (isHarmony) {
        blocker.classList.add('show');
        blocker.innerHTML = `<div><h2 style="margin:0 0 12px">不支持的系统</h2><div>检测到 <b>鸿蒙系统（HarmonyOS）</b>。此页面仅支持 <b>Android</b> 与 <b>iOS</b>。</div></div>`;
        throw new Error('HarmonyOS not supported');
    }
    if (!(isAndroid || isIOS)) {
        blocker.classList.add('show');
        blocker.innerHTML = `<div><h2 style="margin:0 0 12px">不支持的系统</h2><div>仅支持 <b>Android</b> 与 <b>iOS</b>。</div></div>`;
        throw new Error('Only Android/iOS supported');
    }
})();

/* —— 选择“更广”的摄像头：优先超广角 & 最小 zoom —— */
async function pickUltraWideAfterPermission() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const cams = devs.filter(d => d.kind === 'videoinput');
    // 关键词匹配超广角
    const kw = /ultra|wide|0\.5|uw|超广/i;
    const ultra = cams.find(c => kw.test(c.label));
    if (ultra && ultra.deviceId !== curDeviceId) {
        await start(ultra.deviceId);
    } else {
        // 即便没换相机，也尽量把 zoom 调到最小，扩大视角
        const track = stream?.getVideoTracks?.()[0];
        const caps = track?.getCapabilities?.();
        if (caps && 'zoom' in caps) {
            try { await track.applyConstraints({ advanced: [{ zoom: caps.min }] }); } catch { }
        }
    }
}

/* —— 摄像头 —— */
async function start(deviceId) {
    await stop();
    curDeviceId = deviceId || null;
    // 取消“方形”倾向，改为较广的 16:9，希望取到更宽画面
    const constraints = {
        video: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            facingMode: deviceId ? undefined : { ideal: facing },
            width: { ideal: 1920 }, height: { ideal: 1080 }, aspectRatio: { ideal: 16 / 9 },
            advanced: [{ focusMode: 'continuous' }]
        }, audio: false
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    console.log('stream', stream);

    v.srcObject = stream; await v.play();

    // 引擎
    usingDetector = false;
    if ('BarcodeDetector' in window) {
        try {
            detector = new BarcodeDetector({ formats: ['qr_code'] }); await detector.detect(new ImageData(1, 1));
            usingDetector = true; engine.textContent = '引擎：BarcodeDetector（原生）'; engine.className = 'badge ok';
        } catch { fallbackToJs(); }
    } else { fallbackToJs(); }

    // 高分辨率拍照
    try {
        const track = stream.getVideoTracks()[0];
        if ('ImageCapture' in window) imageCapture = new ImageCapture(track);
        else imageCapture = null;
    } catch { imageCapture = null; }

    await applyTorch(false);
    paused = false; stableCount = 0; updateMeta(); scheduleLoop();

    // 拿到权限后再试图选“超广角”
    pickUltraWideAfterPermission();
}
function fallbackToJs() { engine.textContent = '引擎：jsQR（兼容）'; engine.className = 'badge warn'; }
async function stop() {
    clearTimeout(loopTimer); loopTimer = null;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}
function updateMeta() {
    const t = stream?.getVideoTracks?.()[0];
    const st = t?.getSettings?.() || {};
    meta.textContent = `video=${v.videoWidth}×${v.videoHeight} • track=${st.width || '?'}×${st.height || '?'} • dpr=${devicePixelRatio}`;
}

/* —— 计算“真实扫描框边长（像素）” —— */
function getRoiInfo() {
    const vw = v.videoWidth, vh = v.videoHeight;
    const roiSide = Math.min(vw, vh) * ROI_SCALE;  // ✅ 扫描框真实像素边长
    const sx = (vw - roiSide) / 2, sy = (vh - roiSide) / 2;
    return { sx, sy, sw: roiSide, sh: roiSide, roiSide };
}

/* —— 解码循环 —— */
const cv = document.createElement('canvas');
const ctx = cv.getContext('2d', { willReadFrequently: true });

async function loop() {
    if (paused || !v.videoWidth) { return scheduleLoop(); }

    const { sx, sy, sw, sh, roiSide } = getRoiInfo();

    // 将 ROI 等比采样到 target×target（仅用于解码，加速）
    const target = Math.max(320, Math.min(SAMPLE, Math.floor(sw)));
    cv.width = target; cv.height = target;
    ctx.clearRect(0, 0, target, target);
    ctx.drawImage(v, sx, sy, sw, sh, 0, 0, target, target);

    let detected = false, text = null, qrSideOnTarget = 0;
    try {
        if (usingDetector) {
            const bmp = await createImageBitmap(cv);
            const out = await detector.detect(bmp);
            if (out && out.length) {
                const q = out[0];
                text = q.rawValue || null;
                const box = boxFromDetector(q);
                if (box) { qrSideOnTarget = box.size; detected = true; }
            }
        } else {
            const img = ctx.getImageData(0, 0, target, target);
            const res = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
            if (res) {
                text = res.data || null;
                const box = boxFromJsQR(res);
                if (box) { qrSideOnTarget = box.size; detected = true; }
            }
        }
    } catch { }

    if (detected) {

        // ✅ 将“在 target 画布上的二维码边长”换算回“在真实扫描框上的边长”，再与“扫描框边长”比较
        // scale = 真实扫描框像素边长 / target 采样边长
        const scale = roiSide / target;
        const qrSideOnRoi = qrSideOnTarget * scale;
        const ratio = qrSideOnRoi / roiSide;           // == qrSideOnTarget / target（数学等价，但语义上更清晰：和扫描框比）

        gating.className = (ratio < THRESH && ratio >= MIN_OK) ? 'badge ok' : 'badge warn';
        gating.textContent = `已检测到二维码 · 占比 ${(ratio * 100).toFixed(1)}%（阈值 < 30%）`;
        tips.textContent = (ratio >= THRESH) ? '二维码过大，请拉远' :
            (ratio < MIN_OK) ? '二维码过小，稍微靠近' : '保持此距离…';

        if (ratio < THRESH && ratio >= MIN_OK) {
            if (++stableCount >= STABLE_NEED) return onScanPassed(text);
        } else {
            stableCount = 0;
        }
    } else {
        stableCount = 0;
        gating.className = 'badge warn';
        gating.textContent = '未检测到二维码';
        tips.textContent = '请将二维码置于小框内';
    }
    scheduleLoop();
}
function scheduleLoop() { loopTimer = setTimeout(() => requestAnimationFrame(loop), INTERVAL); }

/* —— 成功：拍照 + 提示（拍照瞬间打开遮罩） —— */
async function onScanPassed(text) {
    paused = true;
    navigator.vibrate?.(60);

    root.classList.add('unmask');                 // 打开遮罩
    const fullBlob = await takeFullPhotoBlob();   // 全景（尽量更广）
    const roiBlob = await snapshotRoiBlob();     // 中心 ROI
    setTimeout(() => root.classList.remove('unmask'), 250);  // 恢复遮罩

    resBox.textContent = `扫码完成：${text}`;
    resBox.style.display = 'block';

    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const binaryString = String.fromCharCode.apply(null, data);
    const qrContentBase64 = btoa(binaryString);
    gating.textContent = qrContentBase64;

    gallery.innerHTML = '';
    const ts = timeStamp();
    if (fullBlob) addPreviewCard(fullBlob, `scan_full_${ts}.jpg`, '全景照片');
    if (roiBlob) addPreviewCard(roiBlob, `scan_roi_${ts}.jpg`, '中心ROI');

    btnResume.style.display = 'inline-block';
}

/* —— 拍照（尽可能“全景更广”） —— */
async function takeFullPhotoBlob() {
    try {
        if (imageCapture && imageCapture.takePhoto) {
            try {
                const caps = await imageCapture.getPhotoCapabilities?.().catch(() => null);
                // 用最大分辨率拍（更大视角细节）；不要指定裁剪比例，交由相机决定
                const opts = caps?.imageWidth?.max ? { imageWidth: caps.imageWidth.max, imageHeight: caps.imageHeight.max } : {};
                return await imageCapture.takePhoto(opts);
            } catch { return await imageCapture.takePhoto(); }
        }
    } catch { }
    // 兜底：整帧截图（使用视频原始分辨率，而不是 ROI）
    try {
        const vw = v.videoWidth, vh = v.videoHeight;
        const c = document.createElement('canvas'), x = c.getContext('2d');
        c.width = vw; c.height = vh;
        x.drawImage(v, 0, 0, vw, vh);
        return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
    } catch { return null; }
}
async function snapshotRoiBlob() {
    try {
        const { sx, sy, sw, sh } = getRoiInfo();
        const c = document.createElement('canvas'), x = c.getContext('2d');
        c.width = sw; c.height = sh;
        x.drawImage(v, sx, sy, sw, sh, 0, 0, sw, sh);
        return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
    } catch { return null; }
}

/* —— 预览与保存 —— */
function addPreviewCard(blob, filename, label) {
    const url = URL.createObjectURL(blob);
    const card = document.createElement('div'); card.className = 'card';
    card.innerHTML = `
    <img src="${url}" alt="${label}"/>
    <div class="cap">${label}</div>
    <div class="row">
      <button class="save">保存到相册/下载</button>
      <button class="open">新窗口查看</button>
    </div>`;
    card.querySelector('.save').addEventListener('click', () => saveToDevice(blob, filename));
    card.querySelector('.open').addEventListener('click', () => window.open(url, '_blank', 'noopener,noreferrer'));
    gallery.appendChild(card);
    window.addEventListener('pagehide', () => URL.revokeObjectURL(url), { once: true });
}
async function saveToDevice(blob, filename) {
    const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: '扫码照片', text: filename }); return; } catch { }
    }
    if (window.showSaveFilePicker) {
        try {
            const handle = await showSaveFilePicker({
                suggestedName: filename,
                types: [{ description: 'Image', accept: { 'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'] } }]
            });
            const w = await handle.createWritable(); await w.write(blob); await w.close(); return;
        } catch { }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}

/* —— 工具 —— */
function dist(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return Math.hypot(dx, dy); }
function boxFromDetector(q) {
    if (q.cornerPoints && q.cornerPoints.length >= 4) {
        const p = q.cornerPoints;
        const d = Math.max(dist(p[0], p[1]), dist(p[1], p[2]), dist(p[2], p[3]), dist(p[3], p[0]));
        return { size: d };
    }
    if (q.boundingBox) {
        const s = Math.max(q.boundingBox.width, q.boundingBox.height);
        return { size: s };
    }
    return null;
}
function boxFromJsQR(res) {
    const p = res.location; if (!p) return null;
    const d = Math.max(
        dist(p.topLeftCorner, p.topRightCorner),
        dist(p.topRightCorner, p.bottomRightCorner),
        dist(p.bottomRightCorner, p.bottomLeftCorner),
        dist(p.bottomLeftCorner, p.topLeftCorner)
    );
    return { size: d };
}
function timeStamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/* —— 手电 & 交互 —— */
async function applyTorch(on) {
    const track = stream?.getVideoTracks?.()[0];
    const caps = track?.getCapabilities?.();
    if (caps && 'torch' in caps) {
        try {
            await track.applyConstraints({ advanced: [{ torch: !!on }] });
            torchOn = !!on; btnTorch.textContent = torchOn ? '手电筒：开' : '手电筒';
        } catch { btnTorch.textContent = '手电筒(不支持)'; }
    } else { btnTorch.textContent = '手电筒(不支持)'; }
}
document.getElementById('toggleFacing').addEventListener('click', async () => {
    facing = (facing === 'environment') ? 'user' : 'environment';
    root.classList.toggle('mirror', facing === 'user');
    await start();
});
document.getElementById('torch').addEventListener('click', () => applyTorch(!torchOn));
btnResume.addEventListener('click', () => {
    btnResume.style.display = 'none'; resBox.style.display = 'none';
    tips.textContent = '把实物放入小框内；检测到二维码会提示，满足门槛(<30%)才拍照';
    paused = false; stableCount = 0; scheduleLoop();
});
window.addEventListener('resize', () => setTimeout(updateMeta, 300));
document.addEventListener('visibilitychange', () => { if (document.hidden) paused = true; else { paused = false; scheduleLoop(); } });

/* —— 启动 —— */
async function init() {
    if (!navigator.mediaDevices?.getUserMedia) {
        engine.textContent = '此浏览器不支持摄像头'; engine.className = 'badge err'; return;
    }
    try {
        await start(); document.getElementById('container').style.display = 'block';
        document.getElementById('start-btn').style.display = 'none';
    }
    catch (e) { engine.textContent = '启动失败：' + e.message; engine.className = 'badge err'; console.error(e); }
} 
