(function(){
"use strict";

// 底噪上下限，防止漂移
const MIN_NOISE_FLOOR = 25;
const MAX_NOISE_FLOOR = 60;
const CAL = 96;   // 校准偏移：由 103 降至 93，使读数整体下移约 10dB，与手机声贝 app 接近
const DB_OFFSET = 94;

var wakeLockSentinel = null;
var $=function(id){return document.getElementById(id);};

// ================= 设备指纹（唯一标识，稳定跨刷新） =================
var deviceId = null;

function sha256Hex(str){
  if(window.crypto && crypto.subtle){
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str))
      .then(function(buf){
        return Array.from(new Uint8Array(buf)).map(function(b){return b.toString(16).padStart(2,"0");}).join("");
      })
      .catch(function(){ return fallbackHash(str); });
  }
  return Promise.resolve(fallbackHash(str));
}
function fallbackHash(str){
  // 非 HTTPS / 无 subtle 时的兜底哈希（当前为 HTTPS，正常走 SHA-256）
  var h = 2166136261;
  for(var i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = (h*16777619) >>> 0; }
  return ("00000000"+h.toString(16)).slice(-8);
}
function collectFingerprintSignals(){
  var parts = [
    navigator.userAgent, navigator.language, navigator.platform,
    screen.width+"x"+screen.height, screen.colorDepth,
    navigator.hardwareConcurrency || "",
    new Date().getTimezoneOffset(),
    navigator.deviceMemory || ""
  ];
  try{ // Canvas 指纹
    var c=document.createElement("canvas"); c.width=220;c.height=60;
    var ctx=c.getContext("2d");
    ctx.textBaseline="top";
    ctx.font="14px Arial"; ctx.fillStyle="#f60"; ctx.fillRect(0,0,220,60);
    ctx.fillStyle="#069"; ctx.font="16px monospace"; ctx.fillText("QuietShield fp 12345",2,2);
    parts.push(c.toDataURL());
  }catch(e){}
  try{ // WebGL 渲染器指纹
    var gl=document.createElement("canvas").getContext("webgl");
    if(gl){
      var dbg=gl.getExtension("WEBGL_debug_renderer_info");
      if(dbg){
        parts.push(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
        parts.push(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL));
      }
    }
  }catch(e){}
  return parts.join("|");
}
function getDeviceFingerprint(){
  if(deviceId) return Promise.resolve(deviceId);
  var stored = null;
  try{ stored = localStorage.getItem("qs_device_id"); }catch(e){}
  if(stored){ deviceId=stored; return Promise.resolve(stored); }
  return sha256Hex(collectFingerprintSignals()).then(function(id){
    deviceId = id;
    try{ localStorage.setItem("qs_device_id", id); }catch(e){}
    return id;
  });
}

// ================= 合并流（一次 getUserMedia 同时拿音视频，避免冲突） =================
var combinedStream = null;
/* 媒体流是否还活着：iOS 在来电/系统中断后会把 tracks 静默变成 "ended"，
 * 此时页面照旧显示"监测中"，但麦克风早已没有数据 —— 事件自然全部漏记。
 * 必须显式检查 readyState，不能只看 combinedStream 是否存在。 */
function streamAlive(s){
  if(!s || !s.getTracks) return false;
  var ts = s.getTracks();
  if(!ts.length) return false;
  for(var i=0;i<ts.length;i++){ if(ts[i].readyState !== "live") return false; }
  return true;
}
function ensureStream(){
  if(combinedStream && streamAlive(combinedStream)) return Promise.resolve(combinedStream);
  if(combinedStream){                        // 轨道已结束：先彻底拆掉旧的分析链再重开
    try{ combinedStream.getTracks().forEach(function(t){ try{ t.stop(); }catch(e){} }); }catch(e){}
    combinedStream = null;
    resetAudioAnalysis();
    soundLive = false;
  }
  return navigator.mediaDevices.getUserMedia({
    video:{ facingMode:"user", width:{ideal:1280}, height:{ideal:720} },
    audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false }
  }).then(function(stream){
    combinedStream = stream;
    initAudioAnalysis(stream);           // 同一路音频轨道 → 噪声分析
    var pv = $("preview");
    if(pv && "srcObject" in pv) pv.srcObject = stream;   // 同一路视频 → 预览
    $("dSound").className = "dot live";
    soundLive = true;
    return stream;
  });
}

// ================= 声压 / 噪声检测 =================
var audioCtx=null, analyser=null, micData=null;
var sampleSrc=null, sampleGain=null, sampleHp=null, sampleComp=null, sampleDest=null;
const SAMPLE_HP_FREQ = 120;   // 样本高通切除频点：滤掉低频"嗡嗡"背景（电源/电机低频），保留震楼器撞击瞬态
const SAMPLE_GAIN = 3;        // 样本录音放大增益（原始响度偏低，放大后直接播放可听）
var scopeBuf=[];

/* 区间峰值计：主线程的 100ms 轮询在 iOS 后台会被节流到秒级，而 analyser 每次只能
 * 看到最近 46ms（fftSize=2048）——100~300ms 的撞击脉冲会在两次轮询之间整段漏掉。
 * 这里把 RMS 峰值交给 AudioWorklet（音频线程）累计，主线程被节流也不会丢瞬态。 */
var fastPeakDb = 0;
var peakWorklet = null, peakWorkletSink = null, peakProc = null, peakMeterTried = false;

/* 5 分钟 dB 包络：定长环形缓冲（每 100ms 一点）。
 * 旧实现用数组 push + splice 丢弃头部，每 100ms 复制 3000 个对象，
 * 长时间监测下产生持续的 GC 压力；改为 Float32/Float64 定长环，零分配。 */
var ENV_CAP = 3000;                  // 5 分钟 / 100ms
var envT = new Float64Array(ENV_CAP); // 采样时间戳
var envDb = new Float32Array(ENV_CAP);// 对应 dB
var envHead = 0;                      // 下一个写入位置
var envLen = 0;                       // 有效点数（≤ENV_CAP）
function envPush(t, db){
  envT[envHead] = t; envDb[envHead] = db;
  envHead = (envHead + 1) % ENV_CAP;
  if(envLen < ENV_CAP) envLen++;
}
/* 逻辑下标（0 = 最旧）→ 环形物理下标 */
function envIdx(i){
  var k = envHead - envLen + i;
  return ((k % ENV_CAP) + ENV_CAP) % ENV_CAP;
}
var hoverX=-1;     // 波形图悬停 x（CSS像素），-1 表示未悬停
var soundLive=false;
var S={sound:0};
var DB={value:0};
var thr=60;
const MIN_RECORD_SEC = 0.2;
var logArr=[];
var running=false;

// 底噪自校准
var noiseFloorDb = 30;
var noiseFloorSamples = 0;
var noiseFloorSum = 0;
var noiseFloorCalSec = 2;   // 背景噪声校准时长(秒)，启动时按小时设置：凌晨 1-6 点 10s、白天 2s
var calArr = [];                    // 校准期 dB 样本，用低分位数抗偶发噪声污染
var postSessionCooldownTs = 0;      // 事件结束时间戳，用于冷却期
const POST_SESSION_COOLDOWN_MS = 5000;  // 事件结束后 5 秒内不更新背景，防刚停的噪声拉高背景
var NOISE_FLOOR_ALPHA = 0.02;

function initAudioAnalysis(stream){
  if(audioCtx) return;
  audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  var src = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.12;
  src.connect(analyser);
  micData = new Float32Array(analyser.fftSize);
  initPeakMeter(src);
  // 样本录音放大链：节点只建一次（避免分段重建反复创建节点导致累积/走样），
  // 放大样本响度，使直接播放也能听到（原始响度偏低）
  try{
    sampleSrc = audioCtx.createMediaStreamSource(stream);
    sampleHp = audioCtx.createBiquadFilter();
    sampleHp.type="highpass"; sampleHp.frequency.value=SAMPLE_HP_FREQ; sampleHp.Q.value=0.7;
    sampleGain = audioCtx.createGain(); sampleGain.gain.value = SAMPLE_GAIN;
    sampleComp = audioCtx.createDynamicsCompressor();
    // 压缩器改 limiter：只在响度到 -10dBFS 附近开始限幅防削波，不把低响度背景抬起来（避免样本播放时背景嘈杂）
    sampleComp.threshold.value=-10; sampleComp.knee.value=4; sampleComp.ratio.value=10;
    sampleComp.attack.value=0.003; sampleComp.release.value=0.25;
    sampleDest = audioCtx.createMediaStreamDestination();
    sampleSrc.connect(sampleGain); sampleGain.connect(sampleHp); sampleHp.connect(sampleComp); sampleComp.connect(sampleDest);
  }catch(e){ sampleDest = null; }
}

/* 与 computeDb 完全同一套标定公式，保证两条路径的 dB 可比 */
function rmsToDb(rms){
  return DB_OFFSET + 20*Math.log10(rms + 1e-6) + CAL - 94;
}

/* 音频线程峰值计：worklet 里按 block 求 RMS、累计区间最大值，每 ~32ms 回传一次；
 * 回传的是「这段时间里的最大 dB」，所以主线程哪怕被节流 5 秒，峰值也不会丢。
 * worklet 不可用时退回 ScriptProcessor（兼容老 Safari），再不行就只靠 100ms 轮询。 */
function initPeakMeter(src){
  if(!audioCtx || peakMeterTried) return;
  peakMeterTried = true;
  var sink = null;
  try{
    sink = audioCtx.createGain();
    sink.gain.value = 0;                 // 静音汇：只为让接进来的节点持续被音频线程拉取
    sink.connect(audioCtx.destination);
  }catch(e){ sink = null; }
  var wl = audioCtx.audioWorklet;
  if(wl && wl.addModule && window.AudioWorkletNode && window.Blob && window.URL && URL.createObjectURL){
    var code =
      'class QSPeakMeter extends AudioWorkletProcessor {' +
      ' constructor(){ super(); this.max=-Infinity; this.n=0; }' +
      ' process(inputs){' +
      '  var ch = inputs[0] && inputs[0][0];' +
      '  if(ch){ var s=0; for(var i=0;i<ch.length;i++){ s += ch[i]*ch[i]; }' +
      '   var db = ' + DB_OFFSET + ' + 20*Math.log10(Math.sqrt(s/ch.length)+1e-6) + ' + CAL + ' - 94;' +
      '   if(db > this.max) this.max = db; }' +
      '  if(++this.n >= 12){ this.port.postMessage(this.max); this.max = -Infinity; this.n = 0; }' +
      '  return true; }' +
      '}' +
      'registerProcessor("qs-peak-meter", QSPeakMeter);';
    var url = null;
    try{ url = URL.createObjectURL(new Blob([code], {type:"application/javascript"})); }catch(e){ url = null; }
    if(url){
      wl.addModule(url).then(function(){
        try{
          var node = new AudioWorkletNode(audioCtx, "qs-peak-meter");
          node.port.onmessage = function(ev){
            var v = ev && ev.data;
            if(typeof v === "number" && isFinite(v) && v > fastPeakDb) fastPeakDb = v;
          };
          src.connect(node);
          if(sink) node.connect(sink);
          peakWorklet = node; peakWorkletSink = sink;
        }catch(err){ startScriptProcessorMeter(src, sink); }
      }).catch(function(){ startScriptProcessorMeter(src, sink); });
      return;
    }
  }
  startScriptProcessorMeter(src, sink);
}

function startScriptProcessorMeter(src, sink){
  try{
    if(!audioCtx || !audioCtx.createScriptProcessor) return;
    var proc = audioCtx.createScriptProcessor(1024, 1, 1);
    proc.onaudioprocess = function(e){
      var d = e.inputBuffer.getChannelData(0), s = 0;
      for(var i=0;i<d.length;i++) s += d[i]*d[i];
      var v = rmsToDb(Math.sqrt(s/d.length));
      if(v > fastPeakDb) fastPeakDb = v;
    };
    src.connect(proc);
    if(sink) proc.connect(sink);
    peakProc = proc;
  }catch(err){ console.warn("峰值计启动失败，瞬态捕获退回轮询采样", err); }
}

function computeDb(){
  if(!analyser) return;
  analyser.getFloatTimeDomainData(micData);
  var sum=0; for(var i=0;i<micData.length;i++) sum += micData[i];
  var dc = sum / micData.length;
  var sumSq=0; for(var j=0;j<micData.length;j++){ var v=micData[j]-dc; sumSq += v*v; }
  var rms = Math.sqrt(sumSq / micData.length);
  var db = rmsToDb(rms);
  if(!isFinite(db) || db < 20) db = 20;
  if(db > 120) db = 120;
  // 取「本拍瞬时」与「上一拍以来音频线程累计峰值」中的大者做检测值：
  // 主线程被节流时，脉冲只可能出现在累计峰值里，瞬时值会整段漏掉。
  var _pend = fastPeakDb; fastPeakDb = 0;
  if(!isFinite(_pend) || _pend < 20) _pend = 20;
  if(_pend > 120) _pend = 120;
  var detectDb = _pend > db ? _pend : db;
  DB.value = db;
  DB.detect = detectDb;
  S.sound = Math.max(0, Math.min(1,(db-20)/70));

  scopeBuf = [];
  var step = Math.max(1, Math.floor(micData.length/320));
  for(var k=0;k<micData.length;k+=step) scopeBuf.push(micData[k]-dc);
  if(scopeBuf.length>400) scopeBuf = scopeBuf.slice(-400);

  // 5分钟 dB 包络：用检测值（含区间峰值），节流期间漏掉的尖峰也能画出来
  envPush(Date.now(), DB.detect);

  if(!overSession.active){
    if(noiseFloorSamples < noiseFloorCalSec*10){
      calArr.push(db); noiseFloorSamples++;
      if(noiseFloorSamples === noiseFloorCalSec*10){
        // 背景代表值：凌晨安静→用中位数(抗偶发噪声)；白天→用平均值(常态噪声，避免平时噪声贴近触发线导致不回落)
        var _ca = calArr.slice().sort(function(a,b){return a-b;});
        var _hc2 = new Date().getHours(), _early2 = (_hc2 >= 1 && _hc2 < 6);
        var _bv;
        if(_early2){ _bv = _ca[Math.floor(_ca.length/2)]; }
        else { var _sum2=0; for(var _m2=0;_m2<_ca.length;_m2++) _sum2 += _ca[_m2]; _bv = _sum2/_ca.length; }
        noiseFloorDb = Math.max(MIN_NOISE_FLOOR, Math.min(MAX_NOISE_FLOOR, _bv));
      }
    } else if(Date.now()-postSessionCooldownTs > POST_SESSION_COOLDOWN_MS && db < noiseFloorDb + 3){
      noiseFloorDb = noiseFloorDb*(1-NOISE_FLOOR_ALPHA) + db*NOISE_FLOOR_ALPHA;
      noiseFloorDb = Math.max(MIN_NOISE_FLOOR, Math.min(MAX_NOISE_FLOOR, noiseFloorDb));
    }
  }
}

