# MediaCrawler adaptation

Source: https://github.com/NanmiCoder/MediaCrawler
Commit: 8f583999006d5b692272c608440e193ca282e73b
Copyright (c) 2025 relakkes@gmail.com
License: NON-COMMERCIAL LEARNING LICENSE 1.1 (included in LICENSE).

`backend/creator-links.ts` adapts creator URL patterns from
`media_platform/{bilibili,douyin,kuaishou,xhs}/help.py` and the creator-input shapes
in `config/{tieba,weibo,zhihu}_config.py`.
Local changes: TypeScript URL parsing, exact host and full path checks,
canonical HTTPS addresses, query-free identity keys, private xhs share context,
and rejection of unsupported or ambiguous URLs.

The project-owned Python runtime now executes the original BilibiliClient and
BilibiliSign from this same commit. `backend/mediacrawler-child.py` adapts the
upstream HTTP client factory to a parent-process controlled transport, obtains WBI
keys through the client's existing nav fallback without launching Chromium, and
normalizes one page of videos and bounded first-level comments. No upstream
main(), database, CDP login, media download or user browser profile is started.
The adapter also executes the original WeiboClient, XiaoHongShuClient,
XiaoHongShuExtractor and the locked xhshow signer through the same controlled
transport. Local changes normalize creator profiles, cursor-based post/note pages,
HTML long-post text, distinct engagement metrics and bounded first-level comments.
Read-only note detail requests use the upstream signed POST feed endpoint.
The original ZhiHuClient now supplies signed profile reads, both answer and article
lists, and bounded root comments. Profile normalization follows ZhihuExtractor's
public HTML field without using the upstream anonymized store. Its original
libs/zhihu.js (including the upstream tiam-bloom attribution) is executed by the
existing Node parent through a constrained signing message, rather than allowing
ExecJS to spawn an unrestricted process. The script digest is pinned in runtime.json.
The original BaiduTieBaClient PC signing, creator feed and page API and
TieBaExtractor now run through a page-method broker into one isolated Chromium.
The parent reuses its guarded HTTP adapter; Python cannot open sockets or launch
another browser. Local normalization keeps explicitly followed public profile
fields, thread identities, opening text, bounded replies and available floor numbers.
Missing pagination is a failure; sub-replies and media remain incomplete.
The original DouYinClient profile, creator publications and root comments now use
the same guarded HTTP broker. libs/douyin.js retains its upstream ShilongLee/Crawler
attribution; its normalized digest is pinned and its original sign_datail function
runs in the Node parent instead of unrestricted ExecJS subprocesses. One isolated
page supplies the actual User-Agent and localStorage; only the supplied Cookie's
msToken is seeded as xmst, not claimed as acquired SDK state. Video/image-text
descriptions, private pagination and bounded comments are normalized locally;
video transcription and media remain pending.
The original KuaiShouClient get_creator_profile, get_video_by_creater_v2 and
get_video_comments now use the same broker. The original KS_SIGN_CAPTURE_SCRIPT
from help.py is injected before navigation, and get_ks_sign_from_playwright's
bounded ready/reload/encode calls are adapted to that sole controlled page.
The help.py digest is pinned; production uses the site-provided signing SDK,
never the test fixture SDK. GraphQL is limited to the creator profile query;
REST uses the current signed profile-feed and root-comment list. Public profile,
video descriptions, available metrics and private cursors are normalized locally.
Nested replies, avatar assets, media/ASR and real-account acceptance remain pending.
`runtime.json` pins the commit, Python version and upstream uv.lock SHA-256
after UTF-8 decoding and CRLF-to-LF normalization, so Windows Git settings do not
change the reviewed lock identity.

Use is restricted to the user's stated personal non-commercial learning and research.
The original upstream LICENSE applies to the adapted material; this notice does not
relicense it under the parent application's MIT license.

