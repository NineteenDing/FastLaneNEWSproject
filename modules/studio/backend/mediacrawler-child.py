"""FastLaneNEWS adapter for fixed MediaCrawler 8f583999 (see vendor/mediacrawler).

Reuse upstream clients/signatures; HTTP and page methods cross the parent broker.
No upstream main(), login automation, databases, media downloader or user profile.
"""
import asyncio
import base64
import json
import logging
import re
import sys
from contextlib import chdir
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit, urlencode
from parsel import Selector

wire = sys.stdout
sys.stdout = sys.stderr
sys.path.insert(0, sys.argv[1])
import httpx
import tools.httpx_util


def emit(value):
    wire.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
    wire.flush()


class PlatformFailure(BaseException):
    def __init__(self, code):
        self.code = code


def select_discovered_content(job, identity, question_id=None):
    message = {"type": "content-selected", "externalId": identity}
    if question_id is not None:
        message["questionId"] = question_id
    emit(message)
    if not json.loads(sys.stdin.readline(16384)).get("ok"):
        raise PlatformFailure("platform_failed")
    job["videoId"] = identity
    if question_id is not None:
        job["context"]["questionId"] = question_id


class BrokerTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request):
        await asyncio.sleep(3)
        body = await request.aread()
        emit({"type": "fetch", "url": str(request.url), "method": request.method,
              "headers": dict(request.headers), "body": base64.b64encode(body).decode()})
        line = await asyncio.to_thread(sys.stdin.readline, 12 * 1024 * 1024)
        response = json.loads(line)
        if response.get("error"):
            raise httpx.TransportError("Controlled platform request failed")
        content = base64.b64decode(response["body"])
        if response["status"] in (401, 403):
            raise PlatformFailure("login_required")
        if response["status"] in (412, 429, 461, 471):
            raise PlatformFailure("rate_limited")
        if response["status"] != 200:
            raise PlatformFailure("platform_failed")
        try:
            data = json.loads(content)
        except (ValueError, TypeError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        if data.get("code") in (-101, -100):
            raise PlatformFailure("login_required")
        if data.get("code") in (-352, -412, 300011, 300012):
            raise PlatformFailure("rate_limited")
        if request.url.host == "m.weibo.cn" and data.get("ok") == 0:
            raise PlatformFailure("platform_failed")
        # Known upstream REST business limit: stop this run and use the durable
        # queue's existing backoff instead of immediately repeating limited calls.
        if request.url.host == "www.kuaishou.com" and request.url.path.startswith("/rest/v/") and data.get("result") == 2:
            raise PlatformFailure("rate_limited")
        return httpx.Response(response["status"], headers=response["headers"], content=content, request=request)


def controlled_client(**kwargs):
    kwargs.pop("proxy", None)
    kwargs.pop("verify", None)
    return httpx.AsyncClient(**kwargs, transport=BrokerTransport(), trust_env=False)


tools.httpx_util.make_async_client = controlled_client
from media_platform.bilibili.client import BilibiliClient
from media_platform.bilibili.field import CommentOrderType
from media_platform.bilibili.media import build_durl_item, count_durl_segments, MP4_FNVAL
from media_platform.weibo.client import WeiboClient
from media_platform.weibo.media import extract_video_urls as weibo_video_urls
from media_platform.xhs.client import XiaoHongShuClient
from media_platform.xhs.media import extract_video_urls as xhs_video_urls
from media_platform.zhihu.client import ZhiHuClient
from media_platform.tieba.client import BaiduTieBaClient
from media_platform.tieba.help import TieBaExtractor
from media_platform.kuaishou.client import KuaiShouClient
from media_platform.kuaishou.media import extract_video_urls as kuaishou_video_urls
import media_platform.zhihu.client as zhihu_client
logging.disable(logging.CRITICAL)


def zhihu_sign(uri, cookie):
    # Reuse libs/zhihu.js in the existing Node parent, without permitting ExecJS subprocesses.
    emit({"type": "zhihu-sign", "uri": uri})
    return json.loads(sys.stdin.readline(16 * 1024))


zhihu_client.sign = zhihu_sign


class BrokerPage:
    """Original Python page methods execute in the parent's sole controlled Chromium."""
    url = "about:blank"
    user = None

    async def exchange(self, message):
        emit({"type": "browser", **message})
        reply = json.loads(await asyncio.to_thread(sys.stdin.readline, 12 * 1024 * 1024))
        self.url = reply["url"]
        return reply["value"]

    async def goto(self, url, **kwargs):
        return await self.exchange({"action": "goto", "url": url})

    async def evaluate(self, expression, argument=None):
        if isinstance(argument, list) and len(argument) == 3 and argument[0] in ("/rest/v/profile/feed", "/rest/v/search/feed") and argument[1] == {"caver": 2}:
            return await self.exchange({"action": "kuaishou-sign", "uri": argument[0], "body": argument[2]})
        if argument is None and expression in ("() => window.localStorage", "() => navigator.userAgent"):
            return await self.exchange({"action": "state", "field": "storage" if "localStorage" in expression else "userAgent"})
        reply = await self.exchange({"action": "evaluate", "expression": expression, "argument": argument})
        if reply["status"] in (401, 403):
            raise PlatformFailure("login_required")
        if reply["status"] in (412, 429, 461, 471):
            raise PlatformFailure("rate_limited")
        if reply["status"] != 200:
            raise PlatformFailure("platform_failed")
        if urlsplit(argument["url"]).path == "/p/comment":
            return reply
        data = json.loads(reply["text"])
        if urlsplit(argument["url"]).path == "/c/u/pc/homeSidebarRight":
            self.user = data.get("data", {}).get("user")
        return reply

    async def wait_for_function(self, expression, **kwargs):
        if expression != "() => !!window.__ks_realm":
            raise PlatformFailure("platform_failed")
        if not await self.exchange({"action": "kuaishou-ready", "timeout": kwargs.get("timeout")}):
            raise TimeoutError("Kuaishou signing page not ready")

    async def reload(self, **kwargs):
        return await self.exchange({"action": "kuaishou-reload"})


class DouyinSigner:
    def call(self, name, params, agent):
        if name not in ("sign_datail", "sign_reply"):
            raise PlatformFailure("platform_failed")
        emit({"type": "douyin-sign", "name": name, "params": params, "agent": agent})
        return json.loads(sys.stdin.readline(16 * 1024))


class ApiBilibiliClient(BilibiliClient):
    """The upstream fallback nav API supplies WBI keys without starting Chromium."""
    _keys = None

    async def get_wbi_keys(self):
        if self._keys is None:
            nav = await self.request("GET", self._host + "/x/web-interface/nav", headers=self.headers)
            wbi = nav["wbi_img"]
            self._keys = tuple(wbi[key].rsplit("/", 1)[1].split(".")[0] for key in ("img_url", "sub_url"))
        return self._keys


def number(value):
    if isinstance(value, str) and value.isascii() and value.isdecimal() and len(value) <= 16:
        value = int(value)
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 9007199254740991 else None


def timestamp(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z") if number(value) is not None else None


def plain(value):
    return Selector(text=value or "").xpath("string(.)").get() or ""


def weibo_date(value):
    if not value:
        return None
    try:
        return parsedate_to_datetime(value).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except (ValueError, TypeError):
        return None


async def comment_replies(job, roots, parse, root_complete, preview_key, count_key, fetch):
    """Bounded SDK reply samples. Unknown counts and unvisited parents stay incomplete."""
    if job.get("metadataOnly"):
        return [], {"complete": False, "repliesComplete": False, "limit": 20}
    selected = roots[:20]
    output = [parse(root) for root in selected]
    coverage = {"complete": root_complete, "repliesComplete": False, "limit": 20}
    if not any(count_key in root or isinstance(root.get(preview_key), list) and root[preview_key] for root in selected):
        return output, coverage
    seen = {item["externalId"] for item in output}
    count, checked, pending, requests = 0, 0, 0, 0
    for root, parent in zip(selected, list(output)):
        total = number(root.get(count_key))
        children = root.get(preview_key) if isinstance(root.get(preview_key), list) else []
        complete = total is not None and len(children) >= total
        if not complete and total is not None and total > len(children) and count < 20 and requests < 2 and job.get("_replyRequests", 0) < 12 and fetch:
            requests += 1
            job["_replyRequests"] = job.get("_replyRequests", 0) + 1
            additional, ended = await fetch(root)
            children = children + additional
            complete = ended
        unique = {}
        for child in children:
            item = parse(child)
            if item["externalId"] not in seen:
                unique[item["externalId"]] = item
        available = 20 - count
        for item in list(unique.values())[:available]:
            seen.add(item["externalId"])
            output.append({**item, "parentExternalId": parent["externalId"]})
            count += 1
        # Duplicated previews are one reply; an upstream total remains the independent completeness check.
        if total is not None and len(unique) < total:
            complete = False
        if len(unique) > available:
            complete = False
        if complete:
            checked += 1
        else:
            pending += 1
    coverage.update({"repliesComplete": root_complete and pending == 0,
                     "replySample": {"count": count, "limit": 20, "parentsChecked": checked, "parentsPending": pending, "requests": requests}})
    return output, coverage


def bilibili_comment(item):
    return {"externalId": str(item["rpid"]), "text": item["content"]["message"], "likes": number(item.get("like")), "publishedAt": timestamp(item.get("ctime"))}


def weibo_comment(item):
    return {"externalId": str(item["id"]), "text": plain(item.get("text")), "likes": number(item.get("like_count")), "publishedAt": weibo_date(item.get("created_at"))}


def xhs_comment(item):
    return {"externalId": str(item["id"]), "text": item.get("content") or "", "likes": number(item.get("like_count")),
            "publishedAt": timestamp(number(item["create_time"]) // 1000) if number(item.get("create_time")) is not None else None}


def zhihu_comment(item):
    return {"externalId": str(item["id"]), "text": plain(item.get("content")), "likes": number(item.get("like_count")), "publishedAt": timestamp(item.get("created_time"))}


def douyin_comment(item):
    return {"externalId": str(item["cid"]), "text": item.get("text") or "", "likes": number(item.get("digg_count")), "publishedAt": timestamp(item.get("create_time"))}


def kuaishou_comment(item):
    return {"externalId": str(item["comment_id"]), "text": item.get("content") or "", "likes": None,
            "publishedAt": timestamp(number(item["timestamp"]) // 1000) if number(item.get("timestamp")) is not None else None}


async def collect_weibo(job):
    client = WeiboClient(headers={"User-Agent": "Mozilla/5.0", "Referer": "https://m.weibo.cn/", "Cookie": job["cookie"]},
                         playwright_page=None, cookie_dict={})
    if job.get("searchTerm"):
        # One original search page, at most thirty cards including nested groups.
        search = await client.get_note_by_keyword(job["searchTerm"], page=1)
        pending = list(search.get("cards") or [])
        selected, visited = None, 0
        while pending and visited < 30:
            card = pending.pop(0)
            visited += 1
            if card.get("card_type") == 9 and re.fullmatch(r"\d{1,20}", str(card.get("mblog", {}).get("id", ""))):
                selected = str(card["mblog"]["id"])
                break
            if isinstance(card.get("card_group"), list):
                pending.extend(card["card_group"][:30])
        if not selected:
            raise PlatformFailure("no_representative")
        select_discovered_content(job, selected)
    if job.get("videoId"):
        item = (await client.get_note_info_by_id(job["videoId"])).get("mblog")
        if job.get("discover") and item:
            job["locator"] = str(item.get("user", {}).get("id", ""))
        if not item or str(item.get("id")) != job["videoId"] or str(item.get("user", {}).get("id")) != job["locator"]:
            raise PlatformFailure("platform_failed")
        profile = item["user"]
        listing = {"cards": [{"card_type": 9, "mblog": item}], "cardlistInfo": {"since_id": "0"}}
    else:
        profile = (await client.get_creator_info_by_id(job["locator"]))["userInfo"]
        listing = await client.get_notes_by_creator(job["locator"], "107603" + job["locator"], job["cursor"])
    cards = listing["cards"]
    if len(cards) > 30:
        raise PlatformFailure("platform_failed")
    posts = []
    for card in (cards[:job.get("metadataLimit", 5)] if job.get("metadataOnly") else cards):
        if card.get("card_type") != 9:
            continue
        item = card["mblog"]
        if job.get("onlyIds") and str(item["id"]) not in job["onlyIds"]:
            continue
        if str(item["user"]["id"]) != job["locator"]:
            raise PlatformFailure("platform_failed")
        if item.get("isLongText") and not job.get("videoId") and not job.get("metadataOnly"):
            detail = await client.get_note_info_by_id(str(item["id"]))
            if not detail.get("mblog"):
                raise PlatformFailure("platform_failed")
            item = detail["mblog"]
        comments = {} if job.get("videoId") or job.get("metadataOnly") else await client.get_note_comments(str(item["id"]), max_id=0)
        rows = comments.get("data") or []
        samples, comment_coverage = await comment_replies(job, rows, weibo_comment,
            comments.get("max_id") == 0 and len(rows) <= 20, "comments", "total_number", None)
        text = plain(item.get("text"))
        video_urls = weibo_video_urls(item)
        page_info = item.get("page_info") or {}
        is_video = bool(video_urls) or isinstance(page_info, dict) and page_info.get("type") == "video"
        posts.append({"externalId": str(item["id"]), "url": "https://m.weibo.cn/detail/" + str(item["id"]), "kind": "video" if is_video else "post",
                      "title": text[:80] or "微博帖子", "text": text, "publishedAt": weibo_date(item.get("created_at")), "transcript": None,
                      "media": {"videoUrls": video_urls[:3]},
                      "metrics": {"views": None, "comments": number(item.get("comments_count")), "likes": number(item.get("attitudes_count")), "reposts": number(item.get("reposts_count"))},
                      "comments": samples, "commentCoverage": comment_coverage})
    cursor = str(listing.get("cardlistInfo", {}).get("since_id", "0"))
    complete = cursor in ("", "0")
    if not complete and cursor == job["cursor"]:
        raise PlatformFailure("platform_failed")
    return {"profile": {"externalId": str(profile["id"]), "name": profile.get("screen_name"), "description": plain(profile.get("description")),
                        "avatar": profile.get("profile_image_url"), "followerCount": number(profile.get("followers_count")), "workCount": number(profile.get("statuses_count"))},
            "posts": posts, "coverage": {"page": job["page"], "nextPage": None if complete else job["page"] + 1, "nextCursor": None if complete else cursor, "complete": complete}}


async def collect_xhs(job):
    if "a1=" not in job["cookie"]:
        raise PlatformFailure("login_required")
    client = XiaoHongShuClient(headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.xiaohongshu.com/", "Cookie": job["cookie"]},
                               playwright_page=None, cookie_dict={})
    context = job["context"]
    if job.get("videoId"):
        profile = {"basicInfo": {}}
        listing = {"notes": [{"note_id": job["videoId"], **context}], "has_more": False}
    else:
        profile = await client.get_creator_info(job["locator"], context.get("xsec_token", ""), context.get("xsec_source", ""))
        if not profile or not isinstance(profile.get("basicInfo"), dict):
            raise PlatformFailure("platform_failed")
        listing = await client.get_notes_by_creator(job["locator"], job["cursor"], xsec_token=context.get("xsec_token", ""), xsec_source=context.get("xsec_source", "pc_feed"))
    notes = listing["notes"]
    if len(notes) > 30:
        raise PlatformFailure("platform_failed")
    posts = []
    for listed in (notes[:job.get("metadataLimit", 5)] if job.get("metadataOnly") else notes):
        note_id = listed["note_id"]
        if job.get("onlyIds") and str(note_id) not in job["onlyIds"]:
            continue
        token = listed.get("xsec_token", "")
        source = listed.get("xsec_source", "pc_feed")
        item = await client.get_note_by_id(note_id, source, token)
        if job.get("discover") and item:
            job["locator"] = item.get("user", {}).get("user_id", "")
            profile["basicInfo"]["nickname"] = item.get("user", {}).get("nickname")
        if not item or item.get("note_id") != note_id or item.get("user", {}).get("user_id") != job["locator"]:
            raise PlatformFailure("platform_failed")
        comments = {} if job.get("videoId") or job.get("metadataOnly") else await client.get_note_comments(note_id, token)
        rows = comments.get("comments") or []
        async def fetch_children(root):
            page = await client.get_note_sub_comments(note_id, str(root["id"]), token, num=20)
            return page.get("comments") or [], page.get("has_more") is False
        samples, comment_coverage = await comment_replies(job, rows, xhs_comment,
            comments.get("has_more") is False and len(rows) <= 20, "sub_comments", "sub_comment_count", fetch_children)
        interact = item.get("interact_info", {})
        time = number(item.get("time"))
        posts.append({"externalId": note_id, "url": "https://www.xiaohongshu.com/explore/" + note_id,
                      "kind": "video" if item.get("type") == "video" else "image_text", "title": item.get("title") or item.get("desc", "")[:80] or "小红书笔记",
                      "text": item.get("desc") or "", "publishedAt": timestamp(time // 1000) if time is not None else None, "transcript": None,
                      "media": {"videoUrls": xhs_video_urls(item)[:3], **({"xhsAccess": {"xsec_token": token, "xsec_source": source}} if item.get("type") == "video" else {})},
                      "metrics": {"views": None, "comments": number(interact.get("comment_count")), "likes": number(interact.get("liked_count")), "reposts": number(interact.get("share_count")), "favorites": number(interact.get("collected_count"))},
                      "comments": samples, "commentCoverage": comment_coverage})
    complete = listing.get("has_more") is False
    cursor = listing.get("cursor")
    if not complete and (not isinstance(cursor, str) or not cursor or cursor == job["cursor"]):
        raise PlatformFailure("platform_failed")
    basic = profile["basicInfo"]
    fans = next((number(i.get("count")) for i in profile.get("interactions", []) if i.get("type") == "fans"), None)
    return {"profile": {"externalId": job["locator"], "name": basic.get("nickname"), "description": basic.get("desc"),
                        "avatar": basic.get("images") if isinstance(basic.get("images"), str) else None, "followerCount": fans, "workCount": None},
            "posts": posts, "coverage": {"page": job["page"], "nextPage": None if complete else job["page"] + 1, "nextCursor": None if complete else cursor, "complete": complete}}


async def collect_zhihu(job):
    cookies = {part.split("=", 1)[0].strip(): part.split("=", 1)[1].strip() for part in job["cookie"].split(";") if "=" in part}
    if not cookies.get("d_c0"):
        raise PlatformFailure("login_required")
    client = ZhiHuClient(headers={"user-agent": "Mozilla/5.0", "referer": "https://www.zhihu.com/", "cookie": job["cookie"],
                                 "accept": "*/*", "accept-language": "zh-CN,zh;q=0.9", "x-api-version": "3.0.91", "x-app-za": "OS=Web",
                                 "x-requested-with": "fetch", "x-zse-93": "101_3_3.0"},
                        playwright_page=None, cookie_dict=cookies)
    if job.get("searchTerm"):
        candidates = await client.get_note_by_keyword(job["searchTerm"], page=1, page_size=15)
        selected = next((item for item in candidates[:15] if item.content_type in ("answer", "article") and re.fullmatch(r"\d{1,20}", item.content_id)
                         and (item.content_type == "article" or re.fullmatch(r"\d{1,20}", item.question_id))), None)
        if not selected:
            raise PlatformFailure("no_representative")
        select_discovered_content(job, selected.content_type + ":" + selected.content_id,
                                  selected.question_id if selected.content_type == "answer" else None)
    single = None
    if job.get("videoId"):
        kind, identity = job["videoId"].split(":", 1)
        uri = "/p/" + identity if kind == "article" else "/question/" + job["context"]["questionId"] + "/answer/" + identity
        html = await client.get(uri, return_response=True)
    else:
        html = await client.get("/people/" + job["locator"], return_response=True)
    # Same HTML entities as upstream ZhihuExtractor, selecting the requested identity and retaining the actual author.
    initial = Selector(text=html).xpath("//script[@id='js-initialData']/text()").get()
    entities = json.loads(initial)["initialState"]["entities"]
    if job.get("videoId"):
        single = dict(entities[kind + "s"][identity])
        author = single.get("author")
        profile = entities.get("users", {}).get(author) if isinstance(author, str) else author
        if not profile or single.get("type") != kind or str(single.get("id")) != identity or not isinstance(single.get("content"), str):
            raise PlatformFailure("platform_failed")
        job["locator"] = profile.get("urlToken") or profile.get("url_token") or ""
        single["author"] = profile
        single["created_time"] = single.get("createdTime", single.get("created_time"))
        single["created"] = single.get("created", single.get("createdTime"))
        single["comment_count"] = single.get("commentCount", single.get("comment_count"))
        single["voteup_count"] = single.get("voteupCount", single.get("voteup_count"))
        if kind == "answer":
            question = single.get("question")
            single["question"] = entities.get("questions", {}).get(str(question)) if not isinstance(question, dict) else question
            if not single["question"] or str(single["question"].get("id")) != job["context"]["questionId"]:
                raise PlatformFailure("platform_failed")
    else:
        profile = entities["users"][job["locator"]]
    if not profile.get("id"):
        raise PlatformFailure("platform_failed")
    offsets = {"answers": 0 if kind == "answer" else None, "articles": 0 if kind == "article" else None} if single else json.loads(job["cursor"]) if job["cursor"] else {"answers": 0, "articles": 0}
    if set(offsets) != {"answers", "articles"} or any(value is not None and (number(value) is None or not isinstance(value, int) or value > 10000000) for value in offsets.values()):
        raise PlatformFailure("platform_failed")
    posts = []
    for stream, kind, reader in (("answers", "answer", client.get_creator_answers), ("articles", "article", client.get_creator_articles)):
        offset = offsets[stream]
        if offset is None:
            continue
        listing = {"data": [single], "paging": {"is_end": True}} if single else await reader(job["locator"], offset=offset, limit=15)
        items = listing["data"]
        if len(items) > 15 or not isinstance(listing["paging"].get("is_end"), bool):
            raise PlatformFailure("platform_failed")
        for item in (items[:job.get("metadataLimit", 5)] if job.get("metadataOnly") else items):
            author = item.get("author", {})
            if item.get("type") != kind or str(author.get("id")) != str(profile["id"]) or not isinstance(item.get("content"), str):
                raise PlatformFailure("platform_failed")
            identity = str(item["id"])
            if job.get("onlyIds") and kind + ":" + identity not in job["onlyIds"]:
                continue
            if not identity.isascii() or not identity.isdecimal():
                raise PlatformFailure("platform_failed")
            parent = None
            if kind == "answer":
                question = item["question"]
                question_id = str(question["id"])
                if not question_id.isascii() or not question_id.isdecimal():
                    raise PlatformFailure("platform_failed")
                title = plain(question["title"])
                parent = {"kind": "question", "url": "https://www.zhihu.com/question/" + question_id, "title": title}
                url = parent["url"] + "/answer/" + identity
            else:
                title = plain(item["title"])
                url = "https://zhuanlan.zhihu.com/p/" + identity
                column = item.get("column")
                address = column.get("url") if isinstance(column, dict) else None
                if isinstance(address, str):
                    parsed = urlsplit(address)
                    if parsed.scheme == "https" and parsed.netloc in ("www.zhihu.com", "zhuanlan.zhihu.com") and parsed.path and not parsed.fragment:
                        parent = {"kind": "column", "url": address, "title": plain(column.get("title"))}
            comments = {"data": [], "paging": {"is_end": True}} if job.get("metadataOnly") or number(item.get("comment_count")) == 0 else await client.get_root_comments(identity, kind, limit=20)
            rows = comments["data"]
            async def fetch_children(root):
                page = await client.get_child_comments(str(root["id"]), limit=20)
                return page.get("data") or [], page.get("paging", {}).get("is_end") is True
            samples, comment_coverage = await comment_replies(job, rows, zhihu_comment,
                comments.get("paging", {}).get("is_end") is True and len(rows) <= 20, "child_comments", "child_comment_count", fetch_children)
            post = {"externalId": kind + ":" + identity, "url": url, "kind": kind, "title": title, "text": plain(item["content"]),
                    "publishedAt": timestamp(item.get("created_time") if kind == "answer" else item.get("created")), "transcript": None,
                    "metrics": {"views": None, "comments": number(item.get("comment_count")), "likes": number(item.get("voteup_count"))},
                    "comments": samples, "commentCoverage": comment_coverage}
            if parent:
                post["parent"] = parent
            posts.append(post)
        offsets[stream] = None if listing["paging"]["is_end"] else offset + 15
    complete = all(value is None for value in offsets.values())
    stable_id = str(profile["id"])
    canonical = profile.get("urlToken") or profile.get("url_token") or job["locator"]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", stable_id) or not isinstance(canonical, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", canonical):
        raise PlatformFailure("platform_failed")
    return {"profile": {"externalId": job["locator"], "stableId": stable_id, "canonicalLocator": canonical, "name": profile.get("name"), "description": plain(profile.get("headline")),
                        "avatar": profile.get("avatarUrl"), "followerCount": number(profile.get("followerCount")), "workCount": None},
            "posts": posts, "coverage": {"page": job["page"], "nextPage": None if complete else job["page"] + 1, "nextCursor": None if complete else json.dumps(offsets), "complete": complete}}


async def collect_tieba(job):
    if not any(part.split("=", 1)[0].strip() == "BDUSS" and part.split("=", 1)[1].strip() for part in job["cookie"].split(";") if "=" in part):
        raise PlatformFailure("login_required")
    page = BrokerPage()
    client = BaiduTieBaClient(playwright_page=page)
    extractor = TieBaExtractor()
    if job.get("searchTerm"):
        candidates = await client.get_notes_by_keyword(job["searchTerm"], page=1, page_size=15)
        selected = next((item.note_id for item in candidates[:15] if re.fullmatch(r"\d{1,20}", item.note_id)), None)
        if not selected:
            raise PlatformFailure("no_representative")
        select_discovered_content(job, selected)
    single_detail = None
    if job.get("videoId"):
        single_detail = await client._get_pc_page_data(job["videoId"], page=1)
        author_id = str((single_detail.get("first_floor") or {}).get("author_id", ""))
        profile = next((user for user in single_detail.get("user_list", []) if str(user.get("id")) == author_id), None)
        if not profile or not re.fullmatch(r"tb\.[A-Za-z0-9_.-]{1,197}", profile.get("portrait", "")):
            raise PlatformFailure("platform_failed")
        job["locator"] = profile["portrait"]
    else:
        await client.get_creator_info_by_url("https://tieba.baidu.com/home/main?id=" + job["locator"])
        profile = page.user
    if not profile or profile.get("portrait") != job["locator"]:
        raise PlatformFailure("platform_failed")
    listing = {"data": {"has_more": 0, "list": [{"thread_info": {"tid": job["videoId"]}}]}} if single_detail else await client.get_notes_by_creator_portrait(job["locator"], job["page"], page_size=20)
    more = listing.get("data", {}).get("has_more")
    if type(more) not in (bool, int, str) or more not in (0, 1, "0", "1") or len(listing["data"]["list"]) > 20:
        raise PlatformFailure("platform_failed")
    posts = []
    identities = extractor.extract_creator_thread_id_list_from_api(listing)
    if len(identities) != len(listing["data"]["list"]):
        raise PlatformFailure("platform_failed")
    for identity in (identities[:job.get("metadataLimit", 5)] if job.get("metadataOnly") else identities):
        if not identity.isascii() or not identity.isdecimal():
            raise PlatformFailure("platform_failed")
        if job.get("onlyIds") and identity not in job["onlyIds"]:
            continue
        detail = single_detail if single_detail else await client._get_pc_page_data(identity, page=1)
        note = extractor.extract_note_detail_from_api(detail)
        first = detail.get("first_floor") or {}
        if note.note_id != identity or str(first.get("author_id")) != str(profile["id"]) or not first.get("content"):
            raise PlatformFailure("platform_failed")
        raw_comments = {str(row["id"]): row for row in detail["post_list"] if str(row["id"]) != str(first.get("id")) and number(row.get("post_no")) != 1}
        comments = []
        reply_roots = []
        for row in extractor.extract_tieba_note_parent_comments_from_api(detail, note):
            raw = raw_comments.get(row.comment_id)
            if raw is None:
                continue
            comment = {"externalId": row.comment_id, "text": row.content, "likes": number(raw.get("agree", {}).get("agree_num")), "publishedAt": timestamp(raw.get("time"))}
            floor = number(raw.get("post_no"))
            if floor is not None and floor > 0:
                comment["floor"] = floor
            comments.append(comment)
            reply_roots.append({"_parsed": comment, "_parent": row, **({"sub_post_number": raw["sub_post_number"]} if "sub_post_number" in raw else {})})
        total_pages = number(detail.get("page", {}).get("total_page"))
        async def fetch_children(root):
            parent = root["_parent"]
            url = "https://tieba.baidu.com/p/comment?" + urlencode({"tid": identity, "pid": parent.comment_id, "fid": parent.tieba_id, "pn": 1})
            response = await page.evaluate("""async ({url}) => {
                const response = await fetch(url, {credentials: 'include'});
                return {status: response.status, text: await response.text()};
            }""", {"url": url, "method": "GET", "body": ""})
            children = extractor.extract_tieba_note_sub_comments(response["text"], parent)
            rows = [{"_parsed": {"externalId": child.comment_id, "text": child.content, "likes": None, "publishedAt": None}} for child in children]
            total = number(root.get("sub_post_number"))
            return rows, total is not None and len(rows) >= total
        samples, comment_coverage = await comment_replies(job, reply_roots, lambda row: row["_parsed"],
            total_pages == 1 and len(comments) <= 20, "_no_embedded_preview", "sub_post_number", fetch_children)
        posts.append({"externalId": identity, "url": note.note_url, "kind": "post", "title": note.title, "text": note.desc,
                      "publishedAt": timestamp(first.get("time") or detail.get("thread", {}).get("create_time")), "transcript": None,
                      "metrics": {"views": None, "comments": number(detail.get("thread", {}).get("reply_num"))}, "comments": samples,
                      "commentCoverage": comment_coverage})
    complete = more in (0, "0")
    return {"profile": {"externalId": job["locator"], "name": profile.get("name_show") or profile.get("name"), "description": plain(profile.get("intro")),
                        "avatar": None, "followerCount": number(profile.get("fans_num")), "workCount": number(profile.get("thread_num"))},
            "posts": posts, "coverage": {"page": job["page"], "nextPage": None if complete else job["page"] + 1, "complete": complete}}


async def collect_douyin(job):
    import execjs
    # The upstream module compiles relative libs/douyin.js at import time. Replace
    # only that compiler boundary; the pinned original JS runs in the existing parent.
    original_compile = execjs.compile
    execjs.compile = lambda script: DouyinSigner()
    try:
        with chdir(sys.argv[1]):
            from media_platform.douyin.client import DouYinClient
            from media_platform.douyin.media import extract_video_urls as douyin_video_urls
    finally:
        execjs.compile = original_compile
    page = BrokerPage()
    cookies = {part.split("=", 1)[0].strip(): part.split("=", 1)[1].strip() for part in job["cookie"].split(";") if "=" in part}
    client = DouYinClient(headers={"User-Agent": await page.evaluate("() => navigator.userAgent"), "Cookie": job["cookie"],
                                  "Origin": "https://www.douyin.com/", "Referer": "https://www.douyin.com/", "Content-Type": "application/json;charset=UTF-8"},
                          playwright_page=page, cookie_dict=cookies)
    if job.get("searchTerm"):
        search = await client.search_info_by_keyword(job["searchTerm"], offset=0)
        if search.get("status_code", 0) != 0:
            raise PlatformFailure("platform_failed")
        selected = None
        for row in (search.get("data") or [])[:15]:
            item = row.get("aweme_info") or next(iter(row.get("aweme_mix_info", {}).get("mix_items") or []), {})
            identity = str(item.get("aweme_id", ""))
            if re.fullmatch(r"\d{1,20}", identity):
                selected = identity
                break
        if not selected:
            raise PlatformFailure("no_representative")
        select_discovered_content(job, selected)
    if job.get("videoId"):
        item = await client.get_video_by_id(job["videoId"])
        if not item or str(item.get("aweme_id")) != job["videoId"]:
            raise PlatformFailure("platform_failed")
        profile = item.get("author") or {}
        if job.get("discover"):
            job["locator"] = profile.get("sec_uid", "")
        listing = {"status_code": 0, "aweme_list": [item], "has_more": 0}
    else:
        profile_reply = await client.get_user_info(job["locator"])
        if profile_reply.get("status_code") != 0:
            raise PlatformFailure("platform_failed")
        profile = profile_reply["user"]
        listing = await client.get_user_aweme_posts(job["locator"], job["cursor"])
    if profile.get("sec_uid") != job["locator"]:
        raise PlatformFailure("platform_failed")
    more = listing.get("has_more")
    if listing.get("status_code") != 0 or type(more) not in (bool, int, str) or more not in (0, 1, "0", "1"):
        raise PlatformFailure("platform_failed")
    items = listing["aweme_list"]
    if items is None and more in (0, "0"):
        items = []
    if not isinstance(items, list) or len(items) > 18:
        raise PlatformFailure("platform_failed")
    posts = []
    for item in (items[:job.get("metadataLimit", 5)] if job.get("metadataOnly") else items):
        identity = str(item["aweme_id"])
        if job.get("onlyIds") and identity not in job["onlyIds"]:
            continue
        if not identity.isascii() or not identity.isdecimal() or item.get("author", {}).get("sec_uid") != job["locator"]:
            raise PlatformFailure("platform_failed")
        comments = {"status_code": 0, "comments": []} if job.get("videoId") or job.get("metadataOnly") else await client.get_aweme_comments(identity)
        if comments.get("status_code") != 0:
            raise PlatformFailure("platform_failed")
        rows = comments["comments"] or []
        async def fetch_children(root):
            page = await client.get_sub_comments(identity, str(root["cid"]))
            if page.get("status_code") != 0:
                raise PlatformFailure("platform_failed")
            return page.get("comments") or [], type(page.get("has_more")) in (bool, int, str) and page.get("has_more") in (0, "0")
        samples, comment_coverage = await comment_replies(job, rows, douyin_comment,
            type(comments.get("has_more")) in (bool, int, str) and comments.get("has_more") in (0, "0") and len(rows) <= 20,
            "reply_comment", "reply_comment_total", fetch_children)
        stats = item.get("statistics") or {}
        kind = "image_text" if item.get("images") else "video"
        posts.append({"externalId": identity, "url": "https://www.douyin.com/video/" + identity,
                      "kind": kind, "title": item.get("desc", "")[:80] or "抖音作品", "text": item.get("desc") or "", "publishedAt": timestamp(item.get("create_time")), "transcript": None,
                      "media": {"videoUrls": douyin_video_urls(item)[:3] if kind == "video" else []},
                      "metrics": {"views": number(stats.get("play_count")), "comments": number(stats.get("comment_count")), "likes": number(stats.get("digg_count")), "reposts": number(stats.get("share_count")), "favorites": number(stats.get("collect_count"))},
                      "comments": samples, "commentCoverage": comment_coverage})
    complete = more in (0, "0")
    cursor = str(listing.get("max_cursor", ""))
    if not complete and (not cursor.isascii() or not cursor.isdecimal() or cursor == job["cursor"]):
        raise PlatformFailure("platform_failed")
    return {"profile": {"externalId": job["locator"], "name": profile.get("nickname"), "description": profile.get("signature"), "avatar": None,
                        "followerCount": number(profile.get("follower_count")), "workCount": number(profile.get("aweme_count"))},
            "posts": posts, "coverage": {"page": job["page"], "nextPage": None if complete else job["page"] + 1, "nextCursor": None if complete else cursor, "complete": complete}}


async def collect_kuaishou(job):
    page = BrokerPage()
    agent = await page.evaluate("() => navigator.userAgent")
    # Upstream GraphQL files are cwd-relative; only construction reads them.
    with chdir(sys.argv[1]):
        client = KuaiShouClient(headers={"User-Agent": agent, "Referer": "https://www.kuaishou.com/", "Content-Type": "application/json", "Cookie": job["cookie"]},
                               playwright_page=page, cookie_dict={})
    if job.get("searchTerm"):
        search = await client.search_info_by_keyword_v2(job["searchTerm"], pcursor="")
        selected = None
        for row in (search.get("feeds") or [])[:15]:
            identity = str((row.get("photo") or {}).get("id", ""))
            if row.get("type") == "video" and re.fullmatch(r"[A-Za-z0-9_-]{1,100}", identity):
                selected = identity
                break
        if not selected:
            raise PlatformFailure("no_representative")
        select_discovered_content(job, selected)
    if job.get("videoId"):
        detail = (await client.get_video_info(job["videoId"])).get("visionVideoDetail") or {}
        photo = detail.get("photo") or {}
        author = detail.get("author") or {}
        if job.get("discover"):
            job["locator"] = author.get("id", "")
        if str(photo.get("id")) != job["videoId"] or author.get("id") != job["locator"]:
            raise PlatformFailure("platform_failed")
        profile = {"profile": {"user_id": author["id"], "user_name": author.get("name")}}
        listing = {"feeds": [detail], "pcursor": "no_more"}
    else:
        profile_result = (await client.get_creator_profile(job["locator"]))["visionProfile"]
        if profile_result.get("result") != 1:
            raise PlatformFailure("platform_failed")
        profile = profile_result["userProfile"]
        listing = await client.get_video_by_creater_v2(job["locator"], job["cursor"])
    basic = profile["profile"]
    if basic.get("user_id") != job["locator"]:
        raise PlatformFailure("platform_failed")
    videos = listing["feeds"]
    if not isinstance(videos, list) or len(videos) > 30:
        raise PlatformFailure("platform_failed")
    posts = []
    for video in (videos[:job.get("metadataLimit", 5)] if job.get("metadataOnly") else videos):
        if video["author"].get("id") != job["locator"]:
            raise PlatformFailure("platform_failed")
        item = video["photo"]
        identity = str(item["id"])
        if job.get("onlyIds") and identity not in job["onlyIds"]:
            continue
        comments = {"rootCommentsV2": []} if job.get("videoId") or job.get("metadataOnly") else await client.get_video_comments(identity)
        rows = comments["rootCommentsV2"]
        if not isinstance(rows, list):
            raise PlatformFailure("platform_failed")
        # V2 supplies a boolean rather than a child count. It is only a fetch hint;
        # completion still requires an explicit no_more response from the SDK.
        rows = [{**row, **({"_reply_count_minimum": 1 if row["hasSubComments"] else 0} if type(row.get("hasSubComments")) is bool else {})} for row in rows]
        async def fetch_children(root):
            page = await client.get_video_sub_comments(identity, int(root["comment_id"]))
            return page.get("subCommentsV2") or [], page.get("pcursorV2") == "no_more"
        samples, comment_coverage = await comment_replies(job, rows, kuaishou_comment,
            comments.get("pcursorV2") == "no_more" and len(rows) <= 20, "_no_embedded_preview", "_reply_count_minimum", fetch_children)
        published = number(item.get("timestamp"))
        posts.append({"externalId": identity, "url": "https://www.kuaishou.com/short-video/" + identity,
                      "kind": "video", "title": (item.get("caption") or "")[:80] or "快手作品", "text": item.get("caption") or "",
                      "publishedAt": timestamp(published // 1000) if published is not None else None, "transcript": None,
                      "media": {"videoUrls": kuaishou_video_urls(video)[:3]},
                      "metrics": {"views": number(item.get("viewCount")), "likes": number(item.get("realLikeCount")), "comments": number(comments.get("commentCountV2"))},
                      "comments": samples, "commentCoverage": comment_coverage})
    cursor = listing.get("pcursor")
    complete = cursor == "no_more"
    if not complete and (not isinstance(cursor, str) or not cursor or cursor == job["cursor"]):
        raise PlatformFailure("platform_failed")
    return {"profile": {"externalId": job["locator"], "name": basic.get("user_name"), "description": basic.get("user_text"), "avatar": basic.get("headurl"),
                        "followerCount": number(profile.get("ownerCount", {}).get("fan")), "workCount": number(profile.get("ownerCount", {}).get("photo"))},
            "posts": posts, "coverage": {"page": job["page"], "nextPage": None if complete else job["page"] + 1, "nextCursor": None if complete else cursor, "complete": complete}}


async def collect(job):
    # Prevent any accidental native HTTP/proxy/browser path from bypassing the broker.
    def no_network(event, args):
        if event in ("socket.connect", "socket.getaddrinfo", "subprocess.Popen"):
            raise RuntimeError("Only the controlled parent HTTP broker is available")
    sys.addaudithook(no_network)
    if job["platform"] == "weibo":
        return await collect_weibo(job)
    if job["platform"] == "xhs":
        return await collect_xhs(job)
    if job["platform"] == "zhihu":
        return await collect_zhihu(job)
    if job["platform"] == "tieba":
        return await collect_tieba(job)
    if job["platform"] == "douyin":
        return await collect_douyin(job)
    if job["platform"] == "kuaishou":
        return await collect_kuaishou(job)
    cookie = job.get("cookie", "")
    client = ApiBilibiliClient(headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/", "Cookie": cookie},
                               playwright_page=None, cookie_dict={})
    if job.get("videoId"):
        view = (await client.get_video_info(bvid=job["videoId"]))["View"]
        owner = view["owner"]
        if job.get("discover"):
            identity = str(owner["mid"])
            if not identity.isascii() or not identity.isdecimal() or not 0 < int(identity) < 10 ** 20:
                raise PlatformFailure("platform_failed")
            job["locator"] = identity
        if view["bvid"] != job["videoId"] or str(owner["mid"]) != job["locator"] or len(view.get("pages") or []) != 1:
            raise PlatformFailure("platform_failed")
        play = await client.get_video_play_url(view["aid"], view["pages"][0]["cid"], fnval=MP4_FNVAL)
        if count_durl_segments(play) != 1:
            raise PlatformFailure("platform_failed")
        media = build_durl_item(play, view["bvid"])
        if media is None:
            raise PlatformFailure("platform_failed")
        tracks = []
        try:
            player = await client.get("/x/player/wbi/v2", {"aid": view["aid"], "cid": view["pages"][0]["cid"]}, enable_params_sign=False)
            for track in (player.get("subtitle") or {}).get("subtitles") or []:
                language, url = track.get("lan"), track.get("subtitle_url")
                if isinstance(language, str) and isinstance(url, str) and language and url:
                    tracks.append({"language": language, "url": "https:" + url if url.startswith("//") else url})
        except PlatformFailure:
            # Video remains usable with local ASR when this optional text endpoint
            # requires a different login state. No subtitle is claimed obtained.
            pass
        source = {"videoUrls": [media.url], "subtitleTracks": tracks[:20]}
        duration = number(view.get("duration"))
        if duration is not None and 0 < duration <= 7200:
            source["durationSeconds"] = duration
        stats = view.get("stat") or {}
        return {"profile": {"externalId": str(owner["mid"]), "name": owner.get("name"), "description": None, "avatar": owner.get("face"), "followerCount": None, "workCount": None},
                "posts": [{"externalId": view["bvid"], "url": "https://www.bilibili.com/video/" + view["bvid"], "kind": "video", "title": view["title"], "text": view.get("desc") or "",
                           "publishedAt": timestamp(view.get("pubdate")), "transcript": None, "media": source,
                           "metrics": {"views": number(stats.get("view")), "comments": number(stats.get("reply"))}, "comments": [],
                           "commentCoverage": {"complete": False, "repliesComplete": False, "limit": 20}}],
                "coverage": {"page": 1, "nextPage": None, "complete": True}}
    profile = await client.get_creator_info(int(job["locator"]))
    listing = await client.get_creator_videos(job["locator"], job["page"], ps=job.get("metadataLimit", 5) if job.get("metadataOnly") or job.get("onlyIds") else 30, order_mode="pubdate")
    posts = []
    for video in (listing["list"]["vlist"][:job.get("metadataLimit", 5)] if job.get("metadataOnly") else listing["list"]["vlist"]):
        if job.get("onlyIds") and video["bvid"] not in job["onlyIds"]:
            continue
        comments = {} if job.get("metadataOnly") else await client.get_video_comments(str(video["aid"]))
        replies = comments.get("replies") or []
        async def fetch_children(root):
            page = await client.get_video_level_two_comments(str(video["aid"]), int(root["rpid"]), 1, 20, CommentOrderType.DEFAULT)
            total = number(page.get("page", {}).get("count"))
            rows = page.get("replies") or []
            return rows, total is not None and len(rows) >= total
        samples, comment_coverage = await comment_replies(job, replies, bilibili_comment,
            comments.get("cursor", {}).get("is_end") is True and len(replies) <= 20, "replies", "rcount", fetch_children)
        posts.append({"externalId": video["bvid"], "url": "https://www.bilibili.com/video/" + video["bvid"],
                      "title": video["title"], "text": video.get("description") or "", "publishedAt": timestamp(video.get("created")),
                      "transcript": None, "metrics": {"views": number(video.get("play")), "comments": number(video.get("comment"))},
                      "comments": samples, "commentCoverage": comment_coverage})
    count = number(listing.get("page", {}).get("count"))
    complete = count is not None and job["page"] * 30 >= count
    return {"profile": {"externalId": str(profile["mid"]), "name": profile.get("name"), "description": profile.get("sign"),
                        "avatar": profile.get("face"), "followerCount": None, "workCount": count},
            "posts": posts, "coverage": {"page": job["page"], "nextPage": None if complete else job["page"] + 1, "complete": complete}}


if __name__ == "__main__":
    try:
        job = json.loads(sys.stdin.readline(32 * 1024))
        emit({"type": "result", "result": asyncio.run(collect(job))})
    except PlatformFailure as error:
        emit({"type": "error", "code": error.code})
        sys.exit(1)
    except Exception:
        # Never publish platform responses, URLs with tokens, Cookie or raw exceptions.
        emit({"type": "error", "code": "platform_failed"})
        sys.exit(1)