/* ===== 超标会话状态机（仅噪声，已去除磁/振快照） ===== */
var overSession = { active:false, startTs:0, peakDb:0 };
function resetOverSession(){ overSession.active=false; overSession.startTs=0; overSession.peakDb=0; }

function formatFullTime(ts){
  var d=new Date(ts), p=function(n){return ("0"+n).slice(-2);};
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds());
}
// 文件名时间格式：YYYYMMDD_HHMMSS（年月日时分秒）
function formatToFile(ms){
  var d=new Date(ms), p=function(n){return ("0"+n).slice(-2);};
  return ""+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+"_"+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds());
}
// 读取界面标签（如"客厅"），清洗为文件安全字符（保留中文/字母/数字/下划线/连字符）；并自动记忆到本地，下次打开免重输
function getTag(){
  var v = ($("tagInput") && $("tagInput").value.trim()) || "未命名";
  v = v.replace(/[^\w\u4e00-\u9fff\-]/g, "_").slice(0,24);
  v = v || "未命名";
  if(deviceId) try{ localStorage.setItem("qs_video_tag_"+deviceId, v); }catch(e){}
  return v;
}

/* ---------- 存储 ----------
 * 音频不再存浏览器 IndexedDB / base64（长时间采集会导致 IndexedDB 开销过大，浏览器卡顿、卡死）。
 * 录音直接上传服务器落盘到 logs/audio/，本地 logArr 只保留服务端返回的音频 URL（小字符串），
 * 回放时由 <audio> / player.js 直接 fetch 服务器音频文件，浏览器内存不再被 base64 占满。 */

function validAudio(a){
  return typeof a === "string" && a.length > 400 && a.indexOf("base64,") > 0;
}

/* ---------- 漏记计数 ----------
 * 用来回答"到底探测到多少、存下来多少、丢在哪一环"。旧实现所有丢弃分支都是静默 return，
 * 从页面和日志上都看不出有事件被吞掉，这正是这次"大量错漏"没被及时发现的原因。
 * 计数持久化在 localStorage，可随时在控制台执行 qsDropStats() 查看。 */
var qsDrop = {short:0, lowPeak:0, noAudio:0, upErr:0, ringStall:0};
try{
  var _ds = JSON.parse(localStorage.getItem("qs_drop_stats")||"{}");
  if(_ds && typeof _ds === "object"){
    for(var _dk in qsDrop) if(typeof _ds[_dk] === "number") qsDrop[_dk] = _ds[_dk];
  }
}catch(e){}
function dropCount(k){
  qsDrop[k] = (qsDrop[k]||0) + 1;
  try{ localStorage.setItem("qs_drop_stats", JSON.stringify(qsDrop)); }catch(e){}
  console.warn("[漏记] "+k+" 累计 "+qsDrop[k]);
}
function dropSnapshot(){
  var o = {};
  for(var k in qsDrop) o[k] = qsDrop[k];
  return o;
}
window.qsDropStats = function(){ return dropSnapshot(); };
window.qsDropReset = function(){ for(var k in qsDrop) qsDrop[k]=0; try{ localStorage.removeItem("qs_drop_stats"); }catch(e){} return qsDrop; };

function loadLog(){
  try{ var r=JSON.parse(localStorage.getItem("sm_log")||"[]"); if(Array.isArray(r)) logArr=r; }catch(e){ logArr=[]; }
  // 迁移旧数据：旧记录可能内嵌 base64（audioData）/波形图（waveImg），占满 localStorage；
  // 现已不存浏览器，直接剥离大字段，并给缺失 audio 的旧记录补空串（稍后从服务端回填 URL）
  var dirty=false;
  for(var i=0;i<logArr.length;i++){
    var rec=logArr[i];
    if(!rec) continue;
    if(rec.audioData!==undefined){ delete rec.audioData; dirty=true; }
    if(rec.waveImg!==undefined){ delete rec.waveImg; dirty=true; }
    if(typeof rec.audio !== "string"){ rec.audio = ""; dirty=true; }
  }
  if(dirty) saveLog();
  renderLog();
  resolveAudioUrls();   // 从服务端按日期回填旧记录缺失的音频 URL
}
function saveLog(){
  try{ localStorage.setItem("sm_log", JSON.stringify(logArr)); }catch(e){ toast("⚠️本地存储已满"); }
}
loadLog();

/* ---------- 请求基址：内网可达就直连内网，避免每次 POST 都绕公网 ---------- */
var apiBase="";
function apiUrl(p){ return (apiBase||"")+p; }
var _netInfo=null,_netInfoWait=[],_netInfoStarted=false;
function startNetInfo(){
  if(_netInfoStarted) return;
  _netInfoStarted=true;
  fetch("/api/netinfo",{cache:"no-store"}).then(function(r){ return r.json(); }).then(function(d){
    _netInfo=d||{};
    probeLan(_netInfo);
    flushNetInfo();
  }).catch(function(){ _netInfo={}; flushNetInfo(); });
}
function withNetInfo(cb){
  if(_netInfo){ try{ cb(_netInfo); }catch(e){} return; }
  _netInfoWait.push(cb); startNetInfo();
}
function flushNetInfo(){
  var l=_netInfoWait; _netInfoWait=[];
  for(var i=0;i<l.length;i++){ try{ l[i](_netInfo); }catch(e){} }
}
/* 逐个探测服务端自报的内网地址：能连上（且证书受信）才切换，否则保持公网同源 */
function probeLan(d){
  if(!d||!d.ok||!d.lan||!d.lan.length) return;
  var port=d.port||parseInt(location.port||"8808",10);
  var cands=[];
  for(var i=0;i<d.lan.length;i++){ if(d.lan[i]!==location.hostname) cands.push(d.lan[i]); }
  (function next(i){
    if(i>=cands.length) return;
    var base="https://"+cands[i]+":"+port;
    var ctrl=window.AbortController?new AbortController():null;
    var tm=ctrl?setTimeout(function(){ ctrl.abort(); },1500):0;
    fetch(base+"/api/netinfo",{cache:"no-store",signal:ctrl?ctrl.signal:undefined})
      .then(function(r){ return r.json(); })
      .then(function(j){
        if(tm) clearTimeout(tm);
        if(j&&j.ok){ apiBase=base; console.info("API 走内网直连:",apiBase); }
        else next(i+1);
      })
      .catch(function(){ if(tm) clearTimeout(tm); next(i+1); });
  })(0);
}

// 后台噪声日志推送（含设备ID，无磁/振）；成功时返回服务端落盘后的音频 URL（如 /audio/xxx.webm），失败返回空串
const LOG_API_URL = "/api/log";
async function pushLogToServer(record){
  /* 重试一次：网络/服务端抖动（公网经 cloudflared）时单次失败就整条丢样本太亏。
   * 服务端 records.ts 是主键且 INSERT OR REPLACE，重发不会产生重复记录，可安全重试。
   * 同时加 60 秒超时，避免连接被挂死占住浏览器连接池。 */
  record.deviceId = record.deviceId || (deviceId || "unknown");
  var body = JSON.stringify(record);
  for(var attempt = 0; attempt < 2; attempt++){
    try{
      var ctrl = window.AbortController ? new AbortController() : null;
      var tm = ctrl ? setTimeout(function(){ try{ ctrl.abort(); }catch(e){} }, 60000) : null;
      var resp = await fetch(apiUrl(LOG_API_URL),{
        method:"POST", headers:{"Content-Type":"application/json"},
        body: body, signal: ctrl ? ctrl.signal : undefined
      });
      if(tm) clearTimeout(tm);
      if(!resp.ok) throw new Error("HTTP status: "+resp.status);
      var data = await resp.json().catch(function(){ return {}; });
      return (data && data.ok) ? (data.audio || "") : "";
    }catch(err){
      console.warn("推送日志失败（第"+(attempt+1)+"次）", err);
      if(attempt === 0) await new Promise(function(r){ setTimeout(r, 2000); });
    }
  }
  return "";
}

// 为本地 logArr 中缺失音频 URL 的记录，按日期从服务端回填（最多最近 14 天）。
// 服务端 DB 的 ts 存的是 str(timeTs)，这里用 String(rec.timeTs) 对齐匹配。
function resolveAudioUrls(){
  if(!logArr.length) return;
  var byDate = {};
  for(var i=0;i<logArr.length;i++){
    var rec=logArr[i];
    if(rec && typeof rec.audio === "string" && rec.audio) continue;   // 已有 URL，跳过
    var ts = rec && rec.timeTs;
    if(ts==null) continue;
    var d = new Date(ts);
    if(isNaN(d.getTime())) continue;
    var p=function(n){return ("0"+n).slice(-2);};
    var key = d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate());
    (byDate[key] = byDate[key] || []).push(ts);
  }
  var dates = Object.keys(byDate);
  if(!dates.length) return;
  var cutoff = Date.now() - 14*24*3600*1000;   // 只回填最近 14 天，避免启动时拉取过多历史
  dates = dates.filter(function(k){ return new Date(k).getTime() >= cutoff; });
  (function next(idx){
    if(idx >= dates.length) return;
    fetchLogAudioMap(dates[idx]).then(function(map){
      var dirty=false;
      for(var j=0;j<logArr.length;j++){
        var r=logArr[j];
        if(!r || (typeof r.audio === "string" && r.audio)) continue;
        var au = map[String(r.timeTs)];
        if(au){ r.audio = au; r._uploadErr=false; dirty=true; }
      }
      if(dirty){ saveLog(); renderLog(); }
      next(idx+1);
    }).catch(function(){ next(idx+1); });
  })(0);
}

// 拉取某天全部记录（size=200 分页），构建 {ts: audio} 映射（只含已有 audio 的行）
function fetchLogAudioMap(date){
  return new Promise(function(resolve){
    var map={};
    (function page(p){
      fetch(apiUrl("/api/log/list?date="+encodeURIComponent(date)+"&page="+p+"&size=200"), {cache:"no-store"})
        .then(function(resp){ return resp.ok ? resp.json() : {rows:[]}; })
        .then(function(data){
          var rows = (data && data.rows) || [];
          for(var i=0;i<rows.length;i++){
            var row=rows[i];
            if(row && row.ts && row.audio) map[String(row.ts)] = row.audio;
          }
          var total = (data && data.total) || 0;
          var pageSize = (data && data.size) || 200;
          if(rows.length && (p+1)*pageSize < total){ page(p+1); }
          else { resolve(map); }
        })
        .catch(function(){ resolve(map); });
    })(0);
  });
}

/* ===== 噪声样本：环形常驻录音（每段带头可播） =====
 * 事故背景：旧实现「事件期间永不重建录音段」，只要噪声持续不落（震楼器整夜运转），
 * ringSeg 就会无限增长——实测出现过单条 120 秒记录对应 62MB webm（相当于把整晚的音频
 * 全拼进一个 blob）。随后 FileReader 读 62MB 做 base64、再 POST 上兆的 JSON，
 * Safari 主线程被堵死，浏览器卡死。现改为三重护栏：
 *   1) 单段硬上限 RING_MAX_MS（触发前 ≤10s + 事件 ≤60s + 余量），超限立即切段；
 *   2) 单段字节上限 RING_MAX_BYTES，超限丢新片（宁可少一段尾巴，也不拖死浏览器）；
 *   3) 空闲时每 RING_RESTART_MS 重建一次录音器（旧实现 2s 建一个实例，
 *      1 小时 1800 个 MediaRecorder，Safari 不会及时回收 → 内存持续上涨）。 */
var audioClipRecorder = null;
var ringSeg = [];              // 当前录音段的片数组（每项 {db, blob, ms}），从段头拼 → 可播
var ringBytes = 0;             // 当前段累计字节
var ringT0 = 0;                // 当前段开录时间戳
var ringTimer = null;
const RING_SLICE_MS = 1000;    // 分片/采样间隔（1 秒一片）
const RING_RESTART_MS = 10000; // 空闲时每 10 秒重建一段：触发前最多约 10 秒（比原来 2 秒更有上下文，实例数降 5 倍）
const RING_MAX_MS = 90000;     // 单段最长 90 秒，超过立即切段，杜绝无界增长
const RING_MAX_BYTES = 8*1024*1024;  // 单段字节硬上限（正常 90 秒 opus 约 1MB，远达不到）
/* 样本截取窗口：事件前后各留 1 秒上下文。
 * 环形缓冲本来会在触发前攒 ≤10 秒（每片 1 秒），短促事件（<1 秒）的录音开头全是无关静音，
 * 听感上先播 6 秒空白再出现声音，很容易被判断成"没有声音"。
 * 落盘时按真实时间戳只取 [事件开始-1s, 事件结束+1s]，时长字段仍用事件本身的长度。 */
const PRE_ROLL_MS = 1000;
const POST_ROLL_MS = 1000;

function ringStart(){
  if(!window.MediaRecorder) return;   // iOS 12 Safari 无 MediaRecorder，跳过样本录音（仅监测 dB）
  if(!combinedStream) return;
  var at = combinedStream.getAudioTracks()[0];
  if(!at) return;
  var buf = [];                // 本 recorder 独立片数组（旧段收尾不会污染新段）
  var segBytes = 0, segWarned = false;   // 字节计数按段独立，避免新旧段串账
  ringSeg = buf; ringBytes = 0; ringT0 = Date.now();
  var opts = { mimeType: "audio/webm" };
  if(!MediaRecorder.isTypeSupported(opts.mimeType)) opts = { mimeType: "" };
  try{
    // sampleDest.stream 复用同一个 MediaStreamDestination，不每段新建 MediaStream
    var recStream = (sampleDest && sampleDest.stream) ? sampleDest.stream : new MediaStream([at]);
    var rec = new MediaRecorder(recStream, opts);
    rec.ondataavailable = function(e){
      if(!e.data || e.data.size <= 0) return;
      if(segBytes + e.data.size > RING_MAX_BYTES){
        if(!segWarned){ segWarned = true; console.warn("噪声样本单段超字节上限，已丢弃后续分片"); }
        return;
      }
      buf.push({ db: DB.value, blob: e.data, ms: Date.now() });
      segBytes += e.data.size;
      if(buf === ringSeg) ringBytes = segBytes;   // 只有当前段才更新全局计数
    };
    rec.start(RING_SLICE_MS);
    audioClipRecorder = rec;
  }catch(err){ audioClipRecorder = null; console.warn("噪声样本录音启动失败", err); }
}
/* 切段：先开新段、再停旧段。
 * 旧实现「先 stop 再 start」并且把 ondataavailable 置空，等于每次切段都丢掉旧段最后
 * ≤1 秒的音频（10 秒切一次 → 一小时丢 6 分钟）；撞击正好落在窗口里时就整段没了。 */
