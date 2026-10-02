/* 看台與教學頁共用的數學。兩頁的機率、區間一律從這裡算，數字才不會一頁一個樣。
   只放純函式，不碰任何頁面狀態。 */
"use strict";
/* ============ math ============ */
var SQ2PI = Math.sqrt(2*Math.PI);
function ndf(x){ return Math.exp(-0.5*x*x)/SQ2PI; }
function ncdf(x){
  var a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  var s = x<0?-1:1; var z = Math.abs(x)/Math.SQRT2;
  var t = 1/(1+p*z);
  var y = 1-((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-z*z);
  return 0.5*(1+s*y);
}
/* Black-76 on a futures underlying. T in years, sig annualised. */
function b76(F,K,T,r,sig,isCall){
  var df = Math.exp(-r*T);
  if(T<=0 || sig<=0){
    var iv = isCall ? Math.max(0,F-K) : Math.max(0,K-F);
    var d = isCall ? (F>K?1:0) : (F<K?-1:0);
    return {price:iv*df, delta:d*df, gamma:0, vega:0, theta:0};
  }
  var v = sig*Math.sqrt(T);
  var d1 = (Math.log(F/K) + 0.5*sig*sig*T)/v;
  var d2 = d1 - v;
  var nd1 = ncdf(d1), nd2 = ncdf(d2), pdf = ndf(d1);
  var price, delta, theta;
  if(isCall){
    price = df*(F*nd1 - K*nd2);
    delta = df*nd1;
    theta = -F*df*pdf*sig/(2*Math.sqrt(T)) - r*K*df*nd2 + r*F*df*nd1;
  }else{
    price = df*(K*(1-nd2) - F*(1-nd1));
    delta = -df*(1-nd1);
    theta = -F*df*pdf*sig/(2*Math.sqrt(T)) + r*K*df*(1-nd2) - r*F*df*(1-nd1);
  }
  return {
    price:price, delta:delta,
    gamma: df*pdf/(F*v),
    vega: df*F*pdf*Math.sqrt(T)/100,   // per 1 vol point
    theta: theta/365                    // per calendar day
  };
}
function solveIV(mkt,F,K,T,r,isCall){
  if(!(mkt>0) || T<=0) return NaN;
  var intr = Math.exp(-r*T)*(isCall?Math.max(0,F-K):Math.max(0,K-F));
  if(mkt <= intr + 1e-9) return NaN;
  var lo=0.0005, hi=5.0;
  if(b76(F,K,T,r,hi,isCall).price < mkt) return NaN;
  for(var i=0;i<90;i++){
    var mid=(lo+hi)/2;
    if(b76(F,K,T,r,mid,isCall).price < mkt) lo=mid; else hi=mid;
  }
  return (lo+hi)/2;
}
/* 選擇權自己的標的價：同一履約價 K + 買權 − 賣權。近月期貨是另一個到期日、帶基差，
   不是這批選擇權的標的——曾經差到 194 點，把整條 IV、delta、機率全帶歪。 */
function parityForward(rows){
  var xs=[];
  rows.forEach(function(r){ if(r.call!=null && r.put!=null) xs.push({K:r.K, f:r.K+r.call-r.put}); });
  if(xs.length<3) return NaN;
  var fs=xs.map(function(x){return x.f;}).sort(function(a,b){return a-b;});
  var mid=fs[Math.floor(fs.length/2)];
  var near=xs.sort(function(a,b){ return Math.abs(a.K-mid)-Math.abs(b.K-mid); })
             .slice(0,7).map(function(x){return x.f;}).sort(function(a,b){return a-b;});
  return near[Math.floor(near.length/2)];
}
/* 2025-05~2026-09 共 71 場週三結算，|結算−週二遠期價|÷1σ 的實際涵蓋率，k 從 0.2 每 0.1 一格。
   常態在中段高估（±0.5σ 說 38% 實際 27%），填把握範圍時要看實測那個數字。 */
var EMP=[0.099,0.141,0.225,0.268,0.366,0.408,0.465,0.535,0.648,0.690,0.746,0.775,
         0.831,0.859,0.901,0.901,0.901,0.930,0.944,0.944,0.958,0.958,0.986,0.986];
function empCover(k){
  var i=(k-0.2)/0.1;
  if(i<=0) return EMP[0]*k/0.2;
  if(i>=EMP.length-1) return EMP[EMP.length-1];
  var a=Math.floor(i);
  return EMP[a]+(EMP[a+1]-EMP[a])*(i-a);
}

/* 一個到期系列的市場快照：平價遠期、價平 IV（買權賣權平均）、到結算的 1σ 點數。
   跟看台的 sigmaPts() 同一套算法：σ點數 ＝ F × IV × √T，T 下限一分鐘。 */
/* 到結算還剩幾天（帶小數）：結算看 13:30，所以到期日當天還有幾小時。
   報價裡的 days 是整數天，當天到期會變成 0，不能直接拿來算。 */
function daysToSettle(iso, now){
  var v=(new Date(iso+"T13:30:00")-(now||new Date()))/86400000;
  if(!isFinite(v) || v<=0) return 0;
  return Math.max(0.02, Math.round(v*20)/20);
}
function seriesStats(c, rPct){
  var F=parityForward(c.rows), r=(rPct==null?1.5:rPct)/100;
  var days=daysToSettle(c.expiry);
  var T=days/365, Tf=Math.max(T, 1/(365*24*60));
  if(!isFinite(F)) return null;
  var both=c.rows.filter(function(x){ return x.call!=null && x.put!=null; });
  if(!both.length) return null;
  var atm=both.reduce(function(a,x){ return Math.abs(x.K-F)<Math.abs(a.K-F)?x:a; });
  var ivs=[solveIV(atm.call,F,atm.K,T,r,true), solveIV(atm.put,F,atm.K,T,r,false)].filter(isFinite);
  var iv=ivs.length ? ivs.reduce(function(a,b){return a+b;},0)/ivs.length : NaN;
  return {F:F, K:atm.K, iv:iv, T:T, sigma:F*iv*Math.sqrt(Tf), expiry:c.expiry, days:days};
}
/* 機率 p 的區間對應幾個標準差（雙尾）：50%→0.674、68%→1、80%→1.282、90%→1.645 */
var BAND_Z={50:0.6745, 68:1, 80:1.2816, 90:1.6449};

/* 市場（對數常態、用價平 IV）給「結算低於 x」的機率；看台的機率尺也用這一支 */
function probBelowOf(F, iv, T, x){
  if(!(iv>0) || !(T>0) || !(x>0)) return x>F?1:0;
  var v=iv*Math.sqrt(T);
  return ncdf((Math.log(x/F)+0.5*iv*iv*T)/v);
}
/* 區間分數：寬度＋沒中的罰款（差幾點 × 2/(1−把握度)）。越小越好；伺服器 forecast.py 是同一條公式 */
function intervalScore(lo, hi, y, conf){
  var a=1-conf/100, s=hi-lo;
  if(y<lo) s+=2/a*(lo-y); else if(y>hi) s+=2/a*(y-hi);
  return s;
}
