/* Decision worksheet. Market facts never determine a user's thesis automatically. */
(function(){
"use strict";
var KEY="txo-decision-v1", JOURNAL="txo-journal-v1";
var D={step:0,intent:"unknown",horizon:"",evidence:"",hypothesis:"",invalid:"",review:"",budget:"",cost:"",move:"1",ivMove:"3",elapsed:"0",boundPick:"",boundExpiry:""};
try{var stored=JSON.parse(localStorage.getItem(KEY)||"null");if(stored&&typeof stored==="object")Object.keys(D).forEach(function(k){if(k in stored)D[k]=stored[k];});}catch(e){}
D.step=Math.floor(Math.max(0,Math.min(4,Number(D.step)||0)));
var root=document.getElementById("decision-guide");
var intents={unknown:"尚無判斷／先觀察",up:"預期有一段上漲",notdown:"預期不會大跌",down:"預期有一段下跌",notup:"預期不會大漲",range:"預期維持區間",move:"預期大波動，方向不確定"};
if(!intents[D.intent])D.intent="unknown";
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function val(k){return esc(D[k]);}
function num(x){if(x===""||x==null)return null;var n=Number(x);return Number.isFinite(n)?n:null;}
function money(x){return Number.isFinite(x)?Math.round(x).toLocaleString("zh-TW")+" 元":"無上限";}
function field(k,label,type,extra){return '<label class="dg-field">'+label+'<input id="dg-'+k+'" data-field="'+k+'" type="'+(type||"text")+'" value="'+val(k)+'" '+(extra||"")+'></label>';}
function area(k,label,placeholder){return '<label class="dg-field">'+label+'<textarea id="dg-'+k+'" data-field="'+k+'" maxlength="2000" placeholder="'+esc(placeholder)+'">'+val(k)+'</textarea></label>';}
function persist(){try{localStorage.setItem(KEY,JSON.stringify(D));return true;}catch(e){message("瀏覽器無法儲存，請匯出紀錄備份。");return false;}}
function message(s){document.getElementById("dg-message").textContent=s;}
function liveReady(){var age=quoteAge(),days=daysBetween(S.expiry);return LIVE_STATE==="ok"&&S.chain.length>0&&S.F>0&&Number.isFinite(age)&&age>=0&&age<=180&&S.follow&&currentContract()&&S.pick===pickKey(currentContract())&&S.expiry===currentContract().expiry&&days>0&&S.days>0&&Math.abs(S.days-days)<=0.051&&Math.abs(S.F-LIVE.future.last)<0.001;}
function priceLegs(legs){
  return legs.map(function(l){
    if(l.kind==="fut")throw new Error("候選價差僅比較選擇權。");
    var r=chainRow(l.K), bid=r&&(l.kind==="call"?r.cb:r.pb), ask=r&&(l.kind==="call"?r.ca:r.pa);
    if(!(bid>0&&ask>0&&ask>=bid))throw new Error("履約價 "+l.K+" 缺少有效雙邊報價，暫不建立。");
    return Object.assign({},l,{premium:l.dir>0?ask:bid});
  });
}
function bounds(legs){var a=analyseOf(legs);return {a:a,loss:a.slopeUp<0?Infinity:Math.max(0,-a.minP),gain:a.slopeUp>0?Infinity:a.maxP};}
var recipes={up:[[0,1,"需要上漲；付出權利金換取有限上漲空間。"]],notdown:[[0,2,"不大跌即可保留部分或全部權利金；跌破下緣仍可能承受最大損失。"]],down:[[1,1,"需要下跌；付出權利金換取有限下跌空間。"]],notup:[[1,2,"不大漲即可保留部分或全部權利金；突破上緣仍可能承受最大損失。"]],range:[[3,1,"結算落在兩側賣權與買權之間時獲利最大；兩邊皆有買腳保護。"]],move:[[2,2,"需要足夠大的單邊移動；付出權利金，兩側獲利皆封頂。"]]};
function candidates(){
  var result=[];
  (recipes[D.intent]||[]).forEach(function(r){
    var p=presetAt(r[0],r[1]), combos=[p.d];
    (p.g||[]).forEach(function(v){if(combos.length<3&&JSON.stringify(v)!==JSON.stringify(p.d))combos.push(v);});
    var seen={};
    combos.forEach(function(params){
      var c={name:p.n,why:r[2],params:params,gi:r[0],pi:r[1]};
      try{
        var specs=p.f(params), keys={};
        specs.forEach(function(sp){var key=sp[0]+":"+sp[2];if(keys[key])throw new Error("到期太近或履約價不足，買賣腳重疊。");keys[key]=true;});
        var mid=legsFromSpec(specs), key=JSON.stringify(specs);if(seen[key])return;seen[key]=true;
        if(mid.some(function(l){return !(l.K>0&&l.premium>0);}))throw new Error("報價不足。");
        c.mid=mid;c.legs=priceLegs(mid);c.b=bounds(c.legs);c.mb=bounds(mid);
        if(!(c.b.gain>0&&c.b.loss>0&&Number.isFinite(c.b.loss)))throw new Error("目前買賣價無法形成合理的有限風險價差。");
      }catch(e){c.error=e.message;}
      result.push(c);
    });
  });return result;
}
function scenario(legs,price,shift,elapsed){
  var remain=Math.max(0,S.days-elapsed)/365,total=0;
  for(var i=0;i<legs.length;i++){
    var l=legs[i],mark;
    if(l.kind==="fut")mark=price;
    else if(remain===0)mark=l.kind==="call"?Math.max(0,price-l.K):Math.max(0,l.K-price);
    else{
      var base=markOf(l);if(!(base>0))return null;
      var iv=solveIV(base,S.F,l.K,T(),RR(),l.kind==="call");
      if(!Number.isFinite(iv)||iv+shift/100<=0)return null;
      mark=b76(price,l.K,remain,RR(),iv+shift/100,l.kind==="call").price;
    }
    total+=l.dir*l.qty*(mark-l.premium)*(l.kind==="fut"?l.fmult:S.mult);
  }return total;
}
function checks(){
  var b=bounds(S.legs),budget=num(D.budget),cost=num(D.cost),has=S.legs.length>0;
  return [
    [D.intent!=="unknown","已選擇預期方向或區間","尚無明確預期，可以先觀察，不必建立部位"],
    [!!D.horizon,"已指定判斷期限","填寫判斷期限"],
    [String(D.evidence).trim().length>0&&String(D.hypothesis).trim().length>0,"觀察與假設已分開記錄","分別寫下具體觀察，以及你的解讀假設"],
    [String(D.invalid).trim().length>0&&Date.parse(D.review)>Date.now(),"已填看錯條件與未來的重新檢查時間","填寫看錯條件與未來的重新檢查時間；時間已過則需重新評估"],
    [liveReady(),"行情已載入並自動套用（期貨時間戳三分鐘內）","行情尚未就緒、過期或參數為手動；只作歷史／情境研究"],
    [has,"已有研究部位","尚未建立研究部位"],
    [has&&D.boundPick===S.pick&&D.boundExpiry===S.expiry,"部位已綁定目前到期系列","部位來源系列未確認或已切換；請從本頁候選方案重新建立"],
    [budget!==null&&budget>0&&cost!==null&&cost>=0,"已設定最大損失預算及整組來回成本","填寫損失預算與整組來回費用／滑價預留（可填 0）"],
    [has&&budget>0&&cost!==null&&cost>=0&&Number.isFinite(b.loss)&&b.loss+cost<=budget,"理論最大損失加成本在預算內","尚無法確認風險預算，或最大損失加成本已超出預算"]
  ];
}
function shell(){
  root.innerHTML='<div class="dg-intro"><div><h2>先形成判斷，再比較價差單</h2><p>把市場事實、你的假設與可承受的損失放在同一份研究紀錄。</p></div><span class="chip">決策工作表</span></div><nav class="dg-nav" aria-label="決策步驟">'+["1 預期","2 依據","3 看錯條件","4 策略比較","5 風險與紀錄"].map(function(s,i){return '<button type="button" data-step="'+i+'" aria-controls="dg-stage-'+i+'">'+s+'</button>';}).join("")+'</nav>'+
  '<div id="dg-stage-0" class="dg-stage"><h3>你期待發生什麼？</h3><p>「會上漲」與「不會大跌」需要的獲利條件不同。先選預期，不由指標替你選方向。</p><div class="dg-grid"><label class="dg-field">我的預期<select id="dg-intent" data-field="intent">'+Object.keys(intents).map(function(k){return '<option value="'+k+'" '+(D.intent===k?'selected':'')+'>'+intents[k]+'</option>';}).join("")+'</select></label><label class="dg-field">判斷期限<select id="dg-horizon" data-field="horizon"><option value="">請選擇</option>'+["今天盤中","未來一至兩天","目前系列到期前"].map(function(s){return '<option '+(D.horizon===s?'selected':'')+'>'+s+'</option>';}).join("")+'</select></label></div><div class="dg-hint" id="dg-intent-hint"></div><div id="dg-facts" class="dg-facts"></div><p class="dg-status">選擇期限不會自動替換報價系列。下方「報價鏈」可選到期日，進場前需自行確認是否涵蓋你的預期期間。</p></div>'+
  '<div id="dg-stage-1" class="dg-stage" hidden><h3>先記錄觀察，再寫解釋</h3><p>例如「價格兩次回到某價位後反彈」是觀察；「我認為那裡仍有支撐」是待驗證假設。</p><div class="dg-grid">'+area("evidence","我觀察到的事實／來源與時間","寫下價位、時間或你核對過的資料；不要只寫偏多。")+area("hypothesis","我的解讀假設","這些觀察為何支持你的預期？還有哪些其他解釋？")+'</div><div class="dg-hint">尚未接入逐檔 OI、GEX／VEX、法人籌碼與事件日曆。這些不會被當成已確認的自動依據；外部資料請註明來源與時間。</div></div>'+
  '<div id="dg-stage-2" class="dg-stage" hidden><h3>什麼情況下，你會重新判斷？</h3><p>看錯條件是檢查假設的觸發點，不代表可以保證在那個價位停損成交。</p><div class="dg-grid">'+area("invalid","推翻假設的條件","例如跌破觀察區後，30 分鐘內未收復；或預期時間內沒有發生。")+field("review","預定重新檢查時間（本機時間）","datetime-local")+field("budget","這組部位最多可承受損失（元）","number",'min="1" step="100"')+field("cost","整組來回手續費、稅與額外滑價預留（元）","number",'min="0" step="1"')+'</div><p class="dg-status">這裡記錄研究計畫，不會自動下單、停損或排程提醒。</p></div>'+
  '<div id="dg-stage-3" class="dg-stage" hidden><h3>同一個預期，比較不同代價</h3><p>候選為一組、每腳一口。中價僅作估值；保守試算採買 Ask、賣 Bid，仍不保證成交。不以模型勝率排序。</p><div id="dg-candidates" class="dg-cards"></div><p class="dg-status">按「替換研究部位」會取代下方目前部位，使用保守報價當模擬成本；不會送出交易委託。</p></div>'+
  '<div id="dg-stage-4" class="dg-stage" hidden><h3>檢查承受能力，留下當時的理由</h3><div id="dg-risk"></div><details><summary>價格與 IV 同時改變，帳面會怎樣？</summary><div class="dg-grid" style="margin-top:12px">'+field("move","價格上下變動幅度（%）","number",'min="0.1" max="30" step="0.5"')+field("ivMove","IV 上下變動（百分點）","number",'min="0" max="30" step="1"')+field("elapsed","經過幾天後估值","number",'min="0" step="0.1"')+'</div><div id="dg-scenarios" class="dg-table-wrap"></div><p class="dg-status">逐腳由目前中價反解 IV，再平行加減百分點；以 Black-76 試算，非預測。顯示相對輸入成本的模型損益，扣除所填整組費用。到期後改算內含價值，不延伸為已到期合約的新報價。</p></details><ul class="dg-checks" id="dg-checks"></ul><div class="dg-hint">填寫完整只代表研究資料較齊全，不代表策略有優勢或適合進場。先觀察／不交易也是可記錄的決定。</div><button class="btn primary" id="dg-record" type="button">儲存研究快照</button> <button class="btn" id="dg-export" type="button">匯出研究紀錄 JSON</button><p id="dg-journal-status" class="dg-status"></p></div>'+
  '<div id="dg-message" class="dg-guide-message" role="status" aria-live="polite"></div><div class="dg-footer"><span id="dg-progress" class="dg-status"></span><div><button class="btn" id="dg-prev" type="button">上一步</button> <button class="btn primary" id="dg-next" type="button">下一步</button></div></div>';
}
function updateFacts(){
  var f=LIVE&&LIVE.future,iv=S.chain.length?atmIV():NaN;
  var stamp=f&&f.quoteTs?new Date(f.quoteTs).toLocaleString("zh-TW"):"來源未提供";
  document.getElementById("dg-facts").innerHTML='<span>行情｜'+(f?esc(f.symbol||"台指期")+" "+pts(f.last):"等待來源")+'</span><span>選定到期｜'+esc(S.expiry||"待選擇")+'</span><span>模型 ATM IV｜'+(Number.isFinite(iv)?(iv*100).toFixed(1)+"%":"尚無法計算")+'</span><span>'+ (liveReady()?"期貨時間戳三分鐘內":"資料尚未就緒／過期／手動情境")+'</span><span>期貨報價時間｜'+esc(stamp)+'</span>';
  document.getElementById("dg-intent-hint").textContent=D.intent==="unknown"?"先保留觀察。不確定方向時，不必用更多指標湊出一個答案。":"目前研究目的：「"+intents[D.intent]+"」。接著寫下支持它的觀察與可能推翻它的情況。";
}
function renderCandidates(){
  var box=document.getElementById("dg-candidates");
  if(!recipes[D.intent]){box.innerHTML='<div class="dg-card">先觀察也是選擇。尚未指定預期，因此不自動建立候選單。</div>';return;}
  if(!S.chain.length||!(S.F>0)){box.innerHTML='<div class="dg-card">等待真實報價鏈；不使用範例履約價。</div>';return;}
  var cs=candidates(),budget=num(D.budget),cost=num(D.cost);
  box.innerHTML=cs.map(function(c,i){
    if(c.error)return '<article class="dg-card"><h4>'+esc(c.name)+'</h4><p>'+esc(c.error)+'</p></article>';
    var net=c.b.a.netPrem,ready=liveReady();
    return '<article class="dg-card"><h4>'+esc(c.name)+' · 組合 '+(i+1)+'</h4><p>'+esc(c.why)+'</p><div>'+c.legs.map(function(l){return (l.dir>0?"買 ":"賣 ")+l.K+" "+(l.kind==="call"?"Call":"Put");}).join(" ／ ")+'</div><dl><dt>中價淨'+(c.mb.a.netPrem>=0?"收":"付")+'</dt><dd>'+money(Math.abs(c.mb.a.netPrem))+'</dd><dt>保守淨'+(net>=0?"收":"付")+'</dt><dd>'+money(Math.abs(net))+'</dd><dt>到期最大獲利</dt><dd>'+money(c.b.gain)+'</dd><dt>到期最大損失</dt><dd>'+money(c.b.loss)+'</dd><dt>到期兩平點</dt><dd>'+c.b.a.be.map(pts).join(" / ")+'</dd></dl><small>賺賠未扣費用。'+(budget>0&&cost!==null&&cost>=0?(c.b.loss+cost<=budget?"含成本在所填預算內。":"含成本超出所填預算。") :"預算／費用尚未填完整。")+'</small><br><button class="btn" data-candidate="'+i+'" '+(!ready?'disabled':'')+'>替換研究部位</button>'+(!ready?'<p>報價過期、手動情境或系列不一致，暫不套用。</p>':'')+'</article>';
  }).join("");
}
function renderRisk(){
  var b=bounds(S.legs),cost=num(D.cost),budget=num(D.budget),has=S.legs.length>0;
  document.getElementById("dg-risk").innerHTML='<div class="dg-facts"><span>部位｜'+S.legs.length+' 腳</span><span>到期最大損失｜'+(has?money(b.loss):"尚無部位")+'</span><span>含成本損失｜'+(has&&cost!==null&&cost>=0?money(b.loss+cost):"待填費用")+'</span><span>我的預算｜'+(budget>0?money(budget):"尚未設定")+'</span></div><p>本區針對下方目前部位與輸入成本，並非候選卡的固定一口。期貨或裸賣部位可能有極大或無上限風險。</p>';
  document.getElementById("dg-checks").innerHTML=checks().map(function(c){return '<li class="'+(c[0]?"":"pending")+'">'+(c[0]?"已填／已確認：":"待處理：")+esc(c[c[0]?1:2])+'</li>';}).join("");
  var elapsed=num(D.elapsed),move=num(D.move),iv=num(D.ivMove),box=document.getElementById("dg-scenarios");
  if(!has||D.boundPick!==S.pick||D.boundExpiry!==S.expiry){box.textContent="尚無部位或到期系列未綁定。從第 4 步建立同系列研究部位後再試算。";return;}
  if(elapsed===null||elapsed<0||elapsed>S.days||move===null||move<=0||move>30||iv===null||iv<0||iv>30||cost===null||cost<0){box.textContent="請填有效情境：價格幅度 0–30%（大於 0）、IV 0–30 百分點、經過天數介於 0 與剩餘天數，並填寫費用。";return;}
  box.innerHTML='<table class="dg-table"><thead><tr><th>假設價格</th>'+[-iv,0,iv].map(function(x){return '<th>IV '+(x>0?"+":"")+x+' 百分點</th>';}).join("")+'</tr></thead><tbody>'+[-move,0,move].map(function(x){var price=S.F*(1+x/100);return '<tr><th>'+pts(price)+'（'+(x>0?"+":"")+x+'%）</th>'+[-iv,0,iv].map(function(y){var pnl=scenario(S.legs,price,y,elapsed);return '<td>'+(pnl===null?"IV／報價不足":money(pnl-cost))+'</td>';}).join("")+'</tr>';}).join("")+'</tbody></table>';
}
function journal(){try{var a=JSON.parse(localStorage.getItem(JOURNAL)||"[]");return Array.isArray(a)?a:[];}catch(e){return [];}}
function renderHistory(){
  var container=document.getElementById("dg-history");
  if(!container){container=document.createElement("details");container.id="dg-history";document.getElementById("dg-stage-4").appendChild(container);}
  var list=journal();
  container.innerHTML='<summary>回顧最近研究：補上結果與心得</summary>'+list.slice(-10).reverse().map(function(item,n){
    var index=list.length-1-n,result=item.result||{};
    return '<article class="dg-card" style="margin-top:10px"><h4>'+esc(new Date(item.recordedAt).toLocaleString("zh-TW"))+' · '+esc(intents[item.worksheet.intent]||"觀察")+'</h4><p>'+esc(item.worksheet.hypothesis||"尚未填假設")+'</p><label class="dg-field">結果類型<select id="dg-result-kind-'+index+'"><option value="unreviewed" '+(!result.kind?'selected':'')+'>尚未回顧</option><option value="observed" '+(result.kind==='observed'?'selected':'')+'>只有觀察／沒有交易</option><option value="paper" '+(result.kind==='paper'?'selected':'')+'>模擬交易</option><option value="actual" '+(result.kind==='actual'?'selected':'')+'>實際交易（自行填寫）</option></select></label><div class="dg-grid" style="margin-top:10px"><label class="dg-field">已扣成本損益（元，可留白）<input id="dg-result-pnl-'+index+'" type="number" value="'+esc(result.pnl==null?'':result.pnl)+'"></label><label class="dg-field">結果／哪個假設需要修正<textarea id="dg-result-note-'+index+'" maxlength="2000">'+esc(result.note||'')+'</textarea></label></div><button class="btn" data-review="'+index+'">儲存回顧</button></article>';
  }).join("");
}
function refresh(){
  updateFacts();renderCandidates();renderRisk();
  var filled=checks().filter(function(c){return c[0];}).length;
  document.getElementById("dg-progress").textContent="研究檢查 "+filled+" / 9 項已填或可確認 · 不代表進場訊號";
  document.getElementById("dg-journal-status").textContent="本瀏覽器保留最近 "+journal().length+" 筆研究快照（最多 50 筆）；匯出後可自行留存比較。";
}
function step(i){D.step=i;persist();root.querySelectorAll("[data-step]").forEach(function(b){if(+b.dataset.step===i)b.setAttribute("aria-current","step");else b.removeAttribute("aria-current");});root.querySelectorAll(".dg-stage").forEach(function(s,n){s.hidden=n!==i;});document.getElementById("dg-prev").disabled=i===0;document.getElementById("dg-next").disabled=i===4;refresh();}
shell();
root.addEventListener("input",function(e){var k=e.target.dataset.field;if(!k)return;D[k]=e.target.value;persist();refresh();});
root.addEventListener("change",function(e){var k=e.target.dataset.field;if(!k)return;D[k]=e.target.value;persist();refresh();});
root.addEventListener("click",function(e){
  var b=e.target.closest("button");if(!b)return;
  if(b.dataset.step!==undefined)step(+b.dataset.step);
  if(b.id==="dg-prev")step(Math.max(0,D.step-1));
  if(b.id==="dg-next")step(Math.min(4,D.step+1));
  if(b.dataset.candidate!==undefined){
    var c=candidates()[+b.dataset.candidate];if(!liveReady()||!c||c.error){message("報價狀態已改變，請重新檢查候選方案。");return;}
    S.legs=c.legs.map(function(l,i){return Object.assign({},l,{id:i+1});});S.seq=S.legs.length+1;S.preset={gi:c.gi,pi:c.pi,params:c.params};
    D.boundPick=S.pick;D.boundExpiry=S.expiry;persist();recompute();step(4);message("已替換研究部位，模擬成本採買 Ask／賣 Bid。請檢查預算與情境。");
  }
  if(b.id==="dg-record"){
    var list=journal(),bb=bounds(S.legs);
    list.push({recordedAt:new Date().toISOString(),worksheet:JSON.parse(JSON.stringify(D)),market:{source:"TAIFEX MIS",quoteTimestamp:LIVE&&LIVE.future&&LIVE.future.quoteTs,fetchTimestamp:LIVE&&LIVE.ts,feedState:LIVE_STATE,quoteAgeSeconds:quoteAge(),freshForGuide:liveReady(),future:LIVE&&LIVE.future,selectedSeries:S.pick,expiry:S.expiry,modelF:S.F,days:S.days,scenarioIV:S.sIV,interestRate:S.r,optionQuotes:S.legs.filter(function(l){return l.kind!=="fut";}).map(function(l){return chainRow(l.K)||{K:l.K,missing:true};}),optionQuoteTimestampAvailable:false},legs:JSON.parse(JSON.stringify(S.legs)),risk:{maxLoss:Number.isFinite(bb.loss)?bb.loss:"unbounded",maxGain:Number.isFinite(bb.gain)?bb.gain:"unbounded",breakEven:bb.a.be},checks:checks().map(function(c){return {ok:c[0],text:c[c[0]?1:2]};}),result:null});
    try{localStorage.setItem(JOURNAL,JSON.stringify(list.slice(-50)));message("已儲存研究快照。這是當時的計畫，不是成交紀錄；後續結果尚未填入。");renderHistory();}catch(err){message("儲存失敗：瀏覽器空間不足或禁止儲存。");}refresh();
  }
  if(b.dataset.review!==undefined){
    var index=+b.dataset.review,records=journal();if(!records[index])return;
    var kind=document.getElementById("dg-result-kind-"+index).value;
    records[index].result={reviewedAt:new Date().toISOString(),kind:kind,pnl:num(document.getElementById("dg-result-pnl-"+index).value),note:document.getElementById("dg-result-note-"+index).value};
    try{localStorage.setItem(JOURNAL,JSON.stringify(records));message("已儲存回顧；原始研究快照仍保留。");}catch(err){message("回顧儲存失敗，請確認瀏覽器空間。");}
  }
  if(b.id==="dg-export"){
    var data=journal();if(!data.length){message("尚無研究快照，請先儲存一筆。");return;}
    var url=URL.createObjectURL(new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),records:data},null,2)],{type:"application/json"}));
    var a=document.createElement("a");a.href=url;a.download="台指看台-研究紀錄.json";a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);
  }
});
var originalRecompute=recompute;recompute=function(){originalRecompute();refresh();};
step(D.step);renderHistory();setInterval(refresh,5000);
})();
