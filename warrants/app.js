'use strict';
const M=window.WarrantMath,$=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(n,d=2)=>Number.isFinite(n)?n.toLocaleString('zh-TW',{maximumFractionDigits:d}):'—';
const money=n=>Number.isFinite(n)?(n>0?'+':'')+num(n,0):'—';
const sign=n=>n>0?'pos':n<0?'neg':'';
const dateEnd=d=>new Date(d+'T13:30:00+08:00').getTime();
const days=d=>Math.max(0,(dateEnd(d)-Date.now())/86400000);
const key=w=>w.market+'_'+w.code+'.tw';
const clone=o=>JSON.parse(JSON.stringify(o));
const STORE='warrant-desk-v1';
let state={mode:'live',legs:[],journal:[],selected:null},items=[],quotes=new Map(),total=0,offset=0,undoStack=[];
let quoteBusy=false,searchVersion=0,entryDirty=false,ivManual=false,closeId=null,liveError=false;

function note(text,type=''){ $('notice').textContent=text;$('notice').className=type; }
function positive(id,zero=false){const n=Number($(id).value);if(!$(id).value||!Number.isFinite(n)||(zero?n<0:n<=0))throw Error('請檢查數值：'+$(id).parentElement.textContent.trim());return n;}
function settings(){
  const f={rate:positive('fee-rate',true)/100,min:positive('fee-min',true),tax:positive('tax',true)/100};
  const p={s:positive('spot'),target:positive('target'),elapsed:positive('elapsed',true),vol:positive('iv')/100,r:positive('rate',true)/100,q:positive('yield',true)/100,f};
  if(f.rate>=1||f.tax>=1||p.vol>5||p.r>0.3||p.q>0.5)throw Error('費率或模型參數超出可用範圍');
  return p;
}
function preferences(){const o={};for(const id of ['spot','target','elapsed','iv','fee-rate','fee-min','tax','rate','yield'])o[id]=$(id).value;o.follow=$('follow').checked;return o;}
function persist(){try{localStorage.setItem(STORE,JSON.stringify({...state,prefs:preferences()}));}catch(e){note('瀏覽器儲存空間不足，請匯出備份。','error');}}
function checkpoint(){undoStack.push(clone({legs:state.legs,journal:state.journal,mode:state.mode,prefs:preferences()}));if(undoStack.length>20)undoStack.shift();$('undo').disabled=false;}
function validW(w){
  M.validate(w);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(w.expiry)||!Number.isFinite(dateEnd(w.expiry))||!w.code||!w.underlying)throw Error('部位資料不完整');
  if(!['tse','otc','manual','demo'].includes(w.market))throw Error('市場代碼不正確');
  if(w.units>1e9||w.entry>1e7||w.strike>1e8||w.ratio>1e6)throw Error('數值超出模擬範圍');
}
function validateSaved(o){
  if(!o||!Array.isArray(o.legs)||!Array.isArray(o.journal)||o.legs.length>40||o.journal.length>500)throw Error('備份格式不正確');
  o.legs.forEach(validW);
  const consistent=legs=>!legs.length||legs.every(w=>w.underlying===legs[0].underlying&&w.expiry===legs[0].expiry&&(w.market==='demo')===(legs[0].market==='demo'));
  if(!consistent(o.legs))throw Error('組合標的或到期日不一致');
  for(const j of o.journal){
    if(typeof j.id!=='string'||!Array.isArray(j.legs)||!j.legs.length||j.legs.length>40||!j.fees||!['open','closed'].includes(j.status))throw Error('模擬單格式錯誤');
    j.legs.forEach(validW);
    if(!consistent(j.legs)||!Number.isFinite(j.target)||!Number.isFinite(j.vol)||!Number.isFinite(j.elapsed)||j.target<=0||j.vol<=0||j.vol>5||j.elapsed<0)throw Error('模擬單情境參數錯誤');
    for(const k of ['rate','min','tax'])if(!Number.isFinite(j.fees[k])||j.fees[k]<0)throw Error('費用設定錯誤');
    if(j.fees.rate>=1||j.fees.tax>=1)throw Error('費率錯誤');
    if(j.status==='closed'&&(!j.result||!Number.isFinite(j.result.pnl)))throw Error('結束紀錄錯誤');
  }
  return o;
}
function restore(){
  try{
    const raw=localStorage.getItem(STORE);if(!raw)return;
    const o=validateSaved(JSON.parse(raw));state.legs=o.legs;state.journal=o.journal;
    state.mode=o.mode==='demo'?'demo':'live';
    if(o.prefs){for(const id of ['spot','target','elapsed','iv','fee-rate','fee-min','tax','rate','yield'])if(Number.isFinite(Number(o.prefs[id])))$(id).value=o.prefs[id];$('follow').checked=o.prefs.follow!==false;}
    settings();
  }catch(e){state.legs=[];state.journal=[];note('本機資料無法還原；請使用有效備份。','error');}
}
function demoItems(){
  const date=(n)=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
  return [
    ['DEMO01','教學科技・認購 A','call',100,0.1,1.20,1.25],
    ['DEMO02','教學科技・認購 B','call',105,0.1,0.94,1.00],
    ['DEMO03','教學科技・認購 C','call',110,0.05,0.33,0.38],
    ['DEMO04','教學科技・認售 A','put',100,0.1,1.05,1.12],
    ['DEMO05','教學科技・認售 B','put',95,0.1,0.80,0.90],
  ].map(([code,name,kind,strike,ratio,bid,ask])=>({code,name,kind,strike,ratio,bid,ask,last:(bid+ask)/2,spot:100,market:'demo',underlying:'DEMO',underlyingName:'教學科技（虛構）',expiry:date(60),lastTrade:date(58),style:'歐式',supported:true,dataDate:date(0),quoteAt:null,source:'虛構教學資料'}));
}
function quote(w){return quotes.get(key(w))||w;}
function quoteLabel(w){
  const q=quote(w);
  if(w.market==='demo')return '教學資料・非市場行情';
  if(w.market==='manual')return '手動輸入・不自動更新';
  if(!q.quoteAt)return '每日參考資料 '+(w.dataDate||'日期未知');
  const age=(Date.now()-Date.parse(q.quoteAt))/1000;
  return (liveError?'更新失敗・':'')+(age>180?'歷史／收盤報價 ':'網站行情 ')+q.quoteAt.slice(5,16).replace('T',' ');
}
function tradable(w){return w.supported&&w.lastTrade&&Date.now()<dateEnd(w.lastTrade);}
async function json(url){const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(60000)});const d=await r.json();if(!r.ok)throw Error(d.error||'連線失敗');return d;}
async function search(){
  const version=++searchVersion;
  $('catalog-list').innerHTML='<p class="empty">讀取權證資料中…</p>';
  $('mode-badge').textContent=state.mode==='demo'?'教學範例':'官方行情';
  if(state.mode==='demo'){
    const k=$('kind').value;items=demoItems().filter(w=>k==='all'||w.kind===k);total=items.length;
    note('教學模式：所有名稱與報價都是虛構資料，不會跟隨市場。','warn');renderCatalog();renderAll();return;
  }
  try{
    const [minDays,maxDays]=$('tenor').value.split(',');
    const params=new URLSearchParams({q:$('search').value,kind:$('kind').value,market:$('market').value,minDays,maxDays,offset});
    const d=await json('/api/catalog?'+params);if(version!==searchVersion)return;
    items=d.items;total=d.total;
    note(d.errors.length?d.errors.join('；'):'官方基本資料已載入。網站行情每 15 秒更新；報價日期與時間逐檔標示。',d.errors.length?'warn':'');
    renderCatalog();renderComparison();await refreshQuotes();
  }catch(e){if(version!==searchVersion)return;items=[];total=0;renderCatalog();note(e.message+' 可重試，或使用教學範例。','error');}
}
function renderCatalog(){
  $('catalog-count').textContent=total+' 檔';$('page-info').textContent=total?`${offset+1}–${Math.min(offset+items.length,total)} / ${total}`:'0 檔';
  $('prev').disabled=offset===0||state.mode==='demo';$('next').disabled=offset+items.length>=total||state.mode==='demo';
  $('catalog-list').innerHTML=items.length?items.map(w=>{
    const q=quote(w);
    return `<button class="warrant-card ${state.selected&&key(state.selected)===key(w)?'selected':''}" data-select="${esc(key(w))}" aria-label="查看 ${esc(w.name)} ${esc(w.code)}"><div class="card-top"><span class="card-name">${esc(w.name)}</span><span class="badge ${w.kind==='put'?'put':'call'}">${w.kind==='call'?'認購':'認售'}</span></div><div class="card-code">${esc(w.code)} · ${w.market==='tse'?'上市':w.market==='otc'?'上櫃':'範例'} · 剩 ${Math.ceil(days(w.expiry))} 天</div><div class="card-prices"><span>買 <b>${num(q.bid,3)}</b></span><span>賣 <b>${num(q.ask,3)}</b></span><span>履約 ${num(w.strike)}</span></div><div class="card-meta">${esc(quoteLabel(w))}${!w.supported?' · 不適用模型':!tradable(w)?' · 已過最後交易日／日期待核對':''}</div></button>`;
  }).join(''):'<p class="empty">沒有符合的權證。可調整剩餘天數、方向或搜尋代號。</p>';
}
function select(w){
  state.selected=clone(w);entryDirty=false;$('entry').value=quote(w).ask??'';
  if(!state.legs.length){$('spot').value=w.spot||100;$('target').value=numRaw((w.spot||100)*(w.kind==='call'?1.05:0.95));}
  if(!state.legs.length){ivManual=false;resetIV();}renderSelected();renderCatalog();renderAll();refreshQuotes();
}
function numRaw(n){return Math.round(n*10000)/10000;}
function inferIV(w){try{const p=settings(),q=quote(w),ref=q.bid&&q.ask?(q.bid+q.ask)/2:q.last;return M.iv(w,ref,w.spot||p.s,days(w.expiry),p.r,p.q);}catch(e){return null;}}
function resetIV(){const w=state.selected;if(!w)return;if(state.legs.length&&state.legs[0].underlying!==w.underlying)return;const v=inferIV(w);if(v!==null)$('iv').value=numRaw(v*100);}
function renderSelected(){
  const w=state.selected;if(!w)return;
  const q=quote(w),v=inferIV(w);$('selected-name').textContent=w.name;$('selected-kind').textContent=w.kind==='call'?'認購・看漲':'認售・看跌';
  $('selected-kind').className='badge '+(w.kind==='put'?'put':'call');
  const detail=(l,v)=>`<div><div class="detail-label">${l}</div><div class="detail-value">${esc(v)}</div></div>`;
  $('contract-detail').innerHTML=detail('標的',w.underlyingName+' '+w.underlying)+detail('最新履約價',num(w.strike))+detail('每單位履約比例',num(w.ratio,6))+detail('參考 IV',v===null?'無法反推':num(v*100)+'%')+detail('最後交易日',w.lastTrade||'待核對')+detail('到期日',w.expiry)+detail('買價 / 賣價',num(q.bid,3)+' / '+num(q.ask,3))+detail('相對買賣價差',q.bid&&q.ask?num((q.ask-q.bid)/q.ask*100)+'%':'—')+
    `<div class="detail-wide">${esc(quoteLabel(w))}。${w.style==='美式'?'美式權證：模型未計提前履約價值。':'歐式模型情境試算。'}${!w.supported?' 此商品條款不適用本模型。':''}${!tradable(w)?' 已過最後交易日，或最後交易日未確認，不提供新建買進模擬。':''}</div>`;
  $('add').disabled=!tradable(w);$('entry-note').textContent=q.ask?'預填網站賣價 '+num(q.ask,3)+' 元／單位；'+quoteLabel(w)+'。成本可自行修改。':'沒有可用賣價，請自行填入預計進場價，不以成交價冒充賣價。';
}
async function refreshQuotes(){
  if(quoteBusy||state.mode==='demo'){if(state.mode==='demo')renderAll();return;}
  const all=[...items,...state.legs,...(state.selected?[state.selected]:[]),...state.journal.filter(j=>j.status==='open').flatMap(j=>j.legs)];
  const valid=all.filter(w=>['tse','otc'].includes(w.market));if(!valid.length)return;
  const keys=new Set();for(const w of valid){keys.add(key(w));if(/^\d{4,6}[A-Z]?$/.test(w.underlying)){keys.add('tse_'+w.underlying+'.tw');keys.add('otc_'+w.underlying+'.tw');}}
  quoteBusy=true;$('refresh').disabled=true;
  const version=searchVersion;
  try{
    const list=[...keys];
    for(let i=0;i<list.length;i+=40){const d=await json('/api/quotes?'+new URLSearchParams({keys:list.slice(i,i+40).join('|')}));if(version!==searchVersion)return;for(const q of d.items)quotes.set(q.market+'_'+q.code+'.tw',q);}
    liveError=false;
    for(const w of all){const u=quotes.get('tse_'+w.underlying+'.tw')||quotes.get('otc_'+w.underlying+'.tw');if(u&&u.last>0){w.spot=u.last;w.spotAt=u.quoteAt;}}
    const anchor=state.legs[0]||state.selected;
    if(anchor&&$('follow').checked&&anchor.spot>0)$('spot').value=anchor.spot;
    if(state.selected&&!entryDirty)$('entry').value=quote(state.selected).ask??'';
    if(!ivManual&&state.selected&&(!anchor||anchor.underlying===state.selected.underlying))resetIV();
    persist();
    renderCatalog();renderSelected();renderAll();
  }catch(e){liveError=true;note('行情更新失敗，保留上次資料：'+e.message,'warn');renderCatalog();renderSelected();renderJournal();}
  finally{quoteBusy=false;$('refresh').disabled=false;}
}
function addPosition(e){
  e.preventDefault();
  try{
    const w=state.selected;if(!w||!tradable(w))throw Error('請選擇仍可交易的一般型權證');
    if(state.legs.length>=12)throw Error('同一組合最多 12 筆部位');
    const lots=positive('lots');if(!Number.isInteger(lots))throw Error('張數請填正整數');
    const leg={...clone(w),entry:positive('entry'),units:lots*1000,id:crypto.randomUUID(),bid:quote(w).bid,ask:quote(w).ask};
    validW(leg);
    const first=state.legs[0];
    if(first&&(first.underlying!==w.underlying||first.expiry!==w.expiry||(first.market==='demo')!==(w.market==='demo')))throw Error('同一組合須為相同標的、相同到期日。請先保存目前模擬，再清空組合。');
    checkpoint();state.legs.push(leg);renderAll();persist();note('已加入模擬。金線代表標的參考價；藍色虛線是情境損益。',state.mode==='demo'?'warn':'');
  }catch(e){note(e.message,'error');}
}
function renderPositions(){
  $('positions').innerHTML=state.legs.length?`<table><thead><tr><th>權證</th><th>履約價</th><th>進場價</th><th>張數</th><th>買價估值</th><th></th></tr></thead><tbody>${state.legs.map(w=>`<tr><td><span class="name">${esc(w.name)}</span><small>${esc(w.code)} · ${esc(w.expiry)}</small></td><td>${num(w.strike)}</td><td>${num(w.entry,3)}</td><td>${num(w.units/1000)}</td><td>${num(quote(w).bid,3)}<small>${esc(quoteLabel(w))}</small></td><td><button data-remove="${esc(w.id)}" aria-label="移除 ${esc(w.name)}">移除</button></td></tr>`).join('')}</tbody></table>`:'<p class="empty">尚未加入部位。同一組合使用相同標的與到期日。</p>';
  $('position-note').textContent=state.legs.length?'買進組合；每筆成本固定，行情更新不會改寫進場價。':'';
}
function sums(s,d,p,terminal=false,legs=state.legs){return legs.reduce((a,w)=>a+M.pnl(w,terminal?M.intrinsic(w,s):M.price(w,s,Math.max(0,days(w.expiry)-d),p.vol,p.r,p.q),p.f),0);}
function markPnl(legs,f){if(legs.some(w=>!Number.isFinite(quote(w).bid)))return null;return legs.reduce((a,w)=>a+M.pnl(w,quote(w).bid,f),0);}
function renderMetrics(p){
  if(!state.legs.length){$('metrics').innerHTML='<p class="empty">加入部位後，顯示投入金額、風險與目標損益。</p>';$('greeks').innerHTML='';return;}
  const cost=state.legs.reduce((a,w)=>a+M.cost(w,p.f),0),mark=markPnl(state.legs,p.f),scenario=sums(p.target,p.elapsed,p);
  const tiles=[['投入金額',cost,'含買進手續費',''],['到期歸零損失',-cost,'若提前賣出，費用另計','neg'],['買價估算損益',mark,'依所示報價；未必可成交',sign(mark)],['目標情境損益',scenario,`${num(p.elapsed,1)} 天後・IV ${num(p.vol*100)}%`,sign(scenario)]];
  $('metrics').innerHTML=tiles.map(([l,v,n,c])=>`<div class="metric"><label>${l}</label><strong class="${c}">${v===null?'—':(l==='投入金額'?num(v,0):money(v))}</strong><small>${n}</small></div>`).join('');
  const g={delta:0,gamma:0,theta:0,vega:0};for(const w of state.legs){const v=M.greeks(w,p.s,days(w.expiry),p.vol,p.r,p.q);for(const k in g)g[k]+=v[k];}
  $('greeks').innerHTML=[['delta','標的漲 1 元','元・Delta'],['theta','經過 1 天','元・Theta'],['vega','IV 增加 1 百分點','元・Vega'],['gamma','Delta 的變化','元／元²・Gamma']].map(([k,t,u])=>`<div><span>${t}</span><b>${money(g[k])}</b><span>${u}</span></div>`).join('');
}
function renderChart(p){
  const legs=state.legs;
  if(!legs.length){$('chart').innerHTML='<p class="empty">先加入一檔權證，就能比較情境與到期損益。</p>';$('chart-caption').textContent='圖上的到期獲利，不代表現在平倉能拿到的金額。';return;}
  const W=860,H=350,L=72,R=24,T=30,B=45,iw=W-L-R,ih=H-T-B;
  const ks=legs.map(w=>w.strike),lo=Math.max(0,Math.min(p.s,p.target,...ks)*0.85),hi=Math.max(p.s,p.target,...ks)*1.15;
  const xs=Array.from({length:181},(_,i)=>lo+(hi-lo)*i/180),a=xs.map(x=>sums(x,0,p,true)),b=xs.map(x=>sums(x,p.elapsed,p));
  const low=Math.min(0,...a,...b),high=Math.max(0,...a,...b),pad=Math.max(100,(high-low)*0.12),ylo=low-pad,yhi=high+pad;
  const X=x=>L+(x-lo)/(hi-lo)*iw,Y=y=>T+(yhi-y)/(yhi-ylo)*ih;
  const path=ys=>ys.map((y,i)=>(i?'L':'M')+X(xs[i]).toFixed(2)+' '+Y(y).toFixed(2)).join(' ');
  let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="到期損益與情境理論損益比較，金線為標的參考價，綠色虛線為目標價"><title>到期與情境損益比較</title>`;
  for(let i=0;i<5;i++){const y=ylo+(yhi-ylo)*i/4;svg+=`<line x1="${L}" x2="${W-R}" y1="${Y(y)}" y2="${Y(y)}" class="c-grid"/><text x="${L-9}" y="${Y(y)+4}" text-anchor="end">${num(y,0)}</text>`;}
  for(const x of niceTicks(lo,hi,6)){if(x<lo||x>hi)continue;const px=X(x),at=px-L<26?'start':(W-R-px<26?'end':'middle');svg+=`<text x="${px}" y="${H-22}" text-anchor="${at}">${num(x,1)}</text>`;}
  const y0=Y(0).toFixed(2),area=path(a)+` L${X(xs[xs.length-1]).toFixed(2)} ${y0} L${X(xs[0]).toFixed(2)} ${y0} Z`;
  svg+=`<clipPath id="cp-up"><rect x="${L}" y="${T}" width="${iw}" height="${Math.max(0,y0-T)}"/></clipPath><clipPath id="cp-dn"><rect x="${L}" y="${y0}" width="${iw}" height="${Math.max(0,T+ih-y0)}"/></clipPath>`;
  svg+=`<path d="${area}" class="c-profit" clip-path="url(#cp-up)"/><path d="${area}" class="c-loss" clip-path="url(#cp-dn)"/>`;
  svg+=`<line x1="${L}" x2="${W-R}" y1="${y0}" y2="${y0}" class="c-zero"/><path d="${path(a)}" class="c-term"/><path d="${path(b)}" class="c-scen"/>`;
  for(const [x,c,label,y] of [[p.s,'c-spot','標的 '+num(p.s),16],[p.target,'c-target','目標 '+num(p.target),H-6]])svg+=`<line x1="${X(x)}" x2="${X(x)}" y1="${T}" y2="${H-B}" class="${c}"/><text x="${X(x)}" y="${y}" text-anchor="middle" class="${c}-label">${label}</text>`;
  svg+=`<circle cx="${X(p.target)}" cy="${Y(sums(p.target,p.elapsed,p))}" r="5.5" class="c-dot"/><text x="10" y="16">損益 NT$</text>`;
  svg+=`<g class="hov off" id="hov"><line id="hv-l" y1="${T}" y2="${T+ih}"/><circle id="hv-a" r="4"/><circle id="hv-b" r="4"/>`+
       `<rect id="hv-r" y="${T+4}" height="46"/><text id="hv-t0" y="${T+18}" class="v"></text>`+
       `<text id="hv-t1" y="${T+32}"></text><text id="hv-t2" y="${T+45}"></text></g>`;
  svg+=`<rect id="hit" x="${L}" y="${T}" width="${iw}" height="${ih}" fill="transparent" pointer-events="all"/></svg>`;
  $('chart').innerHTML=svg;
  bindChartHover({p,X,Y,L,T,iw,ih,W,lo,hi});
  const remaining=days(legs[0].expiry),terminal=sums(p.target,0,p,true);
  const be=legs.length===1?M.breakeven(legs[0],p.f):null;
  const pastTrade=legs.some(w=>w.lastTrade&&Date.now()+p.elapsed*86400000>=dateEnd(w.lastTrade));
  $('chart-caption').textContent=`標的在 ${num(p.target)} 元：${num(Math.min(p.elapsed,remaining),1)} 天後理論損益 ${money(sums(p.target,p.elapsed,p))} 元；到期假設損益 ${money(terminal)} 元。${be!==null?'到期兩平標的價約 '+num(be)+' 元。':''}${p.elapsed>=remaining?'情境已到期，兩條線重合。':'剩餘時間與 IV 會讓兩條線不同。'}${pastTrade?' 情境已過最後交易日，理論估值不代表可在市場平倉。':''}`;
}
/* 讀數當場用定價函式算，不是查曲線取樣點，所以要多細都一樣便宜 */
function bindChartHover(g){
  const svg=$('chart').querySelector('svg'),hov=svg&&svg.querySelector('#hov'),hit=svg&&svg.querySelector('#hit');
  if(!hit)return;
  const q=id=>svg.querySelector(id);
  hit.addEventListener('pointerleave',()=>{hoverX=null;hov.classList.add('off');});
  hit.addEventListener('pointermove',e=>{hoverX=e.clientX;draw(e.clientX);});
  if(hoverX!=null)draw(hoverX);
  function draw(clientX){
    const r=svg.getBoundingClientRect();
    if(!r.width)return;
    const u=(clientX-r.left)/r.width*g.W;
    const x=g.lo+(Math.min(Math.max(u,g.L),g.L+g.iw)-g.L)/g.iw*(g.hi-g.lo);
    const term=sums(x,0,g.p,true),scen=sums(x,g.p.elapsed,g.p),px=g.X(x);
    const clamp=v=>Math.min(Math.max(g.Y(v),g.T),g.T+g.ih);
    const t0=`標的 ${num(x,1)} 元　${x>=g.p.s?'＋':'−'}${num(Math.abs(x-g.p.s),1)}`;
    const t1=`到期損益 ${money(term)} 元`;
    const t2=`${num(g.p.elapsed,1)} 天後理論 ${money(scen)} 元`;
    q('#hv-l').setAttribute('x1',px);q('#hv-l').setAttribute('x2',px);
    q('#hv-a').setAttribute('cx',px);q('#hv-a').setAttribute('cy',clamp(term));
    q('#hv-b').setAttribute('cx',px);q('#hv-b').setAttribute('cy',clamp(scen));
    const w=Math.max(t0.length,t1.length,t2.length)*8+20;
    const bx=px+12+w>g.L+g.iw?px-12-w:px+12;
    q('#hv-r').setAttribute('x',bx);q('#hv-r').setAttribute('width',w);
    for(const [id,t,cls] of [['#hv-t0',t0,''],['#hv-t1',t1,sign(term)],['#hv-t2',t2,sign(scen)]]){
      const el=q(id);el.setAttribute('x',bx+10);el.textContent=t;el.setAttribute('class',(id==='#hv-t0'?'v ':'')+cls);
    }
    hov.classList.remove('off');
  }
}
let hoverX=null;
function niceTicks(lo,hi,n){
  const raw=(hi-lo)/n,mag=Math.pow(10,Math.floor(Math.log10(Math.abs(raw)||1))),norm=raw/mag;
  const step=(norm<1.5?1:norm<3?2:norm<7?5:10)*mag,out=[];
  for(let v=Math.ceil(lo/step)*step;v<=hi+1e-9;v+=step)out.push(+v.toFixed(6));
  return out;
}
function renderComparison(){
  let p;try{p=settings();}catch(e){return;}
  const anchor=state.legs[0]||state.selected;
  if(!anchor){$('comparison').innerHTML='<p class="empty">先選一檔權證，設定標的與目標價後再比較。</p>';return;}
  const rows=items.filter(w=>w.supported&&(!anchor||w.underlying===anchor.underlying)).map(w=>{
    const ask=quote(w).ask,eligible=tradable(w)&&ask>0;
    const leg={...w,entry:ask||0,units:1000};
    const profit=eligible?M.pnl(leg,M.price(w,p.target,Math.max(0,days(w.expiry)-p.elapsed),p.vol,p.r,p.q),p.f):null;
    return {w,ask,profit,roi:eligible?profit/M.cost(leg,p.f):null};
  }).sort((a,b)=>(b.roi??-Infinity)-(a.roi??-Infinity));
  $('comparison').innerHTML=rows.length?`<table><thead><tr><th>權證／到期</th><th>賣價</th><th>目標情境損益</th><th>報酬率</th><th></th></tr></thead><tbody>${rows.map(({w,ask,profit,roi})=>`<tr><td>${esc(w.name)}<small>${esc(w.expiry)} · ${esc(quoteLabel(w))}</small></td><td>${num(ask,3)}</td><td class="${sign(profit)}">${money(profit)}</td><td class="${sign(roi)}">${roi===null?'缺報價／不可交易':num(roi*100)+'%'}</td><td><button data-select="${esc(key(w))}">查看</button></td></tr>`).join('')}</tbody></table>`:'<p class="empty">這一頁沒有可比較的同標的權證。</p>';
}
function renderJournal(){
  const closed=state.journal.filter(j=>j.status==='closed'),sum=closed.reduce((a,j)=>a+j.result.pnl,0);
  $('journal').innerHTML=state.journal.length?`<div class="journal-stats">已結束 ${closed.length} 筆 · 合計 <b class="${sign(sum)}">${money(sum)} 元</b>（包含範例及手動紀錄）</div>`+state.journal.slice().reverse().map(j=>{
    const pnl=j.status==='closed'?j.result.pnl:markPnl(j.legs,j.fees);
    return `<article class="journal-card"><div class="journal-head"><b>${esc(j.name)}</b><span class="badge">${j.status==='closed'?'已結束':'追蹤中'} · ${j.mode==='demo'?'教學':'模擬'}</span></div><p>${esc(new Date(j.createdAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}))} 台北 · ${j.legs.length} 檔 · 到期 ${esc(j.legs[0].expiry)}</p><p>目標 ${num(j.target)} · 情境 IV ${num(j.vol*100)}% · <b class="${sign(pnl)}">${j.status==='closed'?'記錄損益':'買價估算'} ${money(pnl)} 元</b>${j.status==='open'?'（報價可能延遲或為收盤資料）':''}</p><div class="actions"><button data-load="${esc(j.id)}">載入組合</button>${j.status==='open'?`<button data-close="${esc(j.id)}">記錄平倉／結算</button>`:`<button data-reopen="${esc(j.id)}">撤銷結束</button>`}<button data-delete="${esc(j.id)}">移除紀錄</button></div></article>`;
  }).join(''):'<p class="empty">保存一組模擬，之後就能追蹤當時的目標與結果。</p>';
}
function renderAll(){
  try{
    const p=settings();renderPositions();renderMetrics(p);renderChart(p);renderComparison();renderJournal();
    const a=state.legs[0]||state.selected;
    $('spot-source').textContent=!$('follow').checked?'自訂標的情境':a?.market==='demo'?'教學標的・100 元':a?.spotAt?'標的報價 '+a.spotAt.slice(5,16).replace('T',' '):'標的每日參考價／手動值';
  }catch(e){note(e.message,'error');}
}
function savePlan(){
  try{
    if(!state.legs.length)throw Error('先加入模擬部位');
    const p=settings();checkpoint();
    state.journal.push({id:crypto.randomUUID(),name:state.legs[0].underlyingName+' · '+state.legs.length+' 檔權證',legs:clone(state.legs),createdAt:new Date().toISOString(),status:'open',mode:state.mode,target:p.target,vol:p.vol,elapsed:p.elapsed,fees:p.f});
    persist();renderJournal();note('模擬單已保存於此瀏覽器，可匯出備份。');
  }catch(e){note(e.message,'error');}
}
function closeFields(){
  const j=state.journal.find(j=>j.id===closeId);if(!j)return;
  if($('close-mode').value==='settle')$('close-inputs').innerHTML='<label>官方標的結算價<input id="settle-price" type="number" min="0" step="any" required></label>';
  else $('close-inputs').innerHTML=j.legs.map((w,i)=>`<label>${esc(w.code)} 賣出價（元／單位）<input id="exit-${i}" type="number" min="0" step="any" value="${quote(w).bid??''}" required></label>`).join('');
}
function closePlan(e){
  e.preventDefault();
  try{
    const j=state.journal.find(j=>j.id===closeId);if(!j)throw Error('找不到紀錄');
    const settle=$('close-mode').value==='settle';
    if(settle&&Date.now()<dateEnd(j.legs[0].expiry))throw Error('尚未到期，請使用平倉紀錄；到期後再填官方結算價。');
    const s=settle?positive('settle-price',true):null;
    const exits=j.legs.map((w,i)=>settle?M.intrinsic(w,s):positive('exit-'+i,true));
    checkpoint();j.status='closed';j.result={type:settle?'settle':'close',exits,settlement:s,pnl:j.legs.reduce((a,w,i)=>a+M.pnl(w,exits[i],j.fees),0),at:new Date().toISOString(),source:'使用者手動確認'};
    persist();renderJournal();$('close-dialog').close();note('已保存手動確認的模擬結果。');
  }catch(e){note(e.message,'error');$('close-title').textContent=e.message;}
}

$('search-form').addEventListener('submit',e=>{e.preventDefault();offset=0;search();});
for(const id of ['kind','market','tenor'])$(id).addEventListener('change',()=>{offset=0;search();});
$('next').onclick=()=>{offset+=12;search();};$('prev').onclick=()=>{offset=Math.max(0,offset-12);search();};
for(const [id,mode] of [['demo-mode','demo'],['live-mode','live']])$(id).onclick=()=>{
  if(state.mode!==mode){checkpoint();state.legs=[];state.selected=null;quotes.clear();$('entry').value='';$('add').disabled=true;$('selected-name').textContent='選一檔權證，開始推演';$('contract-detail').innerHTML='<p class="muted">請選擇權證。</p>';}
  state.mode=mode;offset=0;search();persist();
};
$('refresh').onclick=refreshQuotes;
$('entry').addEventListener('input',()=>{entryDirty=true;});$('add-form').addEventListener('submit',addPosition);
for(const id of ['spot','target','elapsed','iv','fee-rate','fee-min','tax','rate','yield'])$(id).addEventListener('input',()=>{
  if(id==='spot')$('follow').checked=false;if(id==='iv')ivManual=true;
  try{settings();renderAll();persist();}catch(e){/* Allow unfinished input; validate on blur. */}
});
for(const id of ['spot','target','elapsed','iv','fee-rate','fee-min','tax','rate','yield'])$(id).addEventListener('change',()=>renderAll());
$('follow').onchange=()=>{if($('follow').checked)refreshQuotes();renderAll();persist();};
$('reset-iv').onclick=()=>{ivManual=false;resetIV();renderAll();persist();};
$('clear').onclick=()=>{checkpoint();state.legs=[];renderAll();persist();};
$('undo').onclick=()=>{const old=undoStack.pop();if(!old)return;state.legs=old.legs;state.journal=old.journal;state.mode=old.mode;for(const id of ['spot','target','elapsed','iv','fee-rate','fee-min','tax','rate','yield'])$(id).value=old.prefs[id];$('follow').checked=old.prefs.follow;$('undo').disabled=!undoStack.length;renderAll();persist();search();};
$('save-plan').onclick=savePlan;
document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.select){const w=items.find(w=>key(w)===b.dataset.select);if(w)select(w);}
  if(b.dataset.remove){checkpoint();state.legs=state.legs.filter(w=>w.id!==b.dataset.remove);renderAll();persist();}
  if(b.dataset.load){const j=state.journal.find(j=>j.id===b.dataset.load);if(!j)return;checkpoint();state.legs=clone(j.legs);state.mode=j.mode;state.selected=clone(j.legs[0]);$('target').value=j.target;$('iv').value=j.vol*100;$('elapsed').value=j.elapsed;$('fee-rate').value=j.fees.rate*100;$('fee-min').value=j.fees.min;$('tax').value=j.fees.tax*100;$('spot').value=state.legs[0].spot||100;ivManual=true;renderSelected();renderAll();persist();note('已載入保存時的部位與情境；進場成本保留。');search();}
  if(b.dataset.close){closeId=b.dataset.close;const j=state.journal.find(j=>j.id===closeId);$('close-title').textContent=j.name;$('close-mode').value='close';closeFields();$('close-dialog').showModal();}
  if(b.dataset.reopen){checkpoint();const j=state.journal.find(j=>j.id===b.dataset.reopen);j.status='open';delete j.result;persist();renderJournal();}
  if(b.dataset.delete){checkpoint();state.journal=state.journal.filter(j=>j.id!==b.dataset.delete);persist();renderJournal();note('已移除紀錄；可按「復原」還原。');}
});
$('close-mode').onchange=closeFields;$('cancel-close').onclick=()=>$('close-dialog').close();$('close-form').onsubmit=closePlan;
$('manual-form').onsubmit=e=>{
  e.preventDefault();try{
    const expiry=$('man-expiry').value,lastTrade=$('man-trade').value;
    if(dateEnd(lastTrade)>dateEnd(expiry))throw Error('最後交易日不能晚於到期日');
    const w={code:$('man-code').value.trim(),name:$('man-code').value.trim()+'（手動）',underlying:$('man-underlying').value.trim(),underlyingName:$('man-underlying').value.trim(),kind:$('man-kind').value,strike:positive('man-strike'),ratio:positive('man-ratio'),spot:positive('man-spot'),expiry,lastTrade,market:'manual',style:'歐式近似',supported:true,entry:0,units:1000,bid:$('man-bid').value?positive('man-bid',true):null,ask:$('man-ask').value?positive('man-ask',true):null};
    validW(w);select(w);note('手動資料已載入。請核對條款、進場價與 IV。','warn');
  }catch(e){note(e.message,'error');}
};
$('export').onclick=()=>{
  const blob=new Blob([JSON.stringify({version:1,legs:state.legs,journal:state.journal,prefs:preferences(),mode:state.mode},null,2)],{type:'application/json'});
  const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download='warrant-desk-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
$('import').onchange=async e=>{
  try{
    const file=e.target.files[0];if(!file)return;if(file.size>2e6)throw Error('備份不可超過 2 MB');
    const o=validateSaved(JSON.parse(await file.text()));checkpoint();
    const ids=new Set(state.journal.map(j=>j.id));state.journal.push(...o.journal.filter(j=>!ids.has(j.id)));
    state.legs=o.legs;state.mode=state.legs[0]?.market==='demo'?'demo':'live';if(state.legs.length){$('spot').value=state.legs[0].spot||100;$('target').value=state.legs[0].spot||100;}
    renderAll();persist();search();note('備份已還原；追蹤紀錄合併並略過重複項目。');
  }catch(e){note('還原失敗：'+e.message,'error');}finally{e.target.value='';}
};
restore();renderAll();search();setInterval(refreshQuotes,15000);
