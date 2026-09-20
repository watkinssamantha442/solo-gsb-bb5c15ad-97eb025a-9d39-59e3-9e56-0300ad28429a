'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { layout, layoutBatch } = require('../src/packer');
const { layoutCostBatch } = require('../src/cost');

const EPS = 1e-6;

test('订单号：单张结果 items 与 unplaced 透传订单号', () => {
  const r = layout({
    paperW: 200, paperH: 200, kerf: 0,
    products: [
      { name: 'A', width: 100, height: 100, quantity: 1, orderNo: 'SO-1' },
      { name: 'B', width: 300, height: 300, quantity: 1, orderNo: 'SO-2' },
      { name: 'C', width: 50, height: 50, quantity: 1 }, // 无订单号
    ],
  });
  const a = r.items.find((it) => it.name === 'A');
  const c = r.items.find((it) => it.name === 'C');
  assert.strictEqual(a.orderNo, 'SO-1');
  assert.strictEqual(c.orderNo, '');
  const b = r.unplaced.find((u) => u.name === 'B');
  assert.strictEqual(b.orderNo, 'SO-2');
});

test('订单号：非法类型/超长抛出错误，缺省保持空串', () => {
  assert.throws(() => layout({
    paperW: 100, paperH: 100, kerf: 0,
    products: [{ width: 10, height: 10, quantity: 1, orderNo: true }],
  }), /订单号/);
  assert.throws(() => layout({
    paperW: 100, paperH: 100, kerf: 0,
    products: [{ width: 10, height: 10, quantity: 1, orderNo: 'x'.repeat(65) }],
  }), /64/);
  const r = layout({
    paperW: 100, paperH: 100, kerf: 0,
    products: [{ width: 10, height: 10, quantity: 1 }],
  });
  assert.strictEqual(r.items[0].orderNo, '');
});

/* ---------------- 批量隔离 ---------------- */

