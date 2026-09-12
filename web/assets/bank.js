// 取数封装。所有页面共用，错误统一抛成可读的中文。
// 页面里的写操作都走这里，别各写一份 fetch——错误处理只有这一处。
window.api = {
  async _req(path, opts) {
    const r = await fetch(path, opts);
    if (!r.ok) {
      // 后端出错时会回 {"error": "..."}，那是给人看的，优先用它；
      // 不是 JSON（比如 404 落到静态文件、502 网关页）就退回状态码。
      let msg = r.status + ' ' + r.statusText;
      try { msg = (await r.json()).error || msg; } catch (e) { /* 不是 JSON 就用状态码 */ }
      throw new Error(msg);
    }
    return r.json();
  },
  get(path) { return this._req(path); },
  post(path, body) {
    return this._req(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },
  del(path) { return this._req(path, { method: 'DELETE' }); },
};