function rebuildRing(){
  var old = audioClipRecorder;
  ringStart();
  if(old && old !== audioClipRecorder){
    try{ if(old.state === "recording") old.stop(); }catch(e){}
  }
}
function ensureRing(){
  if(!audioClipRecorder){ ringStart(); return; }
  if(audioClipRecorder.state !== "recording") return;   // 正在停止，等下一拍
  var age = Date.now() - ringT0;
  if(overSession.active){
    // 事件期间保持连续不切段；但到硬上限先把这一段落盘再切，绝不无界增长
    if(age >= RING_MAX_MS) closeAndSaveSession();
    return;
  }
  // 新段开了 3 秒还一片都没收到：录音器/音频链已经僵死（AudioContext 静默、destination 断流），
  // 重建一次尝试恢复，并计入漏记统计，避免"看起来在录、其实一直是空段"。
  if(!ringSeg.length && age >= 3000){ dropCount("ringStall"); rebuildRing(); return; }
  if(age >= RING_RESTART_MS) rebuildRing();
}
function startRingRecording(){
  if(!combinedStream) return;
  if(audioClipRecorder){ try{ audioClipRecorder.stop(); }catch(e){} audioClipRecorder = null; }
  ringStart();
  if(ringTimer) clearInterval(ringTimer);
  ringTimer = setInterval(ensureRing, 1000);
}
function stopRingRecording(){
  if(ringTimer){ clearInterval(ringTimer); ringTimer=null; }
  if(audioClipRecorder){
    try{ audioClipRecorder.ondataavailable = null; audioClipRecorder.stop(); }catch(e){}
  }
  audioClipRecorder = null;
  ringSeg = []; ringBytes = 0;
}
/* 同步截取当前段（不读文件、不做 base64，避免主线程阻塞）
 * 传入 startTs/endTs 时按时间窗只取 [startTs-PRE_ROLL_MS, endTs+POST_ROLL_MS]：
 * 每个分片约 RING_SLICE_MS，用它的结束时刻反推起点，整片都落在窗口外的直接丢掉。
 * 分片不能从中间切开（切了会破坏 webm 流），所以前摇实际是 1.0~2.0 秒，足够听见上下文。 */
function takeRingBlob(startTs, endTs){
  if(!ringSeg.length) return null;
  // 警告：不要在前端按时间窗丢掉开头分片（WebM 头在首片里）。默认不传参 = 取整段。
  var from = (startTs != null) ? (startTs - PRE_ROLL_MS) : -Infinity;
  var to   = (endTs   != null) ? (endTs   + POST_ROLL_MS) : Infinity;
  var blobs = [], total = 0, used = 0;
  for(var k = 0; k < ringSeg.length; k++){
    var seg = ringSeg[k];
    var chunkEnd = seg.ms;
    var chunkStart = chunkEnd - RING_SLICE_MS;
    if(chunkEnd < from) continue;        // 整片都在前摇之前：丢掉（这就是"开头 6 秒空白"的来源）
    if(chunkStart > to) break;           // 整片都在尾随之 后：后面的不要（数组是按时间追加的）
    blobs.push(seg.blob); total += seg.blob.size; used++;
  }
  if(!used || total < 200) return null;
  var mime = (audioClipRecorder && audioClipRecorder.mimeType) || "audio/webm";
  return new Blob(blobs, {type: mime});
}
function blobToDataUrl(blob){
  return new Promise(function(resolve){
    try{
      var reader = new FileReader();
      reader.onloadend = function(){ resolve(reader.result || null); };
      reader.onerror = function(){ resolve(null); };
      reader.readAsDataURL(blob);
    }catch(e){ resolve(null); }
  });
}
/* 结束一段并落库。关键改动：
 *   - 进入函数立刻 resetOverSession()（同步），此后 processOverThreshold 不会再重复调用本函数
 *     （旧实现把 reset 放在 await 之后，60 秒触发时同一段会被反复 close → 反复做 base64 → 卡死）；
 *   - 先同步取 blob + 切段，再异步做 base64 / 上传，主线程不长时间被占。 */
var closingSession = false;
async function closeAndSaveSession(){
  if(!overSession.active || closingSession) return;
  closingSession = true;
  try{
    var startTs = overSession.startTs;
    var peak = overSession.peakDb;
    var nowTs = Date.now();
    // 结束时间取「首次跌回结束线」的时刻（合并窗口内不再切断），超长切段时取当前时刻
    var endTs = fallTs || nowTs;
    var durSec = Math.max(0, (endTs - startTs)/1000).toFixed(1);
    resetOverSession();                        // 同步结束，防重入
    fallTs = null;                             // 清掉本段回落时刻，避免影响下一段时长
    trigPendingTs = 0; trigPendingPeak = 0;
    postSessionCooldownTs = nowTs;             // 事件结束进入冷却期，期内不更新背景
    // 取整段，不做前端裁剪：WebM 的 EBML 头与 OpusHead 都在最初那一片里，
    // 丢掉前片会让整段变成"没有容器头的裸数据"，任何浏览器都放不出来。
    // 裁剪交给服务端用 ffmpeg 做（它重写容器头），这里只把事件在片段内的偏移一起送过去。
    var clipStart = ringSeg.length ? (ringSeg[0].ms - RING_SLICE_MS) : (startTs - RING_SLICE_MS);
    var blob = takeRingBlob();                 // 同步截取整段
    if(!blob && running){
      /* 事件正好落在新段开头的第一片还没落袋的 1 秒内（每 10 秒切段，约 10% 命中的情况），
       * 此时缓冲是空的。等一片（≤1.1 秒）再取：声音就在这一片里，不能直接判"无样本"。 */
      await new Promise(function(res){ setTimeout(res, 1100); });
      if(ringSeg.length) clipStart = ringSeg[0].ms - RING_SLICE_MS;
      blob = takeRingBlob();
    }
    var clipPreMs  = Math.max(0, Math.round(startTs - clipStart));
    var clipPostMs = Math.max(0, Math.round(endTs   - clipStart));
    // 立刻切段：下一段从新文件头开始，永不无限增长。停止监测时只清空缓冲不再新建录音器
    if(running) rebuildRing(); else { ringSeg = []; ringBytes = 0; }
    /* 这里是"错漏"最大的一处：旧实现只要样本取不到（blob 为空 / base64 无效）就整条 return，
     * 事件在日志里彻底消失，事后完全看不出"探测到了但没存下来"。
     * 现在只在时长过短、峰值过低时丢弃；样本缺失照样入库，只是 audio 为空。 */
    if(parseFloat(durSec) < MIN_RECORD_SEC){ dropCount("short"); return; }
    if(!isFinite(peak) || peak < MIN_RECORD_PEAK){ dropCount("lowPeak"); return; }
    var audioB64 = blob ? await blobToDataUrl(blob) : null;
    var hasAudio = validAudio(audioB64);
    if(!hasAudio){ audioB64 = ""; dropCount("noAudio"); }
    var fullTimeStr = formatFullTime(startTs);
    var _lat = gpsLat!==null ? gpsLat.toFixed(6):null;
    var _lon = gpsLon!==null ? gpsLon.toFixed(6):null;
    // 记录时携带已解析的地址（后台定时器已解析，直接复用，不阻塞）
    var _addr = currentAddress || "";
    // 先以 audio=""（上传中）入列渲染，待服务端返回 URL 后回填；全程不写 IndexedDB / base64
    var rec = {
      timeText: fullTimeStr, timeTs: startTs, durationSec: durSec,
      peakDb: peak.toFixed(1), tag: getTag(),
      lat: _lat, lon: _lon, address: _addr, audio: "", _noAudio: !hasAudio
    };
    logArr.unshift(rec);
    if(logArr.length>300) logArr.length=300;
    saveLog(); prependLogRow(rec);        // 只插入新增这一行，不整表重绘
    // 异步上传：成功回填服务端音频 URL 并就地更新该行；失败标记上传失败
    pushLogToServer({
      timeText: fullTimeStr, timeTs: startTs, durationSec: durSec,
      peakDb: peak.toFixed(1), tag: getTag(),
      audioData: audioB64,
      audioMissing: !hasAudio,   // 样本缺失标记：服务端照常入库，前端明确显示"无样本"
      clipStartMs: clipPreMs,   // 事件起点在片段内的时间（毫秒）→ 服务端裁到它前后各 1 秒
      clipEndMs: clipPostMs,
      diag: dropSnapshot(),      // 漏记计数一起上报，便于核对"探测到多少、存下多少"
      lat: _lat, lon: _lon,
      address: _addr   // 客户端已转换好的地址，服务端直接写入日志，不再重复解析
    }).then(function(audioUrl){
      if(audioUrl){ rec.audio = audioUrl; rec._uploadErr = false; rec._noAudio = false; }
      else if(!hasAudio){ rec._uploadErr = false; rec._noAudio = true; }  // 本来就没样本：不算上传失败
      else { rec._uploadErr = true; dropCount("upErr"); }
      saveLog(); updateLogRowAudio(rec);
    });
  }catch(e){ console.warn("保存噪声记录失败", e); }
  finally { closingSession = false; }   // 必须 finally：try 内的 return 会跳过语句，守卫卡住就再也关不掉会话
}

/* ===== 超标检测 ===== */
var fallTs = null;
var trigPendingTs = 0, trigPendingPeak = 0;   // 触发去抖：连续超线计时起点与期间峰值
const TRIG_OFFSET = 6;
const RELEASE_OFFSET = 3;   // 结束线 = 背景 + 3dB（低于触发线 6dB），噪声真正回落到常态附近才停
const RELEASE_HYSTERESIS = 5;   // 白天/夜间结束线比触发线低 5dB（滞回）：常态噪声在阈值附近波动也能正常结束
/* 合并窗口：低于结束线后必须连续安静这么久才真正结束本次噪声。
 * 旧值 0.4 秒会把一段连续噪声在每次短暂回落时切断，产生大量 <2 秒的碎片记录；
 * 3 秒内的再次超线视为同一次噪声，继续累加到当前记录（时长/峰值统一计算）。 */
const MERGE_GAP_SEC = 3;
const TRIG_HOLD_SEC = 0.15;   // 连续超触发线 0.15 秒（2 拍）才开记：检测值已是区间峰值，不需要 3 拍去抖
/* 单点尖峰直接开记：震楼器/撞击类噪声只有 100~300ms，靠"连续 0.3 秒超线"永远等不到
 * （100ms 轮询 + 46ms 测量窗，一次撞击最多命中 2~3 拍，实测 100% 漏记）。
 * 只要一拍就高出触发线 IMPULSE_MARGIN_DB，就当作瞬态事件立即开记。 */
const IMPULSE_MARGIN_DB = 3;
const MIN_RECORD_PEAK = 32;   // 只挡明显不是噪声的垃圾样本；旧值 39 会切掉一大批真实轻撞击
const MAX_SESSION_SEC = 60;   // 连续噪声记录上限：最多 60 秒一段，超时切段重记（配合样本段硬上限 90 秒）

function setThr(){
  var h = new Date().getHours();
  thr = (h>=6 && h<22) ? 55 : 45;
}
function processOverThreshold(currentDb){
  var nowTs = Date.now();
  var triggerLevel = noiseFloorDb + TRIG_OFFSET;
  var hh = new Date().getHours();
  var early = (hh >= 1 && hh < 6);   // 凌晨 01:00~06:00 前
  // 每次都读取开关状态，确保会话进行中切换也能正确判定结束线
  var gapOn = !!($("dbGapCb") && $("dbGapCb").checked);
  var gapVal = gapOn ? (parseFloat($("dbGapIn").value)||6) : 0;
  setThr();   // 每拍都刷新：跨时段（白天/夜间切换）也能立即按新阈值判定
  // 触发线显式化：固定阈值与「背景+X」取较小者（与原 OR 逻辑完全等价），
  // 后面的瞬时尖峰线和结束线都以它为基准，避免三处各算一套互相打架。
  var trigLevel = gapOn ? Math.min(thr, noiseFloorDb + gapVal)
                        : (early ? Math.min(thr, triggerLevel) : thr);
  if(!overSession.active){
    fallTs = null;
    var impulseLevel = trigLevel + IMPULSE_MARGIN_DB;
    var pass = currentDb > trigLevel;
    var impulse = currentDb >= impulseLevel;
    // 触发去抖：连续超线 TRIG_HOLD_SEC 才开记；但单拍瞬态尖峰（≥触发线+IMPULSE_MARGIN_DB）立即开记，
    // 起点回填到首次超线时刻，峰值取去抖窗口内的最大值。
    if(pass){
      if(!trigPendingTs){ trigPendingTs = nowTs; trigPendingPeak = currentDb; }
      else if(currentDb > trigPendingPeak){ trigPendingPeak = currentDb; }
      if(impulse || (nowTs - trigPendingTs)/1000 >= TRIG_HOLD_SEC){
        overSession.active = true;
        overSession.startTs = trigPendingTs;
        overSession.peakDb = Math.max(trigPendingPeak, currentDb);
        trigPendingTs = 0; trigPendingPeak = 0;
      }
    } else { trigPendingTs = 0; trigPendingPeak = 0; }
  } else {
    var sessionDur = (nowTs - overSession.startTs)/1000;
    if(sessionDur >= MAX_SESSION_SEC){ closeAndSaveSession(); return; }
    if(currentDb > overSession.peakDb) overSession.peakDb = currentDb;
    // 结束线：勾选背景+X时=背景+3；未勾选时 凌晨=背景+3 / 其他=固定阈值-5dB滞回。
    // 关键：结束线必须不高于触发线，否则背景抬到触发线之上时会话永远结束不了（只能等 60s 硬切）。
    var releaseLevel = gapOn ? (noiseFloorDb + RELEASE_OFFSET)
                             : (early ? (noiseFloorDb + RELEASE_OFFSET) : (thr - RELEASE_HYSTERESIS));
    if(releaseLevel > trigLevel) releaseLevel = trigLevel;
    if(currentDb > releaseLevel){ fallTs=null; }
    else {
      if(fallTs===null) fallTs=nowTs;
      else if((nowTs-fallTs)/1000 >= MERGE_GAP_SEC) closeAndSaveSession();
    }
  }
  // 录像会话内同步记录峰值
  if(recording && currentDb > sessionPeakDb) sessionPeakDb = currentDb;
}

