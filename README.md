<div align="center">

# 弗一把助手 · friberg-helper

**CS:GO / CS2 《弗一把》开源辅助油猴脚本 — 求解、填入、控场、反检测**

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Version: 0.3.0](https://img.shields.io/badge/version-0.3.0-green.svg)
![Tampermonkey](https://img.shields.io/badge/userscript-Tampermonkey-orange.svg)

</div>

---

## 特性

| 模块 | 说明 |
|------|------|
| 求解器 | 信息熵 + 极小化极大双策略，top-K 加权随机避免每步最优（反服务端相似度检测） |
| 单人接管 | 开局自动计算填入，战绩/经验本地统计 |
| 多人接管 | DOM 轮询解析反馈，自动检测回合/整场结束，重赛续接 |
| 自动提交 | 可选；冷却等待 + 昵称校验 + 去重，默认关闭 |
| 控场模式 | 最少猜测（区间随机）、提交延迟（候选数关联 + 抖动）、放水概率 |
| 渐进逼近 | 探路按属性距离从远到近固定序列，反馈面板逐步变绿，排除答案防提前命中 |
| 反检测 | 猜测去最优化（top-4 随机）、延迟非等间隔、探路正向 information gain |
| 选手库 | GitHub 数据仓库自动获取 + 本地 JSON 回退 + 更新检测 |
| 面板 | 毛玻璃 UI、可拖拽、可收起、状态色条 |

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey）
2. 点击安装：[friberg-helper.user.js](https://github.com/byJming/friberg-helper/raw/main/friberg-helper.user.js)
3. 刷新游戏页面，右下角出现面板即成功
4. 选手库自动从 GitHub 获取；失败时点「导入 JSON」选择 `data/players_full.json`

> ⚠️ **选手库一致性**：服务器数据库由管理员手工维护，可能落后于 GitHub 数据仓库。若提示「选手库与服务器不一致」，改用「导入 JSON」加载本仓库 `data/players_full.json`。

## 使用

**单人**：开局后自动填入，手动点提交。

**多人**：
- 默认只填入不提交；面板点「自动提交」开启全自动
- 「控场」开启后配置区间参数，避免碾压
- 本局结束自动停止，下一局/重赛自动恢复

**面板操作**：
- 标题栏可拖拽移动，`─` 按钮收起为浮标
- 「自动提交」「控场」为 pill 开关，点击切换
- 「控场」展开配置：最少猜测区间、延迟区间、放水概率

## 工作原理

```
选手库 → 编码索引(8维属性)
              │
反馈(DOM/网络) → 反馈键 → 候选集过滤
              │
     ┌────────┴────────┐
     ▼                 ▼
  控场探路           正常求解
  (渐进序列,         (top-K 随机,
   排除答案)          非每步最优)
     └────────┬────────┘
              ▼
     填入 → 延迟 → 提交
```

- **求解**：候选 > 12 用信息熵，≤ 12 用极小化极大；均从 top-4 中加权随机选取
- **控场**：每局从区间随机取最少猜测数；探路按 `guessDistance` 生成远→近固定序列，逐步变绿且绝不命中答案
- **延迟**：在用户设定区间内，按候选数偏移（多→上段，少→下段）+ ±0.8s 抖动
- **多人解析**：轮询 `.player-board-self` 表格行 CSS 状态还原反馈；MutationObserver 精准监听
- **数据安全**：所有数据仅存本机油猴存储，不上传

## 项目结构

```
friberg-helper/
├── friberg-helper.user.js   # 单文件脚本（全部功能）
├── data/players_full.json   # 选手库（646 人，与服务器一致）
├── README.md
└── LICENSE                  # MIT
```

## 免责

仅供学习交流。是否使用自动提交由使用者自行决定并承担后果。游戏本体为 [shnlfriberg/csgofriberg](https://github.com/shnlfriberg/csgofriberg)（AGPL-3.0），本项目独立（MIT），不含其源码。

## 许可证

[MIT](LICENSE) © 2026 ming
