// 测试页自身的小工具脚本（与扩展无关，运行在页面 MAIN world）。
// 仅观察扩展面板 host 是否出现，给出可视提示。
(function () {
  const tag = document.createElement("div");
  tag.className = "inject-state";
  tag.textContent = "扩展面板：未注入（点击工具栏图标授权）";
  document.body.appendChild(tag);
  new MutationObserver(() => {
    const injected = !!document.getElementById("__fsp_panel_host");
    tag.textContent = injected
      ? "扩展面板：已注入（仅顶层文档、仅本页授权）"
      : "扩展面板：未注入（点击工具栏图标授权）";
    tag.classList.toggle("on", injected);
  }).observe(document.documentElement, { childList: true, subtree: false });
})();