test('批量隔离：每张纸只含一个订单，逐张标明订单号', () => {
  const r = layoutBatch({
    paperW: 300, paperH: 300, kerf: 0, maxSheets: 20, isolateOrders: true,
    products: [
      { name: 'A件', width: 100, height: 100, quantity: 9, orderNo: 'SO-1' },
      { name: 'B件', width: 100, height: 100, quantity: 4, orderNo: 'SO-2' },
    ],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.isolateOrders, true);
  assert.ok(r.sheets.length >= 2);
  for (const sh of r.sheets) {
    const orders = new Set(sh.layout.items.map((it) => it.orderNo));
    assert.strictEqual(orders.size, 1, '每张纸只能出现一个订单');
    assert.strictEqual([...orders][0], sh.orderNo);
    assert.ok(sh.piecesPlaced > 0);
    assert.ok(sh.round > 0);
  }
  // 第一轮面积大的订单 SO-1 先（90000mm² > 40000mm²）
  assert.strictEqual(r.sheets[0].orderNo, 'SO-1');
  assert.strictEqual(r.sheets[0].piecesPlaced, 9);
  assert.strictEqual(r.sheets[1].orderNo, 'SO-2');
  // 候选指标里列出本轮所有可行订单
  const rankedOrders = r.sheets[0].selection.ranked.map((c) => c.orderNo).sort();
  assert.deepStrictEqual(rankedOrders, ['SO-1', 'SO-2']);
  assert.ok(r.sheets[0].selection.ranked.find((c) => c.selected).orderNo, 'SO-1');
});

test('批量隔离：订单汇总需求/已排/剩余/完成率正确', () => {
  const r = layoutBatch({
    paperW: 300, paperH: 300, kerf: 0, maxSheets: 1, isolateOrders: true,
    products: [
      { name: 'A件', width: 100, height: 100, quantity: 9, orderNo: 'SO-1' },
      { name: 'B件', width: 100, height: 100, quantity: 4, orderNo: 'SO-2' },
    ],
  });
  assert.strictEqual(r.stopReason, 'max-sheets');
  assert.strictEqual(r.sheets.length, 1);
  const o1 = r.orders.find((o) => o.orderNo === 'SO-1');
  const o2 = r.orders.find((o) => o.orderNo === 'SO-2');
  assert.deepStrictEqual(
    [o1.piecesTotal, o1.piecesPlaced, o1.piecesRemaining],
    [9, 9, 0]
  );
  assert.ok(Math.abs(o1.completionRate - 1) < EPS);
  assert.deepStrictEqual(
    [o2.piecesTotal, o2.piecesPlaced, o2.piecesRemaining],
    [4, 0, 4]
  );
  assert.strictEqual(o2.completionRate, 0);
  // 剩余明细携带订单号
  assert.ok(r.remaining.every((u) => u.orderNo === 'SO-2'));
});

test('批量隔离：面积优先于件数决胜', () => {
  // 订单 A：100×100 ×9，一张排 9 件共 90000mm²
  // 订单 B：140×140 ×4，一张排 4 件共 78400mm²（件数少但面积也小 → A 先）
  const r = layoutBatch({
    paperW: 300, paperH: 300, kerf: 0, maxSheets: 20, isolateOrders: true,
    products: [
      { width: 100, height: 100, quantity: 9, orderNo: 'A' },
      { width: 140, height: 140, quantity: 4, orderNo: 'B' },
    ],
  });
  assert.strictEqual(r.sheets[0].orderNo, 'A');
  assert.strictEqual(r.sheets[0].piecesPlaced, 9);
});

test('批量隔离：面积与件数同分时按订单录入顺序', () => {
  // 两订单同规格同数量，每张指标完全一致 → 录入靠前的 Z 先
  const r = layoutBatch({
    paperW: 100, paperH: 100, kerf: 0, maxSheets: 4, isolateOrders: true,
    products: [
      { width: 50, height: 50, quantity: 2, orderNo: 'Z' },
      { width: 50, height: 50, quantity: 2, orderNo: 'A' },
    ],
  });
  assert.strictEqual(r.sheets[0].orderNo, 'Z');
});

test('批量隔离：任一订单无进展即止损，返回受阻订单、不生成空白纸', () => {
  const r = layoutBatch({
    paperW: 200, paperH: 200, kerf: 0, maxSheets: 10, isolateOrders: true,
    products: [
      { name: '小件', width: 50, height: 50, quantity: 2, orderNo: 'O1' },
      { name: '大件', width: 300, height: 300, quantity: 1, orderNo: 'O2' },
    ],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  assert.strictEqual(r.sheets.length, 0, '不应有任何纸（首轮即受阻）');
  assert.strictEqual(r.summary.piecesPlaced, 0);
  assert.strictEqual(r.blockedOrders.length, 1);
  const b = r.blockedOrders[0];
  assert.strictEqual(b.orderNo, 'O2');
  assert.strictEqual(b.piecesRemaining, 1);
  assert.strictEqual(b.piecesPlaced, 0);
  assert.strictEqual(b.completionRate, 0);
  assert.strictEqual(b.remaining[0].name, '大件');
  // 其他订单需求不被扣减
  const o1 = r.orders.find((o) => o.orderNo === 'O1');
  assert.strictEqual(o1.piecesPlaced, 0);
  assert.strictEqual(r.remaining.find((u) => u.orderNo === 'O1').quantity, 2);
});

test('批量隔离：受阻订单诊断纹向受限', () => {
  const r = layoutBatch({
    paperW: 100, paperH: 300, paperGrain: 'along-width', kerf: 0,
    maxSheets: 5, isolateOrders: true,
    products: [
      { name: '纹向件', width: 120, height: 40, quantity: 2, grain: 'along-width', orderNo: 'GB' },
      { name: '正常件', width: 90, height: 50, quantity: 1, orderNo: 'OK' },
    ],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  assert.strictEqual(r.blockedOrders[0].orderNo, 'GB');
  assert.strictEqual(r.blockedOrders[0].remaining[0].grainBlocked, true);
  assert.strictEqual(
    r.remaining.find((u) => u.orderNo === 'GB').grainBlocked,
    true
  );
});

test('批量隔离：空需求直接完成、订单列表为空', () => {
  const r = layoutBatch({
    paperW: 200, paperH: 200, kerf: 0, maxSheets: 5,
    isolateOrders: true, products: [],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.sheets.length, 0);
  assert.deepStrictEqual(r.orders, []);
  assert.deepStrictEqual(r.blockedOrders, []);
});

test('批量隔离：未填订单号的成品归入无订单组，组内可混排', () => {
  const r = layoutBatch({
    paperW: 200, paperH: 200, kerf: 0, maxSheets: 10, isolateOrders: true,
    products: [
      { name: '无单A', width: 50, height: 50, quantity: 4 },
      { name: '有单', width: 50, height: 50, quantity: 4, orderNo: 'X' },
    ],
  });
  assert.strictEqual(r.stopReason, 'completed');
  const noOrder = r.orders.find((o) => o.orderNo === '');
  assert.ok(noOrder);
  assert.strictEqual(noOrder.piecesTotal, 4);
  for (const sh of r.sheets) {
    const ords = new Set(sh.layout.items.map((it) => it.orderNo));
    assert.strictEqual(ords.size, 1);
  }
});

test('批量：isolateOrders 开关校验，非布尔值抛错', () => {
  assert.throws(() => layoutBatch({
    paperW: 100, paperH: 100, kerf: 0, maxSheets: 3,
    isolateOrders: 'yes', products: [],
  }), /布尔/);
});

/* ---------------- 成本隔离 ---------------- */

test('成本隔离：逐张只排一个订单，入选后只扣该订单需求', () => {
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: '大纸', width: 300, height: 300, price: 10, stock: 5 },
      { name: '小纸', width: 100, height: 100, price: 2, stock: 20 },
    ],
    isolateOrders: true,
    products: [
      { name: '卡片', width: 100, height: 100, quantity: 9, orderNo: 'A' },
      { name: '卡片', width: 100, height: 100, quantity: 3, orderNo: 'B' },
    ],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.isolateOrders, true);
  for (const sh of r.sheets) {
    const ords = new Set(sh.layout.items.map((it) => it.orderNo));
    assert.strictEqual(ords.size, 1, '每张纸只能排一个订单');
    assert.strictEqual([...ords][0], sh.orderNo);
    assert.ok(sh.piecesPlaced > 0, '不应有空白纸');
  }
  // A：大纸单位成本 10/90000 < 小纸 2/10000 → 第 1 轮 A×大纸 9 件
  assert.strictEqual(r.sheets[0].orderNo, 'A');
  assert.strictEqual(r.sheets[0].paperId, 'S1');
  // B 只有 3 件，全部走小纸（大纸单位成本更贵）
  for (const sh of r.sheets.slice(1)) {
    assert.strictEqual(sh.orderNo, 'B');
    assert.strictEqual(sh.paperId, 'S2');
  }
  // 库存：大纸用 1，小纸用 3
  assert.strictEqual(r.usage[0].used, 1);
  assert.strictEqual(r.usage[1].used, 3);
  assert.strictEqual(r.usage[0].remainingStock, 4);
  assert.strictEqual(r.orders.find((o) => o.orderNo === 'A').piecesPlaced, 9);
  assert.strictEqual(r.orders.find((o) => o.orderNo === 'B').piecesPlaced, 3);
});

test('成本隔离：联合候选按单位面积成本跨订单比较', () => {
  // X 件 100×100：小纸每张 1 件（1 元/件）；贵纸每张 4 件（2 元/件）
  // Y 件 50×50：小纸每张 4 件（0.25 元/件）
  // → 第 1 轮 Y×小纸（单位成本最低）
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: '贵纸', width: 200, height: 200, price: 8, stock: 5 },
      { name: '便宜纸', width: 100, height: 100, price: 1, stock: 10 },
    ],
    isolateOrders: true,
    products: [
      { name: 'X件', width: 100, height: 100, quantity: 4, orderNo: 'X' },
      { name: 'Y件', width: 50, height: 50, quantity: 8, orderNo: 'Y' },
    ],
  });
  assert.strictEqual(r.sheets[0].orderNo, 'Y');
  assert.strictEqual(r.sheets[0].paperId, 'S2');
  // 每轮 ranked 为「订单 × 纸型」可行候选，并标注订单号
  for (const sh of r.sheets) {
    assert.ok(sh.selection.ranked.every((c) => typeof c.orderNo === 'string'));
    const win = sh.selection.ranked.find((c) => c.selected);
    assert.strictEqual(win.orderNo, sh.orderNo);
    assert.strictEqual(win.paperId, sh.paperId);
  }
});

