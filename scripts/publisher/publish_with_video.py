#!/usr/bin/env python3
"""发布含视频的 Markdown 文章到微信公众号草稿箱（独立实现）

流程：扫描 mp4 引用 → 上传永久素材库 → wenyan 发布占位版 → 拉回草稿 → 替换为视频 iframe → 更新草稿。

用法：
    python publish_with_video.py <markdown-file> [theme] [highlight]

凭证：当前进程环境变量 WECHAT_APP_ID / WECHAT_APP_SECRET；不要把密钥写入 Agent 可读取的说明文件
"""

import sys, os, re, json, subprocess, http.client, tempfile
import urllib.request, urllib.parse
from urllib.error import HTTPError, URLError
from html import escape
from pathlib import Path

THEME = "lapis"
HIGHLIGHT = "solarized-light"


def load_credentials():
    app_id = os.environ.get("WECHAT_APP_ID", "")
    secret = os.environ.get("WECHAT_APP_SECRET", "")
    if app_id and secret:
        return app_id, secret
    raise RuntimeError("缺少 WECHAT_APP_ID / WECHAT_APP_SECRET，请在当前进程环境设置凭证；不要写入 Skill 或 Agent 可读取的说明文件")


def _http_json(url, data=None):
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    else:
        req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise RuntimeError("微信接口返回格式不正确")
        return data
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise RuntimeError("微信接口返回非 JSON 响应") from None
    except HTTPError as e:
        # HTTPError includes the full URL, which contains the token or app secret.
        raise RuntimeError(f"微信接口返回 HTTP {e.code}") from None
    except URLError:
        raise RuntimeError("无法连接微信接口") from None


def get_token(app_id, secret):
    url = f"https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid={app_id}&secret={secret}"
    data = _http_json(url)
    if "access_token" not in data:
        raise RuntimeError(f"获取公众号接口 token 失败，微信错误码: {data.get('errcode', 'unknown')}")
    return data["access_token"]


