/* 噪声样本播放器（全局函数，供三处共用）：
 *   - 前端页面 js/1.js（本文件须先于 1.js 加载）
 *   - 服务端日志 logs/noise_log_*.html（HTML_HEADER 以 <script src="../js/player.js"> 引用）
 *   - 前端导出报告（通过 playClearAudio.toString()/playBoostAudio.toString() 自包含嵌入）
 *
 * playClearAudio —— 「降噪清晰播放」：离线谱减法，从样本自身安静帧估计背景噪声谱 →
 *   全段谱减（稳态嗡声/嘶声被减掉，撞击瞬态不在噪声谱中故保留）；不切低频，
 *   "咚"的能量主体(50-200Hz)完整保留；再做撞击瞬态增强 + 峰值归一化。
 * playBoostAudio —— 「5倍音量播放」：整体增益 ×5，峰值超 0.95 自动限幅，不做任何滤波。 */

async function playClearAudio(dataUrl){
  if(playClearAudio._ctx){ try{playClearAudio._ctx.close();}catch(e){} playClearAudio._ctx=null; }
  var ctx=new (window.AudioContext||window.webkitAudioContext)();
  playClearAudio._ctx=ctx;
  if(ctx.state==='suspended') await ctx.resume();
  function fft(re,im,inv){
    var n=re.length,i,j,bit,t;
    for(i=1,j=0;i<n;i++){ bit=n>>1; for(;j&bit;bit>>=1) j^=bit; j^=bit;
      if(i<j){ t=re[i];re[i]=re[j];re[j]=t; t=im[i];im[i]=im[j];im[j]=t; } }
    for(var L=2;L<=n;L<<=1){
      var ang=2*Math.PI/L*(inv?1:-1), wr=Math.cos(ang), wi=Math.sin(ang), h=L>>1;
      for(i=0;i<n;i+=L){ var cwr=1,cwi=0;
        for(j=0;j<h;j++){
          var ur=re[i+j], ui=im[i+j];
          var vr=re[i+j+h]*cwr-im[i+j+h]*cwi, vi=re[i+j+h]*cwi+im[i+j+h]*cwr;
          re[i+j]=ur+vr; im[i+j]=ui+vi; re[i+j+h]=ur-vr; im[i+j+h]=ui-vi;
          t=cwr*wr-cwi*wi; cwi=cwr*wi+cwi*wr; cwr=t; } } }
    if(inv) for(i=0;i<n;i++){ re[i]/=n; im[i]/=n; }
  }
  try{
    var b64=dataUrl.split(",")[1], bin=atob(b64), raw=new Uint8Array(bin.length);
    for(var i0=0;i0<bin.length;i0++) raw[i0]=bin.charCodeAt(i0);
    var abuf=await ctx.decodeAudioData(raw.buffer);
    var sr=abuf.sampleRate, len=abuf.length, chs=abuf.numberOfChannels;
    var x=new Float32Array(len);
    for(var c=0;c<chs;c++){ var dd=abuf.getChannelData(c); for(var i=0;i<len;i++) x[i]+=dd[i]/chs; }
    var N=2048, HOP=512, B=N/2+1;
    var win=new Float32Array(N);
    for(var k=0;k<N;k++) win[k]=0.5*(1-Math.cos(2*Math.PI*k/N));
    var nF=Math.max(1, Math.floor((len-N)/HOP)+1);
    var mags=[], phs=[], re=new Float32Array(N), im=new Float32Array(N);
    for(var f=0;f<nF;f++){
      var off=f*HOP;
      for(k=0;k<N;k++){ re[k]=(off+k<len?x[off+k]:0)*win[k]; im[k]=0; }
      fft(re,im,false);
      var mg=new Float32Array(B), ph=new Float32Array(B);
      for(var b=0;b<B;b++){ mg[b]=Math.sqrt(re[b]*re[b]+im[b]*im[b]); ph[b]=Math.atan2(im[b],re[b]); }
      mags.push(mg); phs.push(ph);
    }
    // 背景噪声谱：每个频 bin 取 25% 分位数（撞击稀疏，多数帧是纯背景）
    var noise=new Float32Array(B), col=new Float32Array(nF);
    for(var b2=0;b2<B;b2++){
      for(var f2=0;f2<nF;f2++) col[f2]=mags[f2][b2];
      col.sort();
      noise[b2]=col[Math.floor(nF*0.25)]||1e-8;
    }
    // 谱减增益 + 时间平滑（attack 快 release 慢，防音乐噪声）
    var ALPHA=2.5, FLR=0.06, prev=new Float32Array(B), gains=[];
    for(var f3=0;f3<nF;f3++){
      var g=new Float32Array(B);
      for(var b3=0;b3<B;b3++){
        var m=mags[f3][b3], gg=(m-ALPHA*noise[b3])/(m+1e-10);
        gg=gg<FLR?FLR:(gg>1?1:gg);
        gg=Math.max(gg, prev[b3]*0.7); prev[b3]=gg; g[b3]=gg;
      }
      gains.push(g);
    }
    // 撞击瞬态增强：帧能量超背景中位数 3 倍以上时最多再放大 2 倍
    var en=new Float32Array(nF);
    for(var f4=0;f4<nF;f4++){ var e=0; for(var b4=0;b4<B;b4++) e+=mags[f4][b4]*gains[f4][b4]; en[f4]=e; }
    var es=Float32Array.from(en).sort(), base=(es[Math.floor(nF*0.5)]||0)+1e-10;
    // 重建（OLA，窗平方归一化）
    var out=new Float32Array(nF*HOP+N), nrm=new Float32Array(out.length);
    for(var f5=0;f5<nF;f5++){
      var tb=1+Math.min(1, Math.max(0, en[f5]/(base*3)-1))*1.0, off5=f5*HOP;
      for(var b5=0;b5<B;b5++){
        var m2=mags[f5][b5]*gains[f5][b5]*tb;
        re[b5]=m2*Math.cos(phs[f5][b5]); im[b5]=m2*Math.sin(phs[f5][b5]);
      }
      for(var b6=B;b6<N;b6++){ re[b6]=re[N-b6]; im[b6]=-im[N-b6]; }
      fft(re,im,true);
      for(var k2=0;k2<N;k2++){ var ix=off5+k2; out[ix]+=re[k2]*win[k2]; nrm[ix]+=win[k2]*win[k2]; }
    }
    var peak=1e-6;
    for(var i2=0;i2<out.length;i2++){ if(nrm[i2]>1e-6) out[i2]/=nrm[i2]; var a=Math.abs(out[i2]); if(a>peak) peak=a; }
    var sc=0.95/peak; if(sc>20) sc=20;   // 峰值归一化，最多放大 20 倍
    for(var i3=0;i3<out.length;i3++) out[i3]*=sc;
    var ob=ctx.createBuffer(1, out.length, sr);
    ob.getChannelData(0).set(out);
    var src=ctx.createBufferSource(); src.buffer=ob;
    src.connect(ctx.destination);
    src.onended=function(){ if(playClearAudio._ctx){ try{playClearAudio._ctx.close();}catch(e){} playClearAudio._ctx=null; } };
    src.start(0);
  }catch(err){
    console.warn("降噪清晰播放失败，改用原始播放", err);
    if(playClearAudio._ctx){ try{playClearAudio._ctx.close();}catch(e){} playClearAudio._ctx=null; }
    try{ new Audio(dataUrl).play(); }catch(e2){}
  }
}

