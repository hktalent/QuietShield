(function(){
"use strict";

// 底噪上下限，防止漂移
const MIN_NOISE_FLOOR = 25;
const MAX_NOISE_FLOOR = 60;
const CAL = 103;
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
var scopeBuf=[];
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
var NOISE_FLOOR_CAL_SEC = 2;
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

  if(!overSession.active){
    if(noiseFloorSamples < NOISE_FLOOR_CAL_SEC*10){
      noiseFloorSum += db; noiseFloorSamples++;
      if(noiseFloorSamples === NOISE_FLOOR_CAL_SEC*10){
        noiseFloorDb = Math.max(MIN_NOISE_FLOOR, Math.min(MAX_NOISE_FLOOR, noiseFloorSum/noiseFloorSamples));
      }
    } else if(db < noiseFloorDb + 3){
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
  try{ localStorage.setItem("qs_video_tag", v); }catch(e){}
  return v;
}

/* ---------- 存储 ---------- */
function loadLog(){
  try{ var r=JSON.parse(localStorage.getItem("sm_log")||"[]"); if(Array.isArray(r)) logArr=r; }catch(e){ logArr=[]; }
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

// ===== 超标噪声样本短录音（audio 轨道单独录，与录像 MediaRecorder 并行不冲突）=====
var audioClipRecorder = null;
var audioClipChunks = [];
function startRecordAudio(){
  if(!combinedStream) return;
  var at = combinedStream.getAudioTracks()[0];
  if(!at) return;
  audioClipChunks = [];
  var opts = { mimeType: "audio/webm" };
  if(!MediaRecorder.isTypeSupported(opts.mimeType)) opts = { mimeType: "" };
  try{
    audioClipRecorder = new MediaRecorder(new MediaStream([at]), opts);
    audioClipRecorder.ondataavailable = function(e){ if(e.data.size>0) audioClipChunks.push(e.data); };
    audioClipRecorder.start(100);   // 每100ms一片，防短噪声丢数据
  }catch(err){ audioClipRecorder = null; console.warn("噪声样本录音启动失败", err); }
}
function stopRecordAudio(){
  return new Promise(function(resolve){
    if(!audioClipRecorder || audioClipRecorder.state === "inactive"){ resolve(null); return; }
    audioClipRecorder.onstop = function(){
      var blob = new Blob(audioClipChunks, {type: audioClipRecorder.mimeType || "audio/webm"});
      var reader = new FileReader();
      reader.onloadend = function(){ resolve(reader.result); };
      reader.readAsDataURL(blob);
    };
    audioClipRecorder.stop();
  });
}

async function closeAndSaveSession(){
  if(!overSession.active) return;
  var nowTs = Date.now();
  var durSec = ((nowTs - overSession.startTs)/1000).toFixed(1);
  var audioB64 = await stopRecordAudio();
  if(parseFloat(durSec) >= MIN_RECORD_SEC){
    var waveImgB64 = $("scope").toDataURL("image/png");
    var fullTimeStr = formatFullTime(overSession.startTs);
    logArr.unshift({
      timeText: fullTimeStr, timeTs: overSession.startTs, durationSec: durSec,
      peakDb: overSession.peakDb.toFixed(1), waveImg: waveImgB64, tag: getTag(),
      audioData: audioB64,
      lat: gpsLat!==null ? gpsLat.toFixed(6):null, lon: gpsLon!==null ? gpsLon.toFixed(6):null
    });
    saveLog(); renderLog();
    pushLogToServer({
      timeText: fullTimeStr, timeTs: overSession.startTs, durationSec: durSec,
      peakDb: overSession.peakDb.toFixed(1), tag: getTag(), audioData: audioB64,
      lat: gpsLat!==null ? gpsLat.toFixed(6):null, lon: gpsLon!==null ? gpsLon.toFixed(6):null
    });
  }
  resetOverSession();
}

/* ===== 超标检测 ===== */
var fallTs = null;
const TRIG_OFFSET = 6;
const HOLD_AFTER_FALL = 0.4;
const MAX_SESSION_SEC = 12;

function setThr(){
  var h = new Date().getHours();
  thr = (h>=6 && h<22) ? 55 : 45;
}
function processOverThreshold(currentDb){
  var nowTs = Date.now();
  var triggerLevel = noiseFloorDb + TRIG_OFFSET;
  if(!overSession.active){
    fallTs = null;
    if(noiseFloorSamples < NOISE_FLOOR_CAL_SEC*10) return;
    setThr();
    if(currentDb > triggerLevel && currentDb > thr){
      overSession.active=true; overSession.startTs=nowTs; overSession.peakDb=currentDb;
      startRecordAudio();   // 超标开始 → 录噪声样本
    }
  } else {
    var sessionDur = (nowTs - overSession.startTs)/1000;
    if(sessionDur >= MAX_SESSION_SEC){ closeAndSaveSession(); return; }
    if(currentDb > overSession.peakDb) overSession.peakDb = currentDb;
    if(currentDb > triggerLevel){ fallTs=null; }
    else {
      if(fallTs===null) fallTs=nowTs;
      else if((nowTs-fallTs)/1000 >= HOLD_AFTER_FALL) closeAndSaveSession();
    }
  }
  // 录像会话内同步记录峰值
  if(recording && currentDb > sessionPeakDb) sessionPeakDb = currentDb;
}

function liveDb(){
  if((!running && !recording) || !soundLive) return;
  computeDb();
  var db=DB.value;
  var dbTxt=db.toFixed(0);
  $("liveDb").textContent=dbTxt+" dB";
  gGauge.f=S.sound; gGauge.c=(db>thr ? "#F5A623" : "#22D3EE"); gGauge.t=dbTxt;
  drawArc($("gSound"), gGauge.f, gGauge.c, gGauge.t);
  var st=$("sSound");
  if(db>thr){ st.textContent="超阈值!"; st.className="gstate alarm"; }
  else if(db>thr-10){ st.textContent="接近阈值"; st.className="gstate warn"; }
  else { st.textContent="正常"; st.className="gstate"; }
  drawScope();
  processOverThreshold(db);
}
function liveLoop(){ if(running||recording){ liveDb(); setTimeout(liveLoop,100); } }

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
  c.strokeStyle="#14202A"; c.lineWidth=1; c.beginPath(); c.moveTo(0,h/2); c.lineTo(w,h/2); c.stroke();
  if(!scopeBuf.length) return;
  var maxAmp=0; for(var s of scopeBuf){ maxAmp=Math.max(maxAmp,Math.abs(s)); }
  var minAmpFloor=0.04; var gain=Math.min(16, minAmpFloor/maxAmp || 1);
  c.strokeStyle="#22D3EE"; c.lineWidth=1.6; c.beginPath();
  var n=scopeBuf.length;
  for(var i=0;i<n;i++){
    var scaled=scopeBuf[i]*gain, y=h/2 - scaled*(h/2)*0.92, x=i*(w/(n-1));
    if(i===0) c.moveTo(x,y); else c.lineTo(x,y);
  }
  c.stroke();
}

/* ---------- GPS ---------- */
var gpsLat=null, gpsLon=null, gpsWatchId=null;
function startGps(){
  if(!navigator.geolocation || gpsWatchId!==null) return;
  gpsWatchId = navigator.geolocation.watchPosition(
    function(pos){ gpsLat=pos.coords.latitude; gpsLon=pos.coords.longitude; },
    function(err){ console.warn("GPS失败",err); },
    { enableHighAccuracy:true, maximumAge:30000, timeout:15000 }
  );
}
function stopGps(){ if(gpsWatchId!==null){ navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId=null; } }

/* ---------- 屏幕常亮 ---------- */
async function acquireWakeLock(){
  if(!("wakeLock" in navigator)){ toast("当前版本不支持网页常亮，请设置系统自动锁定为「永不」"); return; }
  try{
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    toast("✅已开启屏幕常亮");
    document.addEventListener('visibilitychange', async function(){
      if(wakeLockSentinel!==null && document.visibilityState==='visible'){
        try{ wakeLockSentinel = await navigator.wakeLock.request('screen'); }catch(e){}
      }
    });
  }catch(err){ toast("⚠️无法获取屏幕常亮："+err.message); wakeLockSentinel=null; }
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

/* ---------- 主控制：噪声监测 + 视频录制（点「开始监测」同时启动两者） ---------- */
function startMonitor(){
  if(running) return;
  acquireWakeLock();
  startGps();
  resetOverSession();
  noiseFloorDb=30; noiseFloorSamples=0; noiseFloorSum=0;
  ensureStream().then(function(){
    running=true;
    $("btnStart").textContent="监测+录像中 · 停止";
    $("btnStart").className="btn red";
    if(audioCtx) audioCtx.resume();
    startRecording();          // 录像随监测一并开始
    liveLoop();
  }).catch(function(err){ toast("启动失败："+((err&&err.message)||"请检查 HTTPS 与权限")); });
}
async function stopMonitor(){
  running=false;
  stopGps();
  $("btnStart").textContent="开始监测";
  $("btnStart").className="btn primary";
  if(recording) await stopRecording();   // 录像随监测一并停止
  if(audioCtx) audioCtx.suspend();
  await closeAndSaveSession();
}

/* ---------- 日志渲染 ---------- */
/* ---------- 噪声样本播放（含 ×5 放大） ---------- */
var _boostCtx=null;
async function playBoostAudio(dataUrl, boostGain){
  boostGain = boostGain || 5.0;
  if(_boostCtx){ try{ _boostCtx.close(); }catch(e){} _boostCtx=null; }
  _boostCtx = new (window.AudioContext||window.webkitAudioContext)();
  if(_boostCtx.state==='suspended'){ await _boostCtx.resume(); }
  try{
    var b64=dataUrl.split(",")[1], bin=atob(b64), buf=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++){ buf[i]=bin.charCodeAt(i); }
    var ab=await _boostCtx.decodeAudioData(buf.buffer);
    var src=_boostCtx.createBufferSource(); src.buffer=ab;
    var g=_boostCtx.createGain(); g.gain.value=boostGain;
    var comp=_boostCtx.createDynamicsCompressor();
    comp.threshold.value=-18; comp.knee.value=10; comp.ratio.value=4;
    comp.attack.value=0.003; comp.release.value=0.25;
    src.connect(g); g.connect(comp); comp.connect(_boostCtx.destination);
    src.onended=function(){ if(_boostCtx){ _boostCtx.close(); _boostCtx=null; } };
    src.start(0);
  }catch(err){ alert("音频播放失败："+err.message); if(_boostCtx){ _boostCtx.close(); _boostCtx=null; } }
}
// 暴露为全局，供动态生成的日志行内联 onclick 调用（js/1.js 在 IIFE 内，默认不挂到 window）
window.playBoostAudio = playBoostAudio;

function renderLog(){
  $("logCnt").textContent=logArr.length+" 条";
  var b=$("logBody");
  if(!logArr.length){ b.innerHTML='<tr><td colspan="7" class="empty">尚无记录。</td></tr>'; return; }
  b.innerHTML="";
  for(var i=0;i<logArr.length;i++){
    var r=logArr[i];
    var tr=document.createElement("tr"); tr.className="alarm";
    var au = r.audioData
      ? '<audio controls preload="none"><source src="'+r.audioData+'" type="audio/webm">不支持</audio>'+
        '<br><button type="button" class="au-btn" onclick="var s=this.parentElement.querySelector(\'source\');if(s)playBoostAudio(s.src,5.0);">🔊×5</button>'
      : '<span class="muted">—</span>';
    tr.innerHTML=
      '<td>'+(r.timeText||"--")+'</td>'+
      '<td>'+(r.tag||"--")+'</td>'+
      '<td>'+(r.durationSec||"N/A")+'s</td>'+
      '<td>'+r.peakDb+'</td>'+
      '<td class="au">'+au+'</td>'+
      '<td>'+(r.lat??"--")+'</td>'+
      '<td>'+(r.lon??"--")+'</td>';
    b.appendChild(tr);
  }
}

function exportHtmlReport(){
  if(!logArr.length){ toast("暂无日志可导出"); return; }
  var reportTitle="传感器噪声监测报告 "+new Date().toLocaleString();
  var rows="";
  for(var i=0;i<logArr.length;i++){
    var rec=logArr[i];
    var audioHtml = rec.audioData
      ? `<audio controls preload="none" style="height:28px;max-width:240px;"><source src="${rec.audioData}" type="audio/webm">不支持播放</audio><br><button onclick="const s=this.parentElement.querySelector('source');if(s)playBoostAudio(s.src,5.0);">🔊×5放大播放</button>`
      : '<span style="color:#888">无录音片段</span>';
    rows += `<tr style="border-bottom:#ccc 1px solid;">
  <td style="padding:6px 8px">${rec.timeText}</td>
  <td style="padding:6px 8px">${rec.tag||"--"}</td>
  <td style="padding:6px 8px">${rec.durationSec||"N/A"} s</td>
  <td style="padding:6px 8px">${rec.peakDb} dB</td>
  <td style="padding:6px 8px">${audioHtml}</td>
  <td style="padding:6px 8px"><img src="${rec.waveImg}" style="width:280px;border:1px solid #666;"></td>
  <td style="padding:6px 8px">${rec.lat??"--"}</td>
  <td style="padding:6px 8px">${rec.lon??"--"}</td>
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
async function playBoostAudio(dataUrl, boostGain=5.0){
  if(playBoostAudioCtx){ try{ playBoostAudioCtx.close(); }catch(e){} playBoostAudioCtx=null; }
  playBoostAudioCtx=new (window.AudioContext||window.webkitAudioContext)();
  if(playBoostAudioCtx.state==='suspended'){ await playBoostAudioCtx.resume(); }
  try{
    const b64=dataUrl.split(",")[1]; const bin=atob(b64); const buf=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++){ buf[i]=bin.charCodeAt(i); }
    const ab=await playBoostAudioCtx.decodeAudioData(buf.buffer);
    const src=playBoostAudioCtx.createBufferSource(); src.buffer=ab;
    const g=playBoostAudioCtx.createGain(); g.gain.value=boostGain;
    const comp=playBoostAudioCtx.createDynamicsCompressor();
    comp.threshold.value=-18; comp.knee.value=10; comp.ratio.value=4;
    comp.attack.value=0.003; comp.release.value=0.25;
    src.connect(g); g.connect(comp); comp.connect(playBoostAudioCtx.destination);
    src.onended=()=>{ if(playBoostAudioCtx){ playBoostAudioCtx.close(); playBoostAudioCtx=null; } };
    src.start(0);
  }catch(err){ alert("音频播放失败："+err.message); if(playBoostAudioCtx){ playBoostAudioCtx.close(); playBoostAudioCtx=null; } }
}
</script>
</head><body><h2>${reportTitle}</h2>
<p>当前阈值：&gt;${thr} dB；最小记录时长：${MIN_RECORD_SEC}s；录像分片见后台 /review.html</p>
<table><thead><tr><th>触发时间</th><th>标签</th><th>持续秒数</th><th>峰值dB</th><th>噪声录音</th><th>噪声波形截图</th><th>纬度</th><th>经度</th></tr></thead>
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
  if(running){ await stopMonitor(); toast("监测与录像已停止"); } else startMonitor();
});
$("btnClear").addEventListener("click", function(){ logArr=[]; resetOverSession(); saveLog(); renderLog(); toast("日志已清空"); });
$("btnExport").addEventListener("click", exportHtmlReport);

setInterval(function(){ $("sssb").innerHTML="实时声波 - "+formatFullTime(new Date()); },1000);

function toast(msg){
  var t=$("toast"); t.textContent=msg; t.className="toast show";
  clearTimeout(t._h); t._h=setTimeout(function(){ t.className="toast"; },2600);
}

// 录像标签自动记忆：输入即保存，下次打开同浏览器自动回填，避免每次重新输入
(function(){
  var _ti=$("tagInput");
  if(_ti){
    try{ var _sv=localStorage.getItem("qs_video_tag"); if(_sv) _ti.value=_sv; }catch(e){}
    _ti.addEventListener("input", function(){
      try{ localStorage.setItem("qs_video_tag", _ti.value.trim()); }catch(e){}
    });
  }
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
  if(running||recording) computeDb();
  drawScope();
});

})();
