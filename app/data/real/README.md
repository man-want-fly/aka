# real 数据目录（只由真实数据源写入）

`app/data/real/` 的隔离契约（TD-S0-070）：

- 本目录只接受真实数据源（tdx / tushare 等）落盘，**任何 sim 生成器禁止写入**；
  `data-provider::sim_dataset::write_sim_dataset` 对路径含 `real` 的目录直接返回 `PermissionDenied`
  （单测 `generator_refuses_real_directories` 锁定）。
- sim 数据固定落在 `app/data/sim/seed-<n>/`，与 real 目录互不读取、互不覆盖。
- 本目录当前仅有本说明文件，无任何行情数据；sim 重建前后本目录 sha256 不变（见
  `docs/qa/aka-tech-debt-s0-v0.1.md` 的清偿证据）。
