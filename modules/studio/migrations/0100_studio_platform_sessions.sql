CREATE TABLE IF NOT EXISTS studio_platform_sessions (
  platform text PRIMARY KEY CHECK (platform IN ('xhs', 'douyin', 'kuaishou', 'bilibili', 'weibo', 'tieba', 'zhihu')),
  sealed_cookie text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