function liveDb(){
  if(!soundLive) return;
  computeDb();
  var db=DB.value;
  var dbTxt=db.toFixed(0);
  $("liveDb").textContent=dbTxt+" dB";
  gGauge.f=S.sound; gGauge.c=(db>thr ? "#F5A623" : "#22D3EE"); gGauge.t=dbTxt;
  drawArc($("gSound"), gGauge.f, gGauge.c, gGauge.t);
  var st=$("sSound");
  if(st){
    if(!running && !recording){ st.textContent="待机"; st.className="gstate"; }
    else if(db>thr){ st.textContent="超阈值!"; st.className="gstate alarm"; }
    else if(db>thr-10){ st.textContent="接近阈值"; st.className="gstate warn"; }
    else { st.textContent="正常"; st.className="gstate"; }
  }
  drawScope();
  if(running) processOverThreshold(DB.detect != null ? DB.detect : db);   // 用含区间峰值的检测值，瞬态不漏
}
var _liveLoopRunning=false;
function liveLoop(){
  if(_liveLoopRunning) return;
  _liveLoopRunning=true;
  (function tick(){
    if(soundLive){ liveDb(); if(running) streamWatchdog(); setTimeout(tick,100); }
    else { _liveLoopRunning=false; }
  })();
}

/* 采集链自愈：AudioContext 被系统挂起（锁屏/来电/音频中断）后 analyser 读数是死的，
 * 页面却仍显示"监测中"。这里每 5 秒检查一次状态：挂起就 resume，轨道 ended 就重开流。
 * 只在 running 时生效，且同一时刻只跑一次恢复，避免反复 getUserMedia 把设备占死。 */
var _wdLast=0, _wdBusy=false, _wdFail=0, _wdToastTs=0;
function streamWatchdog(){
  var now = Date.now();
  if(now - _wdLast < 5000) return;
  _wdLast = now;
  if(_wdBusy) return;
  if(audioCtx && audioCtx.state === "suspended"){
    try{ audioCtx.resume(); }catch(e){}
  }
  if(streamAlive(combinedStream) && audioCtx && audioCtx.state === "running") { _wdFail = 0; return; }
  if(!running) return;
  if(_wdFail >= 3) return;     // 连续失败就停手，避免反复抢占麦克风/摄像头（等人工重开）
  _wdBusy = true;
  recoverStream().then(function(ok){
    if(ok){ _wdFail = 0; }
    else {
      _wdFail++;
      if(now - _wdToastTs > 300000 || _wdFail === 1){
        _wdToastTs = now;
        toast("⚠️麦克风/摄像头已中断，自动恢复失败（第"+_wdFail+"次），请手动重新开始监测");
      }
    }
  }).catch(function(){}).then(function(){ _wdBusy = false; });
}
async function recoverStream(){
  console.warn("[自愈] 采集链中断，重新获取媒体流");
  var wasRecording = recording;
  try{
    if(wasRecording) await stopRecording();      // 旧流已死，先把录像会话正常收尾
  }catch(e){}
  resetAudioAnalysis();
  try{
    // ensureStream 会因 combinedStream 存在而直接返回，这里先清空再拉新流
    if(combinedStream){ try{ combinedStream.getTracks().forEach(function(t){ try{ t.stop(); }catch(e){} }); }catch(e){} }
    combinedStream = null;
    var s = await ensureStream();
    if(!streamAlive(s)) return false;
    if(wasRecording){ try{ await startRecording(); }catch(e){} }
    startRingRecording();                         // 录音段从头开始攒前摇
    return true;
  }catch(err){
    console.warn("[自愈] 重新获取媒体流失败", err);
    return false;
  }
}

/* ---------- 绘制 ---------- */
var gGauge={f:0,c:"#22D3EE",t:"--"}; // 声压计当前绘制状态，用于窗口缩放时重绘（含空闲态）

/* 画布尺寸缓存：只在「像素尺寸或 DPR 变化」时才重设 backing store。
 * 旧实现每帧都执行 canvas.width = w*dpr（等于重建一张 GPU 纹理 + 重置全部状态），
 * 10Hz 刷新下 Safari 的纹理/内存反复申请释放，是长时间监测后卡死的另一主因。 */
function fitCanvas(cv){
  var dpr = window.devicePixelRatio || 1;
  var w = Math.max(1, cv.clientWidth || 1), h = Math.max(1, cv.clientHeight || 1);
  var pw = Math.round(w*dpr), ph = Math.round(h*dpr);
  if(cv._pw !== pw || cv._ph !== ph || cv._dpr !== dpr){
    cv.width = pw; cv.height = ph;
    cv._pw = pw; cv._ph = ph; cv._dpr = dpr;
  }
  var c = cv._ctx || (cv._ctx = cv.getContext("2d"));
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return {c:c, w:w, h:h};
}

function drawArc(canvas,frac,color,dbText){
  if(!canvas) return;
  var fit = fitCanvas(canvas), c = fit.c, w = fit.w, h = fit.h;
  // 环居中偏下，完整落在画布内（顶部 cy-r、底部 cy+r≈h），数字画在环内部
  var r=Math.min(w/2 - 10, h*0.42), cx=w/2, cy=h*0.58;
  var a0=Math.PI*0.9, a1=Math.PI*2.1;
  c.clearRect(0,0,w,h); c.lineWidth=7; c.lineCap="round";
  c.strokeStyle="#1E2A35"; c.beginPath(); c.arc(cx,cy,r,a0,a1); c.stroke();
  var val=Math.max(0,Math.min(1,frac));
  var ang=a0+(a1-a0)*val;
  var g=c.createLinearGradient(0,0,w,0);
  if(frac>0.95){ g.addColorStop(0,"#F5A623"); g.addColorStop(1,"#EF4444"); }
  else { g.addColorStop(0,color); g.addColorStop(1,"#34D399"); }
  c.strokeStyle=g; c.beginPath(); c.arc(cx,cy,r,a0,ang); c.stroke();
  c.fillStyle="#7B8A99";
  [0,0.5,1].forEach(function(t){ var a=a0+(a1-a0)*t; c.beginPath(); c.arc(cx+Math.cos(a)*r, cy+Math.sin(a)*r, 1.8,0,6.283); c.fill(); });
  // 中心数值（嵌入弧线环内部，紧贴画布）
  if(dbText!=null && dbText!==""){
    var numH=Math.max(22, Math.round(r*0.55));
    c.textAlign="center"; c.textBaseline="middle";
    c.font="700 "+numH+"px monospace";
    c.fillStyle=(dbText==="--") ? "#7B8A99" : "#EAF2F7";
    c.fillText(dbText, cx, cy - r*0.55);
    c.font=Math.max(11,Math.round(r*0.18))+"px monospace";
    c.fillStyle="#7B8A99";
    c.fillText("dB", cx, cy - r*0.55 + numH*1.05);
  }
}
function drawScope(){
  var cv=$("scope");
  if(!cv) return;
  if(document.hidden) return;           // 页面在后台时不做无意义的绘制
  var fit = fitCanvas(cv), c = fit.c, w = fit.w, h = fit.h;
  c.fillStyle="#080C10"; c.fillRect(0,0,w,h);
  var DB_MIN=30, DB_MAX=90;
  // 底部留 13px 给时间刻度文字：曲线和网格都不进入这一带，否则低噪时段（≤32dB）的折线会横穿刻度字
  var padB=13, plotH=h-padB;
  // 纵向 dB 刻度线（40/60/80）
  c.strokeStyle="#14202A"; c.lineWidth=1;
  c.fillStyle="#3A4A57"; c.font=Math.max(9,Math.round(w/70))+"px monospace";
  for(var db=40; db<=80; db+=20){
    var yy=plotH - ((db-DB_MIN)/(DB_MAX-DB_MIN))*(plotH*0.95);
    c.beginPath(); c.moveTo(0,yy); c.lineTo(w,yy); c.stroke();
    c.fillText(db+"dB", 3, yy-2);
  }
  // 横向时间刻度：5 分钟窗口（-5min … 现在）
  for(var m=0;m<=5;m++){
    var xx=(m/5)*w;
    c.strokeStyle="#14202A"; c.beginPath(); c.moveTo(xx,0); c.lineTo(xx,plotH); c.stroke();
    c.fillStyle="#3A4A57";
    if(m===5){ c.textAlign="right"; c.fillText("现在", w-2, h-4); c.textAlign="left"; }  // 最右标签原来画在 w+2 被截掉
    else c.fillText("-"+(5-m)+"min", xx+2, h-4);
  }
  if(!envLen) return;
  /* 5 分钟 dB 包络：逐样本画折线（按真实时间戳投射，亚像素精度）。
   * 之前是「按像素列取最大值（峰值保持）」：一列约 6 个样本，样本跨列时该列的峰值会整体迁移到相邻列，
   * 尖峰所在的列先掉下来、右边那列接上来 —— 视觉上就是波形上下跳动（每次跨界跳一次）。
   * 现在不再按列合并，每个样本就是折线上的一个点：峰高恒等于真实 dB，横向只做连续的亚像素平移。
   * （早先 `i += step` 抽稀导致的「尖峰闪灭」也是同一个成因，一并消失。） */
  var nowT = Date.now(), WIN = 300000;
  var pxMs = w / WIN;
  c.strokeStyle="#22D3EE"; c.lineWidth=1.8; c.beginPath();
  var started=false, prevX=-1e9, n=envLen;
  for(var i=0;i<n;i++){
    var k=envIdx(i);
    var age = nowT - envT[k];
    if(age < 0 || age > WIN) continue;                 // 超出 5 分钟窗口的旧点直接忽略
    var xx = w - age * pxMs;
    if(xx < -1 || xx > w + 1) continue;
    var yv = plotH - Math.max(0,Math.min(1,(envDb[k]-DB_MIN)/(DB_MAX-DB_MIN)))*(plotH*0.95);
    if(!started || (xx - prevX) > 8){                  // 断档（暂停/丢样本）不拉直线，断开重画
      c.moveTo(xx, yv); started = true;
    } else {
      c.lineTo(xx, yv);
    }
    prevX = xx;
  }
  c.stroke();
  // 悬停参考线 + 时间/分贝提示（按时间找最近的采样点，不再假设固定 100ms 间隔）
  if(hoverX>=0 && n){
    var targetT = nowT - Math.max(0, (w-hoverX)/w * WIN);
    var bestK=-1, bestD=Infinity;
    for(var j=0;j<n;j++){
      var kj=envIdx(j), dj=Math.abs(envT[kj]-targetT);
      if(dj<bestD){ bestD=dj; bestK=kj; }
    }
    if(bestK>=0){
      var ptT=envT[bestK], ptDb=envDb[bestK];
      c.strokeStyle="rgba(245,166,35,0.85)"; c.lineWidth=1.2;
      c.beginPath(); c.moveTo(hoverX,0); c.lineTo(hoverX,plotH); c.stroke();
      var dbv2=Math.max(0,Math.min(1,((ptDb)-DB_MIN)/(DB_MAX-DB_MIN)));
      var py=plotH - dbv2*(plotH*0.95);
      c.fillStyle="#F5A623"; c.beginPath(); c.arc(hoverX,py,3.5,0,6.283); c.fill();
      var txt=formatFullTime(ptT)+"  "+ptDb.toFixed(1)+" dB";
      c.font=Math.max(10,Math.round(w/55))+"px monospace";
      var tw=c.measureText(txt).width;
      var tx=hoverX - tw - 10; if(tx<4) tx=4; if(tx+tw>w-4) tx=w-tw-4;
      c.fillStyle="rgba(8,12,16,0.88)"; c.fillRect(tx-4,4,tw+8,18);
      c.fillStyle="#F5A623"; c.fillText(txt,tx,17);
    }
  }
}

/* ---------- GPS ---------- */
var gpsLat=null, gpsLon=null, gpsWatchId=null;
/* 定位可靠性设计（依据本机 locationd 日志实测）：
 * - macOS 没有 GPS 硬件，定位靠 Wi-Fi 扫描 + Apple 位置库解算，一轮扫描要 30~40 秒；
 * - 问题根因：getCurrentPosition 是"一次性请求"，系统日志里订阅只存活 4~16 毫秒
 *   （register → unsubscribe → stopLocation_nl），扫描还没出结果就被撤掉，只能返回 code=2；
 *   偶尔成功的那次都是刚好命中了系统缓存的位置；
 * - 结论：必须用 watchPosition 挂**常驻订阅**，订阅在，系统才有时间把 Wi-Fi 扫描算出来；
 * - code=2 只是"这一轮还没算出来"，不代表定位服务关闭 → 不清订阅、不退化成单点轮询；
 *   只有连续 90 秒毫无结果才重建一次订阅（重建会重新触发一轮扫描）。 */
var gpsShotTimer=0, gpsRetryTimer=0, gpsFailStreak=0, gpsState="idle", gpsLastErr=null, gpsNextRetryMs=3000;
var gpsWaitStartTs=0;         // 「还没有坐标」这一轮的开始时间，用于显示已等待秒数
var GPS_STALL_MS=300000;      // 常驻订阅存活时的最长等待：macOS 的 Wi-Fi 定位扫描最小间隔就是 300 秒，
                              // 90 秒重建一次等于不停催系统扫描，会被限流得更久；放到 5 分钟再看是否真死了
var GPS_RETRY_MIN_MS=3000;    // 重建订阅的最小间隔
var GPS_RETRY_MAX_MS=30000;   // 退避上限
var GPS_DENY_RETRY_MS=300000; // 权限被拒后的重试间隔（改系统设置才会变，别频繁打扰）
var GPS_WATCH_TIMEOUT_MS=15000; // watchPosition 的单次超时：不能给 0（WebKit 会把 0 当成立即超时）

function gpsMobile(){ return (navigator.maxTouchPoints||0) > 1; }
/* 网站级定位授权状态（granted/prompt/denied）：
 * 「系统已给权限」和「本站被授权」是两件事——Safari 的站点授权在清空网站数据后会重置，
 * 此时 WebKit 根本不会向系统定位服务发请求（locationd 里看不到 Safari 客户端），
 * 页面只会收到 code=3 超时，很容易误判成系统定位坏了。所以把这一层状态显式读出来。 */
var gpsPermState="unknown", gpsPermBound=false;
function gpsQueryPermission(){
  try{
    if(!navigator.permissions || !navigator.permissions.query) return;
    navigator.permissions.query({name:"geolocation"}).then(function(st){
      if(!st) return;
      gpsPermState = st.state || "unknown";
      if(!gpsPermBound && st.addEventListener){
        gpsPermBound = true;
        st.addEventListener("change", function(){ gpsQueryPermission(); });
      }
      gpsRenderStatus();
    }).catch(function(){});
  }catch(e){}
}
/* 定位诊断上报：浏览器里读不到状态（Safari 禁了 AppleScript 注入），
 * 所以把原始错误码报给服务端落 logs/gps_diag.log，排查有据可依。fire-and-forget，不阻塞。 */
