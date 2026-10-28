'use strict';
const { AcpPool } = require('../lib/acp-backend.cjs');

// ACP mode IDs retain their native meaning; they are not OS sandbox policies.
class NativeModePool extends AcpPool {
  async openThread(key, options = {}) {
    const record = await super.openThread(key, options);
    if (!options.sessionConfig) return record;
    try {
      const { permission, preset } = options.sessionConfig;
      if (preset !== 'native') throw new Error('此后端只支持原生会话模式');
      const result = await this.request('session/set_config_option', { sessionId: record.id, configId: 'mode', value: permission });
      if (!result.configOptions?.some(o => o.category === 'mode' && o.currentValue === permission)) throw new Error('后端没有应用所选原生权限模式');
      if (options.strictModel && this.configIds.model) {
        const wanted = this.lookupModel(options.model);
        if (!wanted || !await this.applyConfigOption(record.id, this.configIds.model, wanted.raw || wanted.id, true)) throw new Error('原生模式切换后无法保持固定模型');
      }
      record.appliedSessionConfig = { permission, preset };
      return record;
    } catch (error) { this.closeThread(key); throw error; }
  }
}
module.exports = { NativeModePool };
