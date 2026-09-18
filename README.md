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
- `POST /damages/:id/merge`
- `GET /batches`
- `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/complete`

## 闭环示例

```bash
curl http://127.0.0.1:3020/damages?status=pending
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'
```

## 缺损合并

同一拓片的两条待修缺损可合并：`POST /damages/:id/merge`，body 为 `{"targetId":"主记录ID"}`。
附属记录（`:id`）转为 `merged` 状态并通过 `mergedInto` 指向主记录，主记录保留原位置不变。
任一记录在未结批次、已修复、已合并或不属于同一拓片时整单返回 409，记录不变。
批次结项与批次列表按主记录汇总（附属记录归入 `mergedDamages`），附属记录的原批次归属与修补结果保留。
旧数据缺少合并字段时按未合并处理。

```bash
curl -X POST http://127.0.0.1:3020/damages/damage_demo_2/merge \
  -H 'Content-Type: application/json' \
  -d '{"targetId":"damage_demo_1"}'
```
