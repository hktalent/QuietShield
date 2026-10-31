from http.server import HTTPServer, SimpleHTTPRequestHandler
import traceback
import ssl
import json
import os
import re
import glob
import subprocess
import user_agents  # 解析 User-Agent → 可读的设备/系统（如 iOS 12.0 iPhone）
import threading
from datetime import datetime
from urllib.parse import urlparse, parse_qs, unquote
from urllib.request import urlopen, Request
import html

# 高德逆地理编码 API Key（从环境变量 QuietShield 读取，避免硬编码泄露）
AMAP_KEY = os.environ.get("QuietShield", "").strip()
# 服务端地址缓存：{ "lat,lon": {"address": ..., "ts": ...} }，减少重复 API 调用
_regeo_cache = {}
_REGO_CACHE_TTL = 7 * 24 * 3600  # 缓存 7 天

ADDR = ('0.0.0.0', 8808)
LOG_DIR = "logs"
VIDEO_DIR = "videos"
os.makedirs(LOG_DIR, exist_ok=True)
os.makedirs(VIDEO_DIR, exist_ok=True)

# 全局写锁：确保同设备并发分片落盘不交错
_io_lock = threading.Lock()

# ffmpeg 绝对路径（合并 MP4 用）；不存在时回退到 PATH 中的 ffmpeg
FFMPEG = "/Users/51pwn/anaconda3/bin/ffmpeg" if os.path.exists("/Users/51pwn/anaconda3/bin/ffmpeg") else "ffmpeg"
# 水印字体（支持中文）；macOS 系统字体路径
DRAWTEXT_FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf" if os.path.exists("/System/Library/Fonts/Supplemental/Arial Unicode.ttf") else "/System/Library/Fonts/Helvetica.ttc"

# 只允许安全字符，防路径穿越与文件名注入（\w 含中文与数字，故标签如"客厅"可保留）
_SAFE_RE = re.compile(r"[^\w\-]")


def _wgs84_to_gcj02(lng, lat):
    """WGS-84 → GCJ-02（火星坐标系）。
    浏览器 GPS 返回 WGS-84，高德使用 GCJ-02，不转换会偏移 100~700 米。
    中国境外坐标不做偏移，直接返回原值。"""
    import math
    a = 6378245.0          # 长半轴
    ee = 0.00669342162296594323  # 偏心率平方

    def _out_of_china(lng, lat):
        return not (73.66 < lng < 135.05 and 3.86 < lat < 53.55)

    if _out_of_china(lng, lat):
        return lng, lat

    def _transform_lat(x, y):
        ret = -100.0 + 2.0*x + 3.0*y + 0.2*y*y + 0.1*x*y + 0.2*math.sqrt(abs(x))
        ret += (20.0*math.sin(6.0*x*math.pi) + 20.0*math.sin(2.0*x*math.pi)) * 2.0/3.0
        ret += (20.0*math.sin(y*math.pi) + 40.0*math.sin(y/3.0*math.pi)) * 2.0/3.0
        ret += (160.0*math.sin(y/12.0*math.pi) + 320*math.sin(y*math.pi/30.0)) * 2.0/3.0
        return ret

    def _transform_lng(x, y):
        ret = 300.0 + x + 2.0*y + 0.1*x*x + 0.1*x*y + 0.1*math.sqrt(abs(x))
        ret += (20.0*math.sin(6.0*x*math.pi) + 20.0*math.sin(2.0*x*math.pi)) * 2.0/3.0
        ret += (20.0*math.sin(x*math.pi) + 40.0*math.sin(x/3.0*math.pi)) * 2.0/3.0
        ret += (150.0*math.sin(x/12.0*math.pi) + 300.0*math.sin(x/30.0*math.pi)) * 2.0/3.0
        return ret

    dlat = _transform_lat(lng - 105.0, lat - 35.0)
    dlng = _transform_lng(lng - 105.0, lat - 35.0)
    radlat = lat / 180.0 * math.pi
    magic = math.sin(radlat)
    magic = 1 - ee * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((a * (1 - ee)) / (magic * sqrtmagic) * math.pi)
    dlng = (dlng * 180.0) / (a / sqrtmagic * math.cos(radlat) * math.pi)
    return lng + dlng, lat + dlat


