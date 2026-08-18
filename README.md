# Apple-style NAS service portal

这是一个不保存业务账号、不代理业务请求的 Apple 风格服务入口。门户只保存公开显示的标题、副标题、服务名称、描述、图标、颜色、排序、启用状态和 HTTPS 链接。

## Docker 部署

在 NAS 上进入项目目录，创建只保存在 NAS 本地的 `.env`：

```env
PORTAL_ADMIN_PASSWORD=请替换为新的高强度管理员密码
```

不要把 `.env` 提交到代码仓库、放进镜像、截图或发送给其他人。首次启动时，服务只会把密码生成盐值哈希并写入 Docker volume，之后登录不再读取明文环境变量。

启动或更新：

```bash
docker compose up -d --build
```

容器内部监听 `8080`，只绑定 Docker 主机回环地址：

```text
127.0.0.1:18080
```

容器使用 `portal-data` 命名卷保存 `auth.json` 和门户配置。不要把 Docker Socket、NAS 根目录、证书私钥或业务数据目录挂载给它。

## fn-knock 接入

添加 Host 映射：

```text
portal.myfu.cn -> http://<NAS-LAN-IP>:18080
要求登录：开启
Host 响应：保持默认
```

添加 AliDNS 记录：

```text
portal CNAME eas.myfu.cn
```

在 ESA/备案完成前使用：

```text
https://portal.myfu.cn:7999
https://portal.myfu.cn:7999/admin
```

## 管理员设置

登录 `/admin` 后可以在线修改：

- 门户标题和副标题；
- 服务卡片的添加、编辑、删除、排序和启用状态；
- 服务名称、描述、图标、颜色和 HTTPS 链接；
- 门户管理员密码。

管理员密码是门户第二层密码，不等于 fn-knock、NAS、WebDAV 或飞牛影视的业务密码。修改密码会撤销所有旧管理员会话。

服务链接由服务端再次校验，只允许 `https://myfu.cn` 及其子域名；门户不支持任意 URL 跳转、反向代理、命令执行或 Docker 配置修改。

## 备份与恢复

定期备份 Docker volume `portal-data`。备份前停止容器或使用一致性卷备份方式，备份内容包含管理员密码哈希和公开门户配置，不包含业务服务密码。

如果丢失管理员密码，不能从 `auth.json` 还原明文密码；应先保留配置卷，再按维护流程重置认证数据，并立即设置新的强密码。

## 本地开发

本机没有 Docker 时可直接用 Node 24+ 验证：

```bash
set PORTAL_ADMIN_PASSWORD=一条仅用于本地测试的强密码
node server.mjs
```

然后打开：

```text
http://127.0.0.1:8080
http://127.0.0.1:8080/admin
```

生产环境通过 fn-knock HTTPS 访问时会使用安全 Cookie；本地 HTTP 测试可以临时设置 `PORTAL_COOKIE_SECURE=false`，不要在公网环境关闭它。

旧版静态预览仍可查看 `site/links.js`，但线上首页优先读取 `/api/public/config`，API 暂时不可用时才回退到该默认配置。