async function playBoostAudio(dataUrl){
  if(playBoostAudio._ctx){ try{playBoostAudio._ctx.close();}catch(e){} playBoostAudio._ctx=null; }
  var ctx=new (window.AudioContext||window.webkitAudioContext)();
  playBoostAudio._ctx=ctx;
  if(ctx.state==='suspended') await ctx.resume();
  try{
    var b64=dataUrl.split(",")[1], bin=atob(b64), raw=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++) raw[i]=bin.charCodeAt(i);
    var abuf=await ctx.decodeAudioData(raw.buffer);
    var peak=1e-6, c, d, i2;
    for(c=0;c<abuf.numberOfChannels;c++){ d=abuf.getChannelData(c);
      for(i2=0;i2<d.length;i2++){ var a=Math.abs(d[i2]); if(a>peak) peak=a; } }
    var g=5; if(peak*g>0.95) g=0.95/peak;   // ×5 增益，限幅到峰值 0.95
    for(c=0;c<abuf.numberOfChannels;c++){ d=abuf.getChannelData(c);
      for(i2=0;i2<d.length;i2++) d[i2]*=g; }
    var src=ctx.createBufferSource(); src.buffer=abuf;
    src.connect(ctx.destination);
    src.onended=function(){ if(playBoostAudio._ctx){ try{playBoostAudio._ctx.close();}catch(e){} playBoostAudio._ctx=null; } };
    src.start(0);
  }catch(err){
    console.warn("5倍音量播放失败，改用原始播放", err);
    if(playBoostAudio._ctx){ try{playBoostAudio._ctx.close();}catch(e){} playBoostAudio._ctx=null; }
    try{ new Audio(dataUrl).play(); }catch(e2){}
  }
}
