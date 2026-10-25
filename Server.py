from http.server import HTTPServer, SimpleHTTPRequestHandler
import ssl
import json
import os
from datetime import datetime

ADDR = ('0.0.0.0', 8088)
LOG_DIR = "logs"
os.makedirs(LOG_DIR, exist_ok=True)


def get_daily_log_filename():
    """获取当日日志文件名 noise_log_YYYY‑MM‑DD.html"""
    today = datetime.now().strftime("%Y‑%m‑%d")
    return os.path.join(LOG_DIR, f"noise_log_{today}.html")


# HTML头部模板，新文件创建时写入
HTML_HEADER = """<!DOCTYPE html>
<html lang="zh‑CN">
<head>
<meta charset="utf‑8">
<title>噪声监测服务端日志 {boot_time}</title>
<style>
body{{font‑family:system‑ui,monospace;padding:16px;background:#f8f8f8;color:#111;}}
h2{{margin‑bottom:12px;}}
table{{border‑collapse:collapse;width:100%;font‑size:12px;}}
th{{background:#222;color:#fff;padding:8px;text‑align:left;}}
td{{background:#fff;padding:6px 8px;border‑bottom:#ccc 1px solid;}}
audio{{vertical‑align:middle;height:28px;max‑width:240px;}}
</style>
</head>
<body>
<h2>噪声监测日志(服务端接收)</h2>
<p>日志文件创建时间：{boot_time}</p>
<table>
<thead>
<tr>
<th>服务器接收时间</th>
<th>事件触发时间</th>
<th>持续秒</th>
<th>峰值dB</th>
<th>磁场</th>
<th>振动</th>
<th>纬度</th>
<th>经度</th>
<th>录音</th>
<th>客户端IP</th>
<th>UA</th>
</tr>
</thead>
<tbody>
"""


class MyHandler(SimpleHTTPRequestHandler):
    def _set_cors(self):
        self.send_header("Access‑Control‑Allow‑Origin", "*")
        self.send_header("Access‑Control‑Allow‑Methods", "POST,GET,OPTIONS")
        self.send_header("Access‑Control‑Allow‑Headers", "Content‑Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self._set_cors()
        self.end_headers()

    def _init_daily_html_log(self, log_file_path):
        """当日日志文件不存在，写入头部，不写入闭合标签"""
        if not os.path.exists(log_file_path):
            boot_time = datetime.now().strftime("%Y‑%m‑%d %H:%M:%S")
            header = HTML_HEADER.format(boot_time=boot_time)
            with open(log_file_path, "w", encoding="utf‑8") as f:
                f.write(header)

    def do_POST(self):
        if self.path == "/api/log":
            try:
                html_log_path = get_daily_log_filename()
                self._init_daily_html_log(html_log_path)

                length = int(self.headers["Content‑Length"])
                body = self.rfile.read(length)
                payload = json.loads(body.decode("utf‑8"))
                remote_ip = self.client_address[0]
                ua = self.headers.get("User‑Agent", "")
                server_recv = datetime.now().strftime("%Y‑%m‑%d %H:%M:%S")

                audio_b64 = payload.get("audioData")
                if audio_b64:
                    audio_html = f'<audio controls preload="none"><source src="{audio_b64}" type="audio/webm">不支持播放'
                else:
                    audio_html = '<span style="color:#888">无录音</span>'

                timeText = payload.get("timeText", "")
                durSec = payload.get("durationSec", "")
                peakDb = payload.get("peakDb", "")
                mag = payload.get("mag", "")
                vib = payload.get("vib", "")
                lat = payload.get("lat", "--")
                lon = payload.get("lon", "--")

                tr_html = (
                    f"<tr>"
                    f"<td>{server_recv}</td>"
                    f"<td>{timeText}</td>"
                    f"<td>{durSec}</td>"
                    f"<td>{peakDb}</td>"
                    f"<td>{mag}</td>"
                    f"<td>{vib}</td>"
                    f"<td>{lat}</td>"
                    f"<td>{lon}</td>"
                    f"<td>{audio_html}</td>"
                    f"<td>{remote_ip}</td>"
                    f"<td>{ua}</td>"
                    f"</tr>\n"
                )

                with open(html_log_path, "a", encoding="utf‑8") as f:
                    f.write(tr_html)

                self.send_response(200)
                self._set_cors()
                self.send_header("Content‑Type", "application/json")
                self.end_headers()
                resp = json.dumps({"ok": True, "logfile": os.path.basename(html_log_path)})
                self.wfile.write(resp.encode("utf‑8"))

            except Exception as e:
                self.send_response(500)
                self._set_cors()
                self.send_header("Content‑Type", "application/json")
                self.end_headers()
                err_msg = json.dumps({"ok": False, "err": str(e)})
                self.wfile.write(err_msg.encode("utf‑8"))
            return
        super().do_POST()

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
    print(f"每日日志目录：{LOG_DIR}/ ，文件名：noise_log_YYYY‑MM‑DD.html")
    print("⚠️日志文件不会写入</tbody></table></html>，浏览器打开自动补全标签播放音频")
    httpd.serve_forever()
