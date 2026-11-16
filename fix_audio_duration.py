#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""历史噪声样本补齐时长头（无损，不改音频内容）。

背景：浏览器 MediaRecorder 写出的 WebM 是流式格式，文件头里没有 Duration
（ffprobe 显示 N/A）。Safari 的 <audio> 拿不到总时长，短样本点播放常常没反应/没声音。
本脚本用 `ffmpeg -c:a copy`（只重封装、不重新编码）把时长写进文件头：
  · 解码后的 PCM 与原文件逐字节一致（抽样校验，报告里留证）
  · 文件体积只多出几百字节索引
  · 先写 .tmp 再原子替换，失败自动跳过，原文件不动

用法：
  python3 fix_audio_duration.py                 # 修复全部
  python3 fix_audio_duration.py --dry-run       # 只统计，不动文件
  python3 fix_audio_duration.py --limit 50      # 只处理前 50 个（试点）
  python3 fix_audio_duration.py --workers 6
报告写到 logs/audio_duration_fix_report.txt（含每个文件的修复结果与抽样 PCM 校验）。
"""
import argparse, hashlib, os, random, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO_DIR = os.path.join(HERE, "logs", "audio")
REPORT = os.path.join(HERE, "logs", "audio_duration_fix_report.txt")
FFMPEG = "/Users/51pwn/anaconda3/bin/ffmpeg"
FFPROBE = "/Users/51pwn/anaconda3/bin/ffprobe"


def probe_duration(path):
    """返回 format duration（秒）；N/A 或读不出来返回 None。"""
    try:
        out = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=30).stdout.strip()
        return float(out) if out and out != "N/A" else None
    except Exception:
        return None


def pcm_md5(path):
    """解码成 PCM 后的 md5，用来证明重封装没动音频内容。"""
    try:
        p1 = subprocess.Popen([FFMPEG, "-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", "48000", "-"],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        h = hashlib.md5()
        while True:
            chunk = p1.stdout.read(65536)
            if not chunk:
                break
            h.update(chunk)
        p1.wait()
        return h.hexdigest()
    except Exception:
        return ""


def fix_one(path, verify=False):
    """返回 (状态, 说明)。状态：ok / skip / fail"""
    before = probe_duration(path)
    if before is not None:
        return "skip", f"已有 duration={before:.3f}"
    tmp = path + ".fix.webm"
    try:
        r = subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
                            "-i", path, "-map", "0:a", "-c:a", "copy", "-f", "webm", tmp],
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0 or not os.path.isfile(tmp) or os.path.getsize(tmp) < 200:
            if os.path.exists(tmp):
                os.remove(tmp)
            return "fail", f"ffmpeg 失败: {(r.stderr or '').strip()[:120]}"
        after = probe_duration(tmp)
        if after is None or after <= 0:
            os.remove(tmp)
            return "fail", "重封装后仍读不到时长"
        old_size, new_size = os.path.getsize(path), os.path.getsize(tmp)
        if new_size < old_size * 0.9:      # 体积明显缩水说明不是无损重封装，放弃
            os.remove(tmp)
            return "fail", f"体积异常 {old_size}→{new_size}"
        same = ""
        if verify:
            a, b = pcm_md5(path), pcm_md5(tmp)
            if not a or a != b:
                os.remove(tmp)
                return "fail", "PCM 校验不一致，已放弃"
            same = "PCM=一致"
        os.replace(tmp, path)              # 原子替换
        return "ok", f"duration={after:.3f} {old_size}→{new_size}B {same}".strip()
    except Exception as e:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass
        return "fail", f"异常: {e}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--verify-ratio", type=float, default=0.1, help="抽样 PCM 校验比例")
    args = ap.parse_args()

    if not os.path.isdir(AUDIO_DIR):
        sys.exit(f"目录不存在: {AUDIO_DIR}")
    files = sorted(f for f in os.listdir(AUDIO_DIR) if f.endswith(".webm"))
    if args.limit:
        files = files[:args.limit]
    print(f"待处理 {len(files)} 个文件，{args.workers} 并发，抽样校验 {args.verify_ratio:.0%}")

    need = [os.path.join(AUDIO_DIR, f) for f in files]
    miss = [p for p in need if probe_duration(p) is None]
    print(f"其中缺时长头的 {len(miss)} 个")
    if args.dry_run:
        return

    # 抽样：随机挑 --verify-ratio 的比例做 PCM 一致性校验
    verify_set = set(random.sample(miss, max(20, int(len(miss) * args.verify_ratio)))) if miss else set()

    t0 = time.time()
    stats = {"ok": 0, "skip": 0, "fail": 0}
    lines = []

    def job(p):
        status, info = fix_one(p, verify=(p in verify_set))
        return os.path.basename(p), status, info

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for name, status, info in ex.map(job, miss):
            stats[status] += 1
            lines.append(f"{name}\t{status}\t{info}")
            if stats["ok"] + stats["fail"] + stats["skip"] % 200 == 0:
                print(f"  进度 {stats['ok'] + stats['fail'] + stats['skip']}/{len(miss)}", flush=True)

    # 已有时长头的直接记为 skip
    for p in need:
        if p not in miss:
            stats["skip"] += 1
            lines.append(f"{os.path.basename(p)}\tskip\t已有 duration")

    with open(REPORT, "w", encoding="utf-8") as f:
        f.write(f"# 历史噪声样本补时长头报告  {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write(f"# 方式：ffmpeg -c:a copy（只重封装，未重新编码）；抽样 PCM 校验 {len(verify_set)} 个\n")
        f.write(f"# 结果：成功 {stats['ok']} / 跳过 {stats['skip']} / 失败 {stats['fail']}\n")
        f.write("# 文件\t状态\t说明\n")
        f.write("\n".join(lines))

    print(f"\n完成：成功 {stats['ok']}，跳过 {stats['skip']}，失败 {stats['fail']}，"
          f"耗时 {time.time() - t0:.1f}s")
    print(f"报告：{REPORT}")


if __name__ == "__main__":
    main()
