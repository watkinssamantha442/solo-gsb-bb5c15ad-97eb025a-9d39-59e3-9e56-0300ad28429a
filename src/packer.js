'use strict';

/**
 * 单张纸断头台式（guillotine）二分排样
 *
 * 规则：
 *  - 每次切割把当前矩形区域一分为二（刀缝宽 kerf 居中于切口带）
 *  - 成品允许旋转 90°，但受纹向约束：纸张纹向（沿宽/沿高）与成品要求
 *    （不限/沿自身宽/沿自身高）平行时才允许该朝向
 *  - 切割带与成品互不重叠，即切割不侵占成品
 *  - 排不下的成品保留在 unplaced 列表中（注明尺寸/纹向受阻原因）
 */

const EPS = 1e-6;

const round3 = (v) => Math.round(v * 1000) / 1000;

/* ---------------- 纹向（grain direction） ---------------- */

const PAPER_GRAINS = ['along-width', 'along-height'];
const PRODUCT_GRAINS = ['any', 'along-width', 'along-height'];

/** 规范化纸张纹向：缺省沿宽（对“不限”成品无影响，保持旧行为） */
function normalizePaperGrain(value, subject = '纸张') {
  if (value == null || value === '') return 'along-width';
  const s = String(value);
  if (!PAPER_GRAINS.includes(s)) {
    throw new Error(`${subject}纹向必须是 along-width（沿宽）或 along-height（沿高）`);
  }
  return s;
}

/** 规范化成品纹向要求：缺省不限 */
function normalizeProductGrain(value, pos) {
  if (value == null || value === '') return 'any';
  const s = String(value);
  if (!PRODUCT_GRAINS.includes(s)) {
    throw new Error(
      `第 ${pos} 种成品的纹向要求必须是 any（不限）、along-width（沿自身宽）或 along-height（沿自身高）`
    );
  }
  return s;
}

/**
 * 纹向是否允许某放置朝向（两者纹向平行才可采用）：
 *  - 不限（any）：两种朝向均可；
 *  - 未旋转：成品宽 ∥ 纸张宽，要求须与纸张纹向一致；
 *  - 旋转 90°：成品宽 ∥ 纸张高，要求须与纸张纹向相反。
 */
function grainAllows(productGrain, paperGrain, rotated) {
  if (productGrain === 'any') return true;
  return rotated ? productGrain !== paperGrain : productGrain === paperGrain;
}

/** 数组字典序比较：a < b（元素均为数字） */
function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > EPS) return a[i] < b[i];
  }
  return false;
}

/**
 * 在 W×H 区域左上角放置 w×h 后，计算切分方案（纯几何）。
 * 规则：
 *  - 只在余料够一条刀缝时下刀（kerf=0 时余料大于 EPS 才切）
 *  - 两侧都有余料时，沿较短余料方向先切第一刀（切掉窄条、
 *    保留一条完整宽料带）；平局横切优先
 *
 * @returns { orient:'none'|'v'|'h'|'vv'|'hh', frees:[{x,y,w,h}相对区域] }
 *   'v' 仅竖切一刀；'h' 仅横切一刀；
 *   'vv' 先竖后横两刀；'hh' 先横后竖两刀
 */
function splitPlan(W, H, w, h, kerf) {
  const remW = W - w;
  const remH = H - h;
  const canV = remW > EPS && remW >= kerf - EPS;
  const canH = remH > EPS && remH >= kerf - EPS;

  if (!canV && !canH) return { orient: 'none', frees: [] };

  if (canV && !canH) {
    return {
      orient: 'v',
      frees: [{ x: w + kerf, y: 0, w: W - w - kerf, h: H }],
    };
  }
  if (!canV && canH) {
    return {
      orient: 'h',
      frees: [{ x: 0, y: h + kerf, w: W, h: H - h - kerf }],
    };
  }

  // 两侧都有余料：沿较短余料方向先切
  if (remW < remH) {
    // 先竖切：右侧整带 + 左下块
    return {
      orient: 'vv',
      frees: [
        { x: w + kerf, y: 0, w: W - w - kerf, h: H },
        { x: 0, y: h + kerf, w, h: H - h - kerf },
      ],
    };
  }

  // 先横切（平局也走这里）：底部整带 + 右上块
  return {
    orient: 'hh',
    frees: [
      { x: 0, y: h + kerf, w: W, h: H - h - kerf },
      { x: w + kerf, y: 0, w: W - w - kerf, h },
    ],
  };
}