def reverse_geocode(lat, lon):
    """经纬度 → 结构化地址（高德逆地理编码）。失败返回空串。带服务端缓存。
    入参为 WGS-84（浏览器 GPS），内部自动转 GCJ-02 再调用高德。"""
    if not AMAP_KEY:
        return ""
    try:
        lat = float(lat)
        lon = float(lon)
    except (TypeError, ValueError):
        return ""
    # 缓存键：WGS-84 经纬度保留 4 位小数（约 11m 精度），同一地点复用
    key = f"{lat:.4f},{lon:.4f}"
    cached = _regeo_cache.get(key)
    if cached and (datetime.now().timestamp() - cached.get("ts", 0) < _REGO_CACHE_TTL):
        return cached.get("address", "")
    try:
        # WGS-84 → GCJ-02，再传给高德（高德只认火星坐标系）
        gcj_lng, gcj_lat = _wgs84_to_gcj02(lon, lat)
        url = (
            f"https://restapi.amap.com/v3/geocode/regeo"
            f"?key={AMAP_KEY}&location={gcj_lng:.6f},{gcj_lat:.6f}&extensions=base"
        )
        req = Request(url, headers={"User-Agent": "QuietShield/1.0"})
        with urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if str(data.get("status")) == "1":
            addr = data.get("regeocode", {}).get("formatted_address", "")
            if addr:
                _regeo_cache[key] = {"address": addr, "ts": datetime.now().timestamp()}
                return addr
    except Exception as e:
        print(f"[regeo] 逆地理编码失败: {e}")
    return ""


def safe_token(s, fallback="unknown"):
    s = str(s or "")
    s = _SAFE_RE.sub("_", s)
    s = s.strip("_") or fallback
    return s[:128]


def get_daily_log_filename():
    """获取当日噪声日志文件名 noise_log_YYYY-MM-DD.html"""
    today = datetime.now().strftime("%Y-%m-%d")
    return os.path.join(LOG_DIR, f"noise_log_{today}.html")


def get_early_morning_log_filename():
    """凌晨(01:00~06:00)单独日志文件，文件名含时段起止(0100-0600)"""
    today = datetime.now().strftime("%Y-%m-%d")
    return os.path.join(LOG_DIR, f"noise_log_{today}_凌晨0100-0600.html")


MAX_LOG_BYTES = 100 * 1024 * 1024  # 日志滚动阈值：单文件不超过 100MB


def get_log_write_path(base_path):
    """日志滚动：单文件超过 100MB 则切到 文件名_01 ... _0N（保留 header 继承）"""
    if not os.path.exists(base_path) or os.path.getsize(base_path) < MAX_LOG_BYTES:
        return base_path
    idx = 1
    while True:
        cand = base_path.replace(".html", f"_{idx:02d}.html")
        if not os.path.exists(cand) or os.path.getsize(cand) < MAX_LOG_BYTES:
            return cand
        idx += 1


def extract_mime_from_dataurl(dataurl):
    """从dataURL字符串提取mime类型"""
    if not dataurl or not dataurl.startswith("data:"):
        return None
    head = dataurl.split(",")[0]
    mime_part = head.split(":")[1].split(";")[0]
    return mime_part


