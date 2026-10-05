/*
 * route-hook.js — MAIN world 注入。
 * 只包裹 history.pushState/replaceState 并转发 popstate，不读取或修改页面任何数据。
 * 真正的路由值由 isolated world 自行读取 location，事件本身不携带可信信息。
 * 重复注入安全：只包裹一次。
 */
(function () {
  if (window.__fspRouteHookInstalled) return;
  Object.defineProperty(window, "__fspRouteHookInstalled", { value: true });

  const EVENT = "__fsp_routechange__";

  function notify() {
    try {
      window.dispatchEvent(new CustomEvent(EVENT));
    } catch (_e) {
      /* 忽略 */
    }
  }

  function wrap(name) {
    const orig = history[name];
    if (typeof orig !== "function") return;
    history[name] = function () {
      const ret = orig.apply(this, arguments);
      notify();
      return ret;
    };
  }

  wrap("pushState");
  wrap("replaceState");
  window.addEventListener("popstate", notify, true);
  window.addEventListener("hashchange", notify, true);
})();
