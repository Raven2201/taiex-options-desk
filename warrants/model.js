/* Pure pricing functions shared by the browser and node:test. Percent inputs are fractions. */
(function(root){
  'use strict';
  function cdf(x){
    const z=Math.abs(x),t=1/(1+0.2316419*z);
    const p=1-Math.exp(-z*z/2)/Math.sqrt(2*Math.PI)*t*(0.319381530+t*(-0.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));
    return x>=0?p:1-p;
  }
  function validate(w){
    if(!['call','put'].includes(w.kind)) throw Error('只支援一般型認購／認售');
    for(const k of ['strike','ratio','entry','units']) if(!Number.isFinite(w[k])) throw Error('請填寫完整數值');
    if(w.strike<=0||w.ratio<=0||w.entry<0||w.units<=0||!Number.isInteger(w.units)) throw Error('履約價、比例須大於零；單位數須為正整數');
    return w;
  }
  function intrinsic(w,s){return Math.max(0,w.kind==='call'?s-w.strike:w.strike-s)*w.ratio;}
  function price(w,s,days,vol,r=0.015,q=0){
    if(days<=0)return intrinsic(w,s);
    const t=days/365,df=Math.exp(-r*t),dq=Math.exp(-q*t);
    if(s<=0)return w.kind==='put'?w.strike*df*w.ratio:0;
    if(vol<=0)return Math.max(0,w.kind==='call'?s*dq-w.strike*df:w.strike*df-s*dq)*w.ratio;
    const v=vol*Math.sqrt(t),d1=(Math.log(s/w.strike)+(r-q+vol*vol/2)*t)/v,d2=d1-v;
    return Math.max(0,w.kind==='call'?s*dq*cdf(d1)-w.strike*df*cdf(d2):w.strike*df*cdf(-d2)-s*dq*cdf(-d1))*w.ratio;
  }
  function iv(w,p,s,days,r=0.015,q=0){
    if(!(p>0&&s>0&&days>0&&w.ratio>0&&w.strike>0))return null;
    let lo=0.00001,hi=5;
    if(p<=price(w,s,days,lo,r,q)||p>=price(w,s,days,hi,r,q))return null;
    for(let i=0;i<70;i++){const mid=(lo+hi)/2;if(price(w,s,days,mid,r,q)<p)lo=mid;else hi=mid;}
    return (lo+hi)/2;
  }
  function commission(value,f){return value>0?Math.max(f.min,value*f.rate):0;}
  function cost(w,f){const v=w.entry*w.units;return v+commission(v,f);}
  function pnl(w,exit,f){
    const v=Math.max(0,exit)*w.units;
    return Math.round((v-commission(v,f)-v*f.tax-cost(w,f))*1e8)/1e8;
  }
  function breakeven(w,f){
    let lo=0,hi=Math.max(1,w.entry*2);
    while(pnl(w,hi,f)<0&&hi<1e9)hi*=2;
    for(let i=0;i<70;i++){const p=(lo+hi)/2;if(pnl(w,p,f)<0)lo=p;else hi=p;}
    const movement=(lo+hi)/2/w.ratio;
    const level=w.kind==='call'?w.strike+movement:w.strike-movement;
    return level<0?null:level;
  }
  function greeks(w,s,days,vol,r,q){
    const h=Math.max(0.001,s*0.0001),p=price(w,s,days,vol,r,q);
    const up=price(w,s+h,days,vol,r,q),dn=price(w,Math.max(0,s-h),days,vol,r,q);
    return {delta:(up-dn)/(2*h)*w.units,gamma:(up-2*p+dn)/(h*h)*w.units,
      theta:(price(w,s,Math.max(0,days-1),vol,r,q)-p)*w.units,
      vega:(price(w,s,days,vol+0.01,r,q)-p)*w.units};
  }
  const api={cdf,validate,intrinsic,price,iv,commission,cost,pnl,breakeven,greeks};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.WarrantMath=api;
})(typeof globalThis!=='undefined'?globalThis:this);
