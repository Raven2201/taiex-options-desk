// Deterministic UI/financial checks. The fixture never requests exchange data.
const {chromium}=require(process.env.TXO_PLAYWRIGHT || require('node:path').join(require('node:os').homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const url='http://127.0.0.1:18771';
const server=spawn('python',['serve.py','--no-open','--port','18771'],{cwd:__dirname,windowsHide:true,stdio:'ignore'});
(async()=>{
 let browser;
 try{
  for(let i=0;i<40;i++){try{if((await fetch(url)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addInitScript(()=>{window.setInterval=()=>0;});
  await context.route('**/api/quotes',r=>r.fulfill({json:{contracts:[]}}));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.locator('#dg-toggle').click();await page.locator('#dg-intent').waitFor();
  assert.equal(await page.locator('#dg-intent').inputValue(),'unknown');
  await page.locator('[data-step="3"]').click();
  assert.match(await page.locator('#dg-candidates').innerText(),/先觀察/);
  await page.evaluate(()=>{
    const date=new Date();date.setDate(date.getDate()+7);
    const expiry=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
    const rows=[],days=daysBetween(expiry);
    for(let K=27000;K<=33000;K+=50){
      const c=b76(30000,K,days/365,.015,.2,true).price,p=b76(30000,K,days/365,.015,.2,false).price;
      rows.push({K,call:c,put:p,call_bid:Math.max(.01,c-1),call_ask:c+1,put_bid:Math.max(.01,p-1),put_ask:p+1});
    }
    window.fixture={ts:new Date().toISOString(),future:{symbol:'TEST',last:30000,diff:0,quoteTs:new Date().toISOString(),time:'12:00:00'},contracts:[{code:'TEST',name:'測試系列',expiry,days,rows}]};
    onLive(fixture);
  });
  await page.locator('[data-step="0"]').click();
  assert.equal(await page.evaluate(()=>window.scrollY),0,'live chain must not scroll past worksheet');
  for(const [intent,name] of [['up','買權多頭價差'],['notdown','賣出賣權價差'],['down','賣權空頭價差'],['notup','賣出買權價差'],['range','鐵兀鷹'],['move','反向鐵兀鷹']]){
    await page.locator('[data-step="0"]').click();await page.locator('#dg-intent').selectOption(intent);
    await page.locator('[data-step="3"]').click();
    assert.match(await page.locator('#dg-candidates').innerText(),new RegExp(name));
    assert(await page.locator('[data-candidate]:enabled').count()>0,intent+' must have finite-risk candidates');
  }
  await page.evaluate(()=>{S.chain.forEach(r=>{r.cb=null;r.pb=null;});recompute();});
  assert.equal(await page.locator('[data-candidate]:enabled').count(),0,'missing bid guard');
  await page.evaluate(()=>{onLive(fixture);S.chain.forEach(r=>{r.cb=r.ca+1;r.pb=r.pa+1;});recompute();});
  assert.equal(await page.locator('[data-candidate]:enabled').count(),0,'crossed quote guard');
  await page.evaluate(()=>onLive(fixture));
  await page.locator('[data-step="0"]').click();await page.locator('#dg-intent').selectOption('notdown');
  await page.locator('#dg-horizon').selectOption('目前系列到期前');
  await page.locator('[data-step="1"]').click();
  await page.locator('#dg-evidence').fill('測試事實：觀察區反彈，尚未證實支撐。');
  await page.locator('#dg-hypothesis').fill('<img src=x onerror=alert(1)> 不會大跌');
  await page.locator('[data-step="2"]').click();
  await page.locator('#dg-invalid').fill('跌破觀察區後未收復就重評。');
  await page.locator('#dg-review').fill('2099-01-01T12:00');
  await page.locator('#dg-budget').fill('100');await page.locator('#dg-cost').fill('200');
  await page.locator('[data-step="3"]').click();
  assert.match(await page.locator('#dg-candidates').innerText(),/賣出賣權價差/);
  assert.match(await page.locator('#dg-candidates').innerText(),/超出所填預算/);
  await page.locator('[data-candidate="0"]').click();
  const spread=await page.evaluate(()=>S.legs);
  assert.equal(spread.length,2);assert.equal(spread[0].kind,'put');assert.equal(spread[0].dir,-1);assert.equal(spread[1].dir,1);assert(spread[0].K>spread[1].K);
  const conservative=await page.evaluate(()=>S.legs.every(l=>l.premium===(l.dir>0?chainRow(l.K).pa:chainRow(l.K).pb)));
  assert(conservative,'buy ask / sell bid');
  assert.match(await page.locator('#dg-checks').innerText(),/已超出預算/);
  // At expiry all three volatility scenarios must collapse to identical intrinsic P&L.
  await page.locator('#dg-stage-4 details').first().locator('summary').click();
  const days=await page.evaluate(()=>S.days);await page.locator('#dg-elapsed').fill(String(days));
  const rows=await page.locator('#dg-scenarios tbody tr').all();
  assert.equal(rows.length,3);
  for(const row of rows){const cells=await row.locator('td').allTextContents();assert.equal(cells[0],cells[1]);assert.equal(cells[1],cells[2]);}
  const expected=await page.evaluate(()=>Math.round(payoff(S.F)-200).toLocaleString('zh-TW')+' 元');
  assert.equal(await rows[1].locator('td').first().innerText(),expected);
  await page.locator('#dg-record').click();
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('txo-journal-v1')).length),1);
  assert.equal(await page.locator('#dg-history img').count(),0,'saved thesis must be escaped');
  await page.locator('#dg-history summary').click();
  await page.locator('#dg-result-kind-0').selectOption('paper');await page.locator('#dg-result-pnl-0').fill('-350');await page.locator('#dg-result-note-0').fill('模擬回顧');await page.locator('[data-review="0"]').click();
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('txo-journal-v1'))[0].result.pnl),-350);
  const downloadPromise=page.waitForEvent('download');await page.locator('#dg-export').click();const download=await downloadPromise;
  const downloaded=JSON.parse(fs.readFileSync(await download.path(),'utf8'));assert.equal(downloaded.records[0].result.kind,'paper');assert(downloaded.records[0].market.optionQuotes.length===2);
  await page.locator('[data-step="3"]').click();
  fs.mkdirSync(path.join(__dirname,'verification'),{recursive:true});
  await page.screenshot({path:path.join(__dirname,'verification','candidates.png')});
  await page.reload();await page.locator('#dg-intent').waitFor({state:'attached'});assert.equal(await page.locator('#dg-intent').inputValue(),'notdown');
  // Reload drops the in-memory fixture; recover persisted legs but retain the no-feed guard.
  await page.locator('[data-step="3"]').click();assert.equal(await page.locator('[data-candidate]:enabled').count(),0);
  await page.evaluate(()=>{
    const saved=JSON.parse(localStorage.getItem('txo-journal-v1'))[0];
    const rows=saved.market.optionQuotes.map(r=>({K:r.K,call:r.call,put:r.put,call_bid:r.cb,call_ask:r.ca,put_bid:r.pb,put_ask:r.pa}));
    onLive({ts:new Date().toISOString(),future:{last:30000,quoteTs:new Date(Date.now()-600000).toISOString()},contracts:[{code:'TEST',name:'測試系列',expiry:saved.market.expiry,rows}]});
  });
  assert.equal(await page.locator('[data-candidate]:enabled').count(),0,'stale quote guard');
  await page.evaluate(()=>{LIVE.future.quoteTs=new Date().toISOString();S.expiry='2099-12-31';recompute();});
  await page.locator('[data-step="4"]').click();assert.match(await page.locator('#dg-scenarios').textContent(),/系列未綁定/);
  await page.locator('[data-step="0"]').click();
  fs.mkdirSync(path.join(__dirname,'verification'),{recursive:true});
  await page.screenshot({path:path.join(__dirname,'verification','desktop.png')});
  await page.setViewportSize({width:390,height:844});
  assert(await page.locator('#decision-guide').evaluate(el=>el.scrollWidth<=el.clientWidth),'mobile worksheet overflow');
  await page.screenshot({path:path.join(__dirname,'verification','mobile.png')});
  assert.deepEqual(errors,[]);
  console.log('PASS: empty state, intent mapping, ask/bid pricing, risk budget, expiry scenario math, journal/review/export, persistence, stale/series guards, mobile layout, no JS errors.');
 }finally{if(browser)await browser.close();server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