Bounded reply sampling now reuses this fixed commit's BilibiliClient
get_video_level_two_comments, XiaoHongShuClient.get_note_sub_comments,
ZhiHuClient.get_child_comments, DouYinClient.get_sub_comments (including the
original sign_reply in libs/douyin.js), and KuaiShouClient.get_video_sub_comments.
Weibo's embedded comments follow its existing sub-comment extraction shape.
Tieba reuses TieBaExtractor.extract_tieba_note_sub_comments on a first-page HTML
response obtained through the existing guarded page broker, never its unrestricted
synchronous requests client. Local adaptation adds parent IDs, preview deduplication,
20 roots/20 replies per work, two extra requests per work and twelve per collection,
plus explicit sampled/pending coverage. Prior pending statements above are historical;
full pagination and real-account acceptance remain unfinished.

Local media-input extension (in progress): the same fixed commit's pure
`media_platform/{xhs,weibo,douyin,kuaishou}/media.py` `extract_video_urls`
functions are now invoked against the already-read original note/mblog/aweme/photo
objects. Douyin's import stays inside the existing controlled working-directory
and signer initialization; no upstream ExecJS subprocess is started. At most three
candidate URLs are stored for backend processing and omitted from creator reading
responses. Weibo video posts are identified separately from text-only posts.
`backend/platform-media.ts` connects the selected candidate and platform Referer to
the existing guarded downloader/local recognizer/storage lifecycle. The upstream
MediaDownloader, image proxy rewrites, FFmpeg runner and default media directories
are not started. Bilibili media/subtitles, other media types, candidate fallback,
the durable ASR queue and real-platform acceptance remain unfinished.

Bilibili media input now also reuses this commit's `get_video_info`,
`get_video_play_url(fnval=1)`, `count_durl_segments` and `build_durl_item`.
A designated single-video lookup validates the followed owner and video ID;
only one page with one complete durl is accepted, so the upstream helper's
largest-segment selection never silently substitutes for a complete video.
The existing controlled Python runner and HTTP broker are extended, not a
second downloader service. Subtitles, multi-page/segmented media and live
account verification are still unfinished.

The current candidate-recovery slice adapts the same commit's
`media_downloader/downloader.py` primary/backup loop and content-type rules into
`backend/media-transcription.ts`. The fixed platform extractors still supply the
ordered candidates. Changes: at most three distinct addresses, one shared 120s
deadline and 512MiB response budget, no fragment append, only complete HTTP200
accepted, and rate/server errors returned to the existing durable retry policy.
Explicit HTML/JSON/text/HLS and form-urlencoded types are not accepted as media;
neutral octet-stream/MP4/M4A and absent type headers remain supported.
The TypeScript adaptation uses the original guarded HTTP/storage lifecycle;
the upstream downloader and its retry/filesystem/FFmpeg service are not started.
This is not automatic URL refresh for every platform or real-account acceptance.

The designated-media refresh adaptation also executes this commit's original
WeiboClient.get_note_info_by_id and XiaoHongShuClient.get_note_by_id. The existing
normalizers validate the requested post/note and creator, skip profile/list/comment
requests in this mode, and return current media candidates without updating stored
facts or historical snapshots. XHS note-specific access context is retained only
inside the private media field; it is not substituted with profile share context.
The parent restricts refresh requests to the exact Weibo detail path or the XHS
feed endpoint with its designated note ID and access parameters. Existing HTTP,
Python lifecycle, ASR checkpoints and immediate successful-media cleanup are reused.
Douyin/Kuaishou refresh, multipart Bilibili and real-account tests remain separate.

The subsequent designated-media slice now executes DouYinClient.get_video_by_id
and KuaiShouClient.get_video_info from the same fixed commit, including the
original Douyin same-cookie UIFID/verifyFp/fp parameters and video_detail.graphql.
The existing controlled page supplies the original browser agent and session.
Changes limit parent requests to the requested aweme ID or visionVideoDetail
operation/photoId/page, validate returned creator and work, skip list/comments,
and treat null Kuaishou photo/author as unavailable (adapted from core.py).
These read-only results do not overwrite stored facts or historical snapshots.
Multipart Bilibili, full rhythm evidence and real-account tests are still pending.
