# 458-uivisib

GSB pair-wise 初始快照。

## 授权核对台（全栈应用）

启动（零依赖，需 Node.js）：

```bash
node server.js        # 默认 3000 端口，PORT=8080 node server.js 可改
```

然后浏览器打开 http://localhost:3000

- `server.js`：HTTP API + SSE 实时推送 + 授权推导引擎（多来源声明、冲突拒绝优先、撤销栈、受影响页面 diff）
- `public/index.html`：声明增删改、页面收敛视图、依据链展示、撤销操作
