CREATE TABLE IF NOT EXISTS studio_trend_boards (
  platform text PRIMARY KEY CHECK (platform IN ('douyin', 'bilibili', 'weibo', 'zhihu', 'tieba', 'kuaishou')),
  source_id text NOT NULL UNIQUE REFERENCES sources(id)
);
