#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""历史噪声样本裁到「事件前 1 秒 + 事件 + 事件后 1 秒」（不重编码、可还原）。

为什么需要：旧版环形录音在触发前会攒最多 10 秒音频，落到盘上的文件常常是
[几秒静音][噪声事件][几秒静音]。实测 20261116_081039.webm 时长 7.00 秒，事件只在 3.0~5.0 秒，
前后各约 3 秒、2 秒近乎无声（约 -67 dBFS）。点播放先空等几秒，用户就会判成"没有声音"。
库里「持续秒」字段不动（仍是事件真实长度），只把音频文件裁到事件前后各 1 秒。

事件区间用能量包络定位（50ms 帧 RMS）：
  背景电平 = 200 帧的 20 分位；阈值 = 背景 + 8dB（且不低于峰值 - 30dB）；
  第一帧到最后一帧超过阈值的位置 = 事件区间。

三重保护：
  1. 裁剪用 `ffmpeg -ss/-to -c:a copy`，只丢整帧、不重编码 —— 保留部分音频数据不变；
  2. 裁前把原文件复制到 logs/audio/_backup/，可随时还原；
  3. 裁后校验保留窗口的峰值 ≥ 原峰值 95%，否则放弃、原文件不动。

用法：
  python3 fix_audio_clip.py --dry-run --limit 20
  python3 fix_audio_clip.py --workers 4
