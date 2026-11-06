from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import traceback
import ssl
import sys
import json
import sqlite3
import base64
import time
import os
import re
import glob
import subprocess
import base64
import zipfile
import shutil
import user_agents  # 解析 User-Agent → 可读的设备/系统（如 iOS 12.0 iPhone）
import threading
from datetime import datetime
from urllib.parse import urlparse, parse_qs, unquote
from urllib.request import urlopen, Request
from urllib.error import URLError
import html

# CA 根证书：优先用 certifi 的 cacert.pem（macOS 自带 Python 常缺系统根证书，
# 否则 urlopen 访问 https 会报 CERTIFICATE_VERIFY_FAILED）
try:
    import certifi
    _CA_BUNDLE = certifi.where()
except Exception:
    _CA_BUNDLE = None

# 高德逆地理编码 API Key（从环境变量 QuietShield 读取，避免硬编码泄露）
AMAP_KEY = os.environ.get("QuietShield", "").strip()
# 服务端地址缓存：{ "lat,lon": {"address": ..., "ts": ...} }，减少重复 API 调用
_regeo_cache = {}
_REGO_FAIL_TTL = 60                # 高德返回但无地址时只缓存 60 秒，客户端会持续重试

ADDR = ('0.0.0.0', 8808)
LOG_DIR = "logs"
VIDEO_DIR = "videos"
os.makedirs(LOG_DIR, exist_ok=True)
os.makedirs(VIDEO_DIR, exist_ok=True)

# 全局写锁：确保同设备并发分片落盘不交错
_io_lock = threading.Lock()
# 旧日志迁移锁：同一天可能有多个旧 HTML 分片，必须串行迁移避免写库交错
_migrate_lock = threading.Lock()

# TLS 上下文：由 __main__ 初始化；为 None 时按明文 HTTP 运行
SSL_CONTEXT = None

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


def _amap_get(url):
    """请求高德接口并返回 JSON。
    macOS 的 Python 常缺系统根证书 → 先带 certifi 根证书校验；
    若仍证书校验失败（根证书缺失/过期），降级为不校验证书重试一次
    （仅用于只读的地理编码查询，不涉及账号或敏感数据）。"""
    req = Request(url, headers={"User-Agent": "QuietShield/1.0"})
    ctx = ssl.create_default_context(cafile=_CA_BUNDLE) if _CA_BUNDLE else ssl.create_default_context()
    try:
        with urlopen(req, timeout=8, context=ctx) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except URLError as e:
        if not isinstance(getattr(e, "reason", None), ssl.SSLCertVerificationError):
            raise
    except ssl.SSLCertVerificationError:
        pass
    print("[regeo] 证书校验失败，降级为不校验重试（可安装/更新 certifi 根证书修复）")
    with urlopen(req, timeout=8, context=ssl._create_unverified_context()) as resp:
        return json.loads(resp.read().decode("utf-8"))


def reverse_geocode(lat, lon):
    """经纬度 → 结构化地址（高德逆地理编码）。失败返回空串。
    入参为 WGS-84（浏览器 GPS），内部自动转 GCJ-02 再调用高德。
    缓存顺序：内存 → SQLite（永久缓存，重启后仍生效）→ 高德 API。
    命中成功缓存时直接返回，不再请求高德。"""
    if not AMAP_KEY:
        return ""
    try:
        lat = float(lat)
        lon = float(lon)
    except (TypeError, ValueError):
        return ""
    # 缓存键：保留 3 位小数（约 100m），同一地点（含 GPS 轻微抖动）复用同一结果
    key = f"{lat:.3f},{lon:.3f}"
    now = datetime.now().timestamp()
    cached = _regeo_cache.get(key)
    if cached:
        # 成功结果永久有效；只有“无地址”的短期负缓存会过期
        if cached.get("address"):
            return cached["address"]
        if now - cached.get("ts", 0) < _REGO_FAIL_TTL:
            return ""
    # 内存未命中 → 查持久化缓存（成功结果永久有效，不做过期校验）
    row = _regeo_db_get(key)
    if row and row["address"]:
        _regeo_cache[key] = {"address": row["address"], "ts": row["at"] or now}
        return row["address"]
    try:
        # WGS-84 → GCJ-02，再传给高德（高德只认火星坐标系）
        gcj_lng, gcj_lat = _wgs84_to_gcj02(lon, lat)
        url = (
            f"https://restapi.amap.com/v3/geocode/regeo"
            f"?key={AMAP_KEY}&location={gcj_lng:.6f},{gcj_lat:.6f}&extensions=base"
        )
        data = _amap_get(url)
        if str(data.get("status")) == "1":
            addr = data.get("regeocode", {}).get("formatted_address", "")
            if addr:
                _regeo_cache[key] = {"address": addr, "ts": now}
                _regeo_db_put(key, addr)
                return addr
    except Exception as e:
        print(f"[regeo] 逆地理编码失败: {e}")
        return ""   # 网络/SSL 等异常不做负缓存，下次请求立即重试
    # 没拿到地址也缓存一小段时间，避免客户端轮询时反复触发外部请求
    _regeo_cache[key] = {"address": "", "ts": now}
    return ""


def safe_token(s, fallback="unknown"):
    s = str(s or "")
    s = _SAFE_RE.sub("_", s)
    s = s.strip("_") or fallback
    return s[:128]


# 凌晨时段后缀：文件名与解析共用同一常量，避免两处写法不一致
EARLY_SUFFIX = "_凌晨0100-0600"


def log_stem(date, tag="", early=False):
    """日志 HTML 名称（不含 .html）：noise_log_日期[_标签][_凌晨0100-0600]
    每个标签每天一个独立 HTML；记录仍共用同一个数据库/数据文件，
    页面按标签过滤显示与分页。"""
    name = f"noise_log_{date}"
    tag = safe_token(tag, fallback="") if tag else ""
    if tag:
        name += f"_{tag}"
    if early:
        name += EARLY_SUFFIX
    return name


def parse_log_stem(stem):
    """noise_log_日期[_标签][_凌晨0100-0600] → (日期, 标签, 是否凌晨)
    无法解析返回 None。旧文件（无标签段）标签返回空串，即不过滤。"""
    m = re.match(r"^noise_log_(\d{4}-\d{2}-\d{2})(?:_(.+))?$", str(stem or ""))
    if not m:
        return None
    date, tag = m.group(1), m.group(2) or ""
    # 旧文件无标签段时后缀是 "凌晨0100-0600"（没有前导下划线），新文件是 "_凌晨0100-0600"
    if tag == EARLY_SUFFIX.lstrip("_"):
        tag, early = "", True
    elif tag.endswith(EARLY_SUFFIX):
        tag, early = tag[:-len(EARLY_SUFFIX)], True
    else:
        early = False
    return date, tag, early


def get_daily_log_filename(tag=""):
    """获取当日某标签的日志文件名 noise_log_YYYY-MM-DD[_标签].html"""
    today = datetime.now().strftime("%Y-%m-%d")
    return os.path.join(LOG_DIR, log_stem(today, tag) + ".html")


def get_early_morning_log_filename(tag=""):
    """凌晨(01:00~06:00)单独日志文件，按标签分离，文件名含时段起止(0100-0600)"""
    today = datetime.now().strftime("%Y-%m-%d")
    return os.path.join(LOG_DIR, log_stem(today, tag, True) + ".html")


def extract_mime_from_dataurl(dataurl):
    """从dataURL字符串提取mime类型"""
    if not dataurl or not dataurl.startswith("data:"):
        return None
    head = dataurl.split(",")[0]
    mime_part = head.split(":")[1].split(";")[0]
    return mime_part


# 位置抬头占位：没有定位信息时显示破折号，不再写“未上报（客户端无定位）”这类误导文案
LOC_PENDING = "—"

# 分页外壳标记：写在文件开头 300 字节内，用于区分「外壳」与旧版整文件日志
SHELL_MARK = 'name="qs-shell"'
# 静态资源版本号：写进日志页 URL，强制浏览器取最新 CSS/JS（避免旧脚本不带标签过滤参数）
ASSET_VER = "20261106d"


PAGE_SIZE = 20  # 每页最多显示条数

# 录音文件目录：logs/audio/YYYYMMDD_HHMMSS.webm（独立文件，日志库只存 URL）
AUDIO_DIR = os.path.join(LOG_DIR, "audio")
# 轻量数据库：日志记录存 SQLite，便于分页、按日期范围查询与导出
DB_PATH = os.path.join(LOG_DIR, "logs.db")
# 导出证据包目录（静态 HTML，内嵌音频，可离线打开）
EXPORT_DIR = os.path.join(LOG_DIR, "exports")

# 旧版分页 JSON 文件名：{起}_{止}.json（启动时导入数据库后归档）
_PAGE_JSON_RE = re.compile(r"^\d{8}_\d{6}_\d{8}_\d{6}\.json$")

