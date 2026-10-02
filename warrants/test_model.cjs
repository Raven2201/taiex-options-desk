const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./model.js');
const call = {kind:'call',strike:100,ratio:0.1,entry:1,units:1000};
test('exercise ratio applies to call and put per unit',()=>{
  assert.equal(M.intrinsic(call,120),2);
  assert.equal(M.intrinsic({...call,kind:'put'},80),2);
  assert.equal(M.intrinsic(call,80),0);
});
test('expiry payoff and breakeven include entry and exit costs',()=>{
  const fees={rate:0,min:0,tax:0};
  assert.equal(M.pnl(call,2,fees),1000);
  assert.equal(M.pnl(call,0,fees),-1000);
  assert.ok(Math.abs(M.breakeven(call,fees)-110)<1e-7);
  assert.ok(Math.abs(M.breakeven({...call,kind:'put'},fees)-90)<1e-7);
  assert.equal(M.pnl(call,2,{rate:0.001425,min:20,tax:0.001}),958);
  assert.equal(M.pnl(call,0,{rate:0.001425,min:20,tax:0.001}),-1020);
});
test('Black-Scholes known value and IV round trip with ratio',()=>{
  const p=M.price(call,100,365,0.2,0.05,0);
  assert.ok(Math.abs(p-1.045058)<1e-5);
  assert.ok(Math.abs(M.iv(call,p,100,365,0.05,0)-0.2)<1e-6);
  assert.equal(M.iv(call,30,100,365,0.05,0),null);
  assert.equal(M.price(call,120,0,0.2,0.05,0),2);
});
test('current price differs from terminal intrinsic at same underlying',()=>{
  assert.ok(M.price(call,100,30,0.3,0,0)>0);
  assert.equal(M.price(call,100,0,0.3,0,0),0);
});
test('input validation prevents negative units and model misuse',()=>{
  assert.throws(()=>M.validate({...call,units:-1000}));
  assert.throws(()=>M.validate({...call,units:1.5}));
  assert.throws(()=>M.validate({...call,ratio:0}));
  assert.throws(()=>M.validate({...call,kind:'bull'}));
  assert.throws(()=>M.validate({...call,entry:NaN}));
});
test('spread costs make immediate round trip loss',()=>{
  assert.equal(M.pnl({...call,entry:1.05},0.95,{rate:0,min:0,tax:0}),-100);
});
