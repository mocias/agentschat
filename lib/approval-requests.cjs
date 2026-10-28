'use strict';
const { randomUUID } = require('node:crypto');

class ApprovalRequests {
  constructor(publish) { this.pending = new Map(); this.publish = publish; }
  list(room) { return [...this.pending.values()].filter(p => p.view.room === room).map(p => p.view); }
  request(room, backend, method, params) {
    const id = randomUUID();
    const title = method === 'session/request_permission' ? (params.toolCall?.title || backend + ' 工具操作') : /fileChange|applyPatch/.test(method) ? '修改文件' : '执行命令';
    const detail = String(params.command || params.reason || params.toolCall?.description || '后端请求你确认这次操作。').slice(0, 4000);
    return new Promise(resolve => {
      const entry = { view: { id, room, backend, title, detail, createdAt: new Date().toISOString() }, resolve, timer: null };
      entry.timer = setTimeout(() => this.finish(id, false), 5 * 60 * 1000); entry.timer.unref?.();
      this.pending.set(id, entry); this.publish({ type: 'approvals', room, approvals: this.list(room) });
    });
  }
  finish(id, allow) {
    const entry = this.pending.get(id); if (!entry) return false;
    this.pending.delete(id); clearTimeout(entry.timer); entry.resolve(allow);
    this.publish({ type: 'approvals', room: entry.view.room, approvals: this.list(entry.view.room) }); return true;
  }
  answer(room, id, allow) {
    if (typeof allow !== 'boolean' || this.pending.get(id)?.view.room !== room) throw new Error('权限请求不存在、已过期或不属于当前会话');
    this.finish(id, allow);
  }
  cancel(room) { for (const [id, entry] of this.pending) if (!room || entry.view.room === room) this.finish(id, false); }
}
module.exports = { ApprovalRequests };
