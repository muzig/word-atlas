# 部署 / Deployment

`npm run build` 生成纯静态站点 `dist/`，可以放到任何静态托管（Nginx、Cloudflare Pages、Vercel、GitHub Pages）。

## 子路径

```bash
ATLAS_BASE=/words/ npm run build
```

## 自建同步（可选）

纯静态部署时进度只存在各自浏览器里。如果想让多台设备共享进度，可以用自带的服务器同时托管页面和同步接口，进度存在一个 SQLite 文件里（需要 Node 22.13+）：

```bash
ATLAS_BASE=/words/ npm run build
node scripts/serve.mjs --port 4182 --base /words/ --db ./progress.db
```

- 服务只监听 `127.0.0.1`，请放在反向代理之后。推荐 `tailscale serve --bg --set-path /words http://127.0.0.1:4182`：只有 tailnet 内可访问，并按 Tailscale 登录身份（`Tailscale-User-Login` 请求头）区分用户；没有该请求头的请求共用 `local` 用户。
- 前端会自动探测 `api/sync/`：找不到时退回纯本地模式，静态部署不受影响。
- 设备之间三方合并：各自学过的词、书签、打字记录都会保留；同一个词取最近一次复习；「清空记录」也会同步到其他设备。
- 备份：直接复制数据库文件即可；页面里的「导出备份」仍然可用。

### Docker

```bash
docker compose up -d --build     # 默认子路径 /words/，监听 127.0.0.1:4182，数据在 ./var
```

镜像把约 700 MB 的插画和音频放在独立的层里，只改代码时重新构建很快。`IMAGE_TAG` 决定运行哪个镜像标签，写在 `.env` 里即可回滚。`.gitea/workflows/deploy.yml` 是在自托管 Gitea runner 上自动构建部署的示例。

## Nginx 示例

```nginx
location ^~ /words/ {
    alias /var/www/word-atlas/;
    try_files $uri $uri/ /words/index.html;
    expires 7d;
}
```

## GitHub Pages

仓库带有 `.github/workflows/pages.yml`。在仓库 Settings → Pages 选择 “GitHub Actions”，然后手动运行 “Deploy to GitHub Pages”。

## 体积

插画与音频合计约数百 MB。建议在 CDN 后部署，或按需只发布 `thumb/` 和部分音频。
