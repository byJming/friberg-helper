<div align="center">

# 弗一把助手 · friberg-helper

**CS:GO/CS2 选手猜测游戏辅助油猴脚本 — 求解、填入、控场、反检测**

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Version: 0.10.0](https://img.shields.io/badge/version-0.10.0-green.svg)
![Tampermonkey](https://img.shields.io/badge/userscript-Tampermonkey-orange.svg)

</div>

---

## 核心特性

**求解器** — 信息熵 + 极小化极大双策略，top-K 加权随机避免每步最优，反馈分区键与服务端逐字等价

**单人/多人接管** — 开局自动计算填入；多人 DOM 轮询解析反馈，自动检测回合/场次结束与重赛续接

**控场模式** — 每局最少猜测次数（区间随机）+ 提交延迟（候选数关联 + 偶发长考）+ 放水概率；确认答案后用近似选手递补，绿色单调递增

**反检测 governor** — 跨局滚动平均 entropyPercentile，动态调整目标百分位带，把服务端 similarityIndex 压在 common 区间，模拟"聪明但非机器"的玩家

**三级数据源** — 仓库自动拉取 < 本地 JSON 导入 < 服务器增量同步；任何来源增量合并不清空既有数据，冲突以高优先级为准。检测到答案与本地选手库不一致时，自动从服务器补充缺失选手（服务器数据，优先级最高）

**自动提交** — 可选；冷却等待 + 昵称校验 + 去重，默认关闭

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey）
2. 点击安装：[friberg-helper.user.js](https://github.com/byJming/friberg-helper/raw/main/friberg-helper.user.js)
3. 刷新游戏页面，右下角出现面板即成功

> 首次使用自动从仓库拉取选手库，无需手动操作。也可点面板「导入 JSON」加载本地 `data/players_full.json`，或「同步服务器」增量获取服务器最新属性（支持续传/取消）。

## 使用

**单人** — 开局后自动填入最优猜测，手动点提交。

**多人** — 默认只填入不提交；面板点「自动提交」开启全自动。「控场」开关展开后配置区间参数，避免碾压。

**面板** — 标题栏可拖拽，`─` 收起为浮标。「选手库」卡片展示来源构成（仓库/本地/服务器）与同步进度。

## 选手库数据格式

```json
{
  "version": "2026-07-31",
  "players": [
    {
      "nickname": "...",
      "nationality": "...",
      "region": "...",
      "team": "...",
      "team_history": [],
      "age": 0,
      "role": "...",
      "major_championships": 0,
      "major_appearances": 0,
      "is_active": true
    }
  ]
}
```

脚本兼容 camelCase 与 snake_case 两种字段格式。`version` 为可选字段，用于版本追踪。`team_history` 为可选字符串数组（每项 ≤64 字符、≤50 项）：猜测队伍在答案选手历史队伍中时服务端反馈黄格；缺失时脚本会在对局中自动积累并落盘。

## 项目结构

```
friberg-helper/
├── friberg-helper.user.js   # 单文件脚本（全部功能）
├── data/players_full.json   # 选手库（含 version，646 人）
├── README.md
└── LICENSE                  # MIT
```

## 免责

仅供学习交流。是否使用自动提交由使用者自行决定并承担后果。游戏本体为 [shnlfriberg/csgofriberg](https://github.com/shnlfriberg/csgofriberg)（AGPL-3.0），本项目独立（MIT），不含其源码。

## 许可证

[MIT](LICENSE) © 2026 ming