# 日志 HTML 外壳：只含表头、导出栏与分页栏，记录存 SQLite，翻页时才按需加载
LOG_SHELL = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="qs-shell" content="paged">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>噪声监测服务端日志 {tag_label}{early_tag} {boot_time}</title>
<link href="../css/1.css?v={asset_ver}" rel=stylesheet>
<script src="../js/player.js"></script>
</head>
<body>
<h2>噪声监测日志{tag_label}{early_tag}</h2>
<p>《噪声污染防治法》扰民噪声：白天(>=6点 &lt;22点) &gt; 55 dB(A)；夜间 &gt; 45 dB(A)；录像由 /review.html 回看。日志创建时间：{boot_time}</p>
<p id="locLine" class="loc-bar">📍 位置：{loc_line}</p>
<div class="exp-bar">
  <label>导出范围：<input type="date" id="expStart"></label>
  <span>~</span>
  <label><input type="date" id="expEnd"></label>
  <button type="button" id="expBtn" class="exp-btn">导出离线证据 HTML</button>
  <span id="expMsg" class="exp-msg"></span>
</div>
<div class="pgbar" id="pgbar"></div>
<table>
<thead>
<tr>
<th>事件触发时间</th>
<th>标签</th>
<th>持续秒</th>
<th class="th-sort" data-sort="peak" title="点击按峰值排序（降序/升序切换）">峰值dB<span id="sortInd"></span></th>
<th>录音</th>
<th>客户端IP</th>
<th>UA</th>
</tr>
</thead>
<tbody id="logBody"></tbody>
</table>
<div class="pgbar" id="pgbar2"></div>
<script>window.__LOG_CFG__={cfg};</script>
<script src="../js/logview.js?v={asset_ver}"></script>
</body>
</html>
"""


def _stamp_from_time_text(t):
    """'2026-11-03 10:10:10' → '20261103_101010'；解析失败用当前时间"""
    try:
        return datetime.strptime(str(t), "%Y-%m-%d %H:%M:%S").strftime("%Y%m%d_%H%M%S")
    except Exception:
        return datetime.now().strftime("%Y%m%d_%H%M%S")


def _to_float(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _record_hour(rec):
    try:
        return int(str(rec.get("t", "")).split(" ")[1].split(":")[0])
    except Exception:
        return -1


def _is_early(rec):
    return 1 <= _record_hour(rec) < 6


def _read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _audio_ext(mime):
    m = mime or ""
    if "ogg" in m: return "ogg"
    if "mp4" in m or "aac" in m: return "m4a"
    if "mpeg" in m: return "mp3"
    if "wav" in m: return "wav"
    return "webm"


def save_record_audio(name, data_url, mime):
    """dataURL 录音 → logs/audio/<年月日时分秒>.<后缀> 独立文件，返回播放 URL（失败返回空串）。
    日志库只存该 URL，页面按页加载时再按需取音频。
    设置项 audioBoost5x 开启时，落盘后用放大 5 倍的版本直接覆盖原文件。"""
    if not data_url or not data_url.startswith("data:"):
        return ""
    try:
        raw = base64.b64decode(data_url.split(",", 1)[1])
    except Exception:
        return ""
    if not raw:
        return ""
    os.makedirs(AUDIO_DIR, exist_ok=True)
    base = safe_token(name, fallback="rec")
    ext = _audio_ext(mime)
    fname, n = f"{base}.{ext}", 1
    with _io_lock:
        while os.path.exists(os.path.join(AUDIO_DIR, fname)):  # 同一秒多条时加序号
            n += 1
            fname = f"{base}_{n}.{ext}"
        path = os.path.join(AUDIO_DIR, fname)
        with open(path, "wb") as f:
            f.write(raw)
    # 放大音量：直接覆盖刚保存的版本（不另存副本）；失败则保留原文件
    if load_settings().get("audioBoost5x"):
        if not amplify_audio_inplace(path):
            print(f"[音频] 放大失败，保留原文件: {fname}")
    return f"/audio/{fname}"


def audio_path_from_url(url):
    """'/audio/xxx.webm' → 磁盘真实路径；越界或不存在返回 None"""
    if not url or not url.startswith("/audio/"):
        return None
    base = os.path.realpath(AUDIO_DIR)
    path = os.path.realpath(os.path.join(AUDIO_DIR, unquote(url[len("/audio/"):])))
    if os.path.commonpath([base, path]) != base or not os.path.isfile(path):
        return None
    return path


# ---------------- 运行设置（持久化到 logs/settings.json） ----------------
SETTINGS_FILE = os.path.join(LOG_DIR, "settings.json")
DEFAULT_SETTINGS = {"audioBoost5x": True}


def load_settings():
    """读取运行设置；文件缺失/损坏时返回默认值（录音保存默认放大 5 倍）"""
    data = {}
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}
    merged = dict(DEFAULT_SETTINGS)
    if isinstance(data, dict) and isinstance(data.get("audioBoost5x"), bool):
        merged["audioBoost5x"] = data["audioBoost5x"]
    return merged


def save_settings(patch):
    """保存设置（只接受已知键），返回保存后的完整设置"""
    with _io_lock:
        settings = load_settings()
        if isinstance(patch, dict):
            for key in DEFAULT_SETTINGS:
                if key in patch:
                    settings[key] = bool(patch[key])
        os.makedirs(LOG_DIR, exist_ok=True)
        tmp = SETTINGS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(settings, f, ensure_ascii=False, indent=2)
        os.replace(tmp, SETTINGS_FILE)
    return settings


# ---------------- 录音放大（ffmpeg 就地覆盖） ----------------
AUDIO_BOOST_GAIN = 5            # 放大倍数
AUDIO_BOOST_LIMIT = 0.95        # 峰值限幅，避免放大后削波失真
FFMPEG_BIN = shutil.which("ffmpeg") or next(
    (p for p in ("/Users/51pwn/anaconda3/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg",
                 "/usr/local/bin/ffmpeg") if os.path.isfile(p)), "")

# 后缀 → (编码器, 码率)；wav 直接重采样为 PCM，无损
_BOOST_CODECS = {
    "webm": ("libopus", "96k"),
    "ogg": ("libopus", "96k"),
    "m4a": ("aac", "128k"),
    "mp3": ("libmp3lame", "128k"),
    "wav": ("pcm_s16le", ""),
}


def amplify_audio_inplace(path):
    """用 ffmpeg 把录音放大 5 倍并峰值限幅后原子替换原文件。
    未安装 ffmpeg、格式不支持或转码失败时返回 False，原文件保持不变。"""
    ext = str(path).rsplit(".", 1)[-1].lower()
    codec = _BOOST_CODECS.get(ext)
    if not FFMPEG_BIN or not codec:
        return False
    tmp = f"{path}.boost.{ext}"
    cmd = [FFMPEG_BIN, "-y", "-hide_banner", "-loglevel", "error",
           "-i", path, "-vn",
           "-af", f"volume={AUDIO_BOOST_GAIN},alimiter=limit={AUDIO_BOOST_LIMIT}",
           "-c:a", codec[0]]
    if codec[1]:
        cmd += ["-b:a", codec[1]]
    cmd.append(tmp)
    try:
        r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=120)
        if r.returncode != 0 or not os.path.isfile(tmp) or os.path.getsize(tmp) < 200:
            with _io_lock:
                if os.path.exists(tmp):
                    os.remove(tmp)
            return False
        with _io_lock:
            os.replace(tmp, path)
        return True
    except Exception as e:
        print(f"[音频] 放大异常: {e}")
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        return False


# ---------------- 日志库（SQLite） ----------------
_db_lock = threading.Lock()
_db_ready = False

_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS records(
    ts TEXT PRIMARY KEY, date TEXT NOT NULL, hour INTEGER, t TEXT, stamp TEXT,
    tag TEXT, dur TEXT, peak REAL, audio TEXT, mime TEXT, ip TEXT, ua TEXT,
    ua_raw TEXT, addr TEXT, lat REAL, lon REAL, loc_title TEXT
);
CREATE INDEX IF NOT EXISTS idx_records_date ON records(date);
CREATE INDEX IF NOT EXISTS idx_records_peak ON records(date, peak);
CREATE TABLE IF NOT EXISTS migrated_files(name TEXT PRIMARY KEY, at TEXT);
-- 逆地理编码持久缓存：相同/相近经纬度只调一次高德，服务重启后仍生效
CREATE TABLE IF NOT EXISTS regeo_cache(key TEXT PRIMARY KEY, address TEXT, at REAL);
"""


def _db_conn():
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    global _db_ready
    if _db_ready:
        return
    with _db_lock:
        if _db_ready:
            return
        os.makedirs(LOG_DIR, exist_ok=True)
        con = _db_conn()
        try:
            con.executescript(_CREATE_SQL)
            con.commit()
        finally:
            con.close()
        _db_ready = True


