# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项和修补批次。

## 启动

```bash
PORT=3020 node server.js
```

## 主要接口

- `GET /health`
- `GET /rubbings`
- `POST /rubbings`
- `GET /rubbings/:id/damages`
- `POST /rubbings/:id/damages`
- `GET /damages?status=&type=`
- `PATCH /damages/:id`
- `GET /batches`
- `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/complete`
- `POST /damages/merge`

## 缺损合并闭环

`POST /damages/merge`，请求体：

```json
{ "primaryId": "damage_demo_1", "secondaryId": "damage_demo_2" }
```

- 主记录保留位置，并新增 `mergedDamageIds`（附属 id 列表）与 `mergedAt`
- 附属记录 `status` 转为 `merged`，新增 `mergedInto` 指向主记录、`mergedAt` 记录时间；原 `batchId`、位置、修补结果等字段保留
- 任一记录满足以下条件时整单返回 `409`，记录不变：处于未结批次（`open`）中、已修复（`repaired`）、两条不属于同一拓片、任一方已合并；同 id 自合并返回 `400`，记录不存在返回 `404`
- 批次列表与批次详情按主记录汇总：附属记录折叠在主记录的 `mergedDamages` 下，`total/repaired/pending` 只计主记录；批次自身的 `damageIds` 不改动
- 批次结项时结果（afterPhotoUrl/repairNote，支持按附属 id 回填）落到主记录；附属记录原批次归属与修补结果保留
- 写请求在进程内串行执行，并发重复合并只有一次成功，其余返回 `409`
- 旧数据缺少合并字段（`mergedInto`/`mergedDamageIds`）时一律按未合并处理

## 闭环示例

```bash
curl http://127.0.0.1:3020/damages?status=pending
curl -X POST http://127.0.0.1:3020/damages/merge \
  -H 'Content-Type: application/json' \
  -d '{"primaryId":"damage_demo_1","secondaryId":"damage_demo_2"}'
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1"]}'
```
