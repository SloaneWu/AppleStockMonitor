import test from 'node:test';
import assert from 'node:assert/strict';
import { statusLabel, statusCategory, statusClass, isKnownStatus, taskMatches, summarizeTasks } from './dashboard.js';
const task = (id, code='SKU-A', store='R428') => ({id,product:{Model:'iPhone',Capacity:'512GB',Color:'冰川色',Code:code},store:{StoreNumber:store,CityStoreName:'ifc mall',City:'Central'}});

test('waiting filter includes persisted worker labels and enum aliases', () => {
  for (const status of [undefined,'','尚未检查','未开放预订','preorder','not_open']) {
    assert.equal(taskMatches(task('a'),{a:{status}},'', 'waiting'),true, String(status));
    assert.equal(statusCategory(status),'waiting');
  }
});

test('attention filter includes sibling batches waiting for session recovery', () => {
  for(const status of ['等待恢复','查询异常','状态未知','官网查询受阻','需官网验证','请求受限','error','unknown','verification_required','rate_limited'])
    assert.equal(taskMatches(task('a'),{a:{status}},'', 'attention'),true,status);
  assert.equal(statusClass('等待恢复'),'verify');
});

test('unavailable and pickup-ineligible are known results, not failures', () => {
  for(const status of ['无货','不可提取','unavailable','ineligible']) {
    assert.equal(isKnownStatus(status),true);
    assert.equal(statusCategory(status),'other');
    assert.equal(taskMatches(task('a'),{a:{status}},'', 'attention'),false);
  }
});

test('old available baseline never counts as latest availability', () => {
  const tasks=[task('a')];
  const items={a:{status:'需官网验证',lastSuccess:{status:'有货'}}};
  assert.equal(taskMatches(tasks[0],items,'','available'),false);
  assert.deepEqual(summarizeTasks(tasks,items),{products:1,tasks:1,stores:1,available:0,attention:1});
});

test('summary counts unique products and stores but each monitored pair separately', () => {
  const tasks=[task('a'),task('b','SKU-A','R499'),task('c','SKU-B')];
  const items={a:{status:'available'},b:{status:'有货'},c:{status:'等待恢复'},deleted:{status:'有货'}};
  assert.deepEqual(summarizeTasks(tasks,items),{products:2,tasks:3,stores:2,available:2,attention:1});
});

test('search accepts SKU, city, color and capacity and combines with status', () => {
  for(const query of ['sku-a',' CENTRAL ','冰川色','512gb','IFC']) assert.equal(taskMatches(task('a'),{},query),true,query);
  assert.equal(taskMatches(task('a'),{a:{status:'无货'}},'ifc','available'),false);
  assert.equal(taskMatches(task('a'),{a:{status:'available'}},'ifc','available'),true);
  assert.equal(taskMatches(task('a'),{},'not-a-store'),false);
});

test('unknown labels remain visible without being reclassified as no stock', () => {
  assert.equal(statusLabel('future-state'),'future-state');
  assert.equal(isKnownStatus('future-state'),false);
  assert.equal(taskMatches(task('a'),{a:{status:'future-state'}},'', 'all'),true);
});

test('empty list summary has no invented availability', () => {
  assert.deepEqual(summarizeTasks([], {old:{status:'有货'}}),{products:0,tasks:0,stores:0,available:0,attention:0});
});