def _regeo_db_get(key):
    """读持久化地址缓存，返回 sqlite Row（address/at）或 None"""
    try:
        init_db()
        with _db_lock:
            con = _db_conn()
            try:
                return con.execute(
                    "SELECT address, at FROM regeo_cache WHERE key=?", (key,)).fetchone()
            finally:
                con.close()
    except Exception:
        return None


def _regeo_db_put(key, address):
    """成功解析的地址写入持久化缓存（重启后无需再调高德）"""
    try:
        init_db()
        with _db_lock:
            con = _db_conn()
            try:
                con.execute(
                    "INSERT OR REPLACE INTO regeo_cache(key,address,at) VALUES(?,?,?)",
                    (key, address, datetime.now().timestamp()))
                con.commit()
            finally:
                con.close()
    except Exception as e:
        print(f"[regeo] 写缓存失败: {e}")


def is_file_migrated(name):
    init_db()
    with _db_lock:
        con = _db_conn()
        try:
            return con.execute("SELECT 1 FROM migrated_files WHERE name=?", (name,)).fetchone() is not None
        finally:
            con.close()


def mark_file_migrated(name):
    init_db()
    with _db_lock:
        con = _db_conn()
        try:
            con.execute("INSERT OR REPLACE INTO migrated_files(name, at) VALUES(?,?)",
                        (name, datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
            con.commit()
        finally:
            con.close()


def _record_values(date, rec):
    """记录 dict → 数据库一行（顺序与 INSERT 列一致）"""
    hour = _record_hour(rec)
    return (
        str(rec.get("ts") or ""), date, hour, str(rec.get("t") or ""), str(rec.get("stamp") or ""),
        str(rec.get("tag") or ""), str(rec.get("dur") or ""), _to_float(rec.get("peak")),
        str(rec.get("audio") or ""), str(rec.get("mime") or ""), str(rec.get("ip") or ""),
        str(rec.get("ua") or ""), str(rec.get("uaRaw") or ""), str(rec.get("addr") or ""),
        rec.get("lat"), rec.get("lon"), str(rec.get("locTitle") or ""),
    )


_INSERT_SQL = """INSERT OR REPLACE INTO records
(ts,date,hour,t,stamp,tag,dur,peak,audio,mime,ip,ua,ua_raw,addr,lat,lon,loc_title)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"""


def append_log_record(date, record):
    """写入一条记录（ts 为主键，重复上报自动覆盖）"""
    init_db()
    with _db_lock:
        con = _db_conn()
        try:
            con.execute(_INSERT_SQL, _record_values(date, record))
            con.commit()
        finally:
            con.close()


def append_log_records(date, records):
    """批量写入（旧日志迁移用，减少事务次数）"""
    if not records:
        return 0
    init_db()
    with _db_lock:
        con = _db_conn()
        try:
            con.executemany(_INSERT_SQL, [_record_values(date, r) for r in records])
            con.commit()
        finally:
            con.close()
    return len(records)


def _row_to_record(row):
    return {
        "t": row["t"] or "", "ts": row["ts"] or "", "stamp": row["stamp"] or "",
        "tag": row["tag"] or "", "dur": row["dur"] or "", "peak": row["peak"],
        "audio": row["audio"] or "", "mime": row["mime"] or "", "ip": row["ip"] or "",
        "ua": row["ua"] or "", "uaRaw": row["ua_raw"] or "", "addr": row["addr"] or "",
        "lat": row["lat"], "lon": row["lon"], "locTitle": row["loc_title"] or "",
    }


def list_tags_for_date(date, early=False):
    """某天出现过的标签（去重升序），供旧日志迁移后按标签建独立日志页"""
    init_db()
    where = "date=?"
    if early:
        where += " AND hour>=1 AND hour<6"
    with _db_lock:
        con = _db_conn()
        try:
            rows = con.execute(
                f"SELECT DISTINCT tag FROM records WHERE {where} ORDER BY tag", (date,)).fetchall()
        finally:
            con.close()
    return [r["tag"] or "" for r in rows]


_SORT_SQL = {
    "time": "ts ASC",
    "time_desc": "ts DESC",
    "peak_desc": "peak DESC, ts ASC",
    "peak_asc": "peak ASC, ts ASC",
}


def _log_where(date, early=False, tag=""):
    """日志查询条件：日期 + 可选凌晨时段 + 可选标签（标签为空表示不过滤）。
    返回 (where 子句, 参数列表)，供分页/导出/打包共用。"""
    where, args = "date=?", [date]
    if early:
        where += " AND hour>=1 AND hour<6"
    tag = str(tag or "")
    if tag:
        where += " AND tag=?"
        args.append(tag)
    return where, args


def query_log_page(date, page=0, size=PAGE_SIZE, sort="time", early=False, tag=""):
    """按日期取一页（sort: time / time_desc / peak_desc / peak_asc）"""
    init_db()
    where, args = _log_where(date, early, tag)
    order = _SORT_SQL.get(sort, _SORT_SQL["time"])
    try:
        page = max(0, int(page))
        size = max(1, min(200, int(size or PAGE_SIZE)))
    except (TypeError, ValueError):
        page, size = 0, PAGE_SIZE
    with _db_lock:
        con = _db_conn()
        try:
            total = con.execute(f"SELECT COUNT(*) FROM records WHERE {where}", args).fetchone()[0]
            rows = con.execute(
                f"SELECT * FROM records WHERE {where} ORDER BY {order} LIMIT ? OFFSET ?",
                args + [size, page * size]).fetchall()
        finally:
            con.close()
    return {"date": date, "tag": tag, "page": page, "size": size, "total": total,
            "rows": [_row_to_record(r) for r in rows]}


def query_log_range(start, end, tag=""):
    """按日期范围（含首尾）取全部记录，供导出证据包"""
    init_db()
    where, args = "date>=? AND date<=?", [start, end]
    tag = str(tag or "")
    if tag:
        where += " AND tag=?"
        args.append(tag)
    with _db_lock:
        con = _db_conn()
        try:
            rows = con.execute(
                f"SELECT * FROM records WHERE {where} ORDER BY ts ASC", args).fetchall()
        finally:
            con.close()
    return [_row_to_record(r) for r in rows]


def query_log_all(date, early=False, tag=""):
    """取某一天（可只取凌晨时段、可只取某标签）的全部记录，按时间升序 —— 离线 ZIP 打包用"""
    init_db()
    where, args = _log_where(date, early, tag)
    with _db_lock:
        con = _db_conn()
        try:
            rows = con.execute(
                f"SELECT * FROM records WHERE {where} ORDER BY ts ASC", args).fetchall()
        finally:
            con.close()
    return [_row_to_record(r) for r in rows]


def exportable_records(recs):
    """证据包只保留有录音且峰值大于 0 的记录（无录音/峰值 0 的整行剔除）"""
    out = []
    for r in recs:
        if not r.get("audio"):
            continue
        try:
            peak = float(r.get("peak") or 0)
        except (TypeError, ValueError):
            peak = 0.0
        if peak <= 0:
            continue
        out.append(r)
    return out


def query_export_count(date, early=False, tag=""):
    """某天可导出的记录数（有录音且峰值 > 0），供导出界面显示"""
    init_db()
    where, args = _log_where(date, early, tag)
    where += " AND audio<>'' AND peak IS NOT NULL AND peak>0"
    with _db_lock:
        con = _db_conn()
        try:
            return con.execute(
                f"SELECT COUNT(*) FROM records WHERE {where}", args).fetchone()[0]
        finally:
            con.close()


_EXT_MIME = {"webm": "audio/webm", "ogg": "audio/ogg", "m4a": "audio/mp4",
             "mp3": "audio/mpeg", "wav": "audio/wav"}


def _audio_to_data_url(url, mime=""):
    """独立音频文件 → dataURL（导出离线证据包时内嵌，不再依赖服务器）"""
    path = audio_path_from_url(url)
    if not path:
        return ""
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return ""
    mt = (mime or "").split(";")[0].strip() or _EXT_MIME.get(
        path.rsplit(".", 1)[-1].lower(), "audio/webm")
    return f"data:{mt};base64,{base64.b64encode(raw).decode()}"


def _player_js_source():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "js", "player.js")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def build_evidence_html(start, end, tag=""):
    """生成可离线打开的静态证据日志（音频内嵌 dataURL，无服务器也能播放）。
    传入标签时只导出该标签的记录（与标签日志页一致）。"""
    tag = str(tag or "")
    recs = query_log_range(start, end, tag)
    peaks = [_to_float(r.get("peak")) for r in recs] or [0.0]
    audios = []
    rows = []
    for i, r in enumerate(recs):
        data_url = _audio_to_data_url(r.get("audio"), r.get("mime"))
        idx = -1
        if data_url:
            idx = len(audios)
            audios.append(data_url)
        loc = html.escape(r.get("locTitle") or "", quote=True)
        if idx >= 0:
            au = (f'<button class="au-btn" data-i="{idx}" data-mode="raw" title="原始播放">▶</button>'
                  f'<button class="au-btn" data-i="{idx}" data-mode="boost" title="5倍音量播放">🔊</button>'
                  f'<button class="au-btn" data-i="{idx}" data-mode="clear" title="降噪清晰播放">✨</button>')
        else:
            au = '<span style="color:#888">无录音</span>'
        rows.append(
            "<tr>"
            f'<td title="📍 {loc}">{html.escape(r.get("t") or "")}</td>'
            f"<td>{html.escape(r.get('tag') or '')}</td>"
            f"<td>{html.escape(str(r.get('dur') or ''))}</td>"
            f"<td>{html.escape(str(r.get('peak') if r.get('peak') is not None else ''))}</td>"
            f"<td class='au'>{au}</td>"
            f"<td>{html.escape(r.get('ip') or '')}</td>"
            f"<td title=\"{html.escape(r.get('uaRaw') or '', quote=True)}\">{html.escape(r.get('ua') or '')}</td>"
            "</tr>")
    gen = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    audio_json = json.dumps(audios, ensure_ascii=False)
    player = _player_js_source()
    doc = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>噪声监测证据日志 {start} ~ {end}{(' · ' + html.escape(tag)) if tag else ''}</title>
<style>
body{{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:20px;color:#222;background:#fff}}
h1{{font-size:20px;margin:0 0 8px}}
.meta{{background:#eef;padding:8px 12px;border-radius:6px;font-size:13px;line-height:1.7;margin-bottom:12px}}
table{{width:100%;border-collapse:collapse;font-size:13px}}
th,td{{border:1px solid #d5d9e0;padding:6px 8px;text-align:left;vertical-align:middle}}
th{{background:#f4f6fa;position:sticky;top:0}}
tr:nth-child(even) td{{background:#fafbfd}}
.au{{white-space:nowrap}}
.au-btn{{font-size:14px;line-height:1;padding:5px 7px;margin-right:4px;border:1px solid #ccd;border-radius:4px;background:#fff;cursor:pointer}}
.au-btn:hover{{background:#eef4ff;border-color:#8ab}}
.note{{color:#666;font-size:12px;margin-top:10px;line-height:1.6}}
</style>
</head>
<body>
<h1>噪声监测证据日志{('（标签：' + html.escape(tag) + '）') if tag else ''}</h1>
<div class="meta">
区间：{html.escape(start)} ~ {html.escape(end)}{('　标签：' + html.escape(tag)) if tag else ''}　记录数：{len(recs)}　最高峰值：{max(peaks):.1f} dB<br>
判定参考：《噪声污染防治法》白天(≥6点 &lt;22点) &gt; 55 dB(A)；夜间 &gt; 45 dB(A)<br>
生成时间：{gen}　生成工具：QuietShield
</div>
<table>
<thead><tr>
<th>事件触发时间</th><th>标签</th><th>持续秒</th><th>峰值dB</th><th>录音</th><th>客户端IP</th><th>UA</th>
</tr></thead>
<tbody>
{''.join(rows) or '<tr><td colspan="7" style="color:#888">该区间暂无记录</td></tr>'}
</tbody>
</table>
<p class="note">本文件为独立静态证据包：录音已以 dataURL 内嵌，无需服务器即可播放与存档。按钮 ▶ 原始播放、🔊 5 倍音量、✨ 降噪清晰播放。</p>
<script>
{player}
var __AUDIOS = {audio_json};
document.querySelectorAll('button[data-i]').forEach(function (b) {{
  b.onclick = function () {{
    var src = __AUDIOS[Number(b.dataset.i)];
    if (!src) return;
    if (b.dataset.mode === 'boost') playBoostAudio(src);
    else if (b.dataset.mode === 'clear') playClearAudio(src);
    else playRawAudio(src);
  }};
}});
</script>
</body>
</html>"""
    return doc, len(recs)


def _offline_js_source():
    """离线 ZIP 内的分页/播放脚本（与在线 logview.js 相互独立，不依赖 fetch）"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "js", "logoffline.js")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


_OFFLINE_CSS = """
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:20px;color:#222;background:#fff}
h1{font-size:20px;margin:0 0 10px}
.meta{background:#eef;padding:8px 12px;border-radius:6px;font-size:13px;line-height:1.8;margin-bottom:12px}
.meta b{font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border:1px solid #d5d9e0;padding:6px 8px;text-align:left;vertical-align:middle}
th{background:#f4f6fa;position:sticky;top:0}
tr:nth-child(even) td{background:#fafbfd}
th.th-sort{cursor:pointer;user-select:none}
.au{white-space:nowrap}
.au audio{height:32px;max-width:240px;vertical-align:middle}
.pbtn{font-size:13px;line-height:1;padding:5px 8px;margin-right:4px;border:1px solid #ccd;border-radius:4px;background:#fff;cursor:pointer}
.pbtn:hover{background:#eef4ff;border-color:#8ab}
.pgbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:10px 0}
.pg-btn,.pg-nav{font-size:13px;padding:4px 9px;border:1px solid #ccd;border-radius:4px;background:#fff;cursor:pointer}
.pg-btn:hover,.pg-nav:hover{background:#eef4ff;border-color:#8ab}
.pg-btn.active{background:#2f6fed;border-color:#2f6fed;color:#fff}
.pg-info{color:#666;font-size:12px;margin-left:6px}
.pg-dots{color:#888}
.note{color:#666;font-size:12px;margin-top:12px;line-height:1.7}
"""


def build_offline_log_html(meta):
    """离线日志页：记录由 data/log.js 以 <script> 方式载入，
    因此 file:// 直接双击也能分页；录音用相对路径 audio/xxx 播放。"""
    date = html.escape(str(meta.get("date") or ""))
    early = bool(meta.get("early"))
    tag = str(meta.get("tag") or "")
    tag_html = html.escape(tag)
    title = (f"噪声监测日志 {date}" +
             (f"（标签：{tag}）" if tag else "") +
             ("（凌晨 01:00-06:00）" if early else ""))
    loc = html.escape(str(meta.get("location") or "—"))
    count = int(meta.get("count") or 0)
    exported = html.escape(str(meta.get("exported_at") or ""))
    tag_line = f"　<b>标签：</b>{tag_html}" if tag else ""
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)}（离线证据包）</title>
<style>{_OFFLINE_CSS}</style>
</head>
<body>
<h1>{html.escape(title)}</h1>
<div class="meta">
<b>日期：</b>{date}{tag_line}　<b>记录数：</b><span id="mTotal">{count}</span>　<b>位置：</b>{loc}<br>
判定参考：《噪声污染防治法》扰民噪声：白天(≥6点 &lt;22点) &gt; 55 dB(A)；夜间 &gt; 45 dB(A)<br>
<b>导出时间：</b>{exported}
</div>
<div class="pgbar" id="pgbar"></div>
<table>
<thead>
<tr>
<th>事件触发时间</th><th>标签</th><th>持续秒</th>
<th class="th-sort" data-sort="peak" title="点击按峰值排序（降序/升序切换）">峰值dB<span id="sortInd"></span></th>
<th>录音</th><th>客户端IP</th><th>UA</th>
</tr>
</thead>
<tbody id="logBody"></tbody>
</table>
<div class="pgbar" id="pgbar2"></div>
<p class="note">本文件与同目录 js/、data/、audio/ 构成离线证据包：双击 index.html 即可分页浏览，原始播放可直接收听；「5 倍音量 / 降噪清晰」需通过本地服务器打开（浏览器安全策略禁止在 file:// 下读取并处理本地音频），例如在该目录执行 python3 -m http.server 8000 后访问 http://localhost:8000/ 。</p>
<script src="data/log.js"></script>
<script src="js/player.js"></script>
<script src="js/offline.js"></script>
</body>
</html>"""


def build_offline_log_zip(stem):
    """按日志名（不含 .html）打包离线证据 ZIP：html + js + json + 音频。
    日志名形如 noise_log_日期[_标签][_凌晨0100-0600]，打包只含该标签的记录。
    返回 (zip 路径, 记录数, 音频文件数)；名称非法或日期解析失败返回 None。"""
    stem = str(stem or "").strip()
    if not re.fullmatch(r"noise_log_[^/\\]+", stem) or ".." in stem:
        return None
    parsed = parse_log_stem(stem)
    if not parsed:
        return None
    date, tag, early = parsed
    # 证据包只保留有录音且峰值 > 0 的记录（按标签过滤）
    recs = exportable_records(query_log_all(date, early, tag))
    meta = {
        "name": stem,
        "date": date,
        "tag": tag,
        "early": early,
        "count": len(recs),
        "location": latest_location_line(date, tag),
        "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    # 只打包本日志实际引用的音频，避免把整个 audio 目录塞进证据包；
    # 音频放在 audio/ 目录，离线页通过相对路径实时 fetch 读取，不再内嵌 base64
    # （否则 data/audio.js 会重复存放整份音频，可达数百 MB，页面打开极慢）
    audio_map = {}
    for r in recs:
        p = audio_path_from_url(r.get("audio"))
        if not p:
            continue
        fname = os.path.basename(p)
        audio_map[fname] = p
        r["audio"] = "audio/" + fname   # 记录字段改为离线相对路径
    payload = {"meta": meta, "records": recs}
    # data/log.js：用 <script> 注入数据，绕开 file:// 下 fetch 被浏览器禁止的问题
    data_js = ("window.__QS_LOG__ = " +
               json.dumps(payload, ensure_ascii=False).replace("<", "\\u003c") + ";\n")
    data_json = json.dumps(payload, ensure_ascii=False, indent=1)
    os.makedirs(EXPORT_DIR, exist_ok=True)
    zip_name = f"{stem}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"
    zip_path = os.path.join(EXPORT_DIR, zip_name)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("index.html", build_offline_log_html(meta))
        z.writestr("js/offline.js", _offline_js_source())
        z.writestr("js/player.js", _player_js_source())
        z.writestr("data/log.js", data_js)
        z.writestr("data/log.json", data_json)
        for fname, p in sorted(audio_map.items()):
            z.write(p, f"audio/{fname}", compress_type=zipfile.ZIP_STORED)
    return zip_path, len(recs), len(audio_map)


def list_log_html_stems():
    """logs/ 下所有日志 HTML 的名称（去掉 .html），按日期倒序、标签升序。
    每个条目带 date/tag/early/count，供导出界面按日期与标签分组显示。"""
    try:
        names = sorted(os.listdir(LOG_DIR))
    except OSError:
        return []
    items = []
    for fn in names:
        if not (fn.startswith("noise_log_") and fn.endswith(".html")):
            continue
        full = os.path.join(LOG_DIR, fn)
        if not os.path.isfile(full):
            continue
        stem = fn[:-5]
        parsed = parse_log_stem(stem)
        if not parsed:
            continue
        date, tag, early = parsed
        try:
            count = query_export_count(date, early, tag)
        except Exception:
            count = 0
        items.append({"name": stem, "date": date, "tag": tag, "early": early, "count": count})
    items.sort(key=lambda x: (x["tag"], x["early"], x["name"]))
    items.sort(key=lambda x: x["date"], reverse=True)
    return items


def delete_log_record(ts):
    """删除一条记录并联动删除其独立音频文件，返回删除条数"""
    init_db()
    with _db_lock:
        con = _db_conn()
        try:
            row = con.execute("SELECT audio FROM records WHERE ts=?", (str(ts),)).fetchone()
            removed = con.execute("DELETE FROM records WHERE ts=?", (str(ts),)).rowcount
            con.commit()
        finally:
            con.close()
    if row and row["audio"]:
        path = audio_path_from_url(row["audio"])
        if path:
            try:
                os.remove(path)
            except OSError:
                pass
    return removed


def latest_location_line(date=None, tag=""):
    """最近一条带定位记录的抬头位置文案；没有则返回空串。
    日志页抬头不再固定写“未上报”，而是从数据库回填真实地址。
    传入标签时只取该标签的记录，保证每个标签日志页的位置互不串台。"""
    init_db()
    where, args = "loc_title<>''", []
    if date:
        where += " AND date=?"
        args.append(date)
    tag = str(tag or "")
    if tag:
        where += " AND tag=?"
        args.append(tag)
    try:
        with _db_lock:
            con = _db_conn()
            try:
                row = con.execute(
                    f"SELECT loc_title FROM records WHERE {where} ORDER BY ts DESC LIMIT 1",
                    args).fetchone()
            finally:
                con.close()
        return row["loc_title"] if row else ""
    except Exception:
        return ""


def set_log_location_text(log_file_path, loc_line):
    """把日志外壳抬头的位置行改成 loc_line（空白则显示 —）"""
    if not os.path.exists(log_file_path):
        return
    new_loc = html.escape(loc_line or LOC_PENDING)
    try:
        with _io_lock:
            with open(log_file_path, "r", encoding="utf-8") as f:
                content = f.read()
            content = re.sub(
                r'(<p id="locLine"[^>]*>📍 位置：).*?(</p>)',
                lambda m: m.group(1) + new_loc + m.group(2),
                content,
                count=1,
            )
            with open(log_file_path, "w", encoding="utf-8") as f:
                f.write(content)
    except Exception as e:
        print(f"[回填位置失败] {log_file_path}: {e}")


def _legacy_header_location(path):
    """旧版日志页抬头里记录过的定位地址（只读文件头部，大文件也不会慢）"""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            head = f.read(4096)
    except OSError:
        return ""
    m = re.search(r'<p id="locLine"[^>]*>.*?📍 位置：(.*?)</p>', head, re.DOTALL)
    if not m:
        return ""
    loc = html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()
    if loc in ("", LOC_PENDING, "未上报（客户端无定位）"):
        return ""
    return loc


def _legacy_row_location(path):
    """从旧日志行标题里取带经纬度的定位（形如“地址（30.673836, 103.962540）”）。
    只扫描文件前 4MB（第一行就在附近），命中即停，大文件也不慢。"""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            head = f.read(4 * 1024 * 1024)
    except OSError:
        return ""
    m = re.search(r'<td title="📍 ([^"]*?)">', head)
    if not m:
        return ""
    loc = html.unescape(m.group(1)).strip()
    return loc if "（" in loc else ""


def _split_location(loc):
    """把“地址（lat, lon）”拆成 (地址, 纬度, 经度)；无坐标则返回 (原文, None, None)"""
    loc = str(loc or "").strip()
    m = re.search(r"（(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)）", loc)
    if not m:
        return loc, None, None
    return loc[:m.start()].strip(), float(m.group(1)), float(m.group(2))


def backfill_locations_from_legacy():
    """旧日志迁移时没有 addr/loc_title，但旧页抬头/行标题里有历史定位：
    按日期回填进数据库（优先带经纬度的行标题），避免日志页丢失已知位置。"""
    legacy_dir = os.path.join(LOG_DIR, "_legacy")
    try:
        names = sorted(os.listdir(legacy_dir))
    except OSError:
        return
    by_date = {}
    for fn in names:
        if not (fn.startswith("noise_log_") and fn.endswith(".html")):
            continue
        m = re.search(r"noise_log_(\d{4}-\d{2}-\d{2})", fn)
        if not m or m.group(1) in by_date:
            continue
        full = os.path.join(legacy_dir, fn)
        # 行标题里的地址带经纬度，比页抬头更具体，优先使用
        loc = _legacy_row_location(full) or _legacy_header_location(full)
        if loc:
            by_date[m.group(1)] = loc
    if not by_date:
        return
    init_db()
    try:
        with _db_lock:
            con = _db_conn()
            try:
                for date, loc in by_date.items():
                    addr, lat, lon = _split_location(loc)
                    con.execute(
                        "UPDATE records SET "
                        "addr=CASE WHEN addr='' THEN ? ELSE addr END, "
                        "loc_title=CASE WHEN loc_title='' OR loc_title NOT LIKE '%（%' THEN ? ELSE loc_title END, "
                        "lat=CASE WHEN lat IS NULL THEN ? ELSE lat END, "
                        "lon=CASE WHEN lon IS NULL THEN ? ELSE lon END "
                        "WHERE date=?",
                        (addr, loc, lat, lon, date))
                con.commit()
            finally:
                con.close()
        print(f"[位置回填] 旧日志地址已写入 {len(by_date)} 天：{', '.join(sorted(by_date))}")
    except Exception as e:
        print(f"[位置回填] 失败: {e}")


def refresh_shell_locations():
    """启动时为所有现有日志外壳回填位置（数据库最近一条记录，无则 —）"""
    try:
        names = [n for n in os.listdir(LOG_DIR)
                 if n.startswith("noise_log_") and n.endswith(".html")]
    except OSError:
        return
    for fn in names:
        path = os.path.join(LOG_DIR, fn)
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                head = f.read(300)
            if SHELL_MARK not in head:
                continue
            parsed = parse_log_stem(fn[:-5])
            if not parsed:
                continue
            date, tag, _early = parsed
            set_log_location_text(path, latest_location_line(date, tag))
        except Exception as e:
            print(f"[位置回填失败] {fn}: {e}")


def write_log_shell_file(log_file_path, date, early=False, loc_line=None, tag=""):
    """写日志外壳（含创建时间、标签与位置抬头）。记录不写在这里，由页面按页从数据库加载"""
    boot_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    tag = str(tag or "")
    if not loc_line:
        loc_line = latest_location_line(date, tag)
    loc = html.escape(loc_line or LOC_PENDING)
    tag_label = f"（标签：{html.escape(tag)}）" if tag else ""
    cfg = json.dumps({"date": date, "early": bool(early), "tag": tag}, ensure_ascii=False)
    text = (LOG_SHELL
            .replace("{boot_time}", boot_time)
            .replace("{loc_line}", loc)
            .replace("{tag_label}", tag_label)
            .replace("{early_tag}", "（凌晨 01:00-06:00）" if early else "")
            .replace("{asset_ver}", ASSET_VER)
            .replace("{cfg}", cfg))
    with _io_lock:
        with open(log_file_path, "w", encoding="utf-8") as f:
            f.write(text)


def ensure_tag_shells(date):
    """确保某天每个标签都有独立日志页（日常 + 凌晨），已存在的不覆盖。返回新建数量"""
    created = 0
    for tag in list_tags_for_date(date):
        path = os.path.join(LOG_DIR, log_stem(date, tag) + ".html")
        if not os.path.exists(path):
            write_log_shell_file(path, date, False, None, tag)
            created += 1
    for tag in list_tags_for_date(date, early=True):
        path = os.path.join(LOG_DIR, log_stem(date, tag, True) + ".html")
        if not os.path.exists(path):
            write_log_shell_file(path, date, True, None, tag)
            created += 1
    return created


def refresh_tag_shells():
    """启动时为数据库里已有的日期补齐按标签分离的日志页（旧数据也能按标签查看/导出）"""
    init_db()
    try:
        with _db_lock:
            con = _db_conn()
            try:
                dates = [r[0] for r in con.execute(
                    "SELECT DISTINCT date FROM records ORDER BY date").fetchall()]
            finally:
                con.close()
    except Exception as e:
        print(f"[标签日志] 读取日期失败: {e}")
        return
    total = 0
    for date in dates:
        total += ensure_tag_shells(date)
    if total:
        print(f"[标签日志] 已按标签补齐 {total} 个日志页")


def refresh_shell_assets():
    """把已有日志页里的 CSS/JS 引用升级为带版本号的 URL。
    日志页数据由 logview.js 按标签请求，若浏览器沿用旧脚本（不带 tag 参数），
    标签页会错误显示其他标签的记录；版本号可强制浏览器重新加载。"""
    changed = 0
    try:
        names = [n for n in os.listdir(LOG_DIR)
                 if n.startswith("noise_log_") and n.endswith(".html")]
    except OSError:
        return
    for fn in names:
        path = os.path.join(LOG_DIR, fn)
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
        except OSError:
            continue
        if SHELL_MARK not in text[:300]:
            continue
        new = re.sub(r"\.\./css/1\.css(?:\?v=[^\"'\s>]*)?",
                     f"../css/1.css?v={ASSET_VER}", text)
        new = re.sub(r"\.\./js/logview\.js(?:\?v=[^\"'\s>]*)?",
                     f"../js/logview.js?v={ASSET_VER}", new)
        if new != text:
            with _io_lock:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(new)
            changed += 1
    if changed:
        print(f"[日志页] 已升级 {changed} 个页面的 CSS/JS 版本号")


def _legacy_row_to_record(ts, inner, date):
    """旧版 HTML 的一行 → 记录 dict（录音同步落盘为独立文件）"""
    tds = re.findall(r"<td[^>]*>(.*?)</td>", inner, re.DOTALL)
    if len(tds) < 6:
        return None
    t = re.sub(r"<[^>]+>", "", tds[0]).strip()
    tag = re.sub(r"<[^>]+>", "", tds[1]).strip()
    dur = re.sub(r"<[^>]+>", "", tds[2]).strip()
    peak = _to_float(re.sub(r"<[^>]+>", "", tds[3]).strip())
    audio_m = re.search(r'<source src="([^"]+)"', tds[4])
    mime_m = re.search(r'type="([^"]+)"', tds[4])
    audio_src = html.unescape(audio_m.group(1)) if audio_m else ""
    mime = html.unescape(mime_m.group(1)) if mime_m else "audio/webm"
    ip = re.sub(r"<[^>]+>", "", tds[5]).strip()
    # UA 单元格的 title 属性里是原始 UA（必须按列序取第 7 个 td 的属性，
    # 否则会误取时间列上的定位 title）
    td_attrs = re.findall(r"<td([^>]*)>", inner)
    ua_attr = td_attrs[6] if len(td_attrs) > 6 else ""
    ua_m = re.search(r'title="([^"]*)"', ua_attr)
    ua_disp = re.sub(r"<[^>]+>", "", tds[6]).strip() if len(tds) > 6 else ""
    stamp = _stamp_from_time_text(t)
    if audio_src.startswith("data:"):
        audio_url = save_record_audio(stamp, audio_src, mime)
    else:
        audio_url = audio_src
    return {
        "t": t, "ts": ts, "stamp": stamp, "tag": tag, "dur": dur, "peak": peak,
        "audio": audio_url, "mime": mime, "ip": ip, "ua": ua_disp,
        "uaRaw": html.unescape(ua_m.group(1)) if ua_m else "",
        "addr": "", "lat": None, "lon": None, "locTitle": "",
    }


def migrate_legacy_log_file(path, date):
    """流式迁移旧版日志 HTML → SQLite + 独立音频文件，返回迁移条数。
    旧版一行一条 <tr>，逐行读取，上百 MB 文件也不会撑爆内存。"""
    init_db()
    existing = set()
    with _db_lock:
        con = _db_conn()
        try:
            existing = {r[0] for r in con.execute("SELECT ts FROM records WHERE date=?", (date,))}
        finally:
            con.close()
    n = 0
    pending = []
    buf, buf_size = [], 0
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            if not buf and '<tr id="log-' not in line:
                continue
            buf.append(line)
            buf_size += len(line)
            if "</tr>" not in line:
                if buf_size > 12 * 1024 * 1024:   # 异常大行，放弃该行避免内存爆掉
                    buf, buf_size = [], 0
                continue
            chunk = "".join(buf)
            buf, buf_size = [], 0
            for ts, inner in re.findall(r'<tr id="log-([^"]*)">(.*?)</tr>', chunk, re.DOTALL):
                if str(ts) in existing:
                    continue
                rec = _legacy_row_to_record(ts, inner, date)
                if not rec:
                    continue
                pending.append(rec)
                existing.add(str(ts))
                if len(pending) >= 200:
                    append_log_records(date, pending)
                    n += len(pending)
                    pending = []
    if pending:
        n += append_log_records(date, pending)
    print(f"[迁移进度] {os.path.basename(path)}：{n} 条")
    return n


def _move_to_legacy(path):
    """把旧日志移到 logs/_legacy/ 保留原件，返回新路径（失败返回 None）"""
    legacy_dir = os.path.join(LOG_DIR, "_legacy")
    try:
        os.makedirs(legacy_dir, exist_ok=True)
        dst = os.path.join(legacy_dir, os.path.basename(path))
        if os.path.exists(dst):
            dst = dst.replace(".html", f"_{int(time.time())}.html")
        os.replace(path, dst)
        return dst
    except OSError as e:
        print(f"[迁移] 移动失败 {path}: {e}")
        return None


def _migrate_one(src, date):
    """迁移单个旧日志文件，成功后记录到 migrated_files，重启不再重复解析"""
    print(f"[迁移开始] {os.path.basename(src)} → SQLite …")
    try:
        n = migrate_legacy_log_file(src, date)
        # 旧日志入库后按标签补齐独立日志页（每个标签每天一个；凌晨单独一份）
        ensure_tag_shells(date)
        mark_file_migrated(os.path.basename(src))
        print(f"[迁移完成] {os.path.basename(src)}：{n} 条")
        return True
    except Exception:
        traceback.print_exc()
        return False


def _legacy_migration_job(src, date):
    with _migrate_lock:
        _migrate_one(src, date)


def _legacy_migration_queue(jobs):
    """启动迁移队列：按文件名顺序串行迁移，避免同一天多个分片并发写乱"""
    for src, date in jobs:
        with _migrate_lock:
            _migrate_one(src, date)


def start_legacy_migration(path, date):
    """旧版日志先移到 logs/_legacy/ 保留原件，再后台迁移（不阻塞任何请求）"""
    dst = _move_to_legacy(path)
    if not dst:
        return
    threading.Thread(target=_legacy_migration_job, args=(dst, date), daemon=True).start()


def migrate_all_legacy_logs():
    """启动时扫描：旧版（行写在 HTML 里）的日志全部导入 SQLite。
    先统一移入 logs/_legacy/，再由单个后台线程按文件名顺序串行迁移；
    已在 _legacy/ 但尚未入库的原件也会补导（ts 主键去重，可重复执行）。"""
    try:
        names = sorted(os.listdir(LOG_DIR))
    except OSError:
        return
    jobs, seen = [], set()

    def add_job(src, date):
        if src not in seen:
            seen.add(src)
            jobs.append((src, date))

    for fn in names:
        if not (fn.startswith("noise_log_") and fn.endswith(".html")):
            continue
        p = os.path.join(LOG_DIR, fn)
        try:
            with open(p, "r", encoding="utf-8", errors="ignore") as f:
                head = f.read(300)
        except Exception:
            continue
        if SHELL_MARK in head:
            continue
        m = re.match(r"noise_log_(\d{4}-\d{2}-\d{2})", fn)
        if not m:
            continue
        dst = _move_to_legacy(p)
        if dst:
            add_job(dst, m.group(1))

    legacy_dir = os.path.join(LOG_DIR, "_legacy")
    if os.path.isdir(legacy_dir):
        for fn in sorted(os.listdir(legacy_dir)):
            if not (fn.startswith("noise_log_") and fn.endswith(".html")):
                continue
            m = re.match(r"noise_log_(\d{4}-\d{2}-\d{2})", fn)
            if m and not is_file_migrated(fn):
                add_job(os.path.join(legacy_dir, fn), m.group(1))

    if jobs:
        threading.Thread(target=_legacy_migration_queue, args=(jobs,), daemon=True).start()


def normalize_audio_layout():
    """把旧版 logs/audio/<日期>/<名>.<后缀> 统一拍平为 logs/audio/年月日时分秒.后缀，
    并同步更新数据库里的音频 URL（文件名冲突时加序号）"""
    init_db()
    moved = 0
    with _db_lock:
        con = _db_conn()
        try:
            rows = con.execute(
                "SELECT ts, audio, stamp, t FROM records WHERE audio LIKE '/audio/%/%'").fetchall()
            for r in rows:
                src = audio_path_from_url(r["audio"])
                if not src:
                    continue
                ext = src.rsplit(".", 1)[-1].lower()
                base = r["stamp"] or _stamp_from_time_text(r["t"])
                name, n = f"{safe_token(base, fallback='rec')}.{ext}", 1
                while True:
                    dst = os.path.join(AUDIO_DIR, name)
                    if not os.path.exists(dst) or os.path.realpath(dst) == os.path.realpath(src):
                        break
                    n += 1
                    name = f"{safe_token(base, fallback='rec')}_{n}.{ext}"
                if os.path.realpath(dst) != os.path.realpath(src):
                    try:
                        os.replace(src, dst)
                        moved += 1
                    except OSError:
                        continue
                con.execute("UPDATE records SET audio=? WHERE ts=?", ("/audio/" + name, r["ts"]))
            con.commit()
        finally:
            con.close()
    # 清理已空的日期子目录
    try:
        for fn in os.listdir(AUDIO_DIR):
            p = os.path.join(AUDIO_DIR, fn)
            if os.path.isdir(p):
                try:
                    os.rmdir(p)
                except OSError:
                    pass
    except OSError:
        pass
    if moved:
        print(f"[音频] 已拍平 {moved} 个录音文件为 年月日时分秒.后缀")
    return moved


def migrate_json_pages_to_db():
    """启动时把旧版分页 JSON 导入 SQLite，成功后归档到 logs/_legacy_json/"""
    try:
        names = [fn for fn in os.listdir(LOG_DIR) if _PAGE_JSON_RE.match(fn)]
    except OSError:
        return 0
    total = 0
    archive = os.path.join(LOG_DIR, "_legacy_json")
    os.makedirs(archive, exist_ok=True)
    for fn in sorted(names):
        page = _read_json(os.path.join(LOG_DIR, fn), None)
        recs = (page or {}).get("records") or []
        date = f"{fn[0:4]}-{fn[4:6]}-{fn[6:8]}"
        if recs:
            total += append_log_records(date, recs)
        try:
            os.replace(os.path.join(LOG_DIR, fn), os.path.join(archive, fn))
        except OSError:
            pass
    # 旧索引文件已无用，一并归档
    for fn in [n for n in os.listdir(LOG_DIR) if n.startswith("index_") and n.endswith(".json")]:
        try:
            os.replace(os.path.join(LOG_DIR, fn), os.path.join(archive, fn))
        except OSError:
            pass
    if total:
        print(f"[数据库] 已从旧分页 JSON 导入 {total} 条记录")
    return total


class MyHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # 页面/样式/脚本每次向服务端校验，避免改了 CSS 后浏览器还显示旧样式（默认链接变紫）
        path = urlparse(self.path).path
        if path.endswith((".html", ".css", ".js")) and not path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def _set_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST,GET,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self._set_cors()
        self.end_headers()

    def _write_log_shell(self, log_file_path, date, early=False, loc_line=None, tag=""):
        write_log_shell_file(log_file_path, date, early, loc_line, tag)

    def _ensure_log_shell(self, log_file_path, date, early=False, loc_line=None, tag=""):
        """确保日志页是分页外壳：不存在则创建；旧版（行直接写在 HTML 里）的文件
        交给后台迁移，绝不在请求里做整文件转换"""
        if not os.path.exists(log_file_path):
            self._write_log_shell(log_file_path, date, early, loc_line, tag)
            return
        try:
            with open(log_file_path, "r", encoding="utf-8", errors="ignore") as f:
                head = f.read(300)
        except Exception as e:
            print(f"[读取日志失败] {log_file_path}: {e}")
            return
        if SHELL_MARK in head:
            if loc_line:
                self._update_log_location(log_file_path, loc_line)
            return
        # 旧版文件：移到 _legacy 保留原件，后台迁移入库，再写外壳
        start_legacy_migration(log_file_path, date)
        self._write_log_shell(log_file_path, date, early, loc_line, tag)

    def _update_log_location(self, log_file_path, loc_line):
        """回填日志抬头的位置行：把占位符/旧坐标替换为解析后的地址"""
        if loc_line:
            set_log_location_text(log_file_path, loc_line)

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

    def _handle_log_list(self, parsed):
        """GET /api/log/list?date=&page=&size=&sort=&early= —— 按页取日志记录（数据库直查）"""
        q = parse_qs(parsed.query)
        date = q.get("date", [""])[0]
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            self.send_error(400, "date required")
            return
        try:
            page = int(q.get("page", ["0"])[0])
        except ValueError:
            page = 0
        try:
            size = int(q.get("size", [str(PAGE_SIZE)])[0])
        except ValueError:
            size = PAGE_SIZE
        sort = q.get("sort", ["time"])[0]
        early = q.get("early", ["0"])[0] in ("1", "true", "yes")
        tag = q.get("tag", [""])[0]
        data = query_log_page(date, page, size, sort, early, tag)
        self.send_response(200)
        self._set_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def _handle_log_export(self, parsed):
        """GET /api/log/export?start=YYYY-MM-DD&end=YYYY-MM-DD
        生成离线证据包（音频内嵌），返回可下载的静态 HTML 地址"""
        q = parse_qs(parsed.query)
        start = q.get("start", [""])[0] or q.get("date", [""])[0]
        end = q.get("end", [""])[0] or start
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", start) or not re.match(r"^\d{4}-\d{2}-\d{2}$", end):
            self.send_error(400, "start/end required")
            return
        if start > end:
            start, end = end, start
        tag = q.get("tag", [""])[0]
        doc, count = build_evidence_html(start, end, tag)
        os.makedirs(EXPORT_DIR, exist_ok=True)
        tag_part = ("_" + safe_token(tag, fallback="")) if tag else ""
        fname = (f"noise_evidence_{start}_{end}{tag_part}_"
                 f"{datetime.now().strftime('%Y%m%d_%H%M%S')}.html")
        path = os.path.join(EXPORT_DIR, fname)
        with _io_lock:
            with open(path, "w", encoding="utf-8") as f:
                f.write(doc)
        self.send_response(200)
        self._set_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True, "count": count,
                                     "url": f"/logs/exports/{fname}",
                                     "size": os.path.getsize(path)}, ensure_ascii=False).encode("utf-8"))

    def _send_json(self, obj, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _handle_log_files(self):
        """GET /api/log/files —— logs/ 下的日志 HTML 名称（不含 .html），供导出界面列出"""
        try:
            self._send_json({"ok": True, "files": list_log_html_stems()})
        except Exception as e:
            self._send_json({"ok": False, "err": str(e)}, 500)

    def _handle_log_zip(self, parsed):
        """GET /api/log/zip?name=noise_log_2026-11-03
        将该日志打包为离线证据 ZIP（index.html + js + json + audio），返回下载地址"""
        q = parse_qs(parsed.query)
        name = q.get("name", [""])[0]
        try:
            res = build_offline_log_zip(name)
            if not res:
                self._send_json({"ok": False, "err": "日志名称无效"}, 400)
                return
            path, count, n_audio = res
            self._send_json({
                "ok": True, "count": count, "audio": n_audio,
                "url": f"/logs/exports/{os.path.basename(path)}",
                "size": os.path.getsize(path),
            })
        except Exception as e:
            traceback.print_exc()
            self._send_json({"ok": False, "err": str(e)}, 500)

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
        length = int(self.headers["Content-Length"])
        body = self.rfile.read(length)
        payload = json.loads(body.decode("utf-8"))

        remote_ip = self.client_address[0]
        ua_raw = self.headers.get("User-Agent", "")
        # UA → 友好系统描述（如「iPhone · iOS 12.4 · Mobile Safari」）；原始 UA 悬停可看
        ua_disp = ua_raw
        try:
            _up = user_agents.parse(ua_raw)
            _dev = _up.device.family or "未知设备"
            _osn = (_up.os.family or "未知系统")
            _osv = _up.os.version_string or ""
            _br = _up.browser.family or ""
            ua_disp = f"{_dev} · {_osn}{(' '+_osv) if _osv else ''}"
            if _br:
                ua_disp += f" · {_br}"
        except Exception:
            pass
        tag = safe_token(payload.get("tag", ""), fallback="--")

        audio_raw = payload.get("audioData") or ""
        mime = extract_mime_from_dataurl(audio_raw) or "audio/webm"

        timeText = str(payload.get("timeText", "") or datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        ts = str(payload.get("timeTs", ""))
        stamp = _stamp_from_time_text(timeText)
        date = datetime.now().strftime("%Y-%m-%d")
        # 录音解码落盘为独立文件：logs/audio/年月日时分秒.<后缀>，数据库只存 URL
        audio_url = save_record_audio(stamp, audio_raw, mime)
        lat_raw = payload.get("lat")
        lon_raw = payload.get("lon")
        # 位置直接采用客户端已转换好的地址（客户端定位后经 /api/regeo 解析并缓存），
        # 写日志时不再动态解析；仅旧版客户端未上报 address 时才兜底逆地理编码
        address = str(payload.get("address") or "").strip()
        if not address and lat_raw is not None and lon_raw is not None:
            address = reverse_geocode(lat_raw, lon_raw)
        coords = f"{lat_raw if lat_raw is not None else '--'}, {lon_raw if lon_raw is not None else '--'}"
        loc_title = f"{address}（{coords}）" if address else coords
        # 日志抬头位置：客户端上报的地址直接写入，不再留“定位中…”占位符
        loc_line = address or ("" if lat_raw is None and lon_raw is None else coords)

        record = {
            "t": timeText,
            "ts": ts,
            "stamp": stamp,
            "tag": tag,
            "dur": str(payload.get("durationSec", "")),
            "peak": _to_float(payload.get("peakDb")),
            "audio": audio_url,
            "mime": mime,
            "ip": remote_ip,
            "ua": ua_disp,
            "uaRaw": ua_raw,
            "addr": address,
            "lat": lat_raw,
            "lon": lon_raw,
            "locTitle": loc_title,
        }
        append_log_record(date, record)

        # 日志页外壳：每个标签每天一个独立 HTML（记录仍共用数据库，页面按标签过滤）
        daily_path = get_daily_log_filename(tag)
        self._ensure_log_shell(daily_path, date, False, loc_line, tag)
        # 凌晨 01:00~06:00：额外的凌晨日志页（同样按标签分离，页面按小时+标签过滤）
        if _is_early(record):
            self._ensure_log_shell(get_early_morning_log_filename(tag), date, True, loc_line, tag)

        self.send_response(200)
        self._set_cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        resp = json.dumps({"ok": True, "audio": audio_url,
                           "logfile": os.path.basename(daily_path)}, ensure_ascii=False)
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
            # 数据库里的记录
            removed += delete_log_record(ts)
            # 尚未迁移的旧日志 HTML 里的行
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

    def _send_json(self, obj, code=200):
        self.send_response(code)
        self._set_cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _handle_config_get(self):
        self._send_json({"ok": True, **load_settings()})

    def _handle_config_set(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except Exception:
            payload = {}
        settings = save_settings(payload if isinstance(payload, dict) else {})
        self._send_json({"ok": True, **settings})

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        # 噪声样本音频以正确 mime 提供（数据库里只存该 URL）
        if path.startswith("/audio/"):
            rel = unquote(path[len("/audio/"):])
            base = os.path.realpath(AUDIO_DIR)
            fpath = os.path.realpath(os.path.join(AUDIO_DIR, rel))
            if os.path.commonpath([base, fpath]) == base and os.path.isfile(fpath):
                ctype = {"webm": "audio/webm", "ogg": "audio/ogg", "m4a": "audio/mp4",
                         "mp3": "audio/mpeg", "wav": "audio/wav"}.get(
                    fpath.rsplit(".", 1)[-1].lower(), "application/octet-stream")
                size = os.path.getsize(fpath)
                # 支持 Range 请求（Safari/iOS 的 <audio> 播放需要 206 分段响应，否则静默失败）
                start, end = 0, size - 1
                rng = self.headers.get("Range") or ""
                m = re.match(r"bytes=(\d*)-(\d*)", rng)
                partial = False
                if m and size:
                    a, b = m.group(1), m.group(2)
                    if a:
                        start = int(a)
                        end = int(b) if b else size - 1
                    elif b:  # bytes=-N：最后 N 字节
                        start = max(0, size - int(b))
                    end = min(end, size - 1)
                    if start > end or start >= size:
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.end_headers()
                        return
                    partial = True
                self.send_response(206 if partial else 200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(end - start + 1))
                self.send_header("Accept-Ranges", "bytes")
                if partial:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.end_headers()
                with open(fpath, "rb") as f:
                    f.seek(start)
                    left = end - start + 1
                    while left > 0:               # 分块写出，避免大文件整体读入内存
                        chunk = f.read(min(512 * 1024, left))
                        if not chunk:
                            break
                        left -= len(chunk)
                        self.wfile.write(chunk)
            else:
                self.send_error(404, "audio not found")
            return
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
        if path == "/api/log/list":
            self._handle_log_list(parsed)
            return
        if path == "/api/log/export":
            self._handle_log_export(parsed)
            return
        if path == "/api/log/files":
            self._handle_log_files()
            return
        if path == "/api/log/zip":
            self._handle_log_zip(parsed)
            return
        if path == "/api/config":
            self._handle_config_get()
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
            if path == "/api/config":
                self._handle_config_set()
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

    # 连接级超时：防止卡住的客户端长期占用线程
    timeout = 60
    # TLS 握手超时：避免一个半开连接把手势全堵住（配合多线程更稳）
    handshake_timeout = 15

    def setup(self):
        """TLS 握手放在每个连接自己的线程里做（不再阻塞 accept 主循环），
        这样某个客户端卡住不会影响其它设备访问"""
        sock = self.request
        if SSL_CONTEXT is None:
            super().setup()
            return
        try:
            sock.settimeout(self.handshake_timeout)
            self.request = SSL_CONTEXT.wrap_socket(sock, server_side=True)
        except Exception:
            try:
                sock.close()
            except Exception:
                pass
            raise
        super().setup()


class QuietHTTPServer(ThreadingHTTPServer):
    """多线程 HTTP 服务：每个连接独立线程，单个慢连接不会拖死全站"""
    daemon_threads = True

    def get_request(self):
        sock, addr = self.socket.accept()
        sock.settimeout(15)
        return sock, addr

    def handle_error(self, request, client_address):
        et, ev, _ = sys.exc_info()
        if isinstance(ev, (ssl.SSLError, OSError)):
            return  # 客户端断连/握手失败属正常现象，不打印堆栈
        super().handle_error(request, client_address)


if __name__ == "__main__":
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile="server.crt", keyfile="server.key")
    SSL_CONTEXT = ctx
    httpd = QuietHTTPServer(ADDR, MyHandler)
    init_db()
    migrate_json_pages_to_db()  # 旧分页 JSON → SQLite（成功后归档）
    normalize_audio_layout()    # 旧音频目录拍平为 logs/audio/年月日时分秒.后缀
    migrate_all_legacy_logs()   # 旧版日志（行写在 HTML 里）后台导入 SQLite
    backfill_locations_from_legacy()  # 旧页抬头里的历史定位地址回填数据库
    refresh_tag_shells()        # 按标签补齐每天独立日志页（每个标签日常 + 凌晨）
    refresh_shell_assets()      # 日志页 CSS/JS 加版本号，避免浏览器用旧脚本串标签
    refresh_shell_locations()   # 日志页抬头位置：从数据库回填（无定位显示 —）
    print(f'HTTPS server running on https://{ADDR[0]}:{ADDR[1]}（本机可访问 / 局域网可用）')
    print(f"每日噪声日志：{LOG_DIR}/noise_log_YYYY-MM-DD_<标签>.html（凌晨：…_<标签>_凌晨0100-0600.html）；记录库：{DB_PATH}；每页 {PAGE_SIZE} 条")
    print(f"录像存储目录：{VIDEO_DIR}/<设备指纹>/（webm 分片 + 合并的 10 分钟 MP4）")
    print("录像回看页：https://127.0.0.1:8088/review.html（优先播 MP4）")
    httpd.serve_forever()
