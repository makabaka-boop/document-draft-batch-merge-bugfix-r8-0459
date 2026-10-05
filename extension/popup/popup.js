"use strict";

const $ = (id) => document.getElementById(id);

function sendMsg(type, extra) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ type }, extra), (res) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: "runtime",
          message: chrome.runtime.lastError.message,
        });
      } else {
        resolve(res || { ok: false, error: "no-response" });
      }
    });
  });
}

function shortenRoute(route) {
  if (!route) return "";
  return route.length > 70 ? route.slice(0, 67) + "…" : route;
}

async function refresh() {
  const res = await sendMsg("STATUS");
  const grant = $("grant");
  const revoke = $("revoke");
  const unsupported = $("unsupported");
  const stateEl = $("state");
  const urlEl = $("url");

  if (!res.ok) {
    urlEl.textContent =
      "后台未就绪（请确认扩展已启用，service worker 会自动唤醒）";
    stateEl.className = "state off";
    stateEl.textContent = "";
    grant.disabled = true;
    revoke.classList.add("hidden");
    unsupported.classList.add("hidden");
    return;
  }

  urlEl.textContent = res.route || res.url || "—";
  $("counts").textContent = res.counts
    ? "库内：有效令牌 " +
      res.counts.tokensActive +
      " / 修订 " +
      res.counts.revisions
    : "";

  if (!res.supported) {
    grant.disabled = true;
    revoke.classList.add("hidden");
    unsupported.classList.remove("hidden");
    stateEl.className = "state off";
    stateEl.textContent = "";
    return;
  }
  unsupported.classList.add("hidden");
  grant.disabled = false;

  if (res.bound) {
    grant.textContent = "重新授权（旧令牌立即失效）";
    grant.classList.remove("hasToken");
    revoke.classList.remove("hidden");
    stateEl.className = "state";
    stateEl.textContent = "● 已绑定当前文档 · 路由 " + shortenRoute(res.route);
  } else if (res.hasToken) {
    grant.textContent = "页面已不在（导航/重载）— 重新授权注入";
    revoke.classList.remove("hidden");
    stateEl.className = "state warn";
    stateEl.textContent = "令牌存在，但页面侧未绑定（可能已整页导航）";
  } else {
    grant.textContent = "授权并注入当前页（顶层文档）";
    revoke.classList.add("hidden");
    stateEl.className = "state off";
    stateEl.textContent = "未授权。点击后才会注入，仅本页有效。";
  }
}

$("grant").addEventListener(
  "click",
  async () => {
    const stateEl = $("state");
    stateEl.className = "state";
    stateEl.textContent = "正在注入…";
    const res = await sendMsg("GRANT");
    if (!res.ok) {
      stateEl.className = "state warn";
      stateEl.textContent =
        "注入失败：" +
        (res.error || "") +
        (res.message ? " " + res.message : "");
      return;
    }
    // 注入完成；内容脚本会自行 HELLO 握手。短暂等待后面板应已出现。
    setTimeout(refresh, 400);
    window.close();
  },
  { once: false },
);

$("revoke").addEventListener("click", async () => {
  await sendMsg("REVOKE");
  setTimeout(refresh, 200);
});

$("prune").addEventListener("click", async () => {
  const testMode = $("testMode").checked;
  const res = await sendMsg("PRUNE_NOW", {
    testMode,
    revisionTtl: 0,
    tokenTtl: 0,
  });
  const out = $("testout");
  if (res.ok) {
    out.style.color = "#0a7a37";
    out.textContent =
      "清理完成：删除过期修订 " +
      res.result.revisions +
      " 份、失效令牌 " +
      res.result.tokens +
      " 个" +
      (testMode ? "（TTL=0）" : "");
  } else {
    out.style.color = "#cf222e";
    out.textContent = "清理失败：" + (res.error || "");
  }
  refresh();
});

refresh();
