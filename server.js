const http = require("http");
const { readFile, writeFile, mkdir, rename } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3020);
const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      createdAt: new Date().toISOString()
    }
  ],
  damages: [
    {
      id: "damage_demo_1",
      rubbingId: "rubbing_demo",
      position: "左上角第3列题字旁",
      type: "虫蛀孔",
      beforePhotoUrl: "https://example.local/before-014-1.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null,
      mergedInto: null,
      mergedDamageIds: [],
      mergedAt: null
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null,
      mergedInto: null,
      mergedDamageIds: [],
      mergedAt: null
    }
  ],
  batches: []
};

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete",
  "POST /damages/merge"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    await readFile(DB_FILE, "utf8");
  } catch (err) {
    // 只有文件确实不存在才初始化；文件损坏时绝不覆盖既有数据
    if (err.code === "ENOENT") {
      await writeFileAtomic(DB_FILE, JSON.stringify(initialData, null, 2));
      return;
    }
    throw err;
  }
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await readFile(DB_FILE, "utf8"));
}

// 原子写：先写临时文件再 rename，读者绝不会读到写了一半的 JSON
async function writeFileAtomic(target, content) {
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, target);
}

async function writeDb(data) {
  await writeFileAtomic(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

// 写操作串行化：同一进程内并发写只允许一个进入临界区，避免重复合并等竞态
let writeChain = Promise.resolve();
function withWriteLock(task) {
  const run = writeChain.then(() => task());
  // 不论成功失败都释放锁，不让链中断
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// 旧记录可能没有合并字段：undefined 一律按未合并处理
function isMergedDamage(damage) {
  return damage.status === "merged" && Boolean(damage.mergedInto);
}

function mergedDamageIds(damage) {
  return Array.isArray(damage.mergedDamageIds) ? damage.mergedDamageIds : [];
}

// 已合并的附属记录解析到其主记录；其余（含字段缺失的旧数据）即自身
function resolvePrimary(db, damage) {
  if (isMergedDamage(damage)) {
    return db.damages.find((item) => item.id === damage.mergedInto) || damage;
  }
  return damage;
}

function isInOpenBatch(db, damage) {
  if (damage.batchId == null) return damage.status === "in_repair";
  const batch = db.batches.find((item) => item.id === damage.batchId);
  return !batch || batch.status !== "completed";
}

function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) {
    const error = new Error("拓片不存在");
    error.status = 404;
    throw error;
  }
  return rubbing;
}

// 批次按主记录汇总：
// - 附属记录折叠到主记录下，主记录或附属记录任一出现在批次即计入
// - 批次原 damageIds 不动，附属记录的原批次归属与修补结果保留
function enrichBatch(db, batch) {
  const listed = db.damages.filter((item) => batch.damageIds.includes(item.id));
  const primaries = [];
  const seen = new Set();

  for (const damage of listed) {
    const primary = resolvePrimary(db, damage);
    if (seen.has(primary.id)) continue;
    seen.add(primary.id);

    // 主记录名下的全部附属记录（无论是否在本批次），供汇总与结果保留
    const folded = db.damages.filter(
      (item) => isMergedDamage(item) && item.mergedInto === primary.id
    );
    primaries.push({ ...primary, mergedDamages: folded });
  }

  return {
    ...batch,
    damages: primaries,
    total: primaries.length,
    repaired: primaries.filter((item) => item.status === "repaired").length,
    pending: primaries.filter((item) => item.status !== "repaired").length
  };
}

// 入口：GET 直接处理；所有写请求经进程内互斥串行执行，避免重复合并等竞态
async function handle(req, res) {
  if (req.method !== "GET") {
    return withWriteLock(() => route(req, res));
  }
  return route(req, res);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter(
          (item) => item.status !== "repaired" && !isMergedDamage(item)
        ).length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null,
      mergedInto: null,
      mergedDamageIds: [],
      mergedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const data = db.damages.filter((item) => (!status || item.status === status) && (!type || item.type === type));
    return send(res, 200, { data });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const damage = db.damages.find((item) => item.id === damagePatchMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    if (isMergedDamage(damage)) {
      return send(res, 409, { error: "缺损已合并，附属记录只读", mergedInto: damage.mergedInto });
    }
    const body = await parseBody(req);
    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
      afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
      status: body.status ?? damage.status,
      repairNote: body.repairNote ?? damage.repairNote
    });
    damage.repairedAt = damage.status === "repaired" ? new Date().toISOString() : damage.repairedAt;
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) return send(res, 400, { error: "damageIds必须是非空数组" });
    const invalid = body.damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
    if (invalid.length) return send(res, 400, { error: `缺损项不存在：${invalid.join(", ")}` });
    const mergedIds = body.damageIds.filter((id) => {
      const damage = db.damages.find((item) => item.id === id);
      return isMergedDamage(damage);
    });
    if (mergedIds.length) {
      return send(res, 409, { error: `缺损已合并，不能加入批次：${mergedIds.join(", ")}` });
    }
    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: "open",
      damageIds: body.damageIds,
      note: body.note || "",
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    db.batches.push(batch);
    db.damages.forEach((damage) => {
      if (body.damageIds.includes(damage.id)) {
        damage.batchId = batch.id;
        damage.status = "in_repair";
      }
    });
    await writeDb(db);
    return send(res, 201, { data: enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = db.batches.find((item) => item.id === batchMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const batch = db.batches.find((item) => item.id === completeMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    const body = await parseBody(req);
    const results = Array.isArray(body.results) ? body.results : [];
    batch.status = "completed";
    batch.completedAt = new Date().toISOString();
    batch.note = body.note ?? batch.note;
    // 折叠到主记录：附属记录若在批次中，结果归入其主记录；附属记录本身字段保留
    const primaryIds = new Set();
    batch.damageIds.forEach((id) => {
      const damage = db.damages.find((item) => item.id === id);
      if (damage) primaryIds.add(resolvePrimary(db, damage).id);
    });
    db.damages.forEach((damage) => {
      if (!primaryIds.has(damage.id) || isMergedDamage(damage)) return;
      const result =
        results.find((item) => item.damageId === damage.id) ||
        results.find((item) => mergedDamageIds(damage).includes(item.damageId)) ||
        {};
      damage.status = "repaired";
      damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
      damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
      damage.repairedAt = new Date().toISOString();
    });
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  // 缺损合并：主记录保留位置，附属记录转为 merged 并指向主记录
  // 任一记录未修复、不在未结批次、属于同一拓片且均未合并时才允许，否则整单 409
  if (req.method === "POST" && pathname === "/damages/merge") {
    const body = await parseBody(req);
    required(body, ["primaryId", "secondaryId"]);
    if (body.primaryId === body.secondaryId) {
      return send(res, 400, { error: "主记录与附属记录不能是同一条缺损" });
    }
    const primary = db.damages.find((item) => item.id === body.primaryId);
    const secondary = db.damages.find((item) => item.id === body.secondaryId);
    if (!primary || !secondary) {
      return send(res, 404, {
        error: `缺损项不存在：${[!primary && body.primaryId, !secondary && body.secondaryId]
          .filter(Boolean)
          .join(", ")}`
      });
    }

    // 先全部校验通过再改动，任一不满足整单返回、记录不变
    if (primary.rubbingId !== secondary.rubbingId) {
      throw conflict("只能合并同一拓片的缺损");
    }
    if (primary.status === "repaired" || secondary.status === "repaired") {
      throw conflict("已修复的缺损不能合并");
    }
    if (isInOpenBatch(db, primary) || isInOpenBatch(db, secondary)) {
      throw conflict("缺损处于未结批次中，不能合并");
    }
    if (isMergedDamage(primary) || isMergedDamage(secondary)) {
      throw conflict("缺损已合并，不能重复合并");
    }
    // 主记录下已有附属 或 主记录已并入他人：禁止形成合并链
    if (mergedDamageIds(primary).length > 0) {
      throw conflict("主记录下已有合并缺损，不能再次作为主记录合并");
    }
    if (
      db.damages.some((item) => isMergedDamage(item) && item.mergedInto === secondary.id)
    ) {
      throw conflict("该缺损名下已有合并缺损，不能再作为附属记录");
    }

    const now = new Date().toISOString();
    primary.mergedDamageIds = [...mergedDamageIds(primary), secondary.id];
    primary.mergedAt = now;

    secondary.status = "merged";
    secondary.mergedInto = primary.id;
    secondary.mergedAt = now;
    // 附属记录原有 batchId、修补结果、位置等字段一律保留

    await writeDb(db);
    const primaryOut = {
      ...primary,
      mergedDamages: db.damages.filter(
        (item) => isMergedDamage(item) && item.mergedInto === primary.id
      )
    };
    return send(res, 200, { data: { primary: primaryOut, secondary } });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
