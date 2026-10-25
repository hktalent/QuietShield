from http.server import HTTPServer, SimpleHTTPRequestHandler
import traceback
import ssl
import json
import os
from datetime import datetime
import html

ADDR = ('0.0.0.0', 8088)
LOG_DIR = "logs"
os.makedirs(LOG_DIR, exist_ok=True)


def get_daily_log_filename():
    """获取当日日志文件名 noise_log_YYYY-MM-DD.html"""
    today = datetime.now().strftime("%Y-%m-%d")
    return os.path.join(LOG_DIR, f"noise_log_{today}.html")


def extract_mime_from_dataurl(dataurl):
    """从dataURL字符串提取mime类型"""
    if not dataurl or not dataurl.startswith("data:"):
        return None
    head = dataurl.split(",")[0]
    mime_part = head.split(":")[1].split(";")[0]
    return mime_part


# HTML头部模板，script放在head内部
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
async function playBoostAudio(dataUrl, boostGain=3.0){
    // 关闭上一个实例
    if(playBoostAudioCtx){
        try{ playBoostAudioCtx.close(); }catch(e){}
        playBoostAudioCtx = null;
    }
    playBoostAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    if(playBoostAudioCtx.state === 'suspended'){
        await playBoostAudioCtx.resume();
    }

    try{
        // dataURL 转 ArrayBuffer
        const base64Str = dataUrl.split(",")[1];
        const binaryStr = atob(base64Str);
        const len = binaryStr.length;
        const buf = new Uint8Array(len);
        for(let i=0;i<len;i++){
            buf[i] = binaryStr.charCodeAt(i);
        }

        // 解码音频二进制
        const audioBuf = await playBoostAudioCtx.decodeAudioData(buf.buffer);

        // 创建播放源
        const srcNode = playBoostAudioCtx.createBufferSource();
        srcNode.buffer = audioBuf;

        const gainNode = playBoostAudioCtx.createGain();
        gainNode.gain.value = boostGain;

        // 压缩器防爆音削波
        const compressor = playBoostAudioCtx.createDynamicsCompressor();
        compressor.threshold.value = -18;
        compressor.knee.value = 10;
        compressor.ratio.value = 4;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.25;

        // 链路：bufferSource → gain → compressor → 扬声器
        srcNode.connect(gainNode);
        gainNode.connect(compressor);
        compressor.connect(playBoostAudioCtx.destination);

        // 播放结束自动关闭上下文
        srcNode.onended = ()=>{
            if(playBoostAudioCtx){
                playBoostAudioCtx.close();
                playBoostAudioCtx = null;
            }
        };
        srcNode.start(0);

    }catch(err){
        alert("音频播放失败："+err.message);
        if(playBoostAudioCtx){
            playBoostAudioCtx.close();
            playBoostAudioCtx=null;
        }
    }
}
</script>
</head>
<body>
<h2>噪声监测日志</h2>
<p>《噪声污染防治法》扰民噪声：白天(>=6点 <22点) > 55 dB(A)；夜间 > 45 dB(A); 日志创建时间：{boot_time}</p>
<table>
<thead>
<tr>
<th>事件触发时间</th>
<th>持续秒</th>
<th>峰值dB</th>
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
            # ✅修复：不用format，只用简单replace，防止JS大括号解析报错
            header = HTML_HEADER.replace("{boot_time}", boot_time)
            with open(log_file_path, "w", encoding="utf-8") as f:
                f.write(header)


    def do_POST(self):
        if self.path == "/api/log":
            try:
                html_log_path = get_daily_log_filename()
                self._init_daily_html_log(html_log_path)

                length = int(self.headers["Content-Length"])
                body = self.rfile.read(length)
                payload = json.loads(body.decode("utf-8"))

                remote_ip = html.escape(self.client_address[0])
                ua = html.escape(self.headers.get("User-Agent", ""))

                audio_b64 = payload.get("audioData")
                audio_html = '<span style="color:#888">无录音</span>'
                if audio_b64:
                    mime = extract_mime_from_dataurl(audio_b64)
                    if not mime:
                        mime = "audio/webm"
                    b64_escaped_html = audio_b64.replace("'", "&#39;")
                    # ✅修复onclick属性完整引号包裹，使用&#39;传参
                    audio_html = (
                        f'<audio controls preload="none"><source src="{html.escape(audio_b64)}" type="{html.escape(mime)}">不支持播放'
                        f'</audio><br><button onclick="const s=this.parentElement.querySelector(\'source\');if(s)playBoostAudio(s.src,3.0);">🔊×3放大播放</button>'
                    )

                # 全部外部字段做HTML转义！防止UA/特殊字符破坏表格
                timeText = html.escape(payload.get("timeText", ""))
                durSec = html.escape(payload.get("durationSec", ""))
                peakDb = html.escape(payload.get("peakDb", ""))
                lat = html.escape(str(payload.get("lat", "--")))
                lon = html.escape(str(payload.get("lon", "--")))

                tr_html = (
                    f"<tr>"
                    f"<td>{timeText}</td>"
                    f"<td>{durSec}</td>"
                    f"<td>{peakDb}</td>"
                    f"<td>{lat}</td>"
                    f"<td>{lon}</td>"
                    f"<td>{audio_html}</td>"
                    f"<td>{remote_ip}</td>"
                    f"<td>{ua}</td>"
                    f"</tr>\n"
                )

                with open(html_log_path, "a", encoding="utf-8") as f:
                    f.write(tr_html)

                self.send_response(200)
                self._set_cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                resp = json.dumps({"ok": True, "logfile": os.path.basename(html_log_path)})
                self.wfile.write(resp.encode("utf-8"))

            except Exception as e:
                # 打印完整错误堆栈到控制台！非常关键
                traceback.print_exc()
                self.send_response(500)
                self._set_cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                err_msg = json.dumps({"ok": False, "err": str(e)})
                self.wfile.write(err_msg.encode("utf-8"))
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
    print(f"每日日志目录：{LOG_DIR}/ ，文件名：noise_log_YYYY-MM-DD.html")
    print("⚠️日志文件不会写入</tbody></table></html>，浏览器打开自动补全标签播放音频")
    httpd.serve_forever()
