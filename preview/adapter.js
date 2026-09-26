// Isolated UI demonstration. No Apple, Bark, tabs, or purchase API calls.
const base = new URL('../extension/', import.meta.url);
const [catalog, storesData] = await Promise.all(['data/products/product_data_hk.json', 'data/stores/store_hk.json'].map(path => fetch(new URL(path, base)).then(response => response.json())));
const product = catalog.products['iPhone 18 Pro Max'].find(item => item.Capacity === '512GB' && item.Color === '冰川色');
const duo = catalog.products['iPhone Duo'][0];
const now = new Date().toISOString();
const tasks = storesData.stores.map((store, index) => ({ id: 'demo-' + index, areaCode: 'hk', areaTitle: '香港', product, store }));
tasks.push({ id: 'demo-duo', areaCode: 'hk', areaTitle: '香港', product: duo, store: storesData.stores[0] });
const items = Object.fromEntries(tasks.map((task,index) => [task.id, { status: index === 6 ? 'preorder' : [0,2].includes(index) ? 'available' : 'unavailable', checkedAt: now, detail: index === 6 ? '目录预订时间前不发起库存查询' : [0,2].includes(index) ? '演示结果：可到店提取' : '演示结果：暂不可提取' }]));
const state = { tasks, monitoring: false, monitorState: { running:false, checking:false, items, lastCheck:now, actualIntervalMs:20300, requestDurationMs:920, log:[{time:now,message:'界面演示已加载。此处不进行真实库存查询。'}] }, connectionHealth: { state:'unverified', message:'演示环境未连接 Apple；库存仅用于展示界面。' }, monitorSettings:{intervalSeconds:20,focusSkus:[]}, purchaseSettings:{enabled:false,sku:'',maxPrice:0,quantity:1,storePriority:[]} };
let listeners = [];
const update = async values => { const changes = {}; for(const [key,value] of Object.entries(values)){changes[key]={oldValue:structuredClone(state[key]),newValue:structuredClone(value)}; state[key]=structuredClone(value);} listeners.forEach(fn=>fn(changes,'local')); };
const history = tasks.map(task=>({ ...items[task.id], id:task.id, checkedAt:now, storeName:task.store.CityStoreName, productName:[task.product.Model,task.product.Capacity,task.product.Color].join(' · '), model:task.product.Model, capacity:task.product.Capacity,color:task.product.Color, sku:task.product.Code, changed:false, detail:'模拟记录 · 非真实库存' }));
let bark = { enabled:false, configured:false };
globalThis.chrome = {
  storage: { local: { get: async keys => Object.fromEntries(keys.map(key=>[key,structuredClone(state[key])])), set:update }, onChanged:{addListener(fn){listeners.push(fn);}} },
  runtime:{id:'local-ui-preview',getURL:path=>new URL(path,base).href, async sendMessage(message){
    const ok = result => ({ok:true,...result});
    switch(message.type){
      case 'get-monitor-settings': return ok({settings:state.monitorSettings});
      case 'save-monitor-settings': {const settings={ intervalSeconds:message.intervalSeconds===10?20:message.intervalSeconds, focusSkus:message.focusSkus, boostUntil:message.intervalSeconds===10?new Date(Date.now()+600000).toISOString():null };await update({monitorSettings:settings});return ok({settings});}
      case 'get-purchase-settings': return ok({settings:state.purchaseSettings,operations:[]});
      case 'save-purchase-settings': return {ok:false,error:'演示模式不保存或启用自动加购。'};
      case 'reset-purchase': return {ok:false,error:'演示模式不会重置真实购买记录。'};
      case 'get-bark-settings': return ok(bark);
      case 'save-bark-settings': return {ok:false,error:'演示模式不保存设备密钥；请勿在此输入真实密钥。'};
      case 'test-bark': return {ok:false,error:'演示模式不发送通知。'};
      case 'clear-bark-settings': bark={enabled:false,configured:false};return ok(bark);
      case 'get-history': {
        const records = message.mode === 'changes' ? history.filter(entry => entry.changed) : history;
        const offset = Math.max(0, Math.trunc(Number(message.offset) || 0));
        const limit = Math.max(1, Math.min(200, Math.trunc(Number(message.limit) || 50)));
        return ok({ items: records.slice(offset, offset + limit), total: records.length });
      }
      case 'export-history': return ok({csv:'检查时间,门店,结果\n模拟数据,ifc mall,仅用于界面预览\n'});
      case 'export-diagnostics': return ok({json:{mode:'preview',note:'演示诊断，不含真实监控记录'}});
      case 'save-tasks': await update({tasks:message.tasks});return ok({});
      case 'start-monitor': await update({monitoring:true,monitorState:{...state.monitorState,running:true}});return ok({});
      case 'stop-monitor': await update({monitoring:false,monitorState:{...state.monitorState,running:false}});return ok({});
      case 'check-now': await update({monitorState:{...state.monitorState,lastCheck:new Date().toISOString()}});return ok({});
      case 'scheduler-pulse': return ok({});
      case 'open-product': return {ok:false,error:'演示模式不会打开购买页面；请在扩展内使用此功能。'};
      case 'reconnect': await update({connectionHealth:{state:'unverified',message:'演示模式不会连接 Apple。安装扩展后才能核实官网连接。'}});return ok({message:'演示模式未发起官网连接。'});
      default:return {ok:false,error:'演示不支持此操作：'+message.type};
    }
  }}
};
