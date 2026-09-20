'use strict';

/**
 * 多纸型成本排产
 *
 * 在 2～8 种候选纸张（名称、宽高、纹向、单价、可用张数）之间逐轮择优：
 * 每轮对“仍有库存且能放入余件”的每种纸型调用现有单张排样 layout()
 * （纹向约束与单张一致：只采用纸张纹向与成品要求平行的朝向），
 * 按以下顺序选出下一张纸：
 *   1. 单位已排成品面积成本（元 / m²）最低；
 *   2. 同分时本张已排件数多；
 *   3. 再同分按录入顺序靠前者。
 * 选中后扣减该纸库存与剩余需求，进入下一轮，直到：
 *   - 全部完成            → stopReason: 'completed'
 *   - 库存全部耗尽        → stopReason: 'stock-exhausted'
 *   - 有库存纸型均无进展  → stopReason: 'no-progress'
 * 因尺寸或纹向限制排不进任何余件的纸型不参与当轮选择（即可行候选排名
 * 已排除纹向不可行的纸型）；空白纸（排不进任何余件）绝不计入结果：
 * 不扣库存、不入选。
 */

const { layout, normalizePaperGrain, normalizeProductGrain } = require('./packer');

const MM2_PER_M2 = 1_000_000;
const MAX_SHEETS = 500;

const round3 = (v) => Math.round(v * 1000) / 1000;
const round4 = (v) => Math.round(v * 10000) / 10000;
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * 校验并规范化候选纸型列表。
 * @returns 规范化后的纸型：{ id, name, width, height, grain, price, stock }
 */
function normalizePapers(rawPapers) {
  if (!Array.isArray(rawPapers)) throw new Error('缺少候选纸张列表（papers）');
  if (rawPapers.length < 2) throw new Error('至少需要录入 2 种候选纸张');
  if (rawPapers.length > 8) throw new Error('候选纸张最多为 8 种');

  return rawPapers.map((p, idx) => {
    const pos = idx + 1;
    if (!p || typeof p !== 'object') {
      throw new Error(`第 ${pos} 种纸张不是有效记录`);
    }
    const width = Number(p.width);
    const height = Number(p.height);
    const price = Number(p.price);
    const stock = Number(p.stock);
    const grain = normalizePaperGrain(p.grain, `第 ${pos} 种纸张`);

    if (!Number.isFinite(width) || width <= 0) {
      throw new Error(`第 ${pos} 种纸张的宽必须大于 0`);
    }
    if (!Number.isFinite(height) || height <= 0) {
      throw new Error(`第 ${pos} 种纸张的高必须大于 0`);
    }
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`第 ${pos} 种纸张的单价必须大于 0`);
    }
    if (!Number.isInteger(stock) || stock < 0 || stock > MAX_SHEETS) {
      throw new Error(`第 ${pos} 种纸张的可用张数必须是 0～${MAX_SHEETS} 的整数`);
    }

    const trimmed = p.name != null ? String(p.name).trim() : '';
    return {
      id: `S${pos}`,
      name: trimmed || `纸型${pos}`,
      width,
      height,
      grain,
      price,
      stock,
    };
  });
}

/**
 * 主入口
 * @param {object} input
 *   kerf: number(mm)
 *   papers: [{ name?, width, height, grain?, price, stock }]（2～8 种，
 *     grain 为 'along-width' | 'along-height'，缺省沿宽）
 *   products: [{ id?, name?, width, height, quantity,
 *     grain?: 'any' | 'along-width' | 'along-height' }]（纹向要求，缺省不限）
 * @returns 逐张纸型、布局、选择指标、各纸型用量、总成本、剩余件数与终止原因
 */
