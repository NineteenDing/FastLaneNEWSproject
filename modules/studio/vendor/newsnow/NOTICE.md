# NewsNow platform adapters

Source: https://github.com/newsnext/newsnow
Commit: 0560c993b226cd2fd07d8a79875d50551f52c584
Copyright (c) 2024 ourongxing. MIT; see LICENSE.

Adapted server/sources/{douyin,bilibili,weibo,zhihu,tieba,kuaishou}.ts into backend/trend-reader.ts.
Retained fixed platform endpoints, JSON field selection, Weibo table selectors and Kuaishou Apollo-state lookup.
Replaced Nitro globals with the existing guarded HTTP interface, explicit schemas, byte/time/cancellation bounds and private durable observations.
Preserved raw heat strings separately from genuine Bilibili view metrics. Did not copy the hard-coded Weibo Cookie, third-party icons, public aggregate API, UI, service or cache.
Platform session secrets come only from the user's corresponding encrypted platform session; temporary Douyin bootstrap cookies stay within its fixed platform requests.

2026-10-20 added server/sources/baidu.ts from the same fixed NewsNow commit.
Retained the fixed top.baidu.com endpoint, s-data comment extraction, first card's content and pinned-topic exclusion.
Added strict bounded parsing, same-platform URL validation, optional raw heat (never views), anonymous requests and the existing private durable board observations. No NewsNow service/UI/cache or credentials are copied.
