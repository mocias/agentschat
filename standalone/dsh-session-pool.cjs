'use strict';
const { AcpPool } = require('../lib/acp-backend.cjs');
const { prepareDshControls } = require('./dsh-session-controls.cjs');

class DshSessionPool extends AcpPool {
  constructor(options) { super(options); this.baseLaunch = options; this.controls = null; }
  async start(options) {
    if (!this.controls) {
      this.controls = prepareDshControls(this.baseLaunch, this.baseLaunch.dshControlsRoot);
      this.commandOptions = this.controls.launch;
    }
    try { return await super.start(options); }
    catch (error) { await this.stop(); throw error; }
  }
  _onDeath() { super._onDeath(); this.controls?.resetEndpoint(); }
  async openThread(key, options) {
    const record = await super.openThread(key, options);
    try {
      const config = options.sessionConfig;
      const applied = await this.controls.request('/session', { sessionId: record.id, preset: config.preset, permission: config.permission });
      if (applied.preset !== config.preset || applied.permission !== config.permission) throw new Error('DSH 没有应用所选会话配置');
      if (options.strictModel && this.configIds.model) {
        const wanted = this.lookupModel(options.model);
        if (!wanted || !await this.applyConfigOption(record.id, this.configIds.model, wanted.raw || wanted.id, true)) throw new Error('DSH 预设切换后无法保持固定模型');
      }
      record.appliedSessionConfig = applied;
      return record;
    } catch (error) { this.closeThread(key); throw error; }
  }
  async stop() {
    try { await super.stop(); }
    finally { this.controls?.dispose(); this.controls = null; this.commandOptions = this.baseLaunch; }
  }
}
module.exports = { DshSessionPool };