/**
 * 在自由矩形 leaf 内左上角占据 w×h，按 splitPlan 建树。
 */
function occupy(leaf, w, h, kerf, piece) {
  const { x, y } = leaf;
  const W = leaf.w;
  const H = leaf.h;
  const plan = splitPlan(W, H, w, h, kerf);

  const itemNode = { type: 'item', x, y, w, h, piece };
  if (plan.orient === 'none') return itemNode;

  if (plan.orient === 'v') {
    return {
      type: 'cut', x, y, w: W, h: H, orient: 'v',
      bx: x + w, by: y, bw: kerf, bh: H,
      children: [
        itemNode,
        { type: 'free', x: x + w + kerf, y, w: W - w - kerf, h: H },
      ],
    };
  }

  if (plan.orient === 'h') {
    return {
      type: 'cut', x, y, w: W, h: H, orient: 'h',
      bx: x, by: y + h, bw: W, bh: kerf,
      children: [
        itemNode,
        { type: 'free', x, y: y + h + kerf, w: W, h: H - h - kerf },
      ],
    };
  }

  if (plan.orient === 'vv') {
    // 第一刀竖切（贯穿），第二刀在左侧块内横切
    return {
      type: 'cut', x, y, w: W, h: H, orient: 'v',
      bx: x + w, by: y, bw: kerf, bh: H,
      children: [
        {
          type: 'cut', x, y, w, h: H, orient: 'h',
          bx: x, by: y + h, bw: w, bh: kerf,
          children: [
            itemNode,
            { type: 'free', x, y: y + h + kerf, w, h: H - h - kerf },
          ],
        },
        { type: 'free', x: x + w + kerf, y, w: W - w - kerf, h: H },
      ],
    };
  }

  // hh：第一刀横切（贯穿），第二刀在上侧块内竖切
  return {
    type: 'cut', x, y, w: W, h: H, orient: 'h',
    bx: x, by: y + h, bw: W, bh: kerf,
    children: [
      {
        type: 'cut', x, y, w: W, h, orient: 'v',
        bx: x + w, by: y, bw: kerf, bh: h,
        children: [
          itemNode,
          { type: 'free', x: x + w + kerf, y, w: W - w - kerf, h },
        ],
      },
      { type: 'free', x, y: y + h + kerf, w: W, h: H - h - kerf },
    ],
  };
}

function collectFreeLeaves(node, out) {
  if (node.type === 'free') {
    if (node.w > EPS && node.h > EPS) out.push(node);
    return;
  }
  if (node.type === 'item') return;
  for (const child of node.children) collectFreeLeaves(child, out);
}

/**
 * 主入口
 * @param {object} input
 *   paperW, paperH, kerf: number(mm)
 *   paperGrain: 'along-width' | 'along-height'（纸张纹向，缺省沿宽）
 *   products: [{ id?, name?, width, height, quantity,
 *                grain?: 'any' | 'along-width' | 'along-height' }]（纹向要求，缺省不限）
 * @returns 布局结果（坐标单位均为 mm，原点在左上角）
 */
