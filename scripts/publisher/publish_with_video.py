#!/usr/bin/env python3
"""发布含视频的 Markdown 文章到微信公众号草稿箱（独立实现）

流程：扫描 mp4 引用 → 上传永久素材库 → wenyan 发布占位版 → 拉回草稿 → 替换为视频 iframe → 更新草稿。

用法：
    python publish_with_video.py <markdown-file> [theme] [highlight]

凭证：环境变量 WECHAT_APP_ID / WECHAT_APP_SECRET，或 ~/.workbuddy/TOOLS.md / ~/.codebuddy/TOOLS.md
"""

import sys, os, re, json, subprocess
import urllib.request
from pathlib import Path

TOOLS_MD_PATHS = [
    Path.home() / ".workbuddy" / "TOOLS.md",
    Path.home() / ".codebuddy" / "TOOLS.md",
]
THEME = "lapis"
HIGHLIGHT = "solarized-light"


def load_credentials():
    app_id = os.environ.get("WECHAT_APP_ID", "")
    secret = os.environ.get("WECHAT_APP_SECRET", "")
    if app_id and secret:
        return app_id, secret
    for p in TOOLS_MD_PATHS:
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            if "export WECHAT_APP_ID=" in line:
                app_id = line.split("=", 1)[1].strip()
            if "export WECHAT_APP_SECRET=" in line:
                secret = line.split("=", 1)[1].strip()
        if app_id and secret:
            print(f"凭证来自 {p}")
            return app_id, secret
    raise RuntimeError("缺少 WECHAT_APP_ID / WECHAT_APP_SECRET，请设置环境变量或写入 TOOLS.md")


def _http_json(url, data=None):
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    else:
        req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def get_token(app_id, secret):
    url = f"https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid={app_id}&secret={secret}"
    data = _http_json(url)
    if "access_token" not in data:
        raise RuntimeError(f"获取 token 失败: {data}")
    return data["access_token"]


def upload_video(token, video_path, title="视频"):
    url = f"https://api.weixin.qq.com/cgi-bin/material/add_material?access_token={token}&type=video"
    desc = json.dumps({"title": title, "introduction": title}, ensure_ascii=False)
    result = subprocess.run(
        ["curl", "-s", "-m", "180", "-X", "POST", url,
         "-F", f"media=@{video_path};type=video/mp4", "-F", f"description={desc}"],
        capture_output=True, text=True, timeout=200,
    )
    data = json.loads(result.stdout)
    if "media_id" not in data:
        raise RuntimeError(f"视频上传失败 ({video_path}): {data}")
    media_id = data["media_id"]

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
    out = []
    for m in pattern.finditer(content):
        alt, rel = m.group(1), m.group(2)
        out.append((alt, rel, (article_dir / rel).resolve()))
    return out


def process_videos(content, article_dir, token):
    refs = find_mp4s(content, article_dir)
    if not refs:
        print("无视频引用")
        return content, {}

    placeholders = {}
    for alt, rel, abs_path in refs:
        if not abs_path.exists():
            content = content.replace(f"![{alt}]({rel})", f"[视频: {alt}（文件缺失）]")
            content = content.replace(f"[{alt}]({rel})", f"[视频: {alt}（文件缺失）]")
            continue
        probe = subprocess.run(["file", str(abs_path)], capture_output=True, text=True)
        if "HTML" in probe.stdout or "text" in probe.stdout.lower():
            content = content.replace(f"![{alt}]({rel})", f"[视频预览: {alt}]")
            content = content.replace(f"[{alt}]({rel})", f"[视频预览: {alt}]")
            continue
        size_mb = abs_path.stat().st_size / 1048576
        print(f"上传视频: {rel} ({size_mb:.1f} MB)")
        try:
            media_id, vid, cover = upload_video(token, str(abs_path), title=alt or abs_path.stem)
            ph = f"VIDEO_PLACEHOLDER_{media_id}"
            placeholders[ph] = (media_id, vid, cover)
            content = content.replace(f"![{alt}]({rel})", ph).replace(f"[{alt}]({rel})", ph)
            print(f"  成功: media_id={media_id[:24]}... vid={vid}")
        except Exception as e:
            print(f"  上传失败: {e}，改用截图占位")
            content = content.replace(f"![{alt}]({rel})", f"![{alt}]({rel.replace('.mp4', '.png')})")
            content = content.replace(f"[{alt}]({rel})", f"[{alt}]({rel.replace('.mp4', '.png')})")
    return content, placeholders


def build_iframe(vid, cover=""):
    src = f"https://mp.weixin.qq.com/mp/readtemplate?t=pages/video_player_tmpl&action=mpvideo&scene=0&vid={vid}"
    cover_attr = f' data-cover="{cover}"' if cover else ""
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
    print("wenyan 输出:", result.stdout)
    if result.returncode != 0:
        raise RuntimeError(f"wenyan 发布失败: {result.stderr or result.stdout}")
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
    if "news_item" not in draft:
        print(f"拉取草稿失败: {draft}")
        return
    article = draft["news_item"][0]
    html = article.get("content", "")
    for ph, (media_id, vid, cover) in placeholders.items():
        if ph in html:
            if vid:
                html = html.replace(ph, f"<p>{build_iframe(vid, cover)}</p>")
                print(f"  {ph[:30]}... → iframe(vid={vid[:24]}...)")
            else:
                html = html.replace(ph, f'<mp-video data-pluginname="mpvideo" data-url="{media_id}"></mp-video>')
                print(f"  {ph[:30]}... → mp-video 兜底")
    article["content"] = html
    result = _http_json(
        f"https://api.weixin.qq.com/cgi-bin/draft/update?access_token={token}",
        data={"media_id": draft_id, "index": 0, "articles": article},
    )
    print("草稿更新成功 ✓" if result.get("errcode") in (0, None) else f"草稿更新失败: {result}")


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

    tmp = md_file.parent / f"_publish_tmp_{md_file.stem}.md"
    tmp.write_text(patched, encoding="utf-8")
    try:
        token = get_token(app_id, secret)
        draft_id = publish_markdown(tmp, theme, highlight, app_id, secret)
        if draft_id:
            print(f"草稿已创建: {draft_id}")
            if placeholders:
                token = get_token(app_id, secret)
                patch_draft(token, draft_id, placeholders)
        else:
            print("未解析到 Media ID，跳过视频注入")
    finally:
        tmp.unlink(missing_ok=True)

    print("完成！请到公众号后台草稿箱审核: https://mp.weixin.qq.com/")


if __name__ == "__main__":
    main()