function layoutCostBatch(input) {
  const kerf = Number(input.kerf);
  if (!Number.isFinite(kerf) || kerf < 0) {
    throw new Error('刀缝宽度必须是非负数字');
  }
  const papers = normalizePapers(input.papers);
  if (!Array.isArray(input.products)) throw new Error('缺少成品列表');

  // 先做一次探路排样：复用单张校验（非法成品/纹向直接抛错），并取得总需求
  const probe = layout({
    paperW: papers[0].width,
    paperH: papers[0].height,
    paperGrain: papers[0].grain,
    kerf,
    products: input.products,
  });
  const totalPieces = probe.stats.piecesTotal;
  const originalTotal = new Map(); // id → 原始需求件数
  input.products.forEach((p, idx) => {
    const q = Math.floor(Number(p.quantity));
    if (!(q > 0)) return;
    const id = p.id != null ? String(p.id) : `P${idx + 1}`;
    originalTotal.set(id, (originalTotal.get(id) || 0) + q);
  });

  // 空需求：直接完成，不用任何纸
  if (totalPieces === 0) {
    return {
      kerf: round3(kerf),
      papers: papers.map((p) => ({ ...p })),
      stopReason: 'completed',
      summary: {
        rounds: 0,
        sheetsUsed: 0,
        paperKindsUsed: 0,
        piecesPlaced: 0,
        piecesTotal: 0,
        completionRate: 1,
        cutsTotal: 0,
        totalCost: 0,
        totalPlacedArea: 0,
        totalPlacedAreaM2: 0,
        effectiveCostPerM2: null,
      },
      sheets: [],
      usage: papers.map((p) => ({
        id: p.id,
        name: p.name,
        width: p.width,
        height: p.height,
        grain: p.grain,
        price: p.price,
        stock: p.stock,
        used: 0,
        remainingStock: p.stock,
        cost: 0,
        placedArea: 0,
      })),
      remaining: [],
    };
  }

  const stock = new Map(papers.map((p) => [p.id, p.stock]));
  const usedCount = new Map(papers.map((p) => [p.id, 0]));
  const costSum = new Map(papers.map((p) => [p.id, 0]));
  const placedAreaSum = new Map(papers.map((p) => [p.id, 0]));

  // 规范化首轮需求（后续轮次由上一张的 unplaced 映射而来，纹向随件保留）
  const initialDemand = input.products.map((p, idx) => ({
    id: p.id != null ? String(p.id) : `P${idx + 1}`,
    name: p.name && String(p.name).trim() ? String(p.name).trim() : '',
    width: Number(p.width),
    height: Number(p.height),
    grain: normalizeProductGrain(p.grain, idx + 1),
    quantity: Math.floor(Number(p.quantity)),
  })).filter((p) => p.quantity > 0);
  let demand = initialDemand;
  const sheets = [];
  let lastUnplaced = initialDemand;
  let placedTotal = 0;
  let cutsTotal = 0;
  let stopReason = null;
  // 安全上界：各纸库存之和且不超过 8×500，每张必排至少一件，必然终止
  const roundLimit = papers.reduce((s, p) => s + p.stock, 0);

  for (let round = 0; round < roundLimit; round++) {
    if (papers.every((p) => stock.get(p.id) <= 0)) {
      stopReason = 'stock-exhausted';
      break;
    }

    // 对每种仍有库存的纸型调用现有单张排样（含各自纹向约束）
    const candidates = [];
    const blockedResults = []; // 有库存但零件的排样结果（用于诊断尺寸/纹向受阻）
    for (const p of papers) {
      if (stock.get(p.id) <= 0) continue;
      const result = layout({
        paperW: p.width,
        paperH: p.height,
        paperGrain: p.grain,
        kerf,
        products: demand,
      });
      const piecesPlaced = result.stats.piecesPlaced;
      if (piecesPlaced === 0) {
        blockedResults.push(result); // 空白纸：不可选、不计入
        continue;
      }
      // 选择指标：单位已排成品面积成本（元 / m²）
      const placedArea = round3(result.stats.placedArea);
      const rawCostPerM2 = (p.price / placedArea) * MM2_PER_M2;
      const costPerM2 = placedArea > 0 ? round4(rawCostPerM2) : null;
      candidates.push({
        paper: p,
        result,
        feasible: true,
        piecesPlaced,
        placedArea,
        rawCostPerM2,
        costPerM2,
      });
    }

    if (candidates.length === 0) {
      // 有库存的纸型全部排不进任何余件（尺寸或纹向限制）：无进展止损。
      // 本轮未排任何纸、不扣库存，剩余即当前需求（首轮时据此回填全部需求）。
      // 受阻原因取各有库存纸型排样结果的并集：任一纸型因纹向受阻即标记。
      const grainBlockedById = new Map();
      for (const res of blockedResults) {
        for (const u of res.unplaced) {
          if (u.grainBlocked) grainBlockedById.set(u.id, true);
        }
      }
      lastUnplaced = demand.map((d) => ({
        id: d.id,
        name: d.name,
        width: d.width,
        height: d.height,
        grain: d.grain,
        grainBlocked: grainBlockedById.get(d.id) || false,
        quantity: d.quantity,
      }));
      stopReason = 'no-progress';
      break;
    }

    // 单位面积成本最低 → 已排件数多 → 录入顺序靠前。
    // 同分按未舍入的真实值判定（相对容差 1e-9），避免把微小差异误并列
    candidates.sort((a, b) => {
      const da = a.rawCostPerM2 - b.rawCostPerM2;
      if (Math.abs(da) > 1e-9 * Math.max(1, Math.abs(a.rawCostPerM2), Math.abs(b.rawCostPerM2))) {
        return da;
      }
      if (b.piecesPlaced !== a.piecesPlaced) return b.piecesPlaced - a.piecesPlaced;
      return papers.indexOf(a.paper) - papers.indexOf(b.paper);
    });
    const best = candidates[0];

    // 提交本张：扣库存、扣需求
    const p = best.paper;
    stock.set(p.id, stock.get(p.id) - 1);
    usedCount.set(p.id, usedCount.get(p.id) + 1);
    costSum.set(p.id, costSum.get(p.id) + p.price);
    placedAreaSum.set(p.id, placedAreaSum.get(p.id) + best.placedArea);
    placedTotal += best.piecesPlaced;
    cutsTotal += best.result.stats.cutsTotal;
    lastUnplaced = best.result.unplaced;

    sheets.push({
      round: round + 1,
      paperId: p.id,
      paperName: p.name,
      paperWidth: p.width,
      paperHeight: p.height,
      paperGrain: p.grain,
      price: p.price,
      piecesPlaced: best.piecesPlaced,
      placedArea: best.placedArea,
      costPerM2: best.costPerM2,
      selection: {
        ranked: candidates.map((c) => ({
          paperId: c.paper.id,
          paperName: c.paper.name,
          feasible: true,
          piecesPlaced: c.piecesPlaced,
          placedArea: c.placedArea,
          costPerM2: c.costPerM2,
          selected: c === best,
        })),
      },
      layout: best.result,
    });

    if (placedTotal >= totalPieces) {
      stopReason = 'completed';
      break;
    }

    demand = best.result.unplaced.map((u) => ({
      id: u.id,
      name: u.name,
      width: u.width,
      height: u.height,
      grain: u.grain,
      quantity: u.quantity,
    }));
  }

  if (stopReason === null) {
    // 理论上不可达：达到库存上界仍未完成
    stopReason = 'stock-exhausted';
  }

  const remaining = lastUnplaced.map((u) => {
    const total = originalTotal.has(u.id) ? originalTotal.get(u.id) : u.total;
    return {
      id: u.id,
      name: u.name,
      width: u.width,
      height: u.height,
      grain: u.grain,
      grainBlocked: !!u.grainBlocked,
      total,
      placed: total - u.quantity,
      quantity: u.quantity,
    };
  });

  const usage = papers.map((p) => {
    const used = usedCount.get(p.id);
    const cost = round2(costSum.get(p.id));
    return {
      id: p.id,
      name: p.name,
      width: p.width,
      height: p.height,
      grain: p.grain,
      price: p.price,
      stock: p.stock,
      used,
      remainingStock: p.stock - used,
      cost,
      placedArea: round3(placedAreaSum.get(p.id)),
    };
  });

  const totalCost = round2(sheets.reduce((s, sh) => s + sh.price, 0));
  const totalPlacedArea = round3(
    sheets.reduce((s, sh) => s + sh.placedArea, 0)
  );
  const completionRate = totalPieces > 0 ? placedTotal / totalPieces : 1;

  return {
    kerf: round3(kerf),
    papers: papers.map((p) => ({ ...p })),
    stopReason,
    summary: {
      rounds: sheets.length,
      sheetsUsed: sheets.length,
      paperKindsUsed: papers.filter((p) => usedCount.get(p.id) > 0).length,
      piecesPlaced: placedTotal,
      piecesTotal: totalPieces,
      completionRate: round3(completionRate * 1000) / 1000,
      cutsTotal,
      totalCost,
      totalPlacedArea,
      totalPlacedAreaM2: round4(totalPlacedArea / MM2_PER_M2),
      effectiveCostPerM2: totalPlacedArea > 0
        ? round4((totalCost / totalPlacedArea) * MM2_PER_M2)
        : null,
    },
    sheets,
    usage,
    remaining,
  };
}

module.exports = { layoutCostBatch, normalizePapers };