test('成本隔离：单位成本与件数同分时按订单录入顺序、再按纸型顺序', () => {
  // 两订单均为 50×50 ×4；两纸型均 100×100、单价 1、库存充足 → 全指标相同
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: '纸甲', width: 100, height: 100, price: 1, stock: 4 },
      { name: '纸乙', width: 100, height: 100, price: 1, stock: 4 },
    ],
    isolateOrders: true,
    products: [
      { width: 50, height: 50, quantity: 4, orderNo: '先单' },
      { width: 50, height: 50, quantity: 4, orderNo: '后单' },
    ],
  });
  assert.strictEqual(r.sheets[0].orderNo, '先单');
  assert.strictEqual(r.sheets[0].paperId, 'S1');
});

test('成本隔离：部分订单在所有纸型无进展时止损、不扣库存，其余订单需求保留', () => {
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: '小纸A', width: 200, height: 200, price: 1, stock: 2 },
      { name: '小纸B', width: 150, height: 150, price: 0.8, stock: 2 },
    ],
    isolateOrders: true,
    products: [
      { name: '小件', width: 50, height: 50, quantity: 40, orderNo: 'O1' },
      { name: '大件', width: 300, height: 300, quantity: 1, orderNo: 'O2' },
    ],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  assert.strictEqual(r.sheets.length, 0, '首轮即受阻：不出纸');
  assert.strictEqual(r.summary.totalCost, 0);
  assert.strictEqual(r.usage[0].remainingStock, 2);
  assert.strictEqual(r.usage[1].remainingStock, 2);
  assert.strictEqual(r.blockedOrders.length, 1);
  assert.strictEqual(r.blockedOrders[0].orderNo, 'O2');
  assert.strictEqual(r.blockedOrders[0].piecesRemaining, 1);
  // O1 需求未被扣减
  assert.strictEqual(r.orders.find((o) => o.orderNo === 'O1').piecesPlaced, 0);
  assert.strictEqual(r.remaining.find((u) => u.orderNo === 'O1').quantity, 40);
});

