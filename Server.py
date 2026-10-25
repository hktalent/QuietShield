from http.server import HTTPServer, SimpleHTTPRequestHandler
import traceback
import ssl
import json
import os
import re
import glob
import subprocess
import threading
from datetime import datetime
from urllib.parse import urlparse, parse_qs, unquote
import html

ADDR = ('0.0.0.0', 8088)
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


def safe_token(s, fallback="unknown"):
    s = str(s or "")
    s = _SAFE_RE.sub("_", s)
    s = s.strip("_") or fallback
    return s[:128]


def get_daily_log_filename():
    """获取当日噪声日志文件名 noise_log_YYYY-MM-DD.html"""
    today = datetime.now().strftime("%Y-%m-%d")
    return os.path.join(LOG_DIR, f"noise_log_{today}.html")


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
<style>
body{{font-family:system-ui,monospace;padding:16px;background:#f8f8f8;color:#111;}}
h2{{margin-bottom:12px;}}
table{{border-collapse:collapse;width:100%;font-size:12px;}}
th{{background:#222;color:#fff;padding:8px;text-align:left;}}
td{{background:#fff;padding:6px 8px;border-bottom:#ccc 1px solid;}}
audio{{vertical-align:middle;height:28px;max-width:240px;}}
button{{padding:3px 6px;font-size:11px;cursor:pointer;}}
</style>
<script>
let playBoostAudioCtx = null;
async function playBoostAudio(dataUrl, boostGain=5.0){
    if(playBoostAudioCtx){try{ playBoostAudioCtx.close(); }catch(e){} playBoostAudioCtx = null; }
    playBoostAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    if(playBoostAudioCtx.state === 'suspended'){ await playBoostAudioCtx.resume(); }
    try{
        const base64Str = dataUrl.split(",")[1];
        const binaryStr = atob(base64Str);
        const len = binaryStr.length;
        const buf = new Uint8Array(len);
        for(let i=0;i<len;i++){ buf[i] = binaryStr.charCodeAt(i); }
        const audioBuf = await playBoostAudioCtx.decodeAudioData(buf.buffer);
        const srcNode = playBoostAudioCtx.createBufferSource();
        srcNode.buffer = audioBuf;
        const gainNode = playBoostAudioCtx.createGain();
        gainNode.gain.value = boostGain;
        const compressor = playBoostAudioCtx.createDynamicsCompressor();
        compressor.threshold.value = -18;
        compressor.knee.value = 10;
        compressor.ratio.value = 4;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.25;
        srcNode.connect(gainNode);
        gainNode.connect(compressor);
        compressor.connect(playBoostAudioCtx.destination);
        srcNode.onended = ()=>{ if(playBoostAudioCtx){ playBoostAudioCtx.close(); playBoostAudioCtx = null; } };
        srcNode.start(0);
    }catch(err){
        alert("音频播放失败："+err.message);
        if(playBoostAudioCtx){ playBoostAudioCtx.close(); playBoostAudioCtx=null; }
    }
}
</script>
</head>
<body>
<h2>噪声监测日志</h2>
<p>《噪声污染防治法》扰民噪声：白天(>=6点 &lt;22点) &gt; 55 dB(A)；夜间 &gt; 45 dB(A)；录像由 /review.html 回看。日志创建时间：{boot_time}</p>
<table>
<thead>
<tr>
<th>事件触发时间</th>
<th>标签</th>
<th>持续秒</th>
<th>峰值dB</th>
<th>纬度</th>
<th>经度</th>
<th>录音</th>
<th>录像标签</th>
<th>客户端IP</th>
<th>UA</th>
</tr>
</thead>
<tbody>
"""


class MyHandler(SimpleHTTPRequestHandler):
    def _set_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST,GET,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self._set_cors()
        self.end_headers()

    def _init_daily_html_log(self, log_file_path):
        if not os.path.exists(log_file_path):
            boot_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            header = HTML_HEADER.replace("{boot_time}", boot_time)
            with open(log_file_path, "w", encoding="utf-8") as f:
                f.write(header)

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
        html_log_path = get_daily_log_filename()
        self._init_daily_html_log(html_log_path)

        length = int(self.headers["Content-Length"])
        body = self.rfile.read(length)
        payload = json.loads(body.decode("utf-8"))

        remote_ip = html.escape(self.client_address[0])
        ua = html.escape(self.headers.get("User-Agent", ""))
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
                f'</audio><br><button onclick="const s=this.parentElement.querySelector(\'source\');if(s)playBoostAudio(s.src,5.0);">🔊×5放大播放</button>'
            )

        timeText = html.escape(payload.get("timeText", ""))
        durSec = html.escape(payload.get("durationSec", ""))
        peakDb = html.escape(payload.get("peakDb", ""))
        lat = html.escape(str(payload.get("lat", "--")))
        lon = html.escape(str(payload.get("lon", "--")))

        tr_html = (
            f"<tr>"
            f"<td>{timeText}</td>"
            f"<td>{tag}</td>"
            f"<td>{durSec}</td>"
            f"<td>{peakDb}</td>"
            f"<td>{lat}</td>"
            f"<td>{lon}</td>"
            f"<td>{audio_html}</td>"
            f"<td>{tag}</td>"
            f"<td>{remote_ip}</td>"
            f"<td>{ua}</td>"
            f"</tr>\n"
        )

        with _io_lock:
            with open(html_log_path, "a", encoding="utf-8") as f:
                f.write(tr_html)

        self.send_response(200)
        self._set_cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        resp = json.dumps({"ok": True, "logfile": os.path.basename(html_log_path)})
        self.wfile.write(resp.encode("utf-8"))

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
    print("录像回看页：https://<主机>:8088/review.html（优先播 MP4）")
    print("⚠️噪声日志文件不会写入</tbody></table></html>，浏览器打开自动补全标签播放音频")
    httpd.serve_forever()