function gpsDiag(state, err){
  try{
    if(gpsDiag.sent && state==="fix") return;   // 成功只报一次，别刷屏
    if(state==="fix") gpsDiag.sent = true;
    var q = "s=" + encodeURIComponent(state)
      + "&c=" + (err && err.code != null ? err.code : -1)
      + "&m=" + encodeURIComponent((err && err.message) || "")
      + "&n=" + gpsFailStreak
      + "&p=" + encodeURIComponent(gpsPermState)
      + "&sec=" + (window.isSecureContext === false ? 0 : 1)
      + "&ua=" + encodeURIComponent((navigator.userAgent || "").slice(-50));
    fetch(apiUrl("/api/gpsdiag?" + q), { cache: "no-store" }).catch(function(){});
  }catch(e){}
}
/* 固定坐标兜底：?lat=..&lon=.. 打开一次即写入 localStorage，
 * 浏览器定位长期不可用（系统 Wi-Fi 定位算不出结果）时，地址照样可用。 */
function applyFixedGps(){
  try{
    var sp = new URLSearchParams(location.search || "");
    var qlat = parseFloat(sp.get("lat")), qlon = parseFloat(sp.get("lon"));
    if (isFinite(qlat) && isFinite(qlon) && Math.abs(qlat) <= 90 && Math.abs(qlon) <= 180){
      localStorage.setItem("qs_fixed_gps", JSON.stringify({ lat: qlat, lon: qlon }));
      gpsLat = qlat; gpsLon = qlon; gpsFixedCoords = true;
      return true;
    }
    var s = localStorage.getItem("qs_fixed_gps");
    if (s){
      var o = JSON.parse(s);
      if (o && isFinite(o.lat) && isFinite(o.lon) && Math.abs(o.lat) <= 90 && Math.abs(o.lon) <= 180){
        gpsLat = o.lat; gpsLon = o.lon; gpsFixedCoords = true;
        return true;
      }
    }
  }catch(e){}
  return false;
}
var gpsFixedCoords = false;
function gpsStatusText(){
  if(gpsLat!==null) return null;
  // Safari/Chrome 只在「安全来源」下允许定位：用 http://<局域网IP>:8088 打开时必然拿不到坐标
  if(window.isSecureContext === false)
    return "定位不可用：当前页面是 HTTP 非安全来源（Safari 会直接禁用定位/麦克风），请改用 https:// 打开";
  var c = gpsLastErr && gpsLastErr.code;
  if(gpsPermState==="denied")
    return "本站定位权限被拒绝：点地址栏左侧的「网站设置 / AA」→ 位置改为「允许」→ 刷新页面（系统权限给了不代表本站已授权）";
  if(c===1) return "定位被拒绝：系统设置 → 隐私与安全性 → 定位服务，为浏览器打开定位后，点这里重试";
  var w = gpsWaitStartTs ? Math.round((Date.now()-gpsWaitStartTs)/1000) : 0;
  if(gpsPermState==="prompt" && w>=20)
    return "浏览器还没收到本站的定位授权（已等待 "+w+" 秒）：请点地址栏左侧的「网站设置 / AA」，把「位置」设为「允许」，然后刷新页面";
  if(gpsFailStreak>=6)
    return "已等待 "+w+" 秒仍无定位（仍在自动重试）：macOS 只能靠 Wi-Fi 定位，请确认 Wi-Fi 已连接、页面保持在前台，点这里立即重试";
  if(gpsState==="locating" && w<40)
    return "正在定位…（已等待 "+w+" 秒；macOS 走 Wi-Fi 定位，通常需要 30~40 秒）";
  return "正在重新定位…（已等待 "+w+" 秒，自动重试中，点这里立即重试）";
}
function gpsRenderStatus(){
  var el=$("logLocText"); if(!el) return;
  var t=gpsStatusText(); if(t!==null) el.textContent=t;
}
function gpsStopAll(){
  if(gpsShotTimer){ clearTimeout(gpsShotTimer); gpsShotTimer=0; }
  if(gpsWatchId!==null){ try{ navigator.geolocation.clearWatch(gpsWatchId); }catch(e){} gpsWatchId=null; }
}
function gpsClearRetry(){ if(gpsRetryTimer){ clearTimeout(gpsRetryTimer); gpsRetryTimer=0; } }
function gpsOnFix(pos){
  var lat=pos.coords.latitude, lon=pos.coords.longitude;
  var moved = gpsLat!==null && gpsDistanceM(lat,lon,gpsLat,gpsLon) > 20;
  gpsLat=lat; gpsLon=lon;
  var had = gpsState==="ok";
  gpsState="ok"; gpsLastErr=null; gpsFailStreak=0; gpsNextRetryMs=GPS_RETRY_MIN_MS;
  gpsWaitStartTs=0; gpsCacheTs=0;
  saveLastFix();
  if(gpsShotTimer){ clearTimeout(gpsShotTimer); gpsShotTimer=0; }
  gpsClearRetry();
  renderGpsLoc(currentAddress || "");
  refreshGpsAddress();                 // 拿到坐标立刻解析地址，不必等 1 秒轮询
  if(moved && had) lastAddrLat=null;   // 明显移动了：下次解析不走「200m 内复用」捷径
  gpsStartWatch();                     // 有了坐标再挂持续更新（它的报错不再影响显示）
  gpsDiag("fix", null);
}
/* 常驻订阅：首次定位也走 watchPosition（不等到有坐标才挂）。
 * timeout 必须给正数：WebKit（Safari / iOS Safari）把 0 解释成"立即超时"，
 * 请求发出后马上以 code=3 失败（Chrome 则把 0 当"不超时"，所以只有 Chrome 正常）。
 * 15 秒只影响错误回调时机，订阅本身不会因超时被撤销，桌面端仍能等到 Wi-Fi 解算结果。
 * maximumAge=300000 让系统缓存的位置能立刻返回（冷启动时靠它秒出结果）。 */
function gpsStartWatch(){
  if(gpsWatchId!==null || !navigator.geolocation) return;
  // 桌面（macOS 无 GPS 硬件）低精度即 Wi-Fi 定位；移动端才要高精度
  var high = gpsMobile() && gpsFailStreak===0 && gpsLat===null;
  try{
    gpsWatchId = navigator.geolocation.watchPosition(gpsOnFix, gpsOnWatchError,
      { enableHighAccuracy:high, maximumAge:300000, timeout:GPS_WATCH_TIMEOUT_MS });
  }catch(e){ gpsWatchId=null; }
  gpsArmStallTimer();
}
/* 看门狗：订阅还在但一直没有结果（Safari 常见"既不成功也不报错"）→ 90 秒后重建订阅。
 * 90 秒 ≫ 一轮 Wi-Fi 扫描（30~40 秒），所以重建不会把正在进行的扫描打断。 */
function gpsArmStallTimer(){
  if(gpsShotTimer || gpsLat!==null) return;
  gpsShotTimer = setTimeout(function(){
    gpsShotTimer=0;
    if(gpsLat!==null) return;
    gpsRecreateWatch("stall");
  }, GPS_STALL_MS);
}
/* 重建订阅（会重新触发一轮 Wi-Fi 扫描）：只在"90 秒仍无结果"或权限被拒后调用。
 * 一次 code=2 绝不撤订阅，否则又回到订阅只活十几毫秒、永远等不到解算结果的老问题。 */
function gpsRecreateWatch(reason){
  if(gpsLat!==null) return;
  gpsStopAll();
  gpsFailStreak++;
  gpsState="retrying"; gpsRenderStatus();
  gpsDiag("err", { code:3, message:"无定位结果（"+(reason||"retry")+"）" });
  gpsStartWatch();
}
function gpsScheduleRetry(ms){
  if(gpsRetryTimer || gpsLat!==null) return;
  gpsRetryTimer = setTimeout(function(){ gpsRetryTimer=0; if(gpsLat===null) gpsRecreateWatch("retry"); }, ms);
}
function gpsOnWatchError(err){
  gpsLastErr={ code:(err&&err.code)||2, message:err&&err.message };
  console.warn("GPS失败 code=", gpsLastErr.code, gpsLastErr.message);
  // 把站点授权状态一起带上：日志里一眼能区分"站点没授权"和"系统/WebKit 不给位置"
  gpsDiag("err", { code:gpsLastErr.code, message:(gpsLastErr.message||"") + " [perm=" + gpsPermState + "/loc=" + gpsState + "]" });
  if(gpsLat!==null) return;            // 已有坐标：这次没更新上，无所谓的
  if(gpsLastErr.code===1){
    gpsState="denied"; gpsRenderStatus();
    gpsScheduleRetry(GPS_DENY_RETRY_MS);
    return;
  }
  // code=2/3：只是这一轮没算出结果。订阅原样保留，交给 90 秒看门狗决定是否重建
  gpsFailStreak++;
  gpsState="retrying"; gpsRenderStatus();
}
function startGps(force){
  if(!navigator.geolocation){ gpsLastErr={code:2,message:"浏览器不支持定位"}; gpsState="failed"; gpsRenderStatus(); return; }
  gpsQueryPermission();
  if(force){ gpsStopAll(); gpsClearRetry(); gpsFailStreak=0; gpsLastErr=null; gpsWaitStartTs=Date.now(); }
  // 已有坐标、但订阅掉了（切后台/休眠后常见）：直接重建订阅，别重置已有位置
  if(gpsLat!==null){ gpsStartWatch(); return; }
  gpsState="locating"; gpsRenderStatus();
  if(!gpsWaitStartTs) gpsWaitStartTs=Date.now();
  gpsStartWatch();
}
function stopGps(){ gpsStopAll(); gpsClearRetry(); }

/* ---------- 经纬度 → 地址（后端高德逆地理编码，带浏览器缓存） ---------- */
// 缓存版本号：后端坐标转换算法变更时递增此值，旧缓存自动失效
var ADDR_CACHE_VERSION="v3";
var addrCache={};          // { "lat,lon": address }
var addrCacheLoaded=false;
var currentAddress="";     // 当前解析到的地址（供日志抬头和记录使用）
var lastAddrLat=null, lastAddrLon=null; // 最近一次成功解析地址的坐标
function loadAddrCache(){
  if(addrCacheLoaded) return;
  addrCacheLoaded=true;
  try{
    var ver=localStorage.getItem("qs_addr_cache_ver");
    // 版本不匹配则丢弃旧缓存（修复坐标偏移等问题后需更新版本号）
    if(ver!==ADDR_CACHE_VERSION){
      localStorage.removeItem("qs_addr_cache");
      localStorage.setItem("qs_addr_cache_ver", ADDR_CACHE_VERSION);
      addrCache={};
      return;
    }
    var raw=localStorage.getItem("qs_addr_cache");
    if(raw) addrCache=JSON.parse(raw)||{};
  }catch(e){ addrCache={}; }
}
function saveAddrCache(){
  try{ localStorage.setItem("qs_addr_cache", JSON.stringify(addrCache)); }catch(e){}
}
/* 经纬度保留 3 位小数做缓存键（约 100m），同一地点（含 GPS 抖动）复用同一地址 */
function addrCacheKey(lat,lon){ return lat.toFixed(3)+","+lon.toFixed(3); }
async function resolveAddress(lat,lon){
  if(lat==null||lon==null) return "";
  loadAddrCache();
  var key=addrCacheKey(lat,lon);
  if(addrCache[key]) return addrCache[key];
  try{
    var resp=await fetch(apiUrl("/api/regeo?lat="+lat+"&lon="+lon));
    var data=await resp.json();
    if(data.ok && data.address){
      addrCache[key]=data.address;
      saveAddrCache();
      return data.address;
    }
  }catch(e){
    console.warn("地址解析失败，稍后自动重试",e);
  }
  return "";   // 失败不落缓存：定时器会持续重试，直到拿到地址
}

/* ---------- 指纹 + 「上次定位」缓存 ----------
 * 同一浏览器、同一网络（服务端看到的客户端 IP 相同）视为同一场景：
 * 刷新页面先用上次的坐标/地址直接显示，再后台校准覆盖，
 * 避免每次刷新都去催系统定位（macOS 的 Wi-Fi 定位扫描有 5 分钟限流）。
 */
var gpsFp="", gpsCacheTs=0;
function gpsFpCalc(client){
  var tz="";
  try{ tz=Intl.DateTimeFormat().resolvedOptions().timeZone||""; }catch(e){}
  var raw=[navigator.userAgent||"", navigator.platform||"",
    screen.width+"x"+screen.height, screen.colorDepth, tz,
    navigator.language||"", navigator.hardwareConcurrency||0, client||""].join("|");
  var h=5381;
  for(var i=0;i<raw.length;i++){ h=((h<<5)+h+raw.charCodeAt(i))|0; }
  return (h>>>0).toString(16);
}
function saveLastFix(){
  if(gpsLat===null||gpsLon===null) return;
  try{
    localStorage.setItem("qs_last_fix", JSON.stringify({
      fp:gpsFp||"", lat:gpsLat, lon:gpsLon, addr:currentAddress||"", ts:Date.now()
    }));
  }catch(e){}
}
function restoreLastFix(){
  try{
    var o=JSON.parse(localStorage.getItem("qs_last_fix")||"null");
    if(!o || !isFinite(o.lat) || !isFinite(o.lon)) return false;
    if(gpsFp && o.fp && o.fp!==gpsFp) return false;   // 换了浏览器/网络：不复用，重新定位
    gpsLat=o.lat; gpsLon=o.lon; gpsCacheTs=o.ts||0; gpsState="cached";
    if(o.addr){ currentAddress=o.addr; lastAddrLat=o.lat; lastAddrLon=o.lon; }
    return true;
  }catch(e){ return false; }
}
function ageText(ts){
  var m=Math.round((Date.now()-ts)/60000);
  return m<1 ? "刚刚" : (m+" 分钟前");
}

/* 两点间距离（米）：用于判断是否还在同一地点 */
function gpsDistanceM(lat1,lon1,lat2,lon2){
  var R=6371000, rad=Math.PI/180;
  var dLat=(lat2-lat1)*rad, dLon=(lon2-lon1)*rad;
  var a=Math.sin(dLat/2)*Math.sin(dLat/2)
      +Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin(dLon/2)*Math.sin(dLon/2);
  return 2*R*Math.asin(Math.sqrt(a));
}
function renderGpsLoc(addr){
  var logLoc=$("logLocText");
  if(!logLoc) return;
  // 坐标可能暂时为空（定位被重置/异步解析返回时已无坐标）：只显示地址，别抛 toFixed of null
  if(gpsLat==null || gpsLon==null){ if(addr) logLoc.textContent=addr; return; }
  var tail = gpsFixedCoords ? "　〔固定坐标〕" : "";
  if(!tail && gpsState==="cached" && gpsCacheTs) tail = "　〔上次定位 "+ageText(gpsCacheTs)+"，后台校准中〕";
  logLoc.textContent = (addr
    ? (addr+"（"+gpsLat.toFixed(5)+", "+gpsLon.toFixed(5)+"）")
    : (gpsLat.toFixed(5)+", "+gpsLon.toFixed(5))) + tail;
}

