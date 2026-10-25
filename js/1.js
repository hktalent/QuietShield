(function(){
"use strict";

// 底噪上下限，防止漂移
const MIN_NOISE_FLOOR = 25;
const MAX_NOISE_FLOOR = 60;
const CAL = 103;
const DB_OFFSET = 94;

var wakeLockSentinel = null;
var mediaRecorder = null;
var recordedChunks = [];
var micStream = null;

// ===== 后台 CSV 推送 =====
// 同源部署即可；如跨域可改成 "https://你的服务器:8088/api/log"
const LOG_API_URL = "/api/log";
async function pushLogToServer(record){
  try{
    const resp = await fetch(LOG_API_URL,{
      method:"POST",
      headers:{
        "Content-Type":"application/json"  // ✅普通英文减号
      },
      body:JSON.stringify(record)
    });
    if(!resp.ok){
      // http状态非200抛出异常
      throw new Error(`HTTP status: ${resp.status}`);
    }
    const ret = await resp.json();
    console.log("推送日志成功",ret);
  }catch(err){
    console.warn("推送日志失败，不影响本地存储",err);
    // 可选：toast提示用户
    // toast("⚠️后台日志推送失败");
  }
}
// 请求屏幕常亮
async function acquireWakeLock(){
  if(!("wakeLock" in navigator)){
    toast("当前iOS版本不支持网页常亮，请设置系统自动锁定为「永不」");
    return;
  }
  try{
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    toast("✅已开启屏幕常亮(PWA模式)");
    document.addEventListener('visibilitychange', async ()=>{
      if(wakeLockSentinel !== null && document.visibilityState === 'visible'){
        try{
          wakeLockSentinel = await navigator.wakeLock.request('screen');
        }catch(e){}
      }
    });
  }catch(err){
    toast("⚠️无法获取屏幕常亮："+err.message+"，请将网页【添加到主屏幕】打开");
    wakeLockSentinel=null;
  }
}

async function releaseWakeLock(){
  if(wakeLockSentinel){
    try{await wakeLockSentinel.release();}catch(e){}
    wakeLockSentinel=null;
    toast("已关闭屏幕常亮");
  }
}

var $=function(id){return document.getElementById(id);};
var S={sound:0,mag:0,vib:0};
var DB={value:0};

var thr=60;
const MIN_RECORD_SEC = 0.2;
var logArr=[];
var running=false;
var soundLive=false, motionLive=false;
var magMode="compass";
var magSensor=null;
var magX=0, magY=0, magZ=0, magTotalUt=0;

// GPS定位
var gpsLat = null;
var gpsLon = null;
var gpsWatchId = null;
const GPS_REFRESH_INTERVAL = 30000; // 30秒刷新一次位置

// 启动持续定位监听
function startGps(){
  if(!navigator.geolocation){
    toast("⚠️浏览器不支持地理位置");
    return;
  }
  if(gpsWatchId !== null) return;
  gpsWatchId = navigator.geolocation.watchPosition(
    function(pos){
      gpsLat = pos.coords.latitude;
      gpsLon = pos.coords.longitude;
    },
    function(err){
      console.warn("GPS获取失败",err);
      // 用户拒绝/超时，保留旧坐标，不清空
    },
    {
      enableHighAccuracy:true,
      maximumAge:GPS_REFRESH_INTERVAL,
      timeout:15000
    }
  );
}

// 停止定位
function stopGps(){
  if(gpsWatchId !== null){
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
}

// 修复时间判断：6点(含)~22点(不含)为昼间；22点~次日6点为夜间
function setThr(){
  var h = new Date().getHours();
  if(h >=6 && h < 22){
    thr=55;
  }else{
    thr=45;
  }
}


// ========== 超标会话状态机 ==========
var overSession = {
  active: false,
  startTs: 0,
  peakDb: 0,
  magSnap: "",
  vibSnap: 0
};

function resetOverSession(){
  overSession.active = false;
  overSession.startTs = 0;
  overSession.peakDb = 0;
  overSession.magSnap = "";
  overSession.vibSnap = 0;
}

function formatFullTime(timestampMs){
  const d = new Date(timestampMs);
  const y = d.getFullYear();
  const m = ("0"+(d.getMonth()+1)).slice(-2);
  const day = ("0"+d.getDate()).slice(-2);
  const hh = ("0"+d.getHours()).slice(-2);
  const mm = ("0"+d.getMinutes()).slice(-2);
  const ss = ("0"+d.getSeconds()).slice(-2);
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

/* ---------- 存储 ---------- */
function loadLog(){
  try{
    var r=JSON.parse(localStorage.getItem("sm_log")||"[]");
    if(Array.isArray(r)) logArr=r;
  }catch(e){logArr=[];}
  renderLog();
}

function saveLog(){
  try{localStorage.setItem("sm_log",JSON.stringify(logArr));}catch(e){
    toast("⚠️本地存储已满，无法保存日志");
  }
}

loadLog();

function startRecordAudio(){
  if(!micStream) return;
  try{
    recordedChunks = [];
    let options = { mimeType: "audio/webm" };
    if(!MediaRecorder.isTypeSupported(options.mimeType)){
      options = { mimeType: "" };
    }
    mediaRecorder = new MediaRecorder(micStream, options);
    mediaRecorder.ondataavailable = function(e){
      if(e.data.size>0) recordedChunks.push(e.data);
    };
    mediaRecorder.start();
  }catch(err){
    console.warn("录音启动失败",err);
    mediaRecorder = null;
  }
}

async function stopRecordAudio(){
  return new Promise((resolve)=>{
    if(!mediaRecorder || mediaRecorder.state==="inactive"){
      resolve(null);
      return;
    }
    mediaRecorder.onstop = async ()=>{
      const blob = new Blob(recordedChunks, {type:"audio/webm"});
      const reader = new FileReader();
      reader.onloadend = ()=>{
        resolve(reader.result);
      };
      reader.readAsDataURL(blob);
    };
    mediaRecorder.stop();
  });
}

/* ---------- 绘制工具 ---------- */
function drawArc(canvas,frac,color){
  var dpr=window.devicePixelRatio||1;
  var w=canvas.clientWidth,h=canvas.clientHeight;
  canvas.width=w*dpr;canvas.height=h*dpr;
  var c=canvas.getContext("2d");
  c.setTransform(dpr,0,0,dpr,0,0);
  var r=Math.min(w,h)/2-6;
  var cx=w/2,cy=h*0.86;
  var a0=Math.PI*0.9,a1=Math.PI*2.1;
  c.clearRect(0,0,w,h);
  c.lineWidth=7;c.lineCap="round";
  c.strokeStyle="#1E2A35";
  c.beginPath();c.arc(cx,cy,r,a0,a1);c.stroke();
  var val=Math.max(0,Math.min(1,frac));
  var ang=a0+(a1-a0)*val;
  var g=c.createLinearGradient(0,0,w,0);
  if(frac>0.95){g.addColorStop(0,"#F5A623");g.addColorStop(1,"#EF4444");}
  else{g.addColorStop(0,color);g.addColorStop(1,"#34D399");}
  c.strokeStyle=g;
  c.beginPath();c.arc(cx,cy,r,a0,ang);c.stroke();
  c.fillStyle="#7B8A99";
  [0,0.5,1].forEach(function(t){
    var a=a0+(a1-a0)*t;
    c.beginPath();c.arc(cx+Math.cos(a)*r,cy+Math.sin(a)*r,1.8,0,6.283);c.fill();
  });
}

function drawScope(){
  var cv=$("scope");
  var dpr=window.devicePixelRatio||1;
  var w=cv.clientWidth,h=cv.clientHeight;
  cv.width=w*dpr;cv.height=h*dpr;
  var c=cv.getContext("2d");
  c.setTransform(dpr,0,0,dpr,0,0);
  c.fillStyle="#080C10";
  c.fillRect(0,0,w,h);
  c.strokeStyle="#14202A";
  c.lineWidth=1;
  var mid=h/2;
  c.beginPath();
  c.moveTo(0,mid);
  c.lineTo(w,mid);
  c.stroke();

  if(!scopeBuf.length){return;}

  let maxAmp = 0;
  for(let s of scopeBuf){
    maxAmp = Math.max(maxAmp, Math.abs(s));
  }
  const minAmpFloor = 0.04;
  let gain = Math.min(16, minAmpFloor / maxAmp || 1);

  c.strokeStyle="#22D3EE";
  c.lineWidth=1.6;
  c.beginPath();
  var n=scopeBuf.length;
  for(var i=0;i<n;i++){
    const scaled = scopeBuf[i] * gain;
    var y=mid - scaled * mid * 0.92;
    const x = i*(w/(n-1));
    if(i===0) c.moveTo(x,y);
    else c.lineTo(x,y);
  }
  c.stroke();
}

/* ---------- 麦克风 / 声压 ---------- */
var audioCtx=null,analyser=null,micData=null;
var scopeBuf=[];

// ===== 底噪自校准 =====
var noiseFloorDb = 30;       // 初始底噪（保守值）
var noiseFloorSamples = 0;
var noiseFloorSum = 0;
var NOISE_FLOOR_CAL_SEC = 2; // 校准时长（秒）
var NOISE_FLOOR_ALPHA = 0.02;// 安静期慢更新

function initAudio(){
  if(audioCtx)return Promise.resolve();
  return navigator.mediaDevices.getUserMedia({
    audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}
  })
  .then(function(stream){
    micStream = stream;
    audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    var src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.12;
    src.connect(analyser);
    micData = new Float32Array(analyser.fftSize);
    $("dSound").className="dot live";
    soundLive=true;
    return null;
  });
}

function computeDb(){
  if(!analyser)return;
  analyser.getFloatTimeDomainData(micData);

  // DC 偏移校正
  let sum = 0;
  for(let i=0;i<micData.length;i++) sum += micData[i];
  const dc = sum / micData.length;

  let sumSq = 0;
  for(let i=0;i<micData.length;i++){
    const v = micData[i] - dc;
    sumSq += v*v;
  }
  const rms = Math.sqrt(sumSq / micData.length);

  // SPL 映射（94 dB @ 1 Pa）手机网页麦克风没有校准
  const DB_OFFSET = 94;
  let db = DB_OFFSET + 20 * Math.log10(rms + 1e-6) + CAL - 94;

  if(!isFinite(db) || db < 20) db = 20;
  if(db > 120) db = 120;

  DB.value = db;
  S.sound = Math.max(0, Math.min(1,(db-20)/70));

  // 波形数据
  scopeBuf = [];
  const step = Math.max(1, Math.floor(micData.length / 320));
  for(let k=0;k<micData.length;k+=step){
    scopeBuf.push(micData[k] - dc);
  }
  if(scopeBuf.length>400) scopeBuf = scopeBuf.slice(-400);

  // ===== 底噪自校准 =====
  if(!overSession.active){
    if(noiseFloorSamples < NOISE_FLOOR_CAL_SEC * 10){
      // 初始阶段：快速平均
      noiseFloorSum += db;
      noiseFloorSamples++;
      if(noiseFloorSamples === NOISE_FLOOR_CAL_SEC * 10){
        noiseFloorDb = noiseFloorSum / noiseFloorSamples;
        noiseFloorDb = Math.max(MIN_NOISE_FLOOR, Math.min(MAX_NOISE_FLOOR, noiseFloorDb));
      }
    } else {
      // 安静期慢更新（防止半夜漂移）
      if(db < noiseFloorDb + 3){
        noiseFloorDb = noiseFloorDb * (1 - NOISE_FLOOR_ALPHA) + db * NOISE_FLOOR_ALPHA;
        noiseFloorDb = Math.max(MIN_NOISE_FLOOR, Math.min(MAX_NOISE_FLOOR, noiseFloorDb));
      }
    }
  }
}

async function closeAndSaveSession(){
  if(!overSession.active) return;
  var nowTs=Date.now();
  var durSec = ((nowTs - overSession.startTs)/1000).toFixed(1);
  let audioB64 = await stopRecordAudio();
  if(parseFloat(durSec)>=MIN_RECORD_SEC){
    var waveImgB64 = $("scope").toDataURL("image/png");
    const fullTimeStr = formatFullTime(overSession.startTs);
    logArr.unshift({
      timeText: fullTimeStr,
      timeTs: overSession.startTs,
      durationSec: durSec,
      peakDb: overSession.peakDb.toFixed(1),
      mag: overSession.magSnap,
      vib: overSession.vibSnap.toFixed(2),
      waveImg: waveImgB64,
      audioData: audioB64,
      // 新增GPS
      lat: gpsLat !==null ? gpsLat.toFixed(6) : null,
      lon: gpsLon !==null ? gpsLon.toFixed(6) : null
    });

    if(logArr.length>300) logArr.length=300;
    saveLog();
    renderLog();
    // 后台异步推送，不阻塞主逻辑
    pushLogToServer({
      timeText: fullTimeStr,
      timeTs: overSession.startTs,
      durationSec: durSec,
      peakDb: overSession.peakDb.toFixed(1),
      mag: overSession.magSnap,
      vib: overSession.vibSnap.toFixed(2),
      lat: gpsLat !==null ? gpsLat.toFixed(6) : null,
      lon: gpsLon !==null ? gpsLon.toFixed(6) : null,
      audioData:audioB64
    });
  }
  resetOverSession();
}

// ===== 超标检测（使用底噪）=====
var fallTs = null;
const TRIG_OFFSET = 6;        // 底噪之上 6 dB 触发
const HOLD_AFTER_FALL = 0.4;
const MAX_SESSION_SEC = 12;

function processOverThreshold(currentDb){
  const nowTs = Date.now();
  const magSnapTxt = magMode==="magnetometer" ? (magTotalUt.toFixed(1)+" µT") : $("compass").textContent;
  const triggerLevel = noiseFloorDb + TRIG_OFFSET;

  if(!overSession.active){
    fallTs = null;
    if(noiseFloorSamples < NOISE_FLOOR_CAL_SEC * 10) return;
    // ========== 修复：两个条件同时满足：高于动态相对阈值 AND 大于UI设置的绝对thr ==========
    setThr();
    if(currentDb > triggerLevel && currentDb > thr){
      overSession.active = true;
      overSession.startTs = nowTs;
      overSession.peakDb = currentDb;
      overSession.magSnap = magSnapTxt;
      overSession.vibSnap = vibSmooth;
      startRecordAudio();
    }
  }else{
    const sessionDur = (nowTs - overSession.startTs)/1000;
    if(sessionDur >= MAX_SESSION_SEC){
      closeAndSaveSession();
      return;
    }
    if(currentDb > overSession.peakDb){
      overSession.peakDb = currentDb;
      overSession.magSnap = magSnapTxt;
      overSession.vibSnap = vibSmooth;
    }
    // ==========修复：回落判断：低于触发门限就开始倒计时，而不是低于底噪==========
    if(currentDb > triggerLevel){
      fallTs = null;
    }else{
      if(fallTs === null){
        fallTs = nowTs;
      }else{
        if((nowTs - fallTs)/1000 >= HOLD_AFTER_FALL){
          closeAndSaveSession();
        }
      }
    }
  }
}

function liveDb(){
  if(!running||!soundLive)return;
  computeDb();
  var db=DB.value;
  $("vSound").textContent=db.toFixed(0);
  $("liveDb").textContent=db.toFixed(0)+" dB";
  drawArc($("gSound"),S.sound,db>thr?"#F5A623":"#22D3EE");
  var st=$("sSound");
  if(db>thr){st.textContent="超阈值!";st.className="gstate alarm";}
  else if(db>thr-10){st.textContent="接近阈值";st.className="gstate warn";}
  else{st.textContent="正常";st.className="gstate";}
  drawScope();
  processOverThreshold(db);
}

/* ---------- 振动 ---------- */
var acc={x:0,y:0,z:0};
var vibSmooth=0;
function onMotion(e){
  var a=e.acceleration||{x:0,y:0,z:0};
  acc={x:a.x||0,y:a.y||0,z:a.z||0};
  var mag=Math.sqrt(acc.x*acc.x+acc.y*acc.y+acc.z*acc.z);
  vibSmooth=vibSmooth*0.85+mag*0.15;
  S.vib=Math.max(0,Math.min(1,vibSmooth/12));
  if(!running)return;
  $("vVib").textContent=vibSmooth.toFixed(2);
  $("vibX").textContent=acc.x.toFixed(1);
  $("vibY").textContent=acc.y.toFixed(1);
  $("vibZ").textContent=acc.z.toFixed(1);
  drawArc($("gVib"),S.vib,"#34D399");
  var st=$("sVib");
  if(vibSmooth>4){st.textContent="强烈振动";st.className="gstate alarm";}
  else if(vibSmooth>1.5){st.textContent="振动明显";st.className="gstate warn";}
  else{st.textContent="平稳";st.className="gstate";}
}

function initMotion(){
  if(motionLive)return Promise.resolve();
  var req=window.DeviceMotionEvent&&DeviceMotionEvent.requestPermission?
    DeviceMotionEvent.requestPermission():Promise.resolve("granted");
  return req.then(function(state){
    if(state!=="granted"){throw new Error("motion-denied");}
    window.addEventListener("devicemotion",onMotion,false);
    $("dVib").className="dot live";
    motionLive=true;
    return null;
  });
}

/* ---------- 磁场 / 罗盘 ---------- */
function onOrient(e){
  if(!running)return;
  var head=(typeof e.webkitCompassHeading==="number")?e.webkitCompassHeading:null;
  if(head===null)return;
  $("compass").textContent=Math.round(head)+"°";
  S.mag=head/360;
  drawArc($("gMag"),S.mag,"#A78BFA");
}

function initMagnetometer(){
  if(!("Magnetometer" in window)){
    magMode="compass";
    $("uMag").textContent="方向";
    return;
  }
  magMode="magnetometer";
  try{
    magSensor=new Magnetometer({frequency:20});
    magSensor.addEventListener("reading",function(){
      magX = magSensor.x;
      magY = magSensor.y;
      magZ = magSensor.z;
      magTotalUt = Math.sqrt(magX*magX + magY*magY + magZ*magZ);
      $("uMag").textContent="µT";
      $("vMag").textContent=magTotalUt.toFixed(1);
      $("compass").textContent=Math.round(magX)+","+Math.round(magY)+","+Math.round(magZ);
      S.mag=Math.min(1, magTotalUt / 120);
      drawArc($("gMag"), S.mag,"#A78BFA");
      $("dMag").className="dot live";
    });
    magSensor.addEventListener("error",function(err){
      magMode="compass";
      $("uMag").textContent="方向";
      magSensor=null;
    });
    magSensor.start();
  }catch(err){
    magMode="compass";
    $("uMag").textContent="方向";
    magSensor=null;
  }
}

function initCompass(){
  if(window.DeviceOrientationEvent&&DeviceOrientationEvent.requestPermission){
    DeviceOrientationEvent.requestPermission().then(function(state){
      if(state==="granted"){
        window.addEventListener("deviceorientation",onOrient,false);
        if(magMode==="compass") $("dMag").className="dot live";
      }
    }).catch(function(){});
  }else if(window.DeviceOrientationEvent){
    window.addEventListener("deviceorientation",onOrient,false);
  }
}

/* ---------- 日志渲染 ---------- */
function renderLog(){
  $("logCnt").textContent=logArr.length+" 条";
  var b=$("logBody");
  if(!logArr.length){
    b.innerHTML='<tr><td colspan="5" class="empty">尚无记录。开始监测后，声压超过阈值持续一段时间会记入日志。</td></tr>';
    return;
  }
  b.innerHTML="";
  for(var i=0;i<logArr.length;i++){
    var r=logArr[i];
    var tr=document.createElement("tr");
    tr.className="alarm";
    tr.innerHTML=
      '<td>'+(r.timeText||"--")+'</td>'+
      '<td>'+(r.durationSec||"N/A")+'s</td>'+
      '<td>'+r.peakDb+'</td>'+
      '<td>'+(r.lat??"--")+'</td>'+
      '<td>'+(r.lon??"--")+'</td>';
    b.appendChild(tr);
  }
}

function exportHtmlReport(){
  if(!logArr.length){toast("暂无日志可导出");return;}
  var reportTitle="传感器声‑磁‑振监测报告 "+new Date().toLocaleString();
  var tableRows="";
  for(var i=0;i<logArr.length;i++){
    var rec=logArr[i];
    let audioHtml = "";
    if(rec.audioData){
      audioHtml = `<audio controls preload="none" style="height:28px;max-width:240px;"><source src="${rec.audioData}" type="audio/webm">你的浏览器不支持播放该音频`;
    }else{
      audioHtml = `<span style="color:#888">无录音片段</span>`;
    }
    tableRows += `
<tr style="border-bottom:#ccc 1px solid;">
  <td style="padding:6px 8px">${rec.timeText}</td>
  <td style="padding:6px 8px">${rec.durationSec||"N/A"} s</td>
  <td style="padding:6px 8px">${rec.peakDb} dB</td>
  <td style="padding:6px 8px">${rec.mag}</td>
  <td style="padding:6px 8px">${rec.vib} m/s²</td>
  <td style="padding:4px;">${audioHtml}</td>
  <td style="padding:4px;"><img src="${rec.waveImg}" style="width:280px;border:1px solid #666;"></td>
  <td style="padding:6px 8px">${rec.lat??"--"}</td>
  <td style="padding:6px 8px">${rec.lon??"--"}</td>
</tr>
`;
  }
  var htmlOut=`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${reportTitle}</title>
<style>
body{font-family:system-ui,monospace;padding:16px;background:#f8f8f8;color:#111;}
h2{margin-bottom:12px;}
p{margin:4px 0 12px;}
table{border-collapse:collapse;width:100%;font-size:12px;}
th{background:#222;color:#fff;padding:8px;text-align:left;}
td{background:#fff;}
img{max-width:100%;}
audio{vertical-align:middle;}
</style>
</head>
<body>
<h2>${reportTitle}</h2>
<p>当前阈值：>${thr} dB；最小记录时长：${MIN_RECORD_SEC}s；全部数据本地采集，无网络上传</p>
<table>
<thead>
<tr>
<th>触发时间(年‑月‑日 时:分:秒)</th>
<th>持续秒数</th>
<th>峰值dB</th>
<th>磁场</th>
<th>振动m/s²</th>
<th>噪声录音</th>
<th>噪声波形截图</th>
<th>纬度</th>
<th>经度</th>
</tr>
</thead>
<tbody>
${tableRows}
</tbody>
</table>
</body>
</html>`;
  var blob=new Blob([htmlOut],{type:"text/html;charset=utf‑8"});
  var a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="传感监测报告_"+new Date().toISOString().slice(0,10)+".html";
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast("已导出HTML报告，"+logArr.length+"条记录，含波形与噪声录音");
}

/* ---------- 主循环 ---------- */
function start(){
  if(running)return;
  acquireWakeLock();
  startGps(); // 开启定位
  resetOverSession();

  // 重置底噪校准
  noiseFloorDb = 30;
  noiseFloorSamples = 0;
  noiseFloorSum = 0;

  var init=Promise.resolve()
    .then(initAudio).then(initMotion).then(function(){
      initMagnetometer();
      initCompass();
    });
  init.then(function(){
    running=true;
    $("btnStart").textContent="监测中 · 停止";
    $("btnStart").className="btn red";
    audioCtx&&audioCtx.resume();
    liveLoop();
  }).catch(function(err){
    toast("启动失败："+(err&&err.message||"请检查 HTTPS 与权限"));
  });
}

async function stop(){
  running=false;
  stopGps(); //关闭定位
  $("btnStart").textContent="开始监测";
  $("btnStart").className="btn primary";
  if(audioCtx)audioCtx.suspend();
  await closeAndSaveSession();
}

function liveLoop(){
  if(!running)return;
  liveDb();
  setTimeout(liveLoop,100);
}

/* ---------- 事件 ---------- */
$("btnStart").addEventListener("click",async function(){
  if(running){await stop();toast("监测已停止");}else{start();}
});
$("btnClear").addEventListener("click",function(){
  logArr=[];
  resetOverSession();
  saveLog();renderLog();toast("日志已清空");
});
$("btnExport").addEventListener("click",exportHtmlReport);

function setSecure(){
  var ok=window.isSecureContext===true;
}
setSecure();

function toast(msg){
  var t=$("toast");
  t.textContent=msg;
  t.className="toast show";
  clearTimeout(t._h);
  t._h=setTimeout(function(){t.className="toast";},2600);
}

drawArc($("gSound"),0,"#22D3EE");
drawArc($("gMag"),0,"#A78BFA");
drawArc($("gVib"),0,"#34D399");
drawScope();

window.addEventListener("resize",function(){
  if(running){computeDb();}
  drawScope();
});

})();
