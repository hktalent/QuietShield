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
function ensureStream(){
  if(combinedStream) return Promise.resolve(combinedStream);
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
var scopeBuf=[];
var ltFz = 5 * 600; // N分钟
var scopeEnv=[];   // 5分钟 dB 包络（每100ms一点），横轴呈现近5分钟突发噪声
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

function computeDb(){
  if(!analyser) return;
  analyser.getFloatTimeDomainData(micData);
  var sum=0; for(var i=0;i<micData.length;i++) sum += micData[i];
  var dc = sum / micData.length;
  var sumSq=0; for(var j=0;j<micData.length;j++){ var v=micData[j]-dc; sumSq += v*v; }
  var rms = Math.sqrt(sumSq / micData.length);
  var db = DB_OFFSET + 20*Math.log10(rms + 1e-6) + CAL - 94;
  if(!isFinite(db) || db < 20) db = 20;
  if(db > 120) db = 120;
  DB.value = db;
  S.sound = Math.max(0, Math.min(1,(db-20)/70));

  scopeBuf = [];
  var step = Math.max(1, Math.floor(micData.length/320));
  for(var k=0;k<micData.length;k+=step) scopeBuf.push(micData[k]-dc);
  if(scopeBuf.length>400) scopeBuf = scopeBuf.slice(-400);

  // 5分钟 dB 包络：记录当前时间戳与 dB，供波形图呈现近 5 分钟的突发噪声与悬停取值
  scopeEnv.push({t: Date.now(), db: DB.value});
  if(scopeEnv.length > ltFz) scopeEnv.splice(0, scopeEnv.length-ltFz);

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

/* ---------- 存储 ---------- */
// 音频等大体积媒体存 IndexedDB，localStorage 只存文字字段（避免 5MB 上限）
var idb=null;
function openDB(){
  return new Promise(function(resolve,reject){
    if(idb){ resolve(idb); return; }
    var req=indexedDB.open("qs_media_db",1);
    req.onupgradeneeded=function(e){
      var db=e.target.result;
      if(!db.objectStoreNames.contains("media"))
        db.createObjectStore("media",{keyPath:"timeTs"});
    };
    req.onsuccess=function(){ idb=req.result; resolve(idb); };
    req.onerror=function(){ reject(req.error); };
  });
}
function putMedia(timeTs, audioData){
  if(timeTs==null) return Promise.resolve();
  return openDB().then(function(db){
    return new Promise(function(res,rej){
      var tx=db.transaction("media","readwrite");
      tx.objectStore("media").put({timeTs:timeTs, audioData:audioData||null});
      tx.oncomplete=res; tx.onerror=function(){ rej(tx.error); };
    });
  }).catch(function(e){ console.warn("媒体写入失败",e); });
}
function getMedia(timeTs){
  return openDB().then(function(db){
    return new Promise(function(res,rej){
      var tx=db.transaction("media","readonly");
      var rq=tx.objectStore("media").get(timeTs);
      rq.onsuccess=function(){ res(rq.result||null); };
      rq.onerror=function(){ rej(rq.error); };
    });
  }).catch(function(){ return null; });
}
function getAllMedia(){
  return openDB().then(function(db){
    return new Promise(function(res,rej){
      var tx=db.transaction("media","readonly");
      var rq=tx.objectStore("media").getAll();
      rq.onsuccess=function(){ res(rq.result||[]); };
      rq.onerror=function(){ rej(rq.error); };
    });
  }).catch(function(){ return []; });
}
function clearMedia(){
  return openDB().then(function(db){
    return new Promise(function(res,rej){
      var tx=db.transaction("media","readwrite");
      tx.objectStore("media").clear();
      tx.oncomplete=res; tx.onerror=function(){ rej(tx.error); };
    });
  }).catch(function(){});
}
function deleteMedia(timeTs){
  if(timeTs==null) return Promise.resolve();
  return openDB().then(function(db){
    return new Promise(function(res,rej){
      var tx=db.transaction("media","readwrite");
      tx.objectStore("media").delete(timeTs);
      tx.oncomplete=res; tx.onerror=function(){ rej(tx.error); };
    });
  }).catch(function(e){ console.warn("媒体删除失败",e); });
}

function validAudio(a){
  return typeof a === "string" && a.length > 400 && a.indexOf("base64,") > 0;
}

function loadLog(){
  try{ var r=JSON.parse(localStorage.getItem("sm_log")||"[]"); if(Array.isArray(r)) logArr=r; }catch(e){ logArr=[]; }
  // 迁移旧数据：若旧日志仍含媒体字段，写入 IndexedDB 并从数组剥离，只留文字
  var dirty=false;
  for(var i=0;i<logArr.length;i++){
    var rec=logArr[i];
    if(rec && (rec.audioData!==undefined || rec.waveImg!==undefined)){
      putMedia(rec.timeTs, rec.audioData);
      if("waveImg" in rec) delete rec.waveImg;
      if("audioData" in rec) delete rec.audioData;
      dirty=true;
    }
  }
  if(dirty) saveLog();
  renderLog();
}
function saveLog(){
  try{ localStorage.setItem("sm_log", JSON.stringify(logArr)); }catch(e){ toast("⚠️本地存储已满"); }
}
loadLog();

// 后台噪声日志推送（含设备ID，无磁/振）
const LOG_API_URL = "/api/log";
async function pushLogToServer(record){
  try{
    record.deviceId = deviceId || "unknown";
    var resp = await fetch(LOG_API_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(record)});
    if(!resp.ok) throw new Error("HTTP status: "+resp.status);
  }catch(err){ console.warn("推送日志失败，不影响本地", err); }
}

// ===== 噪声样本：分段常驻录音（每段带头可播）+ 触发前判断（dB>背景才纳入、最多2秒） =====
var audioClipRecorder = null;
var ringSeg = [];              // 当前录音段的片数组（每项 {db, blob}），样本从段头拼 → 可播
var ringTimer = null;
const RING_SLICE_MS = 1000;    // 分片/采样间隔（1 秒一片）
const RING_RESTART_MS = 2000;  // 常态每 2 秒重建一段，保证触发前最多约 2 秒
const LEAD_MAX_MS = 2000;      // 触发前最多向前 2 秒
const LEAD_DB_OFFSET = 3;      // 触发前该段 dB 高于背景底噪这个量才算“不同于背景”，才纳入
const SAMPLE_GAIN = 3;          // 样本录音放大增益（原始响度偏低，放大后直接播放可听）
function ringStart(){
  if(!window.MediaRecorder) return;   // iOS 12 Safari 无 MediaRecorder，跳过样本录音（仅监测 dB）
  if(!combinedStream) return;
  var at = combinedStream.getAudioTracks()[0];
  if(!at) return;
  var buf = [];                // 本 recorder 独立片数组（旧段收尾不会污染新段）
  ringSeg = buf;
  var opts = { mimeType: "audio/webm" };
  if(!MediaRecorder.isTypeSupported(opts.mimeType)) opts = { mimeType: "" };
  try{
    var recStream = (sampleDest && sampleDest.stream) ? sampleDest.stream : new MediaStream([at]);
    var rec = new MediaRecorder(recStream, opts);
    rec.ondataavailable = function(e){ if(e.data && e.data.size>0) buf.push({ db: DB.value, blob: e.data }); };
    rec.start(RING_SLICE_MS);
    audioClipRecorder = rec;
  }catch(err){ audioClipRecorder = null; console.warn("噪声样本录音启动失败", err); }
}
function rebuildRing(){
  if(audioClipRecorder && audioClipRecorder.state === "recording"){
    var old = audioClipRecorder;
    old.onstop = function(){ ringStart(); };   // 等旧段完全停止再开新段，杜绝重叠走样
    old.stop();
  } else {
    ringStart();
  }
}
function ensureRing(){
  if(overSession.active) return;      // 事件期间不重建，保持事件段连续从头
  if(audioClipRecorder && audioClipRecorder.state === "recording") rebuildRing();
}
function startRingRecording(){
  if(!combinedStream) return;
  ringStart();
  if(ringTimer) clearInterval(ringTimer);
  ringTimer = setInterval(ensureRing, RING_RESTART_MS);
}
function stopRingRecording(){
  if(ringTimer){ clearInterval(ringTimer); ringTimer=null; }
  if(audioClipRecorder){ try{ audioClipRecorder.stop(); }catch(e){} }
  audioClipRecorder = null;
  ringSeg = [];
}
function stopRecordAudio(){
  return new Promise(function(resolve){
    if(!audioClipRecorder || !ringSeg.length){ resolve(null); return; }
    // 当前段从头（带头片）拼 → 可正常播放；含触发前（需要时≤2秒）+ 事件时段
    var blobs = [];
    for(var k = 0; k < ringSeg.length; k++) blobs.push(ringSeg[k].blob);
    var blob = new Blob(blobs, {type: audioClipRecorder.mimeType || "audio/webm"});
    if(blob.size < 200){ resolve(null); return; }
    var reader = new FileReader();
    reader.onloadend = function(){ resolve(reader.result); };
    reader.readAsDataURL(blob);
  });
}
async function closeAndSaveSession(){
  if(!overSession.active) return;
  var nowTs = Date.now();
  var durSec = ((nowTs - overSession.startTs)/1000).toFixed(1);
  var audioB64 = await stopRecordAudio();
  // 噪声样本无效/为空，或持续时长过短 → 不记录这条日志
  if(!validAudio(audioB64) || parseFloat(durSec) < MIN_RECORD_SEC){ resetOverSession(); return; }
  var fullTimeStr = formatFullTime(overSession.startTs);
  putMedia(overSession.startTs, audioB64); // 音频 → IndexedDB
  logArr.unshift({
    timeText: fullTimeStr, timeTs: overSession.startTs, durationSec: durSec,
    peakDb: overSession.peakDb.toFixed(1), tag: getTag(),
    lat: gpsLat!==null ? gpsLat.toFixed(6):null, lon: gpsLon!==null ? gpsLon.toFixed(6):null
  });
  if(logArr.length>300) logArr.length=300;
  saveLog(); renderLog();
  pushLogToServer({
    timeText: fullTimeStr, timeTs: overSession.startTs, durationSec: durSec,
    peakDb: overSession.peakDb.toFixed(1), tag: getTag(),
    audioData: audioB64,
    lat: gpsLat!==null ? gpsLat.toFixed(6):null, lon: gpsLon!==null ? gpsLon.toFixed(6):null
  });
  postSessionCooldownTs = Date.now();  // 事件结束进入 5 秒冷却，期内不更新背景
  resetOverSession();
}

/* ===== 超标检测 ===== */
var fallTs = null;
const TRIG_OFFSET = 6;
const RELEASE_OFFSET = 3;   // 结束线 = 背景 + 3dB（低于触发线 6dB），噪声真正回落到常态附近才停
const RELEASE_HYSTERESIS = 5;   // 白天/夜间结束线比触发线低 5dB（滞回）：常态噪声在阈值附近波动也能正常结束
const HOLD_AFTER_FALL = 0.4;
const MAX_SESSION_SEC = 120;   // 连续噪声记录上限：最多 2 分钟一段，超时切段重记

function setThr(){
  var h = new Date().getHours();
  thr = (h>=6 && h<22) ? 55 : 45;
}
function processOverThreshold(currentDb){
  var nowTs = Date.now();
  var triggerLevel = noiseFloorDb + TRIG_OFFSET;
  var hh = new Date().getHours();
  var early = (hh >= 1 && hh < 6);   // 凌晨 01:00~06:00 前
  if(!overSession.active){
    fallTs = null;
    if(noiseFloorSamples < noiseFloorCalSec*10) return;
    setThr();
    // 触发：勾选"背景声+X dB记录"→所有时段 噪声>背景声+XdB 或 超固定阈值，任一即触发；
    //      未勾选→维持原逻辑（凌晨=45或背景+6；其他时段=固定阈值）
    var gapOn = !!($("dbGapCb") && $("dbGapCb").checked);
    var gapVal = gapOn ? (parseFloat($("dbGapIn").value)||6) : 0;
    var pass = gapOn ? (currentDb > thr || currentDb>39 && currentDb > (noiseFloorDb + gapVal))
                     : (early ? (currentDb > thr || currentDb > triggerLevel) : (currentDb > thr));
    if(pass){
      overSession.active=true; overSession.startTs=nowTs; overSession.peakDb=currentDb;
    }
  } else {
    var sessionDur = (nowTs - overSession.startTs)/1000;
    if(sessionDur >= MAX_SESSION_SEC){ closeAndSaveSession(); return; }
    if(currentDb > overSession.peakDb) overSession.peakDb = currentDb;
    // 结束线：勾选背景+X时=背景+3；未勾选时 凌晨=背景+3 / 其他=固定阈值-5dB滞回
    var releaseLevel = gapOn ? (noiseFloorDb + RELEASE_OFFSET)
                             : (early ? (noiseFloorDb + RELEASE_OFFSET) : (thr - RELEASE_HYSTERESIS));   // 勾选=背景+3；未勾选 凌晨=背景+3/其他=阈值-5dB
    if(currentDb > releaseLevel){ fallTs=null; }
    else {
      if(fallTs===null) fallTs=nowTs;
      else if((nowTs-fallTs)/1000 >= HOLD_AFTER_FALL) closeAndSaveSession();
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
  if(running) processOverThreshold(db);   // 仅在监测中做阈值检测与日志记录
}
var _liveLoopRunning=false;
function liveLoop(){
  if(_liveLoopRunning) return;
  _liveLoopRunning=true;
  (function tick(){
    if(soundLive){ liveDb(); setTimeout(tick,100); }
    else { _liveLoopRunning=false; }
  })();
}

/* ---------- 绘制 ---------- */
var gGauge={f:0,c:"#22D3EE",t:"--"}; // 声压计当前绘制状态，用于窗口缩放时重绘（含空闲态）
function drawArc(canvas,frac,color,dbText){
  var dpr=window.devicePixelRatio||1;
  var w=canvas.clientWidth,h=canvas.clientHeight;
  canvas.width=w*dpr; canvas.height=h*dpr;
  var c=canvas.getContext("2d");
  c.setTransform(dpr,0,0,dpr,0,0);
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
  var cv=$("scope"); var dpr=window.devicePixelRatio||1;
  var w=cv.clientWidth,h=cv.clientHeight;
  cv.width=w*dpr; cv.height=h*dpr;
  var c=cv.getContext("2d"); c.setTransform(dpr,0,0,dpr,0,0);
  c.fillStyle="#080C10"; c.fillRect(0,0,w,h);
  var DB_MIN=30, DB_MAX=90;
  // 纵向 dB 刻度线（40/60/80）
  c.strokeStyle="#14202A"; c.lineWidth=1;
  c.fillStyle="#3A4A57"; c.font=Math.max(9,Math.round(w/70))+"px monospace";
  for(var db=40; db<=80; db+=20){
    var yy=h - ((db-DB_MIN)/(DB_MAX-DB_MIN))*(h*0.92);
    c.beginPath(); c.moveTo(0,yy); c.lineTo(w,yy); c.stroke();
    c.fillText(db+"dB", 3, yy-2);
  }
  // 横向时间刻度：5 分钟窗口（-5min … 现在）
  for(var m=0;m<=5;m++){
    var xx=(m/5)*w;
    c.strokeStyle="#14202A"; c.beginPath(); c.moveTo(xx,0); c.lineTo(xx,h); c.stroke();
    c.fillStyle="#3A4A57"; c.fillText("-"+(5-m)+"min", xx+2, h-4);
  }
  if(!scopeEnv.length) return;
  // 5分钟 dB 包络线：最新在右，dB 越高凸起越高（从底部向上），突发噪声清晰可见
  var n=scopeEnv.length;
  c.strokeStyle="#22D3EE"; c.lineWidth=1.8; c.beginPath();
  for(var i=0;i<n;i++){
    var dbv=Math.max(0,Math.min(1,(scopeEnv[i].db-DB_MIN)/(DB_MAX-DB_MIN)));
    var age=(n-1-i)*100;               // 距当前毫秒数（每点100ms）
    var x=w - (age/300000)*w;          // 5分钟窗口，最新贴右
    var y=h - dbv*(h*0.92);
    if(i===0) c.moveTo(x,y); else c.lineTo(x,y);
  }
  c.stroke();
  // 悬停参考线 + 时间/分贝提示
  if(hoverX>=0){
    var age2=Math.max(0, (w-hoverX)/w * 300000);
    var idx=n-1 - Math.round(age2/100);
    idx=Math.max(0,Math.min(n-1,idx));
    var pt=scopeEnv[idx];
    c.strokeStyle="rgba(245,166,35,0.85)"; c.lineWidth=1.2;
    c.beginPath(); c.moveTo(hoverX,0); c.lineTo(hoverX,h); c.stroke();
    var dbv2=Math.max(0,Math.min(1,(pt.db-DB_MIN)/(DB_MAX-DB_MIN)));
    var py=h - dbv2*(h*0.92);
    c.fillStyle="#F5A623"; c.beginPath(); c.arc(hoverX,py,3.5,0,6.283); c.fill();
    var txt=formatFullTime(pt.t)+"  "+pt.db.toFixed(1)+" dB";
    c.font=Math.max(10,Math.round(w/55))+"px monospace";
    var tw=c.measureText(txt).width;
    var tx=hoverX - tw - 10; if(tx<4) tx=4; if(tx+tw>w-4) tx=w-tw-4;
    c.fillStyle="rgba(8,12,16,0.88)"; c.fillRect(tx-4,4,tw+8,18);
    c.fillStyle="#F5A623"; c.fillText(txt,tx,17);
  }
}

/* ---------- GPS ---------- */
var gpsLat=null, gpsLon=null, gpsWatchId=null;
function startGps(){
  if(!navigator.geolocation || gpsWatchId!==null) return;
  // macOS 无 GPS 硬件，enableHighAccuracy 请求可能挂起/超时：高精度失败自动降级标准定位，再失败 getCurrentPosition 兜底
  var tryWatch = function(highAcc){
    gpsWatchId = navigator.geolocation.watchPosition(
      function(pos){ gpsLat=pos.coords.latitude; gpsLon=pos.coords.longitude; },
      function(err){
        console.warn("GPS失败 code=", err.code, err.message);
        if(gpsWatchId!==null){ try{ navigator.geolocation.clearWatch(gpsWatchId); }catch(e){} gpsWatchId=null; }
        if(highAcc){ tryWatch(false); }
        else {
          try{
            navigator.geolocation.getCurrentPosition(
              function(pos){ gpsLat=pos.coords.latitude; gpsLon=pos.coords.longitude; },
              function(e2){ console.warn("GPS最终失败", e2); toast("⚠️定位失败：请检查系统「定位服务」已为浏览器开启并授予位置权限"); },
              { maximumAge:60000, timeout:20000 }
            );
          }catch(e){ toast("⚠️定位失败：请检查系统定位权限"); }
        }
      },
      { enableHighAccuracy:highAcc, maximumAge:30000, timeout:15000 }
    );
  };
  tryWatch(true);
}
function stopGps(){ if(gpsWatchId!==null){ navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId=null; } }

/* ---------- GPS 显示：把经纬度渲染到「实时声波」标题栏中间 ---------- */
function updateGpsDisplay(){
  var el=$("gpsDisp");
  if(!el) return;
  if(gpsLat!==null && gpsLon!==null){
    el.textContent="📍 "+gpsLat.toFixed(5)+", "+gpsLon.toFixed(5);
    el.style.color="var(--cyan)";
  } else {
    el.textContent="📍 定位中…";
    el.style.color="";
  }
}

/* —— 常驻初始化：首次用户交互即启动麦克风（dB 动态显示）与 GPS —— */
var alwaysOnInited=false;
function initAlwaysOn(){
  if(alwaysOnInited) return;
  alwaysOnInited=true;
  // 启动 GPS（页面加载即可定位，不依赖监测按钮）
  startGps();
  setInterval(updateGpsDisplay, 1000);
  updateGpsDisplay();
  // 请求麦克风权限并初始化音频分析（需用户手势，点击页面任意位置触发）
  ensureStream().then(function(){
    if(audioCtx && audioCtx.state==='suspended') audioCtx.resume();
    liveLoop();   // 启动持续 dB 显示循环
  }).catch(function(err){
    console.warn("常驻音频初始化失败", err);
    alwaysOnInited=false;   // 允许下次交互重试
  });
}

/* ---------- 屏幕常亮 ---------- */
var wakeLockTimer=null;
async function acquireWakeLock(){
  if(!("wakeLock" in navigator)){
    toast("⚠️当前浏览器不支持网页常亮，请在手机系统设置把自动锁屏设为「永不」或「充电时常亮」");
    return;
  }
  try{
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    try{ wakeLockSentinel.addEventListener('release', function(){}); }catch(e){}
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
    document.addEventListener('visibilitychange', async function(){
      if(document.visibilityState==='visible'){
        try{ wakeLockSentinel = await navigator.wakeLock.request('screen'); }catch(e){}
      }
    });
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
  try{
    var qs = "/api/video/upload?deviceId="+encodeURIComponent(deviceId||"unknown")
      + "&tag="+encodeURIComponent(sessionTag)
      + "&start="+encodeURIComponent(sessionStartStr)
      + "&segStart="+encodeURIComponent(segStartStr)
      + "&segEnd="+encodeURIComponent(segEndStr)
      + "&segIndex="+i;
    var resp = await fetch(qs,{ method:"POST", headers:{"Content-Type":"application/octet-stream"}, body:blob });
    if(!resp.ok) throw new Error("HTTP "+resp.status);
    segUploaded++;
  }catch(err){
    console.warn("分片上传失败", err);
    toast("⚠️分片上传失败，将丢该段");
  }
  updateVideoStat();
}

async function doFinalize(){
  var endMs = Date.now();
  try{ // 写会话元数据（结束时间为年月日时分秒），后端据此合并 10 分钟 MP4
    await fetch("/api/video/finalize",{method:"POST",headers:{"Content-Type":"application/json"},
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
  if(audioCtx){ try{ audioCtx.close(); }catch(e){} audioCtx=null; analyser=null; micData=null; }
  gGauge.f=0; gGauge.c="#22D3EE"; gGauge.t="--";
  try{ drawArc($("gSound"),0,"#22D3EE","--"); }catch(e){}
}

/* ---------- 主控制：噪声监测 + 视频录制（点「开始监测」同时启动两者） ---------- */
var startPending=false, stopPending=false;
async function startMonitor(){
  if(running || startPending) return;
  startPending=true;
  initAlwaysOn();   // 确保麦克风与GPS已常驻运行（首次点击也能触发）
  acquireWakeLock(); resetOverSession();
  noiseFloorDb=30; noiseFloorSamples=0; noiseFloorSum=0; calArr=[]; postSessionCooldownTs=0;
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
  // 注意：不调用 releaseStream() / stopGps()，保持麦克风与GPS持续运行，
  // 以便 dB 数值与经纬度在停止监测后仍持续动态显示
}

/* ---------- 日志渲染 ---------- */
/* ---------- 噪声样本播放（高通 + 温和噪声门 + 瞬态增强 + 高增益） ---------- */
var _boostCtx=null;
var _enhancerWorkletLoaded = false;   // 缓存 worklet 加载结果，避免重复加载

/* 构建「纯内置节点」回退处理链（无 AudioWorklet 时使用）：
 * 高通 → 噪声门式压缩器 → 增益 → 限幅（不用低通/峰值，避免变闷/改音色） */
function buildFallbackChain(ctx, src, boostGain){
  var hp = ctx.createBiquadFilter();
  hp.type="highpass"; hp.frequency.value=120; hp.Q.value=0.7;
  // 用压缩器模拟噪声门：低阈值+高比率，弱信号被大幅衰减但不完全静音
  var gate = ctx.createDynamicsCompressor();
  gate.threshold.value=-46; gate.knee.value=8; gate.ratio.value=8;
  gate.attack.value=0.003; gate.release.value=0.12;
  var g = ctx.createGain(); g.gain.value = boostGain;
  var lim = ctx.createDynamicsCompressor();
  lim.threshold.value=-6; lim.knee.value=2; lim.ratio.value=20;
  lim.attack.value=0.002; lim.release.value=0.15;
  src.connect(hp); hp.connect(gate); gate.connect(g); g.connect(lim); lim.connect(ctx.destination);
}

async function playBoostAudio(dataUrl, boostGain){
  boostGain = boostGain || 6.0;   // 高增益保证响度，噪声门负责压低背景
  if(_boostCtx){ try{ _boostCtx.close(); }catch(e){} _boostCtx=null; }
  _boostCtx = new (window.AudioContext||window.webkitAudioContext)();
  if(_boostCtx.state==='suspended'){ await _boostCtx.resume(); }
  try{
    var b64=dataUrl.split(",")[1], bin=atob(b64), buf=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++){ buf[i]=bin.charCodeAt(i); }
    var ab=await _boostCtx.decodeAudioData(buf.buffer);
    var src=_boostCtx.createBufferSource(); src.buffer=ab;

    // —— 前级：仅高通，切除低频隆隆（不做低通/峰值，保留高频细节与原始音色） ——
    var hp = _boostCtx.createBiquadFilter();
    hp.type="highpass"; hp.frequency.value=120; hp.Q.value=0.7;
    src.connect(hp);

    // —— 核心：自适应噪声门（衰减而非静音）+ 温和瞬态增强（AudioWorklet） ——
    var useWorklet = false;
    if(_boostCtx.audioWorklet && !_enhancerWorkletLoaded){
      try{
        await _boostCtx.audioWorklet.addModule('js/noise-enhancer.js');
        _enhancerWorkletLoaded = true;
      }catch(e){ console.warn("noise-enhancer worklet 加载失败，使用回退链", e); }
    }
    if(_boostCtx.audioWorklet && _enhancerWorkletLoaded){
      try{
        var enhancer = new AudioWorkletNode(_boostCtx, 'noise-enhancer');
        enhancer.parameters.get('gateMargin').value = 6;       // 门限：底噪+6dB
        enhancer.parameters.get('transientBoost').value = 1.5; // 瞬态+1.5倍（温和）
        enhancer.parameters.get('gateFloor').value = 0.005;
        enhancer.parameters.get('floorGain').value = 0.2;      // 低于门限保留20%，不完全静音
        hp.connect(enhancer);
        var g = _boostCtx.createGain(); g.gain.value = boostGain;
        var lim = _boostCtx.createDynamicsCompressor();
        lim.threshold.value=-6; lim.knee.value=2; lim.ratio.value=20;
        lim.attack.value=0.002; lim.release.value=0.15;
        enhancer.connect(g); g.connect(lim); lim.connect(_boostCtx.destination);
        useWorklet = true;
      }catch(e){ console.warn("AudioWorkletNode 创建失败，使用回退链", e); }
    }
    if(!useWorklet){ buildFallbackChain(_boostCtx, src, boostGain); }

    src.onended=function(){ if(_boostCtx){ _boostCtx.close(); _boostCtx=null; } };
    src.start(0);
  }catch(err){
    console.warn("增强播放失败，改用原生播放", err);
    try{ var _fa=new Audio(dataUrl); _fa.play(); }catch(e2){}
    if(_boostCtx){ try{ _boostCtx.close(); }catch(e){} _boostCtx=null; }
  }
}
// 暴露为全局，供动态生成的日志行内联 onclick 调用（js/1.js 在 IIFE 内，默认不挂到 window）
window.playBoostAudio = playBoostAudio;

function renderLog(){
  $("logCnt").textContent=logArr.length+" 条";
  var b=$("logBody");
  if(!logArr.length){ b.innerHTML='<tr><td colspan="8" class="empty">尚无记录。</td></tr>'; return; }
  b.innerHTML="";
  for(var i=0;i<logArr.length;i++){
    var r=logArr[i];
    var tr=document.createElement("tr"); tr.className="alarm";
    tr.innerHTML=
      '<td>'+(r.timeText||"--")+'</td>'+
      '<td>'+(r.tag||"--")+'</td>'+
      '<td>'+(r.durationSec||"N/A")+'s</td>'+
      '<td>'+r.peakDb+'</td>'+
      '<td class="au"><span class="muted">—</span></td>'+
      '<td>'+(r.lat!=null?r.lat:"--")+'</td>'+
      '<td>'+(r.lon!=null?r.lon:"--")+'</td>'+
      '<td><button type="button" class="au-btn del-btn">删除</button></td>';
    b.appendChild(tr);
    // 音频从 IndexedDB 异步取回，取到后填充播放控件
    (function(ts, cell){
      if(ts==null) return;
      getMedia(ts).then(function(m){
        if(!cell || !m || !validAudio(m.audioData)) return;
        cell.innerHTML='<audio controls preload="none"><source src="'+m.audioData+'" type="audio/webm">不支持</audio>'+
          '<br><button type="button" class="au-btn" onclick="var s=this.parentElement.querySelector(\'source\');if(s)playBoostAudio(s.src,6.0);">🔊 降噪增强</button>';
      }).catch(function(){});
    })(r.timeTs, tr.querySelector(".au"));
    // 删除本行：同步删前端(IndexedDB+列表)并通知后端删除对应日志
    (function(ts, btn){
      if(btn) btn.addEventListener("click", function(){ delLog(ts); });
    })(r.timeTs, tr.querySelector(".del-btn"));
  }
}

async function delLog(ts){
  if(ts==null) return;
  if(!confirm("确定删除这条日志？后端对应记录也会删除。")) return;
  try{ await fetch("/api/log/del",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({timeTs:String(ts)})}); }
  catch(e){ console.warn("删除后端日志失败", e); }
  logArr = logArr.filter(function(x){ return x.timeTs !== ts; });
  try{ deleteMedia(ts); }catch(e){}
  saveLog(); renderLog();
  toast("已删除该条日志");
}

async function exportHtmlReport(){
  if(!logArr.length){ toast("暂无日志可导出"); return; }
  // 从 IndexedDB 取回全部音频媒体
  var mediaMap={};
  try{ (await getAllMedia()).forEach(function(m){ mediaMap[m.timeTs]=m; }); }catch(e){}
  var reportTitle="传感器噪声监测报告 "+new Date().toLocaleString();
  var rows="";
  for(var i=0;i<logArr.length;i++){
    var rec=logArr[i];
    var media=mediaMap[rec.timeTs]||{};
    var audioData=validAudio(media.audioData) ? media.audioData : null;
    var audioHtml = audioData
      ? `<audio controls preload="none" style="height:28px;max-width:240px;"><source src="${audioData}" type="audio/webm">不支持播放</audio><br><button onclick="const s=this.parentElement.querySelector('source');if(s)playBoostAudio(s.src,6.0);">🔊 降噪增强播放</button>`
      : '<span style="color:#888">无录音片段</span>';
    rows += `<tr style="border-bottom:#ccc 1px solid;">
  <td style="padding:6px 8px">${rec.timeText}</td>
  <td style="padding:6px 8px">${rec.tag||"--"}</td>
  <td style="padding:6px 8px">${rec.durationSec||"N/A"} s</td>
  <td style="padding:6px 8px">${rec.peakDb} dB</td>
  <td style="padding:6px 8px">${audioHtml}</td>
  <td style="padding:6px 8px">${rec.lat!=null?rec.lat:"--"}</td>
  <td style="padding:6px 8px">${rec.lon!=null?rec.lon:"--"}</td>
</tr>
`;
  }
  var htmlOut=`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${reportTitle}</title>
<style>body{font-family:system-ui,monospace;padding:16px;background:#f8f8f8;color:#111;}
h2{margin-bottom:12px;}table{border-collapse:collapse;width:100%;font-size:12px;}
th{background:#222;color:#fff;padding:8px;text-align:left;}td{background:#fff;}img{max-width:100%;}
audio{vertical-align:middle;}button{padding:3px 6px;font-size:11px;cursor:pointer;}
</style>
<script>
let playBoostAudioCtx=null;
/* 独立 HTML 报告无 worklet 文件可用，采用纯内置节点链：
 * 高通→噪声门式压缩→增益→限幅（不用低通/峰值，避免变闷/改音色） */
async function playBoostAudio(dataUrl, boostGain=6.0){
  if(playBoostAudioCtx){ try{ playBoostAudioCtx.close(); }catch(e){} playBoostAudioCtx=null; }
  playBoostAudioCtx=new (window.AudioContext||window.webkitAudioContext)();
  if(playBoostAudioCtx.state==='suspended'){ await playBoostAudioCtx.resume(); }
  try{
    const b64=dataUrl.split(",")[1]; const bin=atob(b64); const buf=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++){ buf[i]=bin.charCodeAt(i); }
    const ab=await playBoostAudioCtx.decodeAudioData(buf.buffer);
    const src=playBoostAudioCtx.createBufferSource(); src.buffer=ab;
    const hp=playBoostAudioCtx.createBiquadFilter();
    hp.type="highpass"; hp.frequency.value=120; hp.Q.value=0.7;
    // 压缩器模拟噪声门：低阈值+高比率衰减弱信号（背景噪声），不完全静音
    const gate=playBoostAudioCtx.createDynamicsCompressor();
    gate.threshold.value=-46; gate.knee.value=8; gate.ratio.value=8;
    gate.attack.value=0.003; gate.release.value=0.12;
    const g=playBoostAudioCtx.createGain(); g.gain.value=boostGain;
    const lim=playBoostAudioCtx.createDynamicsCompressor();
    lim.threshold.value=-6; lim.knee.value=2; lim.ratio.value=20;
    lim.attack.value=0.002; lim.release.value=0.15;
    src.connect(hp); hp.connect(gate); gate.connect(g); g.connect(lim); lim.connect(playBoostAudioCtx.destination);
    src.onended=()=>{ if(playBoostAudioCtx){ playBoostAudioCtx.close(); playBoostAudioCtx=null; } };
    src.start(0);
  }catch(err){ alert("音频播放失败："+err.message); if(playBoostAudioCtx){ playBoostAudioCtx.close(); playBoostAudioCtx=null; } }
}
</script>
</head><body><h2>${reportTitle}</h2>
<p>当前阈值：&gt;${thr} dB；最小记录时长：${MIN_RECORD_SEC}s；录像分片见后台 /review.html</p>
<table><thead><tr><th>触发时间</th><th>标签</th><th>持续秒数</th><th>峰值dB</th><th>噪声录音</th><th>纬度</th><th>经度</th></tr></thead>
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
$("btnClear").addEventListener("click", function(){ logArr=[]; resetOverSession(); clearMedia(); saveLog(); renderLog(); toast("日志已清空"); });
$("btnExport").addEventListener("click", exportHtmlReport);

// 波形图 x 轴悬停：鼠标移动时显示该位置对应的年月日 时分秒 与分贝值
(function(){
  var sc=$("scope");
  if(sc){
    sc.addEventListener("mousemove", function(e){
      var r=sc.getBoundingClientRect();
      hoverX=e.clientX - r.left;
      if(hoverX<0) hoverX=-1; else if(hoverX>r.width) hoverX=r.width;
      drawScope();
    });
    sc.addEventListener("mouseleave", function(){ hoverX=-1; drawScope(); });
  }
})();

setInterval(function(){ $("sssb").innerHTML="实时声波 - "+formatFullTime(new Date()); },1000);

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

// —— 首次用户交互即启动常驻音频（dB 动态显示）与 GPS ——
// 浏览器要求 getUserMedia 必须由用户手势触发，故监听首次点击/触摸
function _onFirstInteraction(){
  initAlwaysOn();
  document.removeEventListener("click", _onFirstInteraction);
  document.removeEventListener("touchstart", _onFirstInteraction);
  document.removeEventListener("keydown", _onFirstInteraction);
}
document.addEventListener("click", _onFirstInteraction);
document.addEventListener("touchstart", _onFirstInteraction);
document.addEventListener("keydown", _onFirstInteraction);

})();