/* ---------- GPS 地址解析：结果渲染到日志区上方的位置抬头 ---------- */
var gpsAddrTimer=null, addrFailStreak=0, addrLoading=false;
async function refreshGpsAddress(){
  if(gpsLat==null||gpsLon==null) return;
  // 同一地点（位移 <200m）且已有地址：直接复用，不做重复逆地理编码
  if(currentAddress && lastAddrLat!==null &&
     gpsDistanceM(gpsLat,gpsLon,lastAddrLat,lastAddrLon)<200){
    renderGpsLoc(currentAddress);
    return;
  }
  // 已有一轮解析在飞就不再发起：watchPosition 每次回调都会调到这里，
  // 并发发起会让同一地点被转换好几次（公网访问时尤其明显）
  if(addrLoading) return;
  addrLoading=true;
  var lat0=gpsLat, lon0=gpsLon;
  try{
  var addr=await resolveAddress(lat0,lon0);
  if(gpsLat==null||gpsLon==null) return;     // await 期间坐标被重置：直接放弃这次渲染
  if(addr){
    addrFailStreak=0;
    currentAddress=addr;
    lastAddrLat=lat0; lastAddrLon=lon0;
    renderGpsLoc(addr);
    saveLastFix();                 // 地址也一起存，下次刷新可秒显
    return;
  }
  // 解析失败：继续由定时器重试；若已离上次解析点较远，先只显示坐标，避免显示旧地址
  var far=lastAddrLat!==null && gpsDistanceM(gpsLat,gpsLon,lastAddrLat,lastAddrLon)>=200;
  renderGpsLoc(far ? "" : currentAddress);
  // 连续失败就把"有坐标、但地址没解析出来"这件事写清楚，
  // 免得和"根本没拿到坐标"混在一起（两者排查方向完全不同）
  addrFailStreak++;
  if(addrFailStreak>=3){
    var el=$("logLocText");
    if(el) el.textContent = gpsLat.toFixed(5)+", "+gpsLon.toFixed(5)
      + "（已取得坐标，地址解析失败，自动重试中）";
  }
  }finally{ addrLoading=false; }
}
function updateGpsDisplay(){
  // GPS 定位成功后启动地址解析定时器（结果显示在日志区上方，失败会自动重试直到成功）
  if(gpsLat!==null && gpsLon!==null && !gpsAddrTimer){
    gpsAddrTimer=setInterval(refreshGpsAddress,10000);
    refreshGpsAddress();
  } else if(gpsLat===null){
    gpsRenderStatus();   // 还没定位：持续显示「定位中 / 被拒 / 超时」的真实状态，不假装在工作
  }
}

/* —— 常驻初始化：首次用户交互即启动 GPS（音视频等点「开始监测」才开启）—— */
var alwaysOnInited=false;
function initAlwaysOn(){
  if(alwaysOnInited) return;
  alwaysOnInited=true;
  // 仅启动 GPS（定位不属于音视频，页面加载即可定位）
  // 麦克风/摄像头不在此开启，等用户点「开始监测」后才开启
  // 固定坐标兜底优先：浏览器定位长期不可用时，地址/取证标记照样要能用
  if(!applyFixedGps()) startGps();
  else updateGpsDisplay();
  gpsQueryPermission();          // 站点级授权状态：denied/prompt 时状态栏会直接指出来
  // 内网直连探测 + 指纹：先拿上次的定位结果垫上，真实定位在后台继续跑
  startNetInfo();
  withNetInfo(function(info){
    gpsFp = gpsFpCalc(info && info.client);
    if(!gpsFixedCoords && gpsLat===null && restoreLastFix()){
      renderGpsLoc(currentAddress||"");
      if(!gpsAddrTimer) gpsAddrTimer=setInterval(refreshGpsAddress,10000);
    }
  });
  setInterval(updateGpsDisplay, 1000);
  updateGpsDisplay();
}

/* ---------- 屏幕常亮 ---------- */
var wakeLockTimer=null, _wakeLockVisBound=false;
async function acquireWakeLock(){
  if(!("wakeLock" in navigator)){
    toast("⚠️当前浏览器不支持网页常亮，请在手机系统设置把自动锁屏设为「永不」或「充电时常亮」");
    return;
  }
  try{
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    if(wakeLockTimer) clearInterval(wakeLockTimer);
    // 浏览器节能可能自动释放 Wake Lock，每 60 秒重新获取一次，保证长时间运行不掉屏
    wakeLockTimer = setInterval(function(){
      if(document.visibilityState === 'visible'){
        navigator.wakeLock.request('screen').then(function(s){
          try{ if(wakeLockSentinel && wakeLockSentinel.release) wakeLockSentinel.release(); }catch(e){}
          wakeLockSentinel = s;
        }).catch(function(){});
      }
    }, 60000);
    // visibilitychange 只绑一次；旧实现每次「开始监测」都新增一个监听器，
    // 反复启停后同一事件会触发 N 次请求，WakeLock 句柄越积越多
    if(!_wakeLockVisBound){
      _wakeLockVisBound = true;
      document.addEventListener('visibilitychange', function(){
        if(document.visibilityState === 'visible' && running){
          navigator.wakeLock.request('screen').then(function(s){
            try{ if(wakeLockSentinel && wakeLockSentinel.release) wakeLockSentinel.release(); }catch(e){}
            wakeLockSentinel = s;
          }).catch(function(){});
        }
      });
    }
  }catch(err){
    toast("⚠️无法获取屏幕常亮："+err.message+"，请在系统设置把自动锁屏设为「永不」或「充电时常亮」");
    wakeLockSentinel=null;
  }
}
function releaseWakeLock(){
  if(wakeLockTimer){ clearInterval(wakeLockTimer); wakeLockTimer=null; }
  if(wakeLockSentinel && wakeLockSentinel.release){
    try{ wakeLockSentinel.release(); }catch(e){}
  }
  wakeLockSentinel=null;
}

/* ================= 前置摄像头录像：独立可播分片 + 实时上传 ================= */
var videoRecorder=null;
var videoChunks=[];
var segTimer=null;
var sessionTag="未命名", sessionStartTs=0, sessionStartStr="";
var segIndex=0, segUploaded=0, recording=false, sessionPeakDb=0;
var SEGMENT_MS = 30000; // 每 30 秒产出一个【完整独立可播】分片，实时上传，断网最多丢一段

function pickVideoMime(){
  var c=["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"];
  for(var m of c){ if(window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; }
  return "";
}

// 开启一段独立录制：stop() 产出一段完整可播 webm；若仍在录制则续开下一段
function beginSegment(stream){
  var mime = pickVideoMime();
  videoChunks = [];
  videoRecorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
  videoRecorder.ondataavailable = function(e){ if(e.data && e.data.size>0) videoChunks.push(e.data); };
  videoRecorder.onerror = function(e){ toast("录像错误："+((e.error&&e.error.message)||e.message||"")); };
  videoRecorder.onstop = async function(){
    if(videoChunks.length){
      var blob = new Blob(videoChunks, {type: videoRecorder.mimeType || mime});
      var i = segIndex++;
      await uploadSegment(blob, i);   // 等待本段上传完再续/收尾，保证数据完整
    }
    if(recording){ beginSegment(stream); }
    else { await doFinalize(); }       // 停止后：最后一段上传完才写元数据
  };
  videoRecorder.start();  // 不用时间片；stop() 产出完整独立文件
}

async function uploadSegment(blob, i){
  var segStartMs = sessionStartTs + i*SEGMENT_MS;
  var segEndMs = segStartMs + SEGMENT_MS;
  var segStartStr = formatToFile(segStartMs);
  var segEndStr = formatToFile(segEndMs);
  // 上传加超时：旧实现只有一个裸 fetch，服务端/网络一旦挂住，
  // onstop 里的 await 永不返回 → 录像链就此中断（界面仍显示"录制中"但不产新段）
  var ctrl = ("AbortController" in window) ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function(){ try{ ctrl.abort(); }catch(e){} }, 30000) : null;
  try{
    var qs = apiUrl("/api/video/upload?deviceId="+encodeURIComponent(deviceId||"unknown")
      + "&tag="+encodeURIComponent(sessionTag)
      + "&start="+encodeURIComponent(sessionStartStr)
      + "&segStart="+encodeURIComponent(segStartStr)
      + "&segEnd="+encodeURIComponent(segEndStr)
      + "&segIndex="+i);
    var resp = await fetch(qs,{ method:"POST", headers:{"Content-Type":"application/octet-stream"},
                                body:blob, signal: ctrl ? ctrl.signal : undefined });
    if(!resp.ok) throw new Error("HTTP "+resp.status);
    segUploaded++;
  }catch(err){
    console.warn("分片上传失败", err);
    toast("⚠️分片上传失败，将丢该段");
  }finally{
    if(timer) clearTimeout(timer);
  }
  updateVideoStat();
}

async function doFinalize(){
  var endMs = Date.now();
  try{ // 写会话元数据（结束时间为年月日时分秒），后端据此合并 10 分钟 MP4
    await fetch(apiUrl("/api/video/finalize"),{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({deviceId:deviceId||"unknown", tag:sessionTag,
        start:sessionStartStr, end:formatToFile(endMs),
        startTs:sessionStartTs, endTs:endMs, segCount:segIndex,
        durationSec:((endMs-sessionStartTs)/1000).toFixed(1), peakDb:sessionPeakDb.toFixed(1)})});
  }catch(e){ console.warn("finalize失败",e); }
  updateVideoStat();
  toast("已停止录像，共上传 "+segUploaded+" 段");
}

async function startRecording(){
  if(!window.MediaRecorder){ toast("此设备浏览器不支持录像/样本录音（需 Safari iOS 14.5+），仅进行噪声监测"); return; }
  if(recording) return;
  try{
    if(!deviceId) deviceId = await getDeviceFingerprint();
    var stream = await ensureStream();
    sessionTag = getTag();                  // 界面标签（客厅/卧室…）
    sessionStartTs = Date.now();
    sessionStartStr = formatToFile(sessionStartTs);
    segIndex=0; segUploaded=0; sessionPeakDb=0;
    recording = true;
    beginSegment(stream);
    segTimer = setInterval(function(){     // 到点 roll 一段（stop→上传→续开）
      if(recording && videoRecorder && videoRecorder.state === "recording"){
        videoRecorder.stop();
      }
    }, SEGMENT_MS);
    $("sessionId").textContent="会话：["+sessionTag+"] 开始 "+sessionStartStr+" · 指纹："+deviceId.slice(0,12);
    updateVideoStat();
    toast("录像已开启（标签:"+sessionTag+"），每 "+SEGMENT_MS/1000+" 秒一段独立可播分片实时上传");
  }catch(err){ toast("录像启动失败："+(err&&err.message)); }
}
async function stopRecording(){
  if(!recording || !videoRecorder) return;
  recording = false;
  if(segTimer){ clearInterval(segTimer); segTimer=null; }
  try{
    if(videoRecorder.state !== "inactive") videoRecorder.stop();
    else doFinalize();   // 极少情况下上一段刚结束、尚未开新段，直接收尾
  }catch(e){ doFinalize(); }
  updateVideoStat();
}
function updateVideoStat(){
  var d = recording ? ((Date.now()-sessionStartTs)/1000).toFixed(0) : "0";
  $("videoStat").textContent=(recording?"录制中 ":"未录制 ")+segUploaded+" 段 · "+d+"s";
}

// 拆掉整条音频分析链（只碰音频，不动媒体流）
function resetAudioAnalysis(){
  if(audioCtx){ try{ audioCtx.close(); }catch(e){} }
  audioCtx=null; analyser=null; micData=null;
  // 一并解引用样本录音链节点：否则旧 AudioContext 的节点仍被全局引用，
  // 再次启动时若建图失败，sampleDest 会指向一条已关闭的 destination
  sampleSrc=null; sampleGain=null; sampleHp=null; sampleComp=null; sampleDest=null;
  try{ if(peakWorklet && peakWorklet.disconnect) peakWorklet.disconnect(); }catch(e){}
  try{ if(peakProc && peakProc.disconnect) peakProc.disconnect(); }catch(e){}
  peakWorklet=null; peakWorkletSink=null; peakProc=null; peakMeterTried=false; fastPeakDb=0;
}

// 停止监测：释放摄像头/麦克风轨道，preview 停止出画面
function releaseStream(){
  if(combinedStream){
    combinedStream.getTracks().forEach(function(t){ try{ t.stop(); }catch(e){} });
    combinedStream = null;
  }
  var pv=$("preview");
  if(pv) pv.srcObject = null;
  soundLive = false;
  $("dSound").className = "dot";
  var st=$("sSound"); if(st){ st.textContent="已停止"; st.className="gstate"; }
  resetAudioAnalysis();
  gGauge.f=0; gGauge.c="#22D3EE"; gGauge.t="--";
  try{ drawArc($("gSound"),0,"#22D3EE","--"); }catch(e){}
}

/* ---------- 主控制：噪声监测 + 视频录制（点「开始监测」同时启动两者） ---------- */
var startPending=false, stopPending=false;
async function startMonitor(){
  if(running || startPending) return;
  startPending=true;
  autoMarkDay();    // 手动或自动，只要今天启动过就记下来：避免 11:00–13:00 的兜底检查把手动停掉的采集又拉起来
  initAlwaysOn();   // 确保 GPS 已启动（麦克风/摄像头由下方 ensureStream 在点击后开启）
  acquireWakeLock(); resetOverSession();
  noiseFloorDb=30; noiseFloorSamples=0; noiseFloorSum=0; calArr=[]; postSessionCooldownTs=0;
  fallTs=null; trigPendingTs=0; trigPendingPeak=0;
  var _hc=new Date().getHours(); noiseFloorCalSec = (_hc>=1 && _hc<6) ? 10 : 2;  // 凌晨 1-6 点 10s 校准，白天快速 2s
  try{
    await ensureStream();
    if(stopPending){ stopPending=false; startPending=false; toast("已取消启动"); return; }
    running=true;
    var wantVideo = !($("videoOpt") && !$("videoOpt").checked);   // 默认勾选=录视频
    $("btnStart").textContent = wantVideo ? "监测+录像中 · 停止" : "监测中 · 停止";
    $("btnStart").className="btn red";
    if(audioCtx) audioCtx.resume();
    if(wantVideo) await startRecording(); // 默认录视频；去勾选则跳过视频录制
    startRingRecording();                 // 启动样本录音缓存，噪声样本含触发前一段
    liveLoop();
  }catch(err){ toast("启动失败："+((err&&err.message)||"请检查 HTTPS 与权限")); }
  startPending=false;
}
async function stopMonitor(){
  if(startPending){ stopPending=true; return; }   // 启动中：标记取消，等启动流程自行退出
  running=false;
  $("btnStart").textContent="开始监测";
  $("btnStart").className="btn primary";
  if(recording) await stopRecording();            // 录像随监测一并停止
  else if(videoRecorder && videoRecorder.state==="recording") videoRecorder.stop();
  await closeAndSaveSession();
  stopRingRecording();                             // 停止滑块缓存录音
  releaseWakeLock();                                // 释放屏幕常亮，监测停止后可正常休眠
  releaseStream();                                  // 停止监测即释放麦克风/摄像头，回到未开启音视频的状态
  // 注意：不调用 stopGps()，GPS 持续运行，经纬度在停止监测后仍持续显示
}

/* ---------- 日志渲染 ---------- */
/* 播放函数 _loadAudioBuffer/playRawAudio/playClearAudio/playBoostAudio 已抽到
 * js/player.js（顶层全局函数，index.html 先于本文件加载）。本文件的行内 onclick
 * 直接调用全局函数；exportHtmlReport 用它们的 toString() 自包含嵌入导出报告。 */

/* 表格最多渲染多少行：每条有录音的记录都会实例化一个 <audio>，
 * Safari 的媒体元素很重，300 行整表重绘会造成明显的卡顿与内存占用。 */
var LOG_MAX_RENDER = 120;
/* 批量删除的选中集合：{ "时间戳": true }。只放内存，刷新即清空——
 * 避免"上次选中没删干净、下次进来又删一批"这种误删。 */
var logSel = {};
function logSelCount(){ return Object.keys(logSel).length; }
function updateDelSelUI(){
  var n = logSelCount();
  var btn = $("btnDelSel");
  if(btn){
    btn.textContent = "删除选中 (" + n + ")";
    btn.disabled = n === 0;
  }
  var all = $("logChkAll");
  if(all){
    var b = $("logBody");
    var rows = b ? b.querySelectorAll("tr[data-ts]") : [];
    var total = rows.length, on = 0;
    for(var i=0;i<rows.length;i++){ if(rows[i].querySelector(".row-chk") && rows[i].querySelector(".row-chk").checked) on++; }
    all.checked = total > 0 && on === total;
    all.indeterminate = on > 0 && on < total;
  }
}
function setAllRowsSelected(on){
  var b = $("logBody");
  if(!b) return;
  var rows = b.querySelectorAll("tr[data-ts]");
  for(var i=0;i<rows.length;i++){
    var tr = rows[i], chk = tr.querySelector(".row-chk"), ts = tr.getAttribute("data-ts");
    if(!chk) continue;
    chk.checked = on;
    if(on) logSel[ts] = true; else delete logSel[ts];
  }
  updateDelSelUI();
}

function buildLogRow(r){
  var tr=document.createElement("tr");
  tr.className="alarm";
  if(r && r.timeTs!=null) tr.setAttribute("data-ts", String(r.timeTs));
  // 地址 + 经纬度作为悬停提示（行内不再单列经纬度）
  var locTip = r.address ? (r.address+"（"+r.lat+", "+r.lon+"）") : ((r.lat!=null?r.lat:"--")+", "+(r.lon!=null?r.lon:"--"));
  tr.innerHTML=
    '<td class="chk-cell"><input type="checkbox" class="row-chk" aria-label="选择这条日志"></td>'+
    '<td title="📍 '+locTip.replace(/"/g,'&quot;')+'">'+(r.timeText||"--")+'</td>'+
    '<td>'+(r.tag||"--")+'</td>'+
    '<td>'+(r.durationSec||"N/A")+'s</td>'+
    '<td>'+r.peakDb+'</td>'+
    '<td class="au"></td>'+
    '<td><button type="button" class="au-btn del-btn">删除</button></td>';
  // 音频直接引用服务器 audio 目录的 URL（不读 IndexedDB / base64），点按钮才 fetch 播放
  tr.querySelector(".au").innerHTML = auCellHtml(r);
  var btn = tr.querySelector(".del-btn");
  if(btn) btn.addEventListener("click", function(){ delLog(r.timeTs); });
  var chk = tr.querySelector(".row-chk");
  if(chk){
    chk.checked = !!logSel[String(r.timeTs)];
    chk.addEventListener("change", function(){
      if(chk.checked) logSel[String(r.timeTs)] = true;
      else delete logSel[String(r.timeTs)];
      updateDelSelUI();
    });
  }
  return tr;
}

function renderLog(){
  $("logCnt").textContent=logArr.length+" 条";
  var b=$("logBody");
  b.innerHTML="";
  if(!logArr.length){ b.innerHTML='<tr><td colspan="6" class="empty">尚无记录。</td></tr>'; return; }
  var frag=document.createDocumentFragment();
  var n=Math.min(logArr.length, LOG_MAX_RENDER);
  for(var i=0;i<n;i++) frag.appendChild(buildLogRow(logArr[i]));
  if(logArr.length>n){
    var foot=document.createElement("tr");
    foot.innerHTML='<td colspan="6" class="empty">仅显示最近 '+n+' 条（共 '+logArr.length+
      ' 条，导出 HTML 报告含全部记录）</td>';
    frag.appendChild(foot);
  }
  b.appendChild(frag);
  updateDelSelUI();
}

/* 新增一条：只插入首行，不整表重绘（旧实现每条都要重建 300 行 + 300 个 <audio>） */
function prependLogRow(rec){
  var b=$("logBody");
  if(!b) return;
  var first=b.firstChild;
  // 清掉"尚无记录"占位行
  if(first && first.classList && first.classList.contains("empty")) b.innerHTML="";
  b.insertBefore(buildLogRow(rec), b.firstChild);
  $("logCnt").textContent=logArr.length+" 条";
  while(b.children.length > LOG_MAX_RENDER){ b.removeChild(b.lastChild); }
}

/* 上传完成后就地更新该行的录音单元格（避免重绘整表） */
function updateLogRowAudio(rec){
  var b=$("logBody");
  if(!b || !rec || rec.timeTs==null) return;
  var tr=b.querySelector('tr[data-ts="'+String(rec.timeTs)+'"]');
  if(!tr) return;
  var cell=tr.querySelector(".au");
  if(cell) cell.innerHTML=auCellHtml(rec);
}

function removeLogRow(ts){
  var b=$("logBody");
  if(!b) return;
  var tr=b.querySelector('tr[data-ts="'+String(ts)+'"]');
  if(tr && tr.parentNode) tr.parentNode.removeChild(tr);
  $("logCnt").textContent=logArr.length+" 条";
  if(!logArr.length) renderLog();
}
// 依据记录的音频状态渲染录音列：有 URL → 原生播放 + 三种模式；否则显示上传中/失败/无
function auCellHtml(r){
  if(r && r.audio && /^(\/|https?:)/.test(r.audio)){
    var u=r.audio, esc=u.replace(/"/g,'&quot;'), js=u.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    var dur = String(r.durationSec||"").replace(/[^0-9.]/g, "");
    return '<audio controls preload="none" data-dur="'+dur+'" src="'+esc+'"></audio>'+
      '<br><button type="button" class="au-btn au-ico" title="原始播放" onclick="playRawAudio(\''+js+'\',\''+dur+'\')">▶</button>'+
      '<button type="button" class="au-btn au-ico" title="5倍音量播放" onclick="playBoostAudio(\''+js+'\',\''+dur+'\')">🔊</button>'+
      '<button type="button" class="au-btn au-ico" title="降噪清晰播放" onclick="playClearAudio(\''+js+'\',\''+dur+'\')">✨</button>';
  }
  if(r && r._uploadErr) return '<span style="color:#c00;font-size:11px">上传失败</span>';
  if(r && r._noAudio) return '<span class="muted" title="检测到事件，但当时没有可用样本">无样本</span>';
  if(r && r.audio === "") return '<span class="muted">上传中…</span>';
  return '<span class="muted">—</span>';
}

/* 批量删除：一次请求删掉全部选中项，后端同步删记录、音频文件与旧版 HTML 里的行 */
async function delLogSelected(){
  var tsArr = Object.keys(logSel);
  if(!tsArr.length){ toast("先勾选要删除的日志"); return; }
  var n = tsArr.length;
  if(!confirm("确定删除选中的 "+n+" 条日志？\n后端对应记录与录音文件也会一起删除，不可恢复。")) return;
  var btn = $("btnDelSel");
  if(btn){ btn.disabled = true; btn.textContent = "删除中…"; }
  var okResp = false, respCount = 0;
  try{
    var r = await fetch(apiUrl("/api/log/del"), {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ timeTsList: tsArr })
    });
    var j = await r.json();
    okResp = !!(j && j.ok);
    respCount = (j && j.count) || 0;
  }catch(e){
    console.warn("批量删除后端日志失败", e);
  }
  // 前端同步移除（后端失败也移除，避免界面与已删文件长期不一致；失败会有 toast 提示）
  var del = {};
  tsArr.forEach(function(t){ del[String(t)] = true; });
  logArr = logArr.filter(function(x){ return !del[String(x.timeTs)]; });
  logSel = {};
  saveLog(); renderLog(); updateDelSelUI();
  if(okResp) toast("已删除 "+n+" 条（后端清理 "+respCount+" 项）");
  else toast("已从界面移除 "+n+" 条，但后端删除请求失败，请检查服务端");
}

async function delLog(ts){
  if(ts==null) return;
  if(!confirm("确定删除这条日志？后端对应记录也会删除。")) return;
  try{ await fetch(apiUrl("/api/log/del"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({timeTs:String(ts)})}); }
  catch(e){ console.warn("删除后端日志失败", e); }
  logArr = logArr.filter(function(x){ return x.timeTs !== ts; });
  saveLog(); removeLogRow(ts);
  toast("已删除该条日志");
}

async function exportHtmlReport(){
  if(!logArr.length){ toast("暂无日志可导出"); return; }
  // 音频直接引用服务器 audio 目录（不内嵌 base64），报告体积小、不占浏览器内存
  var reportTitle="传感器噪声监测报告 "+new Date().toLocaleString();
  var rows="";
  for(var i=0;i<logArr.length;i++){
    var rec=logArr[i];
    var au = (rec.audio && /^(\/|https?:)/.test(rec.audio)) ? rec.audio : "";
    if(au && au.charAt(0)==="/") au = (location.origin||"") + au;   // 导出文件可能在别处打开，补全绝对地址
    var audioHtml = au
      ? `<audio controls preload="none" style="height:28px;max-width:240px;" src="${au}">不支持播放</audio><br><button class="au-ico" title="5倍音量播放" onclick="playBoostAudio('${au}','${r.dur||""}')">🔊</button><button class="au-ico" title="降噪清晰播放" onclick="playClearAudio('${au}','${r.dur||""}')">✨</button>`
      : '<span style="color:#888">无录音片段</span>';
    var locTip = rec.address ? (rec.address+"（"+rec.lat+", "+rec.lon+"）") : ((rec.lat!=null?rec.lat:"--")+", "+(rec.lon!=null?rec.lon:"--"));
    rows += `<tr style="border-bottom:#ccc 1px solid;">
  <td style="padding:6px 8px" title="📍 ${locTip.replace(/"/g,'&quot;')}">${rec.timeText}</td>
  <td style="padding:6px 8px">${rec.tag||"--"}</td>
  <td style="padding:6px 8px">${rec.durationSec||"N/A"} s</td>
  <td style="padding:6px 8px">${rec.peakDb} dB</td>
  <td style="padding:6px 8px">${audioHtml}</td>
</tr>
`;
  }
  var htmlOut=`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${reportTitle}</title>
<style>body{font-family:system-ui,monospace;padding:16px;background:#f8f8f8;color:#111;}
h2{margin-bottom:12px;}table{border-collapse:collapse;width:100%;font-size:12px;}
th{background:#222;color:#fff;padding:8px;text-align:left;}td{background:#fff;}img{max-width:100%;}
tbody tr:nth-child(even) td{background:#fffacd;}tbody tr:hover td{background:#ffe97a!important;}
audio{vertical-align:middle;}button{padding:3px 6px;font-size:11px;cursor:pointer;}
.au-ico{padding:1px 5px;font-size:13px;line-height:1.4;margin-right:3px;}
</style>
<script>
var _decodeAudio = ${_decodeAudio.toString()};
var _nativeFallback = ${_nativeFallback.toString()};
var _loadAudioBuffer = ${_loadAudioBuffer.toString()};
var playRawAudio = ${playRawAudio.toString()};
var playClearAudio = ${playClearAudio.toString()};
var playBoostAudio = ${playBoostAudio.toString()};
</script>
</head><body><h2>${reportTitle}</h2>
<p>当前阈值：&gt;${thr} dB；最小记录时长：${MIN_RECORD_SEC}s；录像分片见后台 /review.html</p>
<p style="background:#eef;padding:6px 10px;border-radius:4px;font-size:13px;">📍 位置：${currentAddress||"--"}（${gpsLat!=null?gpsLat.toFixed(5):"--"}, ${gpsLon!=null?gpsLon.toFixed(5):"--"}）</p>
<table><thead><tr><th>触发时间</th><th>标签</th><th>持续秒数</th><th>峰值dB</th><th>噪声录音</th></tr></thead>
<tbody>${rows}</tbody></table></body></html>`;
  var blob=new Blob([htmlOut],{type:"text/html;charset=utf-8"});
  var a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="噪声监测报告_"+new Date().toISOString().slice(0,10)+".html";
  document.body.appendChild(a); a.click(); a.remove();
  toast("已导出 HTML 报告，"+logArr.length+" 条");
}

/* ---------- 事件 ---------- */
$("btnStart").addEventListener("click", async function(){
  if(running){ await stopMonitor(); toast("监测与录像已停止"); } else await startMonitor();
});
$("btnClear").addEventListener("click", function(){
  if(logSelCount() > 0){ logSel = {}; }
  logArr=[]; resetOverSession(); saveLog(); renderLog(); updateDelSelUI(); toast("日志已清空");
});
(function(){
  var all = $("logChkAll");
  if(all) all.addEventListener("change", function(){ setAllRowsSelected(all.checked); });
  var del = $("btnDelSel");
  if(del) del.addEventListener("click", function(){ delLogSelected(); });
  updateDelSelUI();
})();
$("btnExport").addEventListener("click", exportHtmlReport);

// 波形图 x 轴悬停：鼠标移动时显示该位置对应的年月日 时分秒 与分贝值
// 用 rAF 合并高频 mousemove，避免一次拖动触发几十次整幅重绘
(function(){
  var sc=$("scope"), rafId=0;
  function queueDraw(){
    if(rafId) return;
    rafId = requestAnimationFrame(function(){ rafId=0; drawScope(); });
  }
  if(sc){
    sc.addEventListener("mousemove", function(e){
      var r=sc.getBoundingClientRect();
      hoverX=e.clientX - r.left;
      if(hoverX<0) hoverX=-1; else if(hoverX>r.width) hoverX=r.width;
      queueDraw();
    });
    sc.addEventListener("mouseleave", function(){ hoverX=-1; queueDraw(); });
  }
})();

setInterval(function(){
  var el=$("sssb"); if(el) el.textContent="实时声波 - "+formatFullTime(new Date());
},1000);

function toast(msg){
  var t=$("toast"); t.textContent=msg; t.className="toast show";
  clearTimeout(t._h); t._h=setTimeout(function(){ t.className="toast"; },2600);
}

// “录视频”勾选状态 → 控制视频区显示。只隐藏视频画面/标题/统计，保留 .set（含“录视频”复选框）始终可操作
function syncVideoArea(){
  var wantVideo = $("videoOpt") ? $("videoOpt").checked : true;
  var z=$("videoZone"); if(!z) return;
  var secs=z.querySelectorAll(".z-h,#preview,.meta");
  for(var i=0;i<secs.length;i++) secs[i].style.display = wantVideo ? "" : "none";
}
// 录像标签/选项自动记忆：与设备指纹绑定，永久保存；指纹就绪后回填
function applyMem(){
  if(!deviceId) return;
  try{
    var _ti=$("tagInput"); if(_ti){
      var _sv=localStorage.getItem("qs_video_tag_"+deviceId);
      if(_sv){ _ti.value=_sv; }
      else { var _old=localStorage.getItem("qs_video_tag"); if(_old){ _ti.value=_old; localStorage.setItem("qs_video_tag_"+deviceId,_old); localStorage.removeItem("qs_video_tag"); } }
    }
    var _vt=$("videoOpt"); if(_vt){
      var _mv=localStorage.getItem("qs_video_"+deviceId);
      if(_mv!=null){ _vt.checked = (_mv === "1"); }
      else {
        var _old=localStorage.getItem("qs_novideo_"+deviceId);
        if(_old!=null){ _vt.checked = (_old !== "1"); localStorage.removeItem("qs_novideo_"+deviceId); }
        else { _vt.checked = true; }   // 默认录视频
      }
    }
    var _gc=$("dbGapCb"), _gi=$("dbGapIn");
    if(_gc && _gi){
      var _gv=localStorage.getItem("qs_gapcb_"+deviceId);
      if(_gv!=null) _gc.checked = (_gv === "1");
      var _gn=parseInt(localStorage.getItem("qs_gapval_"+deviceId),10);
      if(!isNaN(_gn)) _gi.value=_gn;
    }
    syncVideoArea();
  }catch(e){}
}
(function(){
  var _ti=$("tagInput");
  if(_ti) _ti.addEventListener("input", function(){
    if(deviceId) try{ localStorage.setItem("qs_video_tag_"+deviceId, _ti.value.trim()); }catch(e){}
  });
  var _vt=$("videoOpt");
  if(_vt) _vt.addEventListener("change", function(){
    if(deviceId) try{ localStorage.setItem("qs_video_"+deviceId, _vt.checked ? "1":"0"); }catch(e){}
    syncVideoArea();
  });
  var _gc2=$("dbGapCb"), _gi2=$("dbGapIn");
  if(_gc2 && _gi2){
    var saveGap=function(){
      if(deviceId) try{ localStorage.setItem("qs_gapcb_"+deviceId, _gc2.checked?"1":"0"); localStorage.setItem("qs_gapval_"+deviceId, _gi2.value||"6"); }catch(e){}
    };
    _gc2.addEventListener("change", saveGap);
    _gi2.addEventListener("input", saveGap);
  }
  if(deviceId) applyMem();
  else getDeviceFingerprint().then(applyMem);
})();

// 录音保存音量×5：服务端开关（所有设备共用），保存时直接覆盖为放大后的版本
(function(){
  var cb=$("boostCb");
  if(!cb) return;
  fetch(apiUrl("/api/config"),{cache:"no-store"})
    .then(function(r){ return r.json(); })
    .then(function(d){ if(d && d.ok && typeof d.audioBoost5x==="boolean") cb.checked=d.audioBoost5x; })
    .catch(function(){});   // 读不到就保持页面默认（开启）
  cb.addEventListener("change", function(){
    var want=cb.checked;
    cb.disabled=true;
    fetch(apiUrl("/api/config"),{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({audioBoost5x:want})
    })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(!d || !d.ok) throw new Error((d && d.err) || "保存失败");
      cb.checked=!!d.audioBoost5x;
      toast(cb.checked ? "录音保存音量×5 已开启" : "录音保存恢复原音量");
    })
    .catch(function(e){ cb.checked=!want; toast("⚠️设置保存失败："+e.message); })
    .then(function(){ cb.disabled=false; });
  });
})();

// 初始化：计算设备指纹、绘制空表
getDeviceFingerprint().then(function(id){
  deviceId=id;
  var fpEl=$("devFp");
  if(fpEl) fpEl.textContent="设备指纹："+id.slice(0,12)+"…";
});
drawArc($("gSound"),0,"#22D3EE","--"); gGauge.f=0; gGauge.c="#22D3EE"; gGauge.t="--";
drawScope();
window.addEventListener("resize", function(){
  drawArc($("gSound"), gGauge.f, gGauge.c, gGauge.t); // 始终随窗口缩放重绘，保证 gSound 撑满并等比例放大
  if(soundLive) computeDb();
  drawScope();
});

// —— 首次用户交互即启动 GPS（定位）——
// 麦克风/摄像头不提前开启，等用户点「开始监测」后才请求权限
function _onFirstInteraction(){
  initAlwaysOn();
  document.removeEventListener("click", _onFirstInteraction);
  document.removeEventListener("touchstart", _onFirstInteraction);
  document.removeEventListener("keydown", _onFirstInteraction);
}
document.addEventListener("click", _onFirstInteraction);
document.addEventListener("touchstart", _onFirstInteraction);
document.addEventListener("keydown", _onFirstInteraction);

// 位置抬头可点击重试（定位失败时不用刷新页面）
(function(){
  var bar=$("logLocBar");
  if(!bar) return;
  bar.style.cursor="pointer";
  bar.addEventListener("click", function(){
    if(gpsLat!==null) return;              // 已有定位，点也没意义
    gpsFailStreak=0; gpsLastErr=null; gpsState="locating";
    gpsRenderStatus();
    startGps(true);                        // startGps(force) 内部会撤掉旧的请求与重试定时器
  });
})();

/* ---------- 每天定时自动开始采集（时间可手工输入，默认 11:00） ----------
 * 采集用的是浏览器的 MediaRecorder，只有页面开着才会录 —— 这个定时器只在「页面已打开」时生效。
 * Safari 会把后台标签页的 setTimeout 节流到分钟级，因此除了精确闹钟，
 * 还有一个 60 秒的兜底检查：到点之后、且今天还没启动过就补启动一次；
 * 补启动窗口 = 设定时刻起 2 小时内，避免半夜打开页面突然开始录制。 */
var AUTO_KEY = "qs_auto_1100", AUTO_TIME_KEY = "qs_auto_1100_time", AUTO_LAST_KEY = "qs_auto_1100_last";
var AUTO_DEFAULT_TIME = "11:00", AUTO_CATCHUP_MIN = 120;     // 到点后 2 小时内允许补启动
var autoHH = 11, autoMM = 0, autoTimeBad = false;
var autoAlarmTimer = null, autoTickTimer = null, autoInFlight = false;

function autoPad(n){ return (n < 10 ? "0" : "") + n; }
function autoFmt(){ return autoPad(autoHH) + ":" + autoPad(autoMM); }
function autoParseTime(str){
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(str == null ? "" : str).trim());
  if(!m) return null;
  var h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if(!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
  return { h: h, m: mi };
}
/* 读取保存的时间；非法/缺失一律回落到默认 11:00 */
function autoLoadTime(){
  var raw = null, t = null;
  try{ raw = localStorage.getItem(AUTO_TIME_KEY); }catch(e){}
  t = autoParseTime(raw);
  if(!t){ t = autoParseTime(AUTO_DEFAULT_TIME); autoTimeBad = !!(raw && raw.trim()); }
  autoHH = t.h; autoMM = t.m;
  var el = $("autoTime");
  if(el) el.value = autoFmt();
  return t;
}
function autoSetTime(str){
  var t = autoParseTime(str);
  if(!t) return false;
  autoHH = t.h; autoMM = t.m; autoTimeBad = false;
  try{ localStorage.setItem(AUTO_TIME_KEY, autoFmt()); }catch(e){}
  return true;
}
function autoEnabled(){ try{ return localStorage.getItem(AUTO_KEY) === "1"; }catch(e){ return false; } }
function autoSetEnabled(on){ try{ localStorage.setItem(AUTO_KEY, on ? "1" : "0"); }catch(e){} }
function autoDayStr(d){ return d.getFullYear() + "-" + autoPad(d.getMonth() + 1) + "-" + autoPad(d.getDate()); }
function autoLastDay(){ try{ return localStorage.getItem(AUTO_LAST_KEY) || ""; }catch(e){ return ""; } }
function autoMarkDay(){ try{ localStorage.setItem(AUTO_LAST_KEY, autoDayStr(new Date())); }catch(e){} }
function autoNextRunAt(){
  var now = new Date();
  var t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), autoHH, autoMM, 0, 0);
  if(t.getTime() <= now.getTime()) t = new Date(t.getTime() + 86400000);
  return t;
}
function autoHint(text, cls){
  var el = $("autoHint"); if (!el) return;
  el.textContent = text || "";
  el.className = "auto-hint" + (cls ? " " + cls : "");
}
function autoRenderIdleHint(){
  if(!autoEnabled()){ autoHint(autoTimeBad ? "时间格式无效，已回落到 " + autoFmt() : ""); return; }
  if(autoTimeBad){ autoHint("时间格式无效，已回落到 " + autoFmt() + "｜页面需保持打开", "err"); return; }
  var t = autoNextRunAt(), now = new Date();
  var mins = Math.round((t - now) / 60000);
  var when = autoDayStr(t) === autoDayStr(now) ? "今天" : "明天";
  autoHint("已开启｜下次自动开始：" + when + " " + autoFmt() + "（约 " + Math.floor(mins / 60) + " 小时 " + (mins % 60) + " 分后）", "on");
}
async function autoTrigger(why){
  if(autoInFlight || running || startPending) return false;
  autoInFlight = true;
  autoMarkDay();                                  // 先记日子，避免兜底检查重复触发
  try{
    await startMonitor();
  }catch(e){
    console.warn("自动开始失败", e);
  }
  autoInFlight = false;
  if(running){
    toast(autoFmt() + " 自动开始采集已启动");
    autoHint("已自动启动｜今天 " + autoFmt() + " 已开始采集", "on");
    return true;
  }
  // 失败最常见的原因：麦克风/摄像头权限需要一次人工点击授权（Safari 尤其严格）
  autoHint("自动启动失败：需在页面点一次「开始监测」授权麦克风/摄像头，之后自动启动才会生效", "err");
  toast("自动启动失败，请手动点一次「开始监测」授权");
  return false;
}
/* 兜底检查（每分钟一次，也用于刷新提示文案） */
function autoTick(){
  if(!autoEnabled()) return;
  var now = new Date();
  if(running || startPending || autoInFlight){ autoRenderIdleHint(); return; }
  var nowMin = now.getHours() * 60 + now.getMinutes();
  var startMin = autoHH * 60 + autoMM;
  if(autoLastDay() !== autoDayStr(now) && nowMin >= startMin && nowMin < startMin + AUTO_CATCHUP_MIN){
    autoTrigger("tick");
    return;
  }
  autoRenderIdleHint();
}
function autoSchedule(){
  if(autoAlarmTimer){ clearTimeout(autoAlarmTimer); autoAlarmTimer = null; }
  if(!autoEnabled()){ autoRenderIdleHint(); return; }
  // 精确闹钟：等到下一个 设定时刻（秒级 00）。机器休眠/标签页被节流时由 autoTick 兜底。
  var wait = Math.max(1000, autoNextRunAt().getTime() - Date.now());
  autoAlarmTimer = setTimeout(function(){
    autoAlarmTimer = null;
    autoTrigger("alarm");
    autoSchedule();
  }, wait);
  autoRenderIdleHint();
}
/* 勾选后立刻申请一次麦克风权限再释放：Safari 的 getUserMedia 需要一次用户手势，
 * 提前在这个手势里把权限拿到，到点时无人值守的自动启动才不会被权限挡住。
 * 只申请音频，不点亮摄像头指示灯。 */
function primeMicPermission(){
  try{
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.resolve(false);
    return navigator.mediaDevices.getUserMedia({
      audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false }
    }).then(function(s){
      s.getTracks().forEach(function(t){ try{ t.stop(); }catch(e){} });
      return true;
    }).catch(function(){ return false; });
  }catch(e){ return Promise.resolve(false); }
}
function initAutoStart(){
  var chk = $("optAuto1100"); if(!chk) return;
  autoLoadTime();                 // 先把时间填进输入框（默认 11:00）
  chk.checked = autoEnabled();
  chk.addEventListener("change", function(){
    autoSetEnabled(chk.checked);
    autoSchedule();
    if(chk.checked){
      autoHint("已开启｜页面需保持打开，" + autoFmt() + " 前打开即可自动开始", "on");
      primeMicPermission().then(function(ok){
        if(!autoEnabled()) return;
        if(ok) autoHint("麦克风权限已就绪｜页面保持打开，" + autoFmt() + " 会自动开始采集", "on");
        else autoHint("麦克风权限未授予：自动启动会被拦住，请先点一次「开始监测」授权", "err");
      });
      autoTick();                 // 若此刻已到点且今天未启动，1 分钟内会补启动
    }
  });
  var tin = $("autoTime");
  if(tin){
    var commit = function(){
      var before = autoFmt();
      if(autoSetTime(tin.value)){
        if(tin.value !== autoFmt()) tin.value = autoFmt();   // 统一成 HH:MM
        autoSchedule();
        if(autoEnabled()) autoTick();
      }else{
        // 输入非法（空/残缺）：回落到上一次有效值，不改变调度
        autoHint("时间格式无效（应为 HH:MM），已保持 " + before, "err");
        tin.value = before;
      }
    };
    tin.addEventListener("change", commit);
    tin.addEventListener("blur", commit);
    tin.addEventListener("keydown", function(e){ if(e.key === "Enter"){ commit(); tin.blur(); } });
  }
  if(autoEnabled()) autoSchedule();
  if(!autoTickTimer) autoTickTimer = setInterval(autoTick, 60000);
  document.addEventListener("visibilitychange", function(){
    if(document.visibilityState === "visible" && autoEnabled()) autoTick();
  });
}
initAutoStart();

})();
