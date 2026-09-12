-- 题库与学习数据。bank.db 的唯一结构定义。

-- 注意：外键约束是**每连接**开关，下面这行只对执行本脚本的那条连接生效，
-- 不会写进 bank.db 文件。凡是依赖级联删除的地方（import_bank.py / server.py），
-- 都必须在自己新建的连接上重新执行一次 PRAGMA foreign_keys = ON，
-- 否则 ON DELETE CASCADE 会静默失效，留下孤儿行且不报错。
PRAGMA foreign_keys = ON;

-- 下面全部 DDL 都用 IF NOT EXISTS：import_bank() 每次导入都会执行本脚本，
-- 库已存在时不能炸（否则 bank.db 只能生成一次，任何重跑都报
-- 「table questions already exists」）。同理**不能**改用 DROP TABLE：
-- attempts / wrong 靠 ON DELETE CASCADE 挂在 questions 上，
-- 库一旦删掉就等于连用户的作答历史和错题本一起清空。
-- 代价：若 bank.db 是旧结构，IF NOT EXISTS 会静默跳过，不做结构升级——
-- 升级留到真有需要时显式处理。

CREATE TABLE IF NOT EXISTS questions (
  id          TEXT PRIMARY KEY,
  n           INTEGER NOT NULL UNIQUE,      -- 稳定序号，仅用于显示题号
  section     TEXT NOT NULL,                -- 归哪个知识页：edu/pub/local/school/counselor
  module      TEXT NOT NULL,                -- 配比表与成绩单按它分组
  type        TEXT NOT NULL CHECK (type IN ('single','judge','multi')),
  stem        TEXT NOT NULL,
  options     TEXT NOT NULL,                -- JSON 数组。判断题固定 ["正确","错误"]
  answer      TEXT NOT NULL,                -- 'B' / 'A' / 'ABD'（升序无分隔）
  explanation TEXT NOT NULL,
  source      TEXT,                         -- 本地题/时政题必填
  tags        TEXT,
  difficulty  INTEGER CHECK (difficulty BETWEEN 1 AND 3),
  batch       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_q_section ON questions(section);
CREATE INDEX IF NOT EXISTS idx_q_module  ON questions(module);
CREATE INDEX IF NOT EXISTS idx_q_type    ON questions(type);

CREATE TABLE IF NOT EXISTS attempts (
  qid     TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  chosen  TEXT NOT NULL,
  correct INTEGER NOT NULL,                 -- 判分时算好存下，统计查询快
  at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wrong (
  qid         TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  chosen      TEXT,
  wrong_count INTEGER NOT NULL DEFAULT 1,
  first_at    TEXT NOT NULL,
  last_at     TEXT NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mock_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  ends_at      TEXT NOT NULL,
  submitted_at TEXT,
  state        TEXT NOT NULL                -- JSON：题号序列+答案+分部分结构+是否含多选判断
);

CREATE TABLE IF NOT EXISTS sprint (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at    TEXT NOT NULL
);