def upload_video(token, video_path, title="视频"):
    boundary = "----wechat-content-studio-" + os.urandom(16).hex()
    filename = Path(video_path).name.replace('"', "_").replace("\\", "_").replace("\r", "_").replace("\n", "_")
    description = json.dumps({"title": title, "introduction": title}, ensure_ascii=False).encode("utf-8")
    prefix = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="description"\r\n'
        "\r\n"
    ).encode("utf-8") + description + f"\r\n--{boundary}\r\n".encode("ascii")
    file_header = (
        f'Content-Disposition: form-data; name="media"; filename="{filename}"\r\n'
        "Content-Type: video/mp4\r\n\r\n"
    ).encode("utf-8")
    suffix = f"\r\n--{boundary}--\r\n".encode("ascii")
    file_size = Path(video_path).stat().st_size
    body_length = len(prefix) + len(file_header) + file_size + len(suffix)
    query = urllib.parse.urlencode({"access_token": token, "type": "video"})
    request_path = f"/cgi-bin/material/add_material?{query}"

    # Stream the multipart body so large videos do not need to be loaded into memory.
    conn = http.client.HTTPSConnection("api.weixin.qq.com", timeout=180)
    try:
        conn.putrequest("POST", request_path)
        conn.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
        conn.putheader("Content-Length", str(body_length))
        conn.endheaders()
        conn.send(prefix)
        conn.send(file_header)
        with open(video_path, "rb") as media:
            while chunk := media.read(1024 * 1024):
                conn.send(chunk)
        conn.send(suffix)
        response = conn.getresponse()
        raw = response.read()
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"视频上传接口返回 HTTP {response.status}")
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise RuntimeError("视频上传接口返回非 JSON 响应") from None
        if not isinstance(data, dict):
            raise RuntimeError("视频上传接口返回格式不正确")
    finally:
        conn.close()

    if "media_id" not in data:
        errcode = data.get("errcode", "unknown")
        raise RuntimeError(f"视频上传失败，微信接口错误码: {errcode}")
    media_id = data["media_id"]
    if not isinstance(media_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", media_id):
        raise RuntimeError("微信接口返回了无效的视频素材 ID")

    # 回查 vid / 封面，用于 iframe 嵌入
    listing = _http_json(
        f"https://api.weixin.qq.com/cgi-bin/material/batchget_material?access_token={token}",
        data={"type": "video", "offset": 0, "count": 5},
    )
    vid, cover = "", ""
    for item in listing.get("item", []):
        if item.get("media_id") == media_id:
            vid = item.get("vid", "")
            cover = item.get("cover_url", "")
            break
    return media_id, vid, cover


def find_mp4s(content, article_dir):
    pattern = re.compile(r'!?\[([^\]]*)\]\(([^)]+\.mp4)\)', re.IGNORECASE)
    base = article_dir.resolve()
    out = []
    for m in pattern.finditer(content):
        alt, rel = m.group(1), m.group(2)
        # Do not allow Markdown paths to make the publisher upload files outside
        # the selected article folder (including paths that traverse symlinks).
        abs_path = (base / rel).resolve()
        if not abs_path.is_relative_to(base):
            raise ValueError(f"视频路径必须位于文章目录内: {rel}")
        out.append((alt, rel, abs_path))
    return out


def process_videos(content, article_dir, token):
    refs = find_mp4s(content, article_dir)
    if not refs:
        print("无视频引用")
        return content, {}

    placeholders = {}
    for alt, rel, abs_path in refs:
        if not abs_path.exists():
            raise FileNotFoundError(f"引用的视频文件不存在，已停止发布: {rel}")
        with abs_path.open("rb") as media:
            signature = media.read(64)
        if len(signature) < 12 or signature[4:8] != b"ftyp":
            raise ValueError(f"文件扩展名为 mp4，但内容不是有效 MP4 文件: {rel}")
        size_mb = abs_path.stat().st_size / 1048576
        print(f"上传视频: {rel} ({size_mb:.1f} MB)")
        try:
            media_id, vid, cover = upload_video(token, str(abs_path), title=alt or abs_path.stem)
            ph = f"VIDEO_PLACEHOLDER_{media_id}"
            placeholders[ph] = (media_id, vid, cover)
            content = content.replace(f"![{alt}]({rel})", ph).replace(f"[{alt}]({rel})", ph)
            print(f"  成功: media_id={media_id[:24]}... vid={vid}")
        except Exception as e:
            raise RuntimeError(f"视频上传失败，已停止发布以避免生成不完整草稿: {e}") from None
    return content, placeholders


def build_iframe(vid, cover=""):
    if not isinstance(vid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", vid):
        raise ValueError("无效的视频 vid")
    src = "https://mp.weixin.qq.com/mp/readtemplate?" + urllib.parse.urlencode({
        "t": "pages/video_player_tmpl", "action": "mpvideo", "scene": "0", "vid": vid,
    })
    cover_url = urllib.parse.urlsplit(cover) if cover else None
    trusted_cover = (
        cover_url and cover_url.scheme == "https"
        and not cover_url.username and not cover_url.password and not cover_url.port
        and cover_url.hostname in {"mmbiz.qpic.cn", "mmbiz.qlogo.cn"}
    )
    safe_cover = cover if trusted_cover else ""
    cover_attr = f' data-cover="{escape(safe_cover, quote=True)}"' if safe_cover else ""
    return (
        f'<iframe class="video_iframe rich_pages wxw-img" data-src="{src}" '
        f'data-vidtype="2" data-mpvid="{vid}"{cover_attr} '
        f'allowfullscreen="" frameborder="0" scrolling="no" '
        f'style="width: 677px; height: 508px;" src="{src}"></iframe>'
    )


def publish_markdown(md_path, theme, highlight, app_id, secret):
    env = os.environ.copy()
    env.update({"WECHAT_APP_ID": app_id, "WECHAT_APP_SECRET": secret})
    result = subprocess.run(
        ["wenyan", "publish", "-f", str(md_path), "-t", theme, "-h", highlight],
        env=env, capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"wenyan 发布失败，退出码: {result.returncode}")
    m = re.search(r"Media ID[:\s]+(\S+)", result.stdout)
    return m.group(1) if m else None


def patch_draft(token, draft_id, placeholders):
    if not placeholders:
        return
    print("修复草稿视频占位符...")
    draft = _http_json(
        f"https://api.weixin.qq.com/cgi-bin/draft/get?access_token={token}",
        data={"media_id": draft_id},
    )
    if not isinstance(draft.get("news_item"), list) or not draft["news_item"] or not isinstance(draft["news_item"][0], dict):
        raise RuntimeError(f"拉取草稿失败，微信错误码: {draft.get('errcode', 'unknown')}")
    article = draft["news_item"][0]
    html = article.get("content", "")
    if any(ph not in html for ph in placeholders):
        raise RuntimeError("草稿正文缺少视频占位符；请在公众号后台核查该草稿后再处理")
    for ph, (media_id, vid, cover) in placeholders.items():
        if ph in html:
            if vid:
                html = html.replace(ph, f"<p>{build_iframe(vid, cover)}</p>")
                print(f"  {ph[:30]}... → iframe(vid={vid[:24]}...)")
            else:
                html = html.replace(ph, f'<mp-video data-pluginname="mpvideo" data-url="{media_id}"></mp-video>')
                print(f"  {ph[:30]}... → mp-video 兜底")
    if any(ph in html for ph in placeholders):
        raise RuntimeError("草稿中未能替换全部视频占位符；请在公众号后台检查该草稿后再处理")
    article["content"] = html
    result = _http_json(
        f"https://api.weixin.qq.com/cgi-bin/draft/update?access_token={token}",
        data={"media_id": draft_id, "index": 0, "articles": article},
    )
    if result.get("errcode") not in (0, None):
        raise RuntimeError(f"草稿更新失败，微信错误码: {result.get('errcode', 'unknown')}")
    print("草稿更新成功 ✓")


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        return
    md_file = Path(sys.argv[1]).resolve()
    theme = sys.argv[2] if len(sys.argv) > 2 else THEME
    highlight = sys.argv[3] if len(sys.argv) > 3 else HIGHLIGHT
    if not md_file.exists():
        print(f"文件不存在: {md_file}")
        sys.exit(1)

    app_id, secret = load_credentials()
    token = get_token(app_id, secret)
    print("公众号接口凭证已就绪")

    original = md_file.read_text(encoding="utf-8")
    patched, placeholders = process_videos(original, md_file.parent, token)

    fd, tmp_name = tempfile.mkstemp(prefix=f".{md_file.stem}_publish_", suffix=".md", dir=md_file.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as tmp_file:
            tmp_file.write(patched)
        token = get_token(app_id, secret)
        draft_id = publish_markdown(tmp, theme, highlight, app_id, secret)
        if draft_id:
            print(f"草稿已创建: {draft_id}")
            if placeholders:
                token = get_token(app_id, secret)
                patch_draft(token, draft_id, placeholders)
        else:
            raise RuntimeError("wenyan 未返回草稿 Media ID；草稿状态无法自动确认，请到公众号后台核查")
    finally:
        tmp.unlink(missing_ok=True)

    print("完成！请到公众号后台草稿箱审核: https://mp.weixin.qq.com/")


if __name__ == "__main__":
    main()
