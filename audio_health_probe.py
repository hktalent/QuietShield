#!/usr/bin/env python3
# QuietShield 噪声样本失真体检：解码真实落盘样本，量化"听起来和真实差别很大"的客观指标
import json, subprocess, sys
import numpy as np
from scipy import signal

FFMPEG = "/Users/51pwn/anaconda3/bin/ffmpeg"
FFPROBE = "/Users/51pwn/anaconda3/bin/ffprobe"
SR = 48000

def load_mono(path):
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR),
                          "-f", "f32le", "-"], capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)

def load_stereo(path):
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-ac", "2", "-ar", str(SR),
                          "-f", "f32le", "-"], capture_output=True).stdout
    a = np.frombuffer(raw, dtype=np.float32).astype(np.float64)
    return a[0::2], a[1::2]

def db(x):
    return 20 * np.log10(max(x, 1e-12))

def band_energy_db(x, lo, hi):
    if len(x) < 4096:
        return float("nan")
    f, P = signal.welch(x, SR, nperseg=4096, noverlap=2048)
    sel = (f >= lo) & (f < hi)
    return db(np.sqrt(np.trapz(P[sel], f[sel])))

def analyze(path):
    x = load_mono(path)
    L, R = load_stereo(path)
    dur = len(x) / SR
    peak = np.max(np.abs(x))
    rms = np.sqrt(np.mean(x ** 2))
    crest = db(peak) - db(rms)
    # 限幅/削波平台：连续 >=3 个样本贴在同一峰值电平（±0.3%）视为平顶
    thr = peak * 0.997
    flat = np.abs(x) >= thr
    runs = 0; longest = 0; cur = 0
    for v in flat:
        if v:
            cur += 1; longest = max(longest, cur)
        else:
            if cur >= 3: runs += 1
            cur = 0
    if cur >= 3: runs += 1
    clip_pct = 100.0 * flat.sum() / len(x)
    # 分带能量（相对总能量）
    total = band_energy_db(x, 20, 20000)
    b = {
        "20-120Hz": band_energy_db(x, 20, 120),
        "120-400Hz": band_energy_db(x, 120, 400),
        "400-2k": band_energy_db(x, 400, 2000),
        "2k-8k": band_energy_db(x, 2000, 8000),
        "8k-20k": band_energy_db(x, 8000, 20000),
    }
    rel = {k: round(v - total, 1) for k, v in b.items()}
    # 通道相关性（判断是否双单声道 / 有无声道错位）
    corr = float(np.corrcoef(L, R)[0, 1]) if len(L) > 10 else float("nan")
    # 谱质心
    f, P = signal.welch(x, SR, nperseg=4096)
    cent = float((f * P).sum() / (P.sum() + 1e-12))
    # 编码规格
    meta = subprocess.run([FFPROBE, "-v", "error", "-show_entries",
                           "format=duration,bit_rate:stream=codec_name,sample_rate,channels",
                           "-of", "json", path], capture_output=True, text=True).stdout
    m = json.loads(meta)
    st = (m.get("streams") or [{}])[0]
    return {
        "file": path.split("/")[-1], "dur_s": round(dur, 2),
        "codec": st.get("codec_name"), "sr": st.get("sample_rate"), "ch": st.get("channels"),
        "kbps": round(int((m.get("format") or {}).get("bit_rate") or 0) / 1000),
        "peak_dbfs": round(db(peak), 1), "rms_dbfs": round(db(rms), 1),
        "crest_db": round(crest, 1),
        "flat_pct": round(clip_pct, 2), "flat_runs": runs, "longest_flat": longest,
        "bands_rel_db": rel, "centroid_hz": round(cent),
        "stereo_corr": round(corr, 4),
    }

if __name__ == "__main__":
    rows = []
    for p in sys.argv[1:]:
        try:
            rows.append(analyze(p))
        except Exception as e:
            rows.append({"file": p.split("/")[-1], "error": str(e)})
    for r in rows:
        if "error" in r:
            print(f"{r['file']}: ERROR {r['error']}"); continue
        print(f"{r['file']}  {r['dur_s']}s  {r['codec']}/{r['sr']}Hz/{r['ch']}ch  {r['kbps']}kbps")
        print(f"   峰值 {r['peak_dbfs']} dBFS | RMS {r['rms_dbfs']} dBFS | 波峰因数 {r['crest_db']} dB")
        print(f"   贴顶样本 {r['flat_pct']}% | 平顶段 {r['flat_runs']} 处 | 最长平顶 {r['longest_flat']} 样本 ({r['longest_flat']/48:.1f} ms)")
        print(f"   分带能量(相对总) {r['bands_rel_db']} | 谱质心 {r['centroid_hz']} Hz | L/R 相关 {r['stereo_corr']}")
        print()
