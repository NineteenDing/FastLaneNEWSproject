ALTER TABLE studio_trend_boards ADD CONSTRAINT studio_trend_boards_platform_v2_check CHECK (platform IN ('douyin', 'bilibili', 'weibo', 'zhihu', 'tieba', 'kuaishou', 'baidu')) NOT VALID;
