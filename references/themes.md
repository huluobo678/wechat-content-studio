# wenyan 主题与高亮

内置主题查看：`wenyan theme -l`

## 常用主题

| 主题 | 风格 | 适用 |
|------|------|------|
| `default` | 简洁通用 | 大部分文章 |
| `lapis` | 蓝色调 | 技术文章（推荐） |
| `phycat` | 轻量现代 | 科技内容 |

## 代码高亮

亮色：`atom-one-light`、`github`、`solarized-light`（推荐）、`xcode`
暗色：`atom-one-dark`、`dracula`、`github-dark`、`monokai`、`solarized-dark`

## 自定义主题

```bash
wenyan publish -f article.md -c /path/to/theme.css        # 临时
wenyan theme --add --name my-theme --path /path.css       # 安装
wenyan publish -f article.md -t my-theme                  # 使用
wenyan theme --rm my-theme                                # 删除
```

## 常用组合

```bash
# 技术文
wenyan publish -f article.md -t lapis -h solarized-light

# 深色
wenyan publish -f article.md -t phycat -h dracula

# 简洁
wenyan publish -f article.md -t default -h github
```

## 附加选项

```bash
wenyan publish -f article.md -t lapis --no-mac-style   # 关 Mac 风格代码块
wenyan publish -f article.md -t lapis --no-footnote    # 链接不转脚注
```

模板源：wenyan-core `src/assets/themes`（github.com/caol64/wenyan-core）