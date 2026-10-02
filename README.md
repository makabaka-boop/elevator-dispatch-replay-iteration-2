# 离线电梯群控模拟器

基于 **Svelte 4 + TypeScript + Vite + Vitest** 的纯前端离散事件模拟器。引擎先一次性计算完整 tick 时间线；页面播放、倍速、跳转都只读取预计算快照，不会重新派车或生成另一套状态。

## 功能

- 楼层 3～16；电梯 2～4；每台轿厢容量固定 6 人。
- 最多输入 100 个请求，每个请求包含：
  - `arrivalTick`：到达 tick，非负整数；
  - `origin`：出发层；
  - `destination`：目的层；
  - `people`：人数，正整数；
  - 可选 `cancelTick`：取消尚未上车乘客的 tick。
- `travelTicks`：行驶一层耗时；`doorOpenTicks`：开门耗时；`doorCloseTicks`：关门耗时，均为正整数。
- 门未关闭前电梯不能移动。
- 新请求派车规则：
  1. 对每台电梯基于其当前状态和**已承诺停靠点**做确定性 dry-run；
  2. 计算该电梯最早可实际接到乘客的 tick；
  3. 先取最小 ETA，ETA 相同再取最小电梯 ID。
- 容量不足时按轿厢剩余空间部分上客；未上车乘客保留在同一承诺队列，不会消失。
- 未上车乘客可取消；已上车乘客不可取消。若一个大请求已经部分上车，取消只影响剩余未上车部分。
- 可选 `carEvents` 按 tick 指定轿厢停运（`outage`）与恢复（`recover`）：
  - 事件在该 tick 的**新请求派车与轿厢推进之前**生效；
  - 同一 tick 的确定顺序：请求到达 → 取消 → 停运/恢复（按 carId，outage 先于 recover）→ 派车 → 轿厢推进；
  - 停运车冻结当前楼层、门相位及该相位剩余耗时；已上车乘客与目的层承诺保留；
  - 未上车承诺撤回，未上车乘客立即按其他可用车重新计算 ETA 并派车；全部车都停运时乘客继续等待（不取消），恢复后下一 tick 自动再派；
  - 恢复后从冻结相位继续，只消耗剩余耗时，**不补走**停运期间的路程。
- 事件日志记录每次请求到达、派车候选与依据、开关门、上下客、空驶/载客移动、取消及取消拒绝、停运/恢复与无车等待。

## 启动

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
npm run preview
```

## 场景 JSON 示例

```json
{
  "floors": 10,
  "elevators": 3,
  "travelTicks": 2,
  "doorOpenTicks": 1,
  "doorCloseTicks": 1,
  "requests": [
    {
      "id": "R001",
      "arrivalTick": 1,
      "origin": 1,
      "destination": 8,
      "people": 6
    },
    {
      "id": "R002",
      "arrivalTick": 3,
      "origin": 6,
      "destination": 2,
      "people": 8,
      "cancelTick": 30
    }
  ]
}
```

ID 可省略，系统按输入顺序生成 `R001`、`R002`……同 tick 新请求按 ID 升序处理，便于并列派车回放核对。

`carEvents` 可选；每台车的事件必须从 `outage` 开始、交替出现，同一 tick 同车只能有一个事件：

```json
{
  "floors": 10,
  "elevators": 3,
  "travelTicks": 2,
  "doorOpenTicks": 1,
  "doorCloseTicks": 1,
  "requests": [],
  "carEvents": [
    { "carId": 0, "tick": 4, "type": "outage" },
    { "carId": 0, "tick": 9, "type": "recover" }
  ]
}
```

## 状态机语义

- `closed`：门关，可决定开门或开始移动。
- `opening`：开门中，持续 `doorOpenTicks`。
- 开门完成的同一 tick 执行上客/下客，并立即进入 `closing`。
- `closing`：关门中，持续 `doorCloseTicks`。
- `moving`：行驶中，持续 `travelTicks` 后只移动一层。
- 每一层移动、开门、关门都是独立、可逐 tick 回放的离散状态。
- 停运不是门相位：`outOfService` 标记叠加在当前相位上，冻结期间位置、相位与 `phaseElapsed` 完全不变；恢复时继续消耗剩余耗时。

## 测试

```bash
npm test
npm run check
```

Vitest 覆盖：

- 并列候选的 ETA 与电梯 ID tie-break；
- 同 tick 多请求的确定性派车；
- 容量 6 人时的部分上客、返回再服务余客与人数守恒；
- 仅取消未上车乘客、已上车乘客不可取消；
- 开门/关门期间不行驶；
- 同一输入重复计算得到完全相同的逐 tick 快照；
- 不同播放速度、跳转、变速后仍引用同一份预计算状态；
- 行驶中/开关门途中停运的冻结、已上车乘客保留、未上车承诺撤回与重新派车、恢复只走剩余耗时；
- 部分上客后停运的余客重派与容量/人数守恒、全车停运时等待不取消、同 tick 事件确定顺序；
- 跨停运/恢复帧的播放跳转仍读取同一份快照。
