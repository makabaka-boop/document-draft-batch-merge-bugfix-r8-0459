#!/usr/bin/env node
// 静态安全检查：
// 1) manifest：无 host_permissions、无通配内容脚本声明、权限最小化
// 2) 所有扩展 JS 通过语法检查
// 3) 扫描外发面：fetch/XHR/WebSocket/navigator.sendBeacon 不应出现在扩展代码中（纯本地）
// 4) 不声明 content_scripts / web_accessible_resources（只经 activeTab 编程注入）
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "extension");
let failures = 0;
const fail = (m) => {
  failures++;
  console.error("✗ " + m);
};
const ok = (m) => console.log("✓ " + m);

// 1) manifest
const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"),
);
if (manifest.manifest_version !== 3) fail("manifest_version 必须是 3");
else ok("Manifest V3");

const allowedPerms = new Set(["activeTab", "scripting", "alarms"]);
const perms = manifest.permissions || [];
const badPerms = perms.filter((p) => !allowedPerms.has(p));
if (badPerms.length) fail("不允许的权限: " + badPerms.join(", "));
else ok("权限仅为: " + perms.join(", "));

if ((manifest.host_permissions || []).length)
  fail("host_permissions 必须为空（不申请通配站点权限）");
else ok("host_permissions 为空");

if (manifest.content_scripts)
  fail("不应声明 content_scripts（仅点击后编程注入）");
else ok("无声明式 content_scripts");

if (manifest.web_accessible_resources)
  fail("不应声明 web_accessible_resources");
else ok("无 web_accessible_resources");

if (
  !manifest.background ||
  !/service-worker\.js$/.test(manifest.background.service_worker || "")
) {
  fail("缺少 service worker");
} else ok("service worker: " + manifest.background.service_worker);

// 2) JS 语法检查
const jsFiles = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    if (fs.statSync(f).isDirectory()) walk(f);
    else if (f.endsWith(".js")) jsFiles.push(f);
  }
})(ROOT);
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    ok("语法检查通过: " + path.relative(ROOT, f));
  } catch (e) {
    fail("语法错误: " + path.relative(ROOT, f) + "\n" + e.stderr);
  }
}

// 3) 外发面扫描（允许出现在注释/字符串之外的调用基本为零；这里做保守 token 扫描）
const FORBIDDEN = [
  ["fetch(", "fetch（禁止任何网络请求）"],
  ["XMLHttpRequest", "XMLHttpRequest（禁止）"],
  ["WebSocket", "WebSocket（禁止）"],
  ["sendBeacon", "sendBeacon（禁止）"],
  ["navigator.onLine", "联网状态读取（禁止）"],
];
for (const f of jsFiles) {
  const src = fs.readFileSync(f, "utf8");
  for (const [token, desc] of FORBIDDEN) {
    if (src.includes(token)) fail(path.relative(ROOT, f) + " 含 " + desc);
  }
}
ok("未发现任何网络外发 API");

// 4) 注入只针对顶层
const sw = fs.readFileSync(
  path.join(ROOT, "background", "service-worker.js"),
  "utf8",
);
if (!sw.includes("allFrames: false"))
  fail("注入必须显式 allFrames:false（不读 iframe）");
else ok("注入限定 allFrames:false（仅顶层文档）");
if (!sw.includes("sender.frameId !== 0")) fail("消息必须拒绝非顶层 frameId");
else ok("消息仅接受 frameId === 0");
if (!sw.includes("sender.documentId"))
  fail("必须使用 sender.documentId 组合验证");
else ok("组合验证包含 sender.documentId");

console.log(failures ? "\n检查失败: " + failures : "\n全部检查通过");
process.exit(failures ? 1 : 0);
