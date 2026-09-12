-- 题库与学习数据。bank.db 的唯一结构定义。
PRAGMA foreign_keys = ON;

CREATE TABLE questions (
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
CREATE INDEX idx_q_section ON questions(section);
CREATE INDEX idx_q_module  ON questions(module);
CREATE INDEX idx_q_type    ON questions(type);

CREATE TABLE attempts (
  qid     TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  chosen  TEXT NOT NULL,
  correct INTEGER NOT NULL,                 -- 判分时算好存下，统计查询快
  at      TEXT NOT NULL
);

CREATE TABLE wrong (
  qid         TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  chosen      TEXT,
  wrong_count INTEGER NOT NULL DEFAULT 1,
  first_at    TEXT NOT NULL,
  last_at     TEXT NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE mock_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  ends_at      TEXT NOT NULL,
  submitted_at TEXT,
  state        TEXT NOT NULL                -- JSON：题号序列+答案+分部分结构+是否含多选判断
);

CREATE TABLE sprint (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at    TEXT NOT NULL
);
