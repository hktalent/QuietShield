/* 离线证据包日志视图：数据由 data/log.js 注入 window.__QS_LOG__，
 * 不依赖 fetch / 服务器，双击 index.html 即可分页浏览与播放录音（音频走相对路径 audio/）。 */
(function () {
  var D = window.__QS_LOG__ || { meta: {}, records: [] };
  var records = (D.records || []).slice();
  // 数据文件可按天共用（含全部标签）；显示与分页按标签过滤，保证每个标签日志只看到自己的记录
  var tag = (D.meta && D.meta.tag) || "";
  if (tag) {
    records = records.filter(function (r) { return (r.tag || "") === tag; });
  }
  var S = { page: 0, size: 20, sort: "time" };

  function $(id) { return document.getElementById(id); }

  function peakOf(r) {
    return r.peak == null ? Number.NEGATIVE_INFINITY : Number(r.peak);
  }

  function sortedRecords() {
    var arr = records.slice();
    if (S.sort === "peak_desc") {
      arr.sort(function (a, b) {
        return (peakOf(b) - peakOf(a)) || (a.ts > b.ts ? 1 : a.ts < b.ts ? -1 : 0);
      });
    } else if (S.sort === "peak_asc") {
      arr.sort(function (a, b) {
        return (peakOf(a) - peakOf(b)) || (a.ts > b.ts ? 1 : a.ts < b.ts ? -1 : 0);
      });
    }
    return arr;
  }

  function audioSrc(r) {
    return "audio/" + String(r.audio || "").replace(/^.*\//, "");
  }

  /* 录音列：原生 <audio> 保证 file:// 双击也能收听原始录音；
   * 三个按钮通过 player.js 实时读取 audio/ 目录：http 打开时 5倍/降噪可正常处理，
   * file:// 下 fetch 失败时 player.js 会自动兜底为原生播放，不会静默无声。 */
  function audioCell(r) {
    var td = document.createElement("td");
    td.className = "au";
    if (!r.audio) {
      td.textContent = "无录音";
      td.style.color = "#888";
      return td;
    }
    var src = audioSrc(r);
    // 原生播放器：file:// 双击也能直接播放原始录音
    var au = document.createElement("audio");
    au.controls = true;
    au.preload = "none";
    au.src = src;
    td.appendChild(au);
    var modes = [
      ["▶", "原始播放", "playRawAudio"],
      ["🔊", "5倍音量播放", "playBoostAudio"],
      ["✨", "降噪清晰播放", "playClearAudio"]
    ];
    modes.forEach(function (m) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pbtn";
      b.textContent = m[0];
      b.title = m[1];
      b.onclick = function () {
        var fn = window[m[2]];
        if (typeof fn === "function") {
          try { fn(src); } catch (e) { console.warn(m[1] + "失败", e); }
        }
      };
      td.appendChild(b);
    });
    return td;
  }

  function renderRows(rows) {
    var body = $("logBody");
    body.innerHTML = "";
    if (!rows.length) {
      var tr0 = document.createElement("tr");
      var td0 = document.createElement("td");
      td0.colSpan = 7;
      td0.className = "pg-dots";
      td0.textContent = records.length ? "本页暂无记录" : "该日志暂无记录";
      tr0.appendChild(td0);
      body.appendChild(tr0);
      return;
    }
    rows.forEach(function (r) {
      var tr = document.createElement("tr");

      var td1 = document.createElement("td");
      td1.textContent = r.t || "";
      if (r.locTitle) td1.title = "📍 " + r.locTitle;
      tr.appendChild(td1);

      var td2 = document.createElement("td");
      td2.textContent = r.tag || "";
      tr.appendChild(td2);

      var td3 = document.createElement("td");
      td3.textContent = r.dur == null ? "" : String(r.dur);
      tr.appendChild(td3);

      var td4 = document.createElement("td");
      td4.textContent = r.peak == null ? "" : String(r.peak);
      tr.appendChild(td4);

      var td5 = audioCell(r);
      tr.appendChild(td5);

      var td6 = document.createElement("td");
      td6.textContent = r.ip || "";
      tr.appendChild(td6);

      var td7 = document.createElement("td");
      td7.textContent = r.ua || "";
      if (r.uaRaw) td7.title = r.uaRaw;
      tr.appendChild(td7);

      body.appendChild(tr);
    });
  }

  function pageNumbers(n, cur) {
    var out = [];
    if (n <= 9) {
      for (var i = 0; i < n; i++) out.push(i);
      return out;
    }
    out.push(0);
    var lo = Math.max(1, cur - 2), hi = Math.min(n - 2, cur + 2);
    if (lo > 1) out.push(-1);
    for (var j = lo; j <= hi; j++) out.push(j);
    if (hi < n - 2) out.push(-2);
    out.push(n - 1);
    return out;
  }

  function navBtn(text, fn) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "pg-nav";
    b.textContent = text;
    b.onclick = fn;
    return b;
  }

  function renderPager(total) {
    var n = Math.max(1, Math.ceil(total / S.size));
    var meta = D.meta || {};
    ["pgbar", "pgbar2"].forEach(function (id) {
      var bar = $(id);
      if (!bar) return;
      bar.innerHTML = "";
      if (n <= 1 && total <= S.size) { bar.style.display = "none"; return; }
      bar.style.display = "";
      if (S.page > 0) bar.appendChild(navBtn("‹ 上一页", function () { S.page--; render(); }));
      pageNumbers(n, S.page).forEach(function (k) {
        if (k < 0) {
          var dots = document.createElement("span");
          dots.className = "pg-dots";
          dots.textContent = "…";
          bar.appendChild(dots);
          return;
        }
        var b = document.createElement("button");
        b.type = "button";
        b.className = "pg-btn" + (k === S.page ? " active" : "");
        b.textContent = String(k + 1);
        b.onclick = function () { S.page = k; render(); };
        bar.appendChild(b);
      });
      if (S.page < n - 1) bar.appendChild(navBtn("下一页 ›", function () { S.page++; render(); }));

      var info = document.createElement("span");
      info.className = "pg-info";
      info.textContent = "第 " + (S.page + 1) + "/" + n + " 页 · 共 " + total + " 条" +
        (((D.meta || {}).tag) ? "（标签：" + D.meta.tag + "）" : "") +
        (meta.early ? "（仅凌晨记录）" : "");
      bar.appendChild(info);
    });
  }

  function render() {
    var arr = sortedRecords();
    var total = arr.length;
    var pages = Math.max(1, Math.ceil(total / S.size));
    if (S.page >= pages) S.page = pages - 1;
    if (S.page < 0) S.page = 0;
    var rows = arr.slice(S.page * S.size, S.page * S.size + S.size);
    renderRows(rows);
    renderPager(total);
    var mt = $("mTotal");
    if (mt) mt.textContent = String(total);
  }

  function bindSort() {
    var th = document.querySelector('th[data-sort="peak"]');
    if (!th) return;
    th.onclick = function () {
      S.sort = S.sort === "peak_desc" ? "peak_asc" : "peak_desc";
      var ind = $("sortInd");
      if (ind) ind.textContent = S.sort === "peak_desc" ? " ↓" : " ↑";
      S.page = 0;
      render();
    };
  }

  function init() {
    bindSort();
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
