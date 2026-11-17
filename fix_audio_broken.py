#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抢救「丢了 WebM 容器头」的噪声样本。

成因：曾在前端按时间戳丢掉录音开头那几片 —— 但 EBML 头（含 OpusHead）只在首片里，
丢完就剩"裸 cluster 数据"，任何播放器都放不出来（实际坏了 26 个）。

抢救思路：用 ffmpeg 生成一段同参数（Opus 48k 立体声）的 WebM 头，只取到第一个 Cluster 之前的部分，
后面接上坏文件残留的原始数据，再用 ffmpeg 解码重封装成合法 WebM。只能救回残留部分的内容
（被前端丢掉的开头那几片音频已经不存在了），事件本身的声音都在残留区里。

坏文件原样备份到 logs/audio/_broken/，可随时查看。
"""
import os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO_DIR = os.path.join(HERE, "logs", "audio")
BROKEN_DIR = os.path.join(AUDIO_DIR, "_broken")
REPORT = os.path.join(HERE, "logs", "audio_salvage_report.txt")
FFMPEG = "/Users/51pwn/anaconda3/bin/ffmpeg"
FFPROBE = "/Users/51pwn/anaconda3/bin/ffprobe"
EBML_MAGIC = b"\x1aE\xdf\xa3"


def make_header():
    """生成只含 EBML/Segment(未知长度)/Info/Tracks 的头，截止到第一个 Cluster 之前。"""
    r = subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                        "-t", "0.02", "-c:a", "libopus", "-f", "webm", "-"],
                       capture_output=True)
    d = r.stdout
    i = d.find(b"\x1f\x43\xb6\x75")
    if i <= 0:
        raise RuntimeError("生成头部失败")
    return d[:i]


def probe_dur(p):
    o = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=nw=1:nk=1", p], capture_output=True, text=True).stdout.strip()
    try:
        return float(o)
    except Exception:
        return None


def peak_of(p):
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", p, "-f", "s16le", "-ac", "1", "-ar", "8000", "-"],
                         capture_output=True).stdout
    if not raw:
        return None
    import numpy as np
    return float(np.abs(np.frombuffer(raw, dtype=np.int16)).max()) / 32768


def salvage(name, header):
    p = os.path.join(AUDIO_DIR, name)
    raw = open(p, "rb").read()
    stage = f"{p}.stage.webm"
    fixed = f"{p}.fixed.webm"
    open(stage, "wb").write(header + b"\x1f\x43\xb6\x75" + b"\xff" + raw)
    r = subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", stage,
                        "-vn", "-c:a", "libopus", "-b:a", "96k", "-f", "webm", fixed],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return "fail", f"重封装失败 {(r.stderr or '').strip()[:100]}"
    dur = probe_dur(fixed)
    pk = peak_of(fixed)
    if not dur or pk is None:
        return "fail", "抢救结果无法解码"
    if pk < 0.002:
        return "fail", f"抢救结果近乎无声（峰值 {pk:.4f}）"
    os.makedirs(BROKEN_DIR, exist_ok=True)
    shutil.copy2(p, os.path.join(BROKEN_DIR, name))
    os.replace(fixed, p)
    try:
        os.remove(stage)
    except Exception:
        pass
    return "ok", f"恢复 {dur:.2f}s，峰值 {pk:.3f}"


def main():
    header = make_header()
    print(f"容器头长度 {len(header)} 字节")
    names = []
    for f in sorted(os.listdir(AUDIO_DIR)):
        if not f.endswith(".webm"):
            continue
        p = os.path.join(AUDIO_DIR, f)
        if os.path.getsize(p) < 400:
            continue
        with open(p, "rb") as fh:
            if fh.read(4) != EBML_MAGIC:
                names.append(f)
    print(f"待抢救 {len(names)} 个")
    lines, ok, fail = [], 0, 0
    for n in names:
        st, info = salvage(n, header)
        lines.append(f"{n}\t{st}\t{info}")
        if st == "ok":
            ok += 1
        else:
            fail += 1
        print(f"  {'OK ' if st=='ok' else 'FAIL'} {n}  {info}", flush=True)
    with open(REPORT, "w", encoding="utf-8") as f:
        f.write("file\tstatus\tdetail\n" + "\n".join(lines))
    print(f"\n成功 {ok}，失败 {fail}，报告 {REPORT}")


if __name__ == "__main__":
    main()
