# 外部代码审查（OpenCodeReview）接入

## 一句话

`scripts/review.mjs` 把阿里开源的 OpenCodeReview（命令 `ocr`）包了一层，作用是**不让「没审」看起来像「审过了」**。

## 为什么需要这层壳

`ocr` 有三种结局，其中两种的退出码都是 0：

| status | 含义 | 原始退出码 |
| --- | --- | --- |
| `complete` | 真审了，可能 0 条也可能 N 条 | 0 |
| `skipped` | 没审（没有可选文件 / 全被规则排除） | **0** |
| `failed` | 查了但失败（预算耗尽 / LLM 报错 / 工具全挂） | 1 |

实测依据：
- 在空仓跑 `ocr review` → `status="skipped"`，`exit=0`
- 把 `--max-tokens-budget` 压到 1 → `status="failed"`，`exit=1`

所以「退出码 0」既可能是干净，也可能是根本没审。这正是本插件一直在防的形状，这层壳的唯一职责就是把三种结局拆开。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | complete，真审了。**不代表 0 条发现** |
| 1 | failed，没审成 |
| 2 | 参数错或找不到 ocr |
| 3 | skipped，没审。CI 里应视为失败 |
| 4 | `--clean` 跑完了（这不是一次审查） |

关键约定：**0 不表示「代码没问题」**。发现项打印在输出里，是否卡住由调用方决定。

## 用法

```bash
node scripts/review.mjs                    # 审工作区改动
node scripts/review.mjs --commit HEAD      # 审单个提交
node scripts/review.mjs --from main --to dev
node scripts/review.mjs --clean            # 清临时结果
```

或 `npm run review`。

`--out <path>` 是**副本**：ocr 永远只写进本次独占的临时目录，成功后才复制到你指定的位置。这样 `--out package.json` 不会在跑之前就把原文件删掉。

## 实现里踩到的坑（留作记录）

**Windows 上 spawn `.cmd` 会 EINVAL。** npm 全局 bin 在 Windows 是 `ocr.cmd` 批处理垫片，而 Node 在未开 `shell` 的 `spawnSync` 里拒绝执行 `.cmd`（CVE-2024-27980 之后加的防护）。三个解法各有代价：开 `shell:true` 要多一层引号转义（中文路径容易碎）、走 `cmd /c` 同上、或者顺着垫片读出它真正要跑的 `.js` 入口用当前 node 跑。这里取第三种。

**结果 JSON 里带源码片段。** 所以每次运行用 `mkdtempSync` 独占一个临时目录、权限压到 0700，不共用固定文件名——否则两个并发审查会互删对方的结果，一个可能读到另一个的 JSON 当成自己的结论。

**先删旧结果再跑。** 否则 ocr 崩了没写盘时，会读到上一轮的 JSON 并报成 `complete`。

**参数校验一律返回 2。** 覆盖：缺值、空串（`--from "$UNSET"`）、以 `-` 开头的值、`--commit` 与 `--from/--to` 互斥、`--to` 单独给。

## 边界

- 这层壳只保证**结局不撒谎**，不保证审查质量。ocr 报 0 条也可能是它没看懂。
- 审查内容是工作区相对 HEAD 的改动，`cwd` 固定为仓库根，在你别的目录里跑也一样。
- 结果 JSON 含源码片段，默认落在系统临时目录，需要留存请用 `--out` 复制出来。