test('成本隔离：库存耗尽（非几何受阻）时 blockedOrders 为空', () => {
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: 'A', width: 100, height: 100, price: 1, stock: 1 },
      { name: 'B', width: 100, height: 100, price: 1, stock: 1 },
    ],
    isolateOrders: true,
    products: [
      { width: 50, height: 50, quantity: 4, orderNo: 'A' },
      { width: 50, height: 50, quantity: 4, orderNo: 'B' },
    ],
  });
  // 每张排 4 件，两张纸恰好各完成一个订单，全部完成
  assert.strictEqual(r.stopReason, 'completed');
  assert.deepStrictEqual(r.blockedOrders, []);
});

test('成本隔离：空需求完成，orders 按录入分组（零件）', () => {
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: 'A', width: 100, height: 100, price: 1, stock: 2 },
      { name: 'B', width: 200, height: 200, price: 2, stock: 2 },
    ],
    isolateOrders: true,
    products: [],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.sheets.length, 0);
  assert.deepStrictEqual(r.orders, []);
});

/* ---------------- 兼容性：未开启隔离时行为不变 ---------------- */

test('兼容：批量不带 isolateOrders 时 sheets 为裸布局且无 orders/blockedOrders', () => {
  const r = layoutBatch({
    paperW: 300, paperH: 200, kerf: 0, maxSheets: 10,
    products: [{ width: 100, height: 100, quantity: 6, orderNo: 'SO-1' }],
  });
  assert.strictEqual(r.isolateOrders, false);
  assert.strictEqual(typeof r.sheets[0].stats, 'object', '非隔离时 sheets 为裸 layout');
  assert.ok(!('orders' in r));
  assert.ok(!('blockedOrders' in r));
  // 同一张纸可排完全部件（不隔离）
  assert.strictEqual(r.sheets.length, 1);
  assert.strictEqual(r.sheets[0].stats.piecesPlaced, 6);
});

test('兼容：成本不带 isolateOrders 时无 orders/blockedOrders，sheet 无 orderNo', () => {
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: 'A', width: 100, height: 100, price: 1, stock: 2 },
      { name: 'B', width: 200, height: 200, price: 3, stock: 2 },
    ],
    products: [{ width: 50, height: 50, quantity: 2, orderNo: 'SO-1' }],
  });
  assert.strictEqual(r.isolateOrders, false);
  assert.ok(!('orders' in r));
  assert.ok(!('blockedOrders' in r));
  assert.ok(!('orderNo' in r.sheets[0]));
});