function layout(input) {
  const paperW = Number(input.paperW);
  const paperH = Number(input.paperH);
  const kerf = Number(input.kerf);
  if (![paperW, paperH, kerf].every((n) => Number.isFinite(n))) {
    throw new Error('纸张尺寸或刀缝宽度不是有效数字');
  }
  if (paperW <= 0 || paperH <= 0) throw new Error('纸张宽高必须大于 0');
  if (kerf < 0) throw new Error('刀缝宽度不能为负');
  const paperGrain = normalizePaperGrain(input.paperGrain);
  if (!Array.isArray(input.products)) throw new Error('缺少成品列表');

  // 展开为单件列表
  let pieces = [];
  const unplaced = [];
  let totalPieces = 0;
  input.products.forEach((p, idx) => {
    const w = Number(p.width);
    const h = Number(p.height);
    const q = Math.floor(Number(p.quantity));
    if (![w, h].every((n) => Number.isFinite(n)) || w <= 0 || h <= 0) {
      throw new Error(`第 ${idx + 1} 种成品的宽高必须为正数`);
    }
    if (!Number.isFinite(q) || q < 0) {
      throw new Error(`第 ${idx + 1} 种成品的数量无效`);
    }
    const grain = normalizeProductGrain(p.grain, idx + 1);
    const id = p.id != null ? String(p.id) : `P${idx + 1}`;
    const name = p.name && String(p.name).trim() ? String(p.name).trim() : '';
    for (let n = 1; n <= q; n++) {
      pieces.push({ id, name, w, h, grain, pieceNo: n });
    }
    totalPieces += q;
    if (q > 0) unplaced.push({ id, name, width: w, height: h, grain, quantity: q });
  });

  // 大件优先：最长边降序，再按面积、最短边
  pieces.sort((a, b) => {
    const da = Math.max(a.w, a.h) - Math.max(b.w, b.h);
    if (da !== 0) return -da;
    const sa = a.w * a.h - b.w * b.h;
    if (sa !== 0) return -sa;
    return Math.min(b.w, b.h) - Math.min(a.w, a.h);
  });

  // 初始整张纸为一个自由区域
  let root = { type: 'free', x: 0, y: 0, w: paperW, h: paperH };
  let freeLeaves = [root];

  const remaining = new Map(pieces.map((p) => [p, p]));
  let placedCount = 0;

  while (remaining.size > 0) {
    let best = null; // { leaf, piece, rotated, score:[...] }

    for (const leaf of freeLeaves) {
      for (const piece of remaining.keys()) {
        // 不旋转（成品宽 ∥ 纸张宽）：纹向平行才考虑
        if (
          grainAllows(piece.grain, paperGrain, false) &&
          piece.w <= leaf.w + EPS && piece.h <= leaf.h + EPS
        ) {
          consider(leaf, piece, false, kerf);
        }
        // 旋转 90°（成品宽 ∥ 纸张高）：纹向平行才考虑
        if (
          grainAllows(piece.grain, paperGrain, true) &&
          piece.h <= leaf.w + EPS && piece.w <= leaf.h + EPS
        ) {
          consider(leaf, piece, true, kerf);
        }
      }
    }

    function consider(leaf, piece, rotated, kerfW) {
      const w = rotated ? piece.h : piece.w;
      const h = rotated ? piece.w : piece.h;
      // 用与建树完全一致的切分方案取得实际余料矩形
      const plan = splitPlan(leaf.w, leaf.h, w, h, kerfW);
      const frees = plan.frees
        .filter((f) => f.w > EPS && f.h > EPS)
        .map((f) => ({ ...f, area: f.w * f.h }));
      frees.sort((a, b) => b.area - a.area);

      const leftoverArea = frees.reduce((s, f) => s + f.area, 0);
      // BSSF 变体：优先余料总面积小，其次最大余料块的短边短
      // （余料越窄越难复用，应尽量产生在别处），再比长边，最后偏好不旋转
      const score = [
        leftoverArea,
        frees.length ? Math.min(frees[0].w, frees[0].h) : 0,
        frees.length ? Math.max(frees[0].w, frees[0].h) : 0,
        rotated ? 1 : 0,
      ];
      if (!best || lexLess(score, best.score)) {
        best = { leaf, piece, rotated, w, h, score };
      }
    }

    if (!best) break; // 现存任何自由区域都放不下任何余件

    const { leaf, piece, rotated, w, h } = best;
    piece.rotated = rotated;
    piece.x = leaf.x;
    piece.y = leaf.y;
    piece.placedW = w;
    piece.placedH = h;

    const node = occupy(leaf, w, h, kerf, piece);
    if (leaf === root) {
      root = node;
    } else {
      // 用新子树原地替换自由叶节点
      Object.assign(leaf, node);
    }

    remaining.delete(piece);
    placedCount += 1;

    freeLeaves = [];
    collectFreeLeaves(root, freeLeaves);
  }

  // 统计未排件
  for (const piece of remaining.keys()) {
    const row = unplaced.find((u) => u.id === piece.id);
    // 初始 quantity = 总数，已排数量稍后扣减
    row._unplaced = (row._unplaced || 0) + 1;
  }
  const placedById = {};
  const items = [];
  const cuts = [];
  const frees = [];
  walk(root, 0);

  function walk(node, depth) {
    if (node.type === 'item') {
      const p = node.piece;
      placedById[p.id] = (placedById[p.id] || 0) + 1;
      items.push({
        x: round3(node.x),
        y: round3(node.y),
        w: round3(node.w),
        h: round3(node.h),
        id: p.id,
        name: p.name,
        specW: p.w,
        specH: p.h,
        rotated: !!p.rotated,
        pieceNo: p.pieceNo,
        grain: p.grain, // 成品的纹向要求
        // 排样只采用纹向平行的朝向，已排成品必然满足其纹向要求
        grainOk: grainAllows(p.grain, paperGrain, !!p.rotated),
      });
      return;
    }
    if (node.type === 'free') {
      frees.push({
        x: round3(node.x),
        y: round3(node.y),
        w: round3(node.w),
        h: round3(node.h),
        area: round3(node.w * node.h),
      });
      return;
    }
    // cut：前序编号即实际下刀顺序
    cuts.push({
      n: cuts.length + 1,
      depth,
      orient: node.orient,
      region: {
        x: round3(node.x),
        y: round3(node.y),
        w: round3(node.w),
        h: round3(node.h),
      },
      band: {
        x: round3(node.bx),
        y: round3(node.by),
        w: round3(node.bw),
        h: round3(node.bh),
      },
      length: round3(node.orient === 'v' ? node.bh : node.bw),
    });
    node.children.forEach((c) => walk(c, depth + 1));
  }

  frees.sort((a, b) => b.area - a.area);

  // 未排件受阻原因：忽略纹向时某自由区域几何上能放下（任一朝向），
  // 但纹向允许的朝向放不下 → 纹向受阻；否则为尺寸不足
  const fitsAnyOrientation = (u) => freeLeaves.some((leaf) => (
    (u.width <= leaf.w + EPS && u.height <= leaf.h + EPS) ||
    (u.height <= leaf.w + EPS && u.width <= leaf.h + EPS)
  ));

  const unplacedList = unplaced
    .map((u) => ({
      id: u.id,
      name: u.name,
      width: u.width,
      height: u.height,
      grain: u.grain,
      total: u.quantity,
      placed: placedById[u.id] || 0,
      quantity: u._unplaced || 0,
    }))
    .filter((u) => u.quantity > 0)
    .map((u) => ({
      ...u,
      grainBlocked: u.grain !== 'any' && fitsAnyOrientation(u),
    }));

  const paperArea = paperW * paperH;
  const placedArea = items.reduce((s, it) => s + it.w * it.h, 0);
  const kerfArea = cuts.reduce((s, c) => s + c.band.w * c.band.h, 0);
  const ratio = paperArea > 0 ? placedArea / paperArea : 0;

  return {
    paper: { width: round3(paperW), height: round3(paperH), kerf: round3(kerf), grain: paperGrain },
    stats: {
      paperArea: round3(paperArea),
      placedArea: round3(placedArea),
      kerfArea: round3(kerfArea),
      freeArea: round3(paperArea - placedArea - kerfArea),
      areaRatio: round3(ratio * 1000) / 1000, // 0..1
      piecesPlaced: placedCount,
      piecesTotal: totalPieces,
      cutsTotal: cuts.length,
    },
    items,
    cuts,
    frees,
    unplaced: unplacedList,
  };
}