# HTML头部模板（已移除磁场/振动列，仅保留噪声事件）
HTML_HEADER = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>噪声监测服务端日志 {boot_time}</title>
<link href=../css/1.css rel=stylesheet>
<script src="../js/player.js"></script>
</head>
<body>
<h2>噪声监测日志</h2>
<p>《噪声污染防治法》扰民噪声：白天(>=6点 &lt;22点) &gt; 55 dB(A)；夜间 &gt; 45 dB(A)；录像由 /review.html 回看。日志创建时间：{boot_time}</p>
<p id="locLine" class="loc-bar">📍 位置：{loc_line}</p>
<table>
<thead>
<tr>
<th>事件触发时间</th>
<th>标签</th>
<th>持续秒</th>
<th>峰值dB</th>
<th>录音</th>
<th>客户端IP</th>
<th>UA</th>
</tr>
</thead>
<tbody>
"""

# 录音单元格的双图标播放按钮（🔊=5倍音量 ✨=降噪清晰）；行HTML与旧文件修补共用
LOG_PLAYER_BTNS = (
    '<button class="au-btn au-ico" title="5倍音量播放" '
    "onclick=\"const s=this.parentElement.querySelector('source');if(s)playBoostAudio(s.src);\">🔊</button>"
    '<button class="au-btn au-ico" title="降噪清晰播放" '
    "onclick=\"const s=this.parentElement.querySelector('source');if(s)playClearAudio(s.src);\">✨</button>"
)


class MyHandler(SimpleHTTPRequestHandler):
    def _set_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST,GET,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self._set_cors()
        self.end_headers()

    # 位置占位符：地址未解析时写入此标记，解析成功后回填替换
    LOC_PENDING = "定位中…"

    def _init_daily_html_log(self, log_file_path, loc_line=None):
        if not os.path.exists(log_file_path):
            boot_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            loc = loc_line if loc_line else self.LOC_PENDING
            header = HTML_HEADER.replace("{boot_time}", boot_time).replace("{loc_line}", html.escape(loc))
            with open(log_file_path, "w", encoding="utf-8") as f:
                f.write(header)

    def _patch_log_file(self, log_file_path):
        """修补已有日志文件（头部是创建时的快照，不随 Server.py 更新）：
        ①补入隔行换色+悬停高亮 CSS；②播放器统一为外链 ../js/player.js（内嵌旧脚本或
        缺脚本时按钮点击无反应）；③旧文字播放按钮统一升级为双图标按钮"""
        if not os.path.exists(log_file_path):
            return
        try:
            with _io_lock:
                with open(log_file_path, "r", encoding="utf-8") as f:
                    content = f.read()
                changed = False
                # ① CSS
                if "nth-child" not in content:
                    zebra_css = (
                        "tbody tr:nth-child(even) td{background:#fffacd;}"
                        "tbody tr:hover td{background:#ffe97a!important;}"
                    )
                    content = content.replace("</style>", zebra_css + "</style>", 1)
                    changed = True
                # ② 播放器：统一为外链 ../js/player.js（旧文件可能内嵌了过时的播放器脚本，
                #    或根本没有脚本 —— 按钮点击会无反应）
                if "js/player.js" not in content:
                    tag = '<script src="../js/player.js"></script>'
                    if "<script>" in content:
                        content = re.sub(r"<script>.*?</script>",
                                         lambda _: tag, content, count=1, flags=re.DOTALL)
                    else:
                        content = content.replace("</head>", tag + "\n</head>", 1)
                    changed = True
                # ③ 旧按钮（带中文文字）→ 当前双图标按钮；新图标按钮内容无中文，不受影响
                new_content = re.sub(
                    r'(?:<button[^>]*>[^<]*[一-鿿][^<]*</button>\s*){1,2}',
                    lambda _: LOG_PLAYER_BTNS, content)
                if new_content != content:
                    content = new_content
                    changed = True
                if changed:
                    with open(log_file_path, "w", encoding="utf-8") as f:
                        f.write(content)
        except Exception as e:
            print(f"[修补日志文件失败] {log_file_path}: {e}")

    def _update_log_location(self, log_file_path, loc_line):
        """回填日志抬头的位置行：把占位符/旧坐标替换为解析后的地址"""
        if not os.path.exists(log_file_path) or not loc_line:
            return
        new_loc = html.escape(loc_line)
        try:
            with _io_lock:
                with open(log_file_path, "r", encoding="utf-8") as f:
                    content = f.read()
                if self.LOC_PENDING in content:
                    content = content.replace(self.LOC_PENDING, new_loc, 1)
                else:
                    # 已有旧地址/坐标，正则替换 locLine 段落内容
                    content = re.sub(
                        r'(<p id="locLine"[^>]*>📍 位置：).*?(</p>)',
                        r"\g<1>" + new_loc + r"\g<2>",
                        content,
                        count=1,
                    )
                with open(log_file_path, "w", encoding="utf-8") as f:
                    f.write(content)
        except Exception as e:
            print(f"[回填位置失败] {log_file_path}: {e}")

    # ---------- 视频分片实时落盘 ----------
    # 文件名规则：{标签}_{会话开始}_{本段开始}_{本段结束}_seg{序号}.webm  （时间均为 YYYYMMDD_HHMMSS）
    def _handle_video_upload(self, parsed):
        q = parse_qs(parsed.query)
        device_id = safe_token(q.get("deviceId", ["unknown"])[0])
        tag = safe_token(q.get("tag", ["未命名"])[0], fallback="未命名")
        start = safe_token(q.get("start", ["0"])[0], fallback="0")        # 会话开始（年月日时分秒）
        seg_start = safe_token(q.get("segStart", ["0"])[0], fallback="0") # 本段开始
        seg_end = safe_token(q.get("segEnd", ["0"])[0], fallback="0")     # 本段结束
        try:
            seg_index = int(q.get("segIndex", ["0"])[0])
        except Exception:
            seg_index = 0

        length = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(length) if length > 0 else b""

        dev_dir = os.path.join(VIDEO_DIR, device_id)
        session_key = f"{tag}_{start}"
        fname = f"{session_key}_{seg_start}_{seg_end}_seg{seg_index:05d}.webm"
        fpath = os.path.join(dev_dir, fname)

        with _io_lock:
            os.makedirs(dev_dir, exist_ok=True)
            with open(fpath, "wb") as f:
                f.write(data)

        self.send_response(200)
        self._set_cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        resp = json.dumps({"ok": True, "deviceId": device_id, "sessionKey": session_key,
                           "file": fname, "bytes": len(data)})
        self.wfile.write(resp.encode("utf-8"))

    def _handle_video_finalize(self, parsed):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length > 0 else b""
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            payload = {}
        device_id = safe_token(payload.get("deviceId", "unknown"))
        tag = safe_token(payload.get("tag", "未命名"), fallback="未命名")
        start = safe_token(payload.get("start", "0"), fallback="0")
        end = safe_token(payload.get("end", start), fallback=start)
        session_key = f"{tag}_{start}"
        meta = {
            "deviceId": device_id,
            "tag": tag,
            "sessionKey": session_key,
            "start": start,
            "end": end,
            "startTs": payload.get("startTs"),
            "endTs": payload.get("endTs"),
            "segCount": int(payload.get("segCount", 0)),
            "durationSec": payload.get("durationSec"),
            "peakDb": payload.get("peakDb"),
        }
        dev_dir = os.path.join(VIDEO_DIR, device_id)
        with _io_lock:
            os.makedirs(dev_dir, exist_ok=True)
            with open(os.path.join(dev_dir, f"{session_key}_meta.json"), "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False)

        # 后台线程：把本会话的 webm 分片合并成 ~10 分钟一段的 MP4（不阻塞响应）
        threading.Thread(target=self._merge_session_mp4,
                         args=(device_id, session_key, end), daemon=True).start()

        self.send_response(200)
        self._set_cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True}).encode("utf-8"))

    # ---- 合并 webm 分片 → 10 分钟 MP4 ----
    def _merge_session_mp4(self, device_id, session_key, end):
        try:
            dev_dir = os.path.join(VIDEO_DIR, device_id)
            pat = re.compile(r"^" + re.escape(session_key) +
                             r"_\d{8}_\d{6}_\d{8}_\d{6}_seg(\d+)\.webm$")
            segs = []
            for fn in os.listdir(dev_dir):
                m = pat.match(fn)
                if m and os.path.isfile(os.path.join(dev_dir, fn)):
                    segs.append((int(m.group(1)), os.path.join(dev_dir, fn)))
            segs.sort(key=lambda x: x[0])
            if not segs:
                return
            n = len(segs)
            inputs = []
            for _, p in segs:
                inputs += ["-i", p]
            concat = "".join(f"[{i}:v][{i}:a]" for i in range(n)) + \
                     f"concat=n={n}:v=1:a=1[v][a]"
            # 水印：标签 + 年月日 时分秒（动态时间戳，随播放从会话开始连续推进）
            map_v = "[v]"
            try:
                mts = re.search(r"_(\d{8})_(\d{6})$", session_key)
                start_epoch = int(datetime.strptime(
                    f"{mts.group(1)}_{mts.group(2)}", "%Y%m%d_%H%M%S").timestamp())
                tag_safe = re.sub(r"[\\:'\";,\[\]%{}\x00-\x1f]", "",
                                  re.sub(r"_\d{8}_\d{6}$", "", session_key))
                wtext = f"{tag_safe} %{{pts\\:localtime\\:{start_epoch}}}"
                wm = (f"[v]drawtext=fontfile='{DRAWTEXT_FONT}':"
                      f"text='{wtext}':x=20:y=20:"
                      f"fontsize='max(20, w*0.04)':fontcolor=white:"
                      f"box=1:boxcolor=black@0.4:boxborderw=10[vW]")
                flt = concat + ";" + wm
                map_v = "[vW]"
            except Exception:
                flt = concat
            out_pat = os.path.join(dev_dir, session_key + "_tmp_%03d.mp4")
            cmd = ([FFMPEG, "-y", "-loglevel", "error"] + inputs +
                   ["-filter_complex", flt, "-map", map_v, "-map", "[a]",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
                    "-c:a", "aac", "-g", "150",
                    "-force_key_frames", "expr:gte(t,n_forced*600)",
                    "-f", "segment", "-segment_time", "600",
                    "-reset_timestamps", "1", out_pat])
            subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
            # 重命名为 {标签}_{开始}_{结束}_第N段.mp4
            tmp = glob.glob(os.path.join(dev_dir, session_key + "_tmp_*.mp4"))
            tmp.sort()
            for idx, p in enumerate(tmp):
                new = os.path.join(dev_dir, f"{session_key}_{end}_第{idx+1}段.mp4")
                os.replace(p, new)
        except Exception:
            traceback.print_exc()

    def _handle_regeo(self, parsed):
        """经纬度 → 地址（高德逆地理编码），GET /api/regeo?lat=&lon="""
        qs = parse_qs(parsed.query)
        lat = qs.get("lat", [None])[0]
        lon = qs.get("lon", [None])[0]
        addr = reverse_geocode(lat, lon)
        self.send_response(200)
        self._set_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": bool(addr), "address": addr}, ensure_ascii=False).encode("utf-8"))

    def _handle_videos_list(self):
        # 汇总：webm 分片 + 合并后的 10 分钟 MP4（{标签}_{开始}_{结束}_第N段.mp4）
        sessions = []
        if os.path.isdir(VIDEO_DIR):
            for dev in sorted(os.listdir(VIDEO_DIR)):
                dev_dir = os.path.join(VIDEO_DIR, dev)
                if not os.path.isdir(dev_dir):
                    continue
                groups = {}
                for fn in sorted(os.listdir(dev_dir)):
                    full = os.path.join(dev_dir, fn)
                    if fn.startswith(".") or not os.path.isfile(full):
                        continue
                    if fn.endswith("_meta.json"):
                        try:
                            with open(full, "r", encoding="utf-8") as f:
                                meta = json.load(f)
                        except Exception:
                            meta = {}
                        key = fn[: fn.rfind("_meta.json")]
                        groups.setdefault(key, {"segments": [], "mp4s": []})["meta"] = meta
                        continue
                    # 合并后的 MP4：{sessionKey}_{结束}_第N段.mp4
                    m2 = re.match(r"^(.+)_\d{8}_\d{6}_第(\d+)段\.mp4$", fn)
                    if m2:
                        key, part = m2.group(1), int(m2.group(2))
                        g = groups.setdefault(key, {"segments": [], "mp4s": []})
                        g["mp4s"].append({"part": part, "file": fn, "url": f"/videos/{dev}/{fn}"})
                        continue
                    # webm 分片：{sessionKey}_{segStart}_{segEnd}_segN.webm
                    m = re.match(r"^(.+)_(\d{8}_\d{6})_(\d{8}_\d{6})_seg(\d+)\.webm$", fn)
                    if not m:
                        continue
                    key, seg_start, seg_end, idx = m.group(1), m.group(2), m.group(3), int(m.group(4))
                    g = groups.setdefault(key, {"segments": [], "mp4s": []})
                    g["segments"].append({"index": idx, "segStart": seg_start, "segEnd": seg_end,
                                          "file": fn, "url": f"/videos/{dev}/{fn}"})
                for key, g in groups.items():
                    g["segments"].sort(key=lambda x: x["index"])
                    g["mp4s"].sort(key=lambda x: x["part"])
                    meta = g.get("meta") or {}
                    tag = meta.get("tag") or (key.split("_", 1)[0] if "_" in key else key)
                    start = meta.get("start") or (key.split("_", 1)[1] if "_" in key else "")
                    sessions.append({"deviceId": dev, "tag": tag, "sessionStart": start,
                                     "sessionKey": key, "segments": g["segments"],
                                     "mp4s": g["mp4s"], "meta": meta})
        self.send_response(200)
        self._set_cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True, "sessions": sessions}).encode("utf-8"))

    def _handle_noise_log(self):
        html_log_path = get_log_write_path(get_daily_log_filename())
        self._init_daily_html_log(html_log_path)

        length = int(self.headers["Content-Length"])
        body = self.rfile.read(length)
        payload = json.loads(body.decode("utf-8"))

        remote_ip = html.escape(self.client_address[0])
        ua_raw = self.headers.get("User-Agent", "")
        ua = html.escape(ua_raw)
        # UA → 友好系统描述（如「iPhone · iOS 12.4 · Mobile Safari」）；原始 UA 悬停可看
        ua_disp = ua
        try:
            _up = user_agents.parse(ua_raw)
            _dev = _up.device.family or "未知设备"
            _osn = (_up.os.family or "未知系统")
            _osv = _up.os.version_string or ""
            _br = _up.browser.family or ""
            ua_disp = f"{_dev} · {_osn}{(' '+_osv) if _osv else ''}"
            if _br: ua_disp += f" · {_br}"
            ua_disp = html.escape(ua_disp)
        except Exception:
            ua_disp = ua
        device_id = html.escape(safe_token(payload.get("deviceId", ""), fallback="--"))
        tag = html.escape(safe_token(payload.get("tag", ""), fallback="--"))

        audio_b64 = payload.get("audioData")
        audio_html = '<span style="color:#888">无录音</span>'
        if audio_b64:
            mime = extract_mime_from_dataurl(audio_b64)
            if not mime:
                mime = "audio/webm"
            b64_escaped_html = audio_b64.replace("'", "&#39;")
            audio_html = (
                f'<audio controls preload="none"><source src="{html.escape(audio_b64)}" type="{html.escape(mime)}">不支持播放'
                f'</audio><br>' + LOG_PLAYER_BTNS
            )

        timeText = html.escape(payload.get("timeText", ""))
        durSec = html.escape(payload.get("durationSec", ""))
        peakDb = html.escape(payload.get("peakDb", ""))
        lat_raw = payload.get("lat")
        lon_raw = payload.get("lon")
        # 后端逆地理编码：经纬度 → 地址（带服务端缓存，避免重复调用高德 API）
        address = ""
        if lat_raw is not None and lon_raw is not None:
            address = reverse_geocode(lat_raw, lon_raw)
        lat = html.escape(str(lat_raw if lat_raw is not None else "--"))
        lon = html.escape(str(lon_raw if lon_raw is not None else "--"))
        loc_title = f"{lat}, {lon}"
        if address:
            loc_title = f"{address}（{lat}, {lon}）"
        # 抬头位置行：有地址写地址，无地址留占位符，后续拿到地址后回填
        loc_line = address or None
        file_existed = os.path.exists(html_log_path)
        if not file_existed:
            self._init_daily_html_log(html_log_path, loc_line)
        else:
            # 文件已存在：修补旧文件（CSS + 播放器脚本 + 旧按钮升级）
            self._patch_log_file(html_log_path)
            if address:
                # 回填抬头位置行（替换占位符/旧坐标）
                self._update_log_location(html_log_path, address)

        timeTs_esc = html.escape(str(payload.get("timeTs", "")))
        tr_html = (
            f'<tr id="log-{timeTs_esc}">'
            f'<td title="📍 {html.escape(loc_title)}">{timeText}</td>'
            f"<td>{tag}</td>"
            f"<td>{durSec}</td>"
            f"<td>{peakDb}</td>"
            f'<td class="au">{audio_html}</td>'
            f"<td>{remote_ip}</td>"
            f'<td title="{ua}">{ua_disp}</td>'
            f"</tr>\n"
        )

        with _io_lock:
            with open(html_log_path, "a", encoding="utf-8") as f:
                f.write(tr_html)

        # 凌晨 01:00~06:00 的记录：额外单独存一份凌晨文件（文件名含时段起止）
        try:
            _eh = int(str(payload.get("timeText", "")).split(" ")[1].split(":")[0])
        except Exception:
            _eh = -1
        if 1 <= _eh < 6:
            early_path = get_log_write_path(get_early_morning_log_filename())
            if not os.path.exists(early_path):
                self._init_daily_html_log(early_path, loc_line)
            else:
                self._patch_log_file(early_path)
                if address:
                    self._update_log_location(early_path, address)
            with _io_lock:
                with open(early_path, "a", encoding="utf-8") as f:
                    f.write(tr_html)

        self.send_response(200)
        self._set_cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        resp = json.dumps({"ok": True, "logfile": os.path.basename(html_log_path)})
        self.wfile.write(resp.encode("utf-8"))

    def _handle_log_delete(self, parsed):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            payload = {}
        ts = safe_token(str(payload.get("timeTs", "")), fallback="")
        removed = 0
        if ts:
            pat = re.compile(r'<tr\s+id="log-' + re.escape(ts) + r'"[^>]*>.*?</tr>', re.DOTALL)
            with _io_lock:
                for fn in os.listdir(LOG_DIR):
                    if not fn.startswith("noise_log_") or not fn.endswith(".html"):
                        continue
                    p = os.path.join(LOG_DIR, fn)
                    try:
                        with open(p, "r", encoding="utf-8") as f:
                            content = f.read()
                    except Exception:
                        continue
                    newc, n = pat.subn("", content)
                    if n:
                        try:
                            with open(p, "w", encoding="utf-8") as f:
                                f.write(newc)
                        except Exception:
                            continue
                        removed += n
        self.send_response(200)
        self._set_cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True, "removed": removed}).encode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        # 视频文件以正确 mime 提供，保证 <video> 可播
        if path.startswith("/videos/"):
            rel = unquote(path[len("/videos/"):])   # 中文文件名需先解码
            base = os.path.realpath(VIDEO_DIR)
            fpath = os.path.realpath(os.path.join(VIDEO_DIR, rel))
            # 真实路径包含检查，防止 ../ 穿越到 videos 之外
            if os.path.commonpath([base, fpath]) == base and os.path.isfile(fpath):
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4" if fpath.endswith(".mp4") else "video/webm")
                self.send_header("Content-Length", str(os.path.getsize(fpath)))
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                with open(fpath, "rb") as f:
                    self.wfile.write(f.read())
                return
            self.send_error(404)
            return
        if path == "/api/videos":
            self._handle_videos_list()
            return
        if path == "/api/regeo":
            self._handle_regeo(parsed)
            return
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/video/upload":
                self._handle_video_upload(parsed)
                return
            if path == "/api/video/finalize":
                self._handle_video_finalize(parsed)
                return
            if path == "/api/log":
                self._handle_noise_log()
                return
            if path == "/api/log/del":
                self._handle_log_delete(parsed)
                return
            super().do_POST()
        except Exception as e:
            traceback.print_exc()
            try:
                self.send_response(500)
                self._set_cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "err": str(e)}).encode("utf-8"))
            except Exception:
                pass

    def end_headers(self):
        self._set_cors()
        super().end_headers()


if __name__ == "__main__":
    httpd = HTTPServer(ADDR, MyHandler)
    httpd.socket = ssl.wrap_socket(
        httpd.socket,
        certfile='server.crt',
        keyfile='server.key',
        server_side=True
    )
    print(f'HTTPS server running on https://{ADDR[0]}:{ADDR[1]}')
    print(f"每日噪声日志目录：{LOG_DIR}/ ，文件名：noise_log_YYYY-MM-DD.html")
    print(f"录像存储目录：{VIDEO_DIR}/<设备指纹>/（webm 分片 + 合并的 10 分钟 MP4）")
    print("录像回看页：https://127.0.0.1:8088/review.html（优先播 MP4）")
    httpd.serve_forever()
