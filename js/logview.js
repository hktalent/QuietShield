/* 服务端日志分页视图：记录存 SQLite，按页向后端取数（每页 ≤20 条），点击翻页才加载。
 * 峰值列可排序（降序/升序），切换排序即重新查询第 1 页。
 * 支持选择起止日期导出离线证据 HTML（音频内嵌，无服务器也能播放）。 */
(function () {
  var cfg = window.__LOG_CFG__ || { date: "", early: false, tag: "" };
  var S = { date: cfg.date, early: !!cfg.early, tag: cfg.tag || "", page: 0, size: 20, total: 0, sort: "time", rows: [] };

  function $(id) { return document.getElementById(id); }

  function fetchJSON(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function loadPage(i) {
    var pages = Math.max(1, Math.ceil(S.total / S.size));
    if (i < 0 || i >= (S.total ? pages : 1)) return;
    S.page = i;
    $("logBody").innerHTML = '<tr><td colspan="7" class="pg-loading">加载中…</td></tr>';
    renderPager();
    var url = "/api/log/list?date=" + encodeURIComponent(S.date) +
      "&page=" + i + "&size=" + S.size + "&sort=" + S.sort +
      (S.early ? "&early=1" : "") +
      (S.tag ? "&tag=" + encodeURIComponent(S.tag) : "");
    fetchJSON(url).then(function (data) {
      S.total = data.total || 0;
      // 双保险：即使脚本被缓存/后端忽略 tag，也只显示当前标签的记录
      S.rows = (data.rows || []).filter(function (r) {
        return !S.tag || (r.tag || "") === S.tag;
      });
      renderRows();
      renderPager();
    }).catch(function (e) {
      $("logBody").innerHTML = '<tr><td colspan="7" class="pg-err">本页数据加载失败：' + e.message + '</td></tr>';
    });
  }

  function mkBtn(text, title, fn) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "au-btn au-ico";
    b.title = title;
    b.textContent = text;
    b.onclick = fn;
    return b;
  }

  function renderRows() {
    var body = $("logBody");
    body.innerHTML = "";
    if (!S.rows.length) {
      body.innerHTML = '<tr><td colspan="7" class="pg-loading">本页暂无记录</td></tr>';
      return;
    }
    S.rows.forEach(function (r) {
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

      var td5 = document.createElement("td");
      td5.className = "au";
      if (r.audio) {
        var a = r.audio;
        td5.appendChild(mkBtn("▶", "原始播放", function () { playRawAudio(a); }));
        td5.appendChild(mkBtn("🔊", "5倍音量播放", function () { playBoostAudio(a); }));
        td5.appendChild(mkBtn("✨", "降噪清晰播放", function () { playClearAudio(a); }));
      } else {
        td5.textContent = "无录音";
        td5.style.color = "#888";
      }
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

  function renderPager() {
    var n = Math.max(1, Math.ceil(S.total / S.size));
    var bars = [$("pgbar"), $("pgbar2")];
    bars.forEach(function (bar) {
      if (!bar) return;
      bar.innerHTML = "";
      if (n <= 1) { bar.style.display = "none"; return; }
      bar.style.display = "";
      if (S.page > 0) bar.appendChild(navBtn("‹ 上一页", function () { loadPage(S.page - 1); }));
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
        b.onclick = function () { loadPage(k); };
        bar.appendChild(b);
      });
      if (S.page < n - 1) bar.appendChild(navBtn("下一页 ›", function () { loadPage(S.page + 1); }));

      var info = document.createElement("span");
      info.className = "pg-info";
      info.textContent = "第 " + (S.page + 1) + "/" + n + " 页 · 共 " + S.total + " 条" +
        (S.tag ? "（标签：" + S.tag + "）" : "") +
        (S.early ? "（仅凌晨记录）" : "");
      bar.appendChild(info);
    });
  }

  function navBtn(text, fn) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "pg-nav";
    b.textContent = text;
    b.onclick = fn;
    return b;
  }

  function bindSort() {
    var th = document.querySelector('th[data-sort="peak"]');
    if (!th) return;
    th.onclick = function () {
      // 无 → 降序 → 升序 → 降序
      S.sort = (S.sort === "peak_desc") ? "peak_asc"
        : (S.sort === "peak_asc" ? "peak_desc" : "peak_desc");
      var ind = $("sortInd");
      if (ind) ind.textContent = S.sort === "peak_desc" ? " ↓" : " ↑";
      if (S.total) loadPage(0);
    };
  }

  function bindExport() {
    var btn = $("expBtn"), st = $("expStart"), en = $("expEnd"), msg = $("expMsg");
    if (!btn || !st || !en) return;
    st.value = cfg.date;
    en.value = cfg.date;
    btn.onclick = function () {
      var a = st.value, b = en.value;
      if (!a || !b) { msg.textContent = "请选择开始和结束日期"; return; }
      msg.textContent = "生成中…";
      btn.disabled = true;
      fetch("/api/log/export?start=" + encodeURIComponent(a) + "&end=" + encodeURIComponent(b) +
        (S.tag ? "&tag=" + encodeURIComponent(S.tag) : ""), { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.ok) throw new Error(d.err || "导出失败");
          msg.textContent = "已导出 " + d.count + " 条（" + (d.size / 1024).toFixed(1) + " KB），正在打开…";
          if (d.url) window.open(d.url, "_blank");
        })
        .catch(function (e) { msg.textContent = "导出失败：" + e.message; })
        .then(function () { btn.disabled = false; });
    };
  }

  function init() {
    bindSort();
    bindExport();
    loadPage(0);
  }

  window.LogView = { init: init };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
