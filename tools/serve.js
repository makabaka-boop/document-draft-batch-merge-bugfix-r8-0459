#!/usr/bin/env node
// 零依赖本地测试服务器。activeTab 只在真实 http(s) 页面生效，因此测试表单走 http://127.0.0.1。
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "test-site");
const PORT = Number(process.env.PORT) || 8765;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("404 " + p);
        return;
      }
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] || "application/octet-stream",
        // 便于测试导航/重载时拿到的是稳定内容
        "cache-control": "no-store",
      });
      res.end(buf);
    });
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log("测试站点: http://127.0.0.1:" + PORT + "/index.html");
    console.log("SPA 页 : http://127.0.0.1:" + PORT + "/spa.html");
    console.log(
      "导航页 : http://127.0.0.1:" + PORT + "/navigate.html?fsp_test=1",
    );
  });