/**
 * 批量排产：按与 layout() 完全相同的断头台规则（含纹向约束）逐张排样。
 * 每张纸排完后，从剩余需求中扣除该张已排数量（直接以该张的
 * unplaced 作为下一张的需求清单，纹向要求随件保留），直到满足任一终止条件：
 *  - 全部成品排完           → stopReason: 'completed'
 *  - 已用纸张达到 maxSheets → stopReason: 'max-sheets'
 *  - 某张纸一件成品都排不进 → stopReason: 'no-progress'
 *    （尺寸或纹向限制均可能导致；该空白纸不计入结果并立即停止，
 *      绝不输出空白纸；循环上界为 maxSheets 且每张至少排入一件，必然终止）
 *
 * @param {object} input  同 layout()，另需 maxSheets：正整数（≤500）
 * @returns {{
 *   paper: object, stopReason: string,
 *   summary: { maxSheets, sheetsUsed, piecesPlaced, piecesTotal, completionRate, cutsTotal },
 *   sheets: Array,   // 每张纸各自完整的 layout() 结果
 *   remaining: Array // 仍未排入的成品（结构同 layout() 的 unplaced）
 * }}
 */
function layoutBatch(input) {
  const maxSheets = Number(input.maxSheets);
  if (!Number.isInteger(maxSheets) || maxSheets < 1) {
    throw new Error('最多用纸张数必须是正整数');
  }
  if (maxSheets > 500) throw new Error('最多用纸张数不能超过 500');

  // 首轮直接透传原始清单，纸张/成品/纹向校验由 layout 完成
  let demand = input.products;
  const originalTotal = new Map(); // id → 原始需求件数
  const sheets = [];
  let paper = null;
  let lastUnplaced = [];
  let totalPieces = 0;
  let placedTotal = 0;
  let cutsTotal = 0;
  let stopReason = 'max-sheets';

  for (let n = 0; n < maxSheets; n++) {
    const result = layout({
      paperW: input.paperW,
      paperH: input.paperH,
      paperGrain: input.paperGrain,
      kerf: input.kerf,
      products: demand,
    });
    paper = result.paper;
    lastUnplaced = result.unplaced;

    if (n === 0) {
      // 此时输入已通过 layout 校验，记录每种成品的原始需求
      totalPieces = result.stats.piecesTotal;
      demand.forEach((p, idx) => {
        const q = Math.floor(Number(p.quantity));
        if (!(q > 0)) return;
        const id = p.id != null ? String(p.id) : `P${idx + 1}`;
        originalTotal.set(id, (originalTotal.get(id) || 0) + q);
      });
    }

    if (result.stats.piecesPlaced === 0) {
      // 空白纸：不计入结果，立即止损
      stopReason = placedTotal >= totalPieces ? 'completed' : 'no-progress';
      break;
    }

    sheets.push(result);
    placedTotal += result.stats.piecesPlaced;
    cutsTotal += result.stats.cutsTotal;

    if (placedTotal >= totalPieces) {
      stopReason = 'completed';
      break;
    }

    // 扣除本张已排数量，剩余需求（含纹向要求）进入下一张纸
    demand = result.unplaced.map((u) => ({
      id: u.id,
      name: u.name,
      width: u.width,
      height: u.height,
      grain: u.grain,
      quantity: u.quantity,
    }));
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

  const completionRate = totalPieces > 0 ? placedTotal / totalPieces : 1;

  return {
    paper,
    stopReason,
    summary: {
      maxSheets,
      sheetsUsed: sheets.length,
      piecesPlaced: placedTotal,
      piecesTotal: totalPieces,
      completionRate: round3(completionRate * 1000) / 1000, // 0..1
      cutsTotal,
    },
    sheets,
    remaining,
  };
}

module.exports = {
  layout,
  layoutBatch,
  grainAllows,
  normalizePaperGrain,
  normalizeProductGrain,
};
