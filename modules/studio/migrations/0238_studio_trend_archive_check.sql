ALTER TABLE studio_trend_news ADD CONSTRAINT studio_trend_news_state_check CHECK(state IN ('queued','ready','awaiting_content','failed','archived')) NOT VALID;