"""
import argparse, os, shutil, sqlite3, subprocess, sys, time
import numpy as np
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO_DIR = os.path.join(HERE, "logs", "audio")
BACKUP_DIR = os.path.join(AUDIO_DIR, "_backup")
DB_PATH = os.path.join(HERE, "logs", "logs.db")
REPORT = os.path.join(HERE, "logs", "audio_clip_trim_report.txt")
FFMPEG = "/Users/51pwn/anaconda3/bin/ffmpeg"
FFPROBE = "/Users/51pwn/anaconda3/bin/ffprobe"
SR = 8000
HOP = SR * 50 // 1000        # 50ms 一帧
PRE_SEC, POST_SEC = 1.0, 1.0
MIN_GAIN_DB = 8.0            # 事件阈值 = 背景 + 8dB
FLOOR_FROM_PEAK_DB = 30.0    # 阈值不低于峰值 - 30dB
MIN_CUT_SEC = 1.0            # 需要裁掉的时长少于 1 秒就不动


def probe(path):
    try:
        o = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                            "-of", "default=nw=1:nk=1", path], capture_output=True, text=True, timeout=30).stdout.strip()
        return float(o) if o and o != "N/A" else None
    except Exception:
        return None


def peak_of(path):
    """解码后取最大绝对值（0~1）；失败返回 None。裁剪后的校验只用它，不受"全段有声"影响。"""
    try:
        raw = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-vn", "-map", "0:a",
                              "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"],
                             capture_output=True, timeout=180).stdout
        if not raw:
            return None
        x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        return float(np.abs(x).max()) if len(x) else None
    except Exception:
        return None


def analyze(path):
    """返回 (事件起点, 事件终点, 背景dB, 峰值dB, 总时长, 峰值绝对值) ；无法分析返回 None。"""
    try:
        raw = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-vn", "-map", "0:a",
                              "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"],
                             capture_output=True, timeout=180).stdout
        if not raw:
            return None
        x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        n = len(x) // HOP
        if n < 4:
            return None
        frames = x[:n * HOP].reshape(n, HOP)
        rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
        db = 20 * np.log10(rms)
        base = float(np.percentile(db, 20))
        peak_db = float(db.max())
        thr = max(base + MIN_GAIN_DB, peak_db - FLOOR_FROM_PEAK_DB)
        loud = np.where(db > thr)[0]
        if not len(loud):
            return None
        start = loud[0] * HOP / SR
        end = (loud[-1] + 1) * HOP / SR
        return start, end, base, peak_db, len(x) / SR, float(np.abs(x).max())
    except Exception:
        return None


def trim_one(name, dur, dry=False):
    path = os.path.join(AUDIO_DIR, name)
    if not os.path.isfile(path):
        return "fail", "文件不存在"
    length = probe(path)
    if not length:
        return "fail", "读不到时长"
    info = analyze(path)
    if not info:
        return "skip", "分析失败/全段都有声"
    ev_start, ev_end, base, peak_db, total, peak_abs = info
    # 护栏一：整段缓冲型超长文件（旧版无界累积留下的几十秒~几分钟文件）不裁，
    # 它可能横跨多次事件，按能量猜一个位置裁容易砍掉别的证据。
    if total > 30:
        return "skip", f"超长历史文件 {total:.0f}s，条目边界不确定，保守跳过"
    # 护栏二：背景与峰值差太小（整段都有声）没法定出事件，跳过
    if peak_db - base < 7:
        return "skip", f"背景 {base:.0f}dB 与峰值 {peak_db:.0f}dB 太接近，无法定位事件"
    # 护栏三：能量区间明显短于记录的持续秒，说明对不上，跳过
    if dur > 0 and (ev_end - ev_start) < dur * 0.5:
        return "skip", f"能量区间 {ev_end-ev_start:.2f}s 远短于持续秒 {dur:.2f}s，保守跳过"
    keep_start = max(0.0, ev_start - PRE_SEC)
    keep_end = min(total, ev_end + POST_SEC)
    trimmed = total - (keep_end - keep_start)
    if trimmed < MIN_CUT_SEC:
        return "skip", f"无需裁剪（事件 {ev_start:.2f}~{ev_end:.2f}s / 共 {total:.2f}s）"
    if keep_end - keep_start < dur + 0.5 and dur > 0:
        # 按能量算出的区间明显短于库里记的持续秒：宁可不裁，避免砍掉尾部声音
        return "skip", f"能量区间 {keep_end-keep_start:.2f}s < 持续秒 {dur:.2f}s，保守跳过"

    tmp = path + ".trim.webm"
    try:
        r = subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
                            "-i", path, "-ss", f"{keep_start:.3f}", "-to", f"{keep_end:.3f}",
                            "-map", "0:a", "-c:a", "copy", "-f", "webm", tmp],
                           capture_output=True, text=True, timeout=180)
        if r.returncode != 0 or not os.path.isfile(tmp) or os.path.getsize(tmp) < 200:
            if os.path.exists(tmp):
                os.remove(tmp)
            return "fail", f"ffmpeg 失败 {(r.stderr or '').strip()[:100]}"
        tlen = probe(tmp)
        p_after = peak_of(tmp)
        if not tlen or p_after is None:
            os.remove(tmp)
            return "fail", "裁剪结果无法解析"
        if peak_abs > 0 and p_after < peak_abs * 0.95:
            os.remove(tmp)
            return "fail", f"峰值校验不通过 {peak_abs:.3f}→{p_after:.3f}"
        summary = (f"{total:.2f}s→{tlen:.2f}s 事件 {ev_start:.2f}~{ev_end:.2f}s "
                   f"窗口 {keep_start:.2f}~{keep_end:.2f}s 背景 {base:.0f}dB 峰值 {peak_db:.0f}dB")
        if dry:
            os.remove(tmp)
            return "ok", "[dry] " + summary
        os.makedirs(BACKUP_DIR, exist_ok=True)
        bak = os.path.join(BACKUP_DIR, name)
        if not os.path.exists(bak):
            shutil.copy2(path, bak)
        os.replace(tmp, path)
        return "ok", summary
    except Exception as e:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass
        return "fail", f"异常 {e}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--max-dur", type=float, default=3.0, help="只处理事件时长不超过该值的记录（0=全部）")
    args = ap.parse_args()

    con = sqlite3.connect(DB_PATH)
    rows = con.execute("SELECT audio, dur FROM records WHERE audio LIKE '/audio/%'").fetchall()
    con.close()
    todo = []
    for audio, dur in rows:
        try:
            d = float(dur)
        except Exception:
            continue
        if d <= 0 or (args.max_dur and d > args.max_dur):
            continue
        name = audio.split("/")[-1]
        if name.endswith(".webm"):
            todo.append((name, d))
    if args.limit:
        todo = todo[:args.limit]
    print(f"候选 {len(todo)} 条")

    stats = {"ok": 0, "skip": 0, "fail": 0}
    lines = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for idx, ((name, dur), (st, info)) in enumerate(
                zip(todo, ex.map(lambda x: trim_one(x[0], x[1], args.dry_run), todo)), 1):
            stats[st] += 1
            lines.append(f"{name}\tdur={dur}\t{st}\t{info}")
            if idx % 100 == 0 or idx == len(todo):
                print(f"  {idx}/{len(todo)} ok={stats['ok']} skip={stats['skip']} fail={stats['fail']}", flush=True)

    with open(REPORT, "w", encoding="utf-8") as f:
        f.write(f"# 历史样本裁剪报告  {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write("# 方式：ffmpeg -ss/-to -c:a copy（不重编码）；原文件备份 logs/audio/_backup/\n")
        f.write(f"# 成功 {stats['ok']} / 跳过 {stats['skip']} / 失败 {stats['fail']}\n")
        f.write("\n".join(lines))
    print(f"\n完成：成功 {stats['ok']}，跳过 {stats['skip']}，失败 {stats['fail']}，耗时 {time.time()-t0:.1f}s")
    print(f"报告：{REPORT}")


if __name__ == "__main__":
    main()
