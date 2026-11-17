#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""修复旧合并样本（*_merged.webm）时间戳非单调导致的解码异常。

成因：早期流水线用 ffmpeg concat 拼接多段录音，各段 DTS 从 0 重启，拼接后出现时间戳回退
（"Application provided invalid, non monotonically increasing dts"）。ffmpeg/Chrome 能容忍，
Safari 对坏 DTS 更敏感，可能直接放不出来。

处理：用 libopus 重新编码一遍，让 ffmpeg 重新生成单调递增的时间戳与完整容器头。
原件备份到 logs/audio/_merged_bak/，可还原。三重自检：解码零报错、时长偏差 ≤0.3s、峰值 ≥原件一半。
"""
import os, json, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO_DIR = os.path.join(HERE, "logs", "audio")
BAK_DIR = os.path.join(AUDIO_DIR, "_merged_bak")
REPORT = os.path.join(HERE, "logs", "audio_merged_fix_report.txt")
FFMPEG = "/Users/51pwn/anaconda3/bin/ffmpeg"
FFPROBE = "/Users/51pwn/anaconda3/bin/ffprobe"
BAD_LIST = "/tmp/qs_bad_list.json"


def probe_dur(p):
    o = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=nw=1:nk=1", p], capture_output=True, text=True, timeout=60).stdout.strip()
    try:
        return float(o)
    except Exception:
        return None


def peak_of(p):
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", p, "-f", "s16le", "-ac", "1", "-ar", "8000", "-"],
                          capture_output=True, timeout=120).stdout
    if not raw:
        return None
    import numpy as np
    return float(np.abs(np.frombuffer(raw, dtype=np.int16)).max()) / 32768


def decode_ok(p):
    r = subprocess.run([FFMPEG, "-v", "error", "-i", p, "-f", "null", "-"],
                       capture_output=True, text=True, timeout=120)
    return r.returncode == 0 and not (r.stderr or "").strip(), (r.stderr or "").strip()[:80]


def fix(name):
    p = os.path.join(AUDIO_DIR, name)
    if not os.path.isfile(p):
        return "missing", "文件不存在"
    src_dur = probe_dur(p)
    src_peak = peak_of(p)
    tmp = f"{p}.mfix.webm"
    r = subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", p,
                        "-vn", "-c:a", "libopus", "-b:a", "96k", "-ar", "48000", "-ac", "2", tmp],
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0 or not os.path.isfile(tmp) or os.path.getsize(tmp) < 200:
        return "fail", f"重编码失败 {(r.stderr or '').strip()[:100]}"
    ok, err = decode_ok(tmp)
    if not ok:
        os.remove(tmp)
        return "fail", f"修复后仍解码异常 {err}"
    new_dur = probe_dur(tmp)
    new_peak = peak_of(tmp)
    if src_dur and new_dur and abs(new_dur - src_dur) > 0.3:
        os.remove(tmp)
        return "fail", f"时长偏差 {src_dur:.2f}→{new_dur:.2f}"
    if src_peak is not None and new_peak is not None and new_peak < src_peak * 0.5:
        os.remove(tmp)
        return "fail", f"峰值掉太多 {src_peak:.3f}→{new_peak:.3f}"
    os.makedirs(BAK_DIR, exist_ok=True)
    shutil.copy2(p, os.path.join(BAK_DIR, name))
    os.replace(tmp, p)
    return "ok", f"{src_dur:.2f}s→{new_dur:.2f}s, 峰值 {src_peak:.3f}→{new_peak:.3f}"


def main():
    if os.path.isfile(BAD_LIST):
        bad = [x[0] for x in json.load(open(BAD_LIST))]
    else:
        bad = [f for f in os.listdir(AUDIO_DIR) if f.endswith("_merged.webm")]
    print(f"待修复 {len(bad)} 个")
    lines, ok, fail = [], 0, 0
    for i, n in enumerate(bad, 1):
        st, info = fix(n)
        lines.append(f"{n}\t{st}\t{info}")
        if st == "ok":
            ok += 1
        else:
            fail += 1
        if i % 20 == 0 or st != "ok":
            print(f"  [{i}/{len(bad)}] {st} {n} {info}", flush=True)
    with open(REPORT, "w", encoding="utf-8") as f:
        f.write("file\tstatus\tdetail\n" + "\n".join(lines))
    print(f"\n成功 {ok}，失败 {fail}，报告 {REPORT}，原件备份 {BAK_DIR}")


if __name__ == "__main__":
    main()
