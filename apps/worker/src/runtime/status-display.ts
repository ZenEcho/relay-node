import { updateActive } from '../../../../packages/rules/src/node-control.js';
const updates: Record<string, string> = {
  queued: '等待空闲',
  draining: '等待原订单全部结束',
  checking: '正在检查版本',
  downloading: '正在下载新版',
  installing: '正在安装',
  restarting: '正在验证新版启动',
  current: '已是最新版本',
  completed: '更新成功',
  failed: '更新失败',
  rolled_back: '已回滚到原版本',
  cancelled: '更新已取消',
};
const runs: Record<string, string> = {
  running: '执行中',
  queued: '等待继续',
  awaiting_captcha: '等待客户验证',
  pending_confirmation: '付款待核对',
  paused: '等待继续',
  completed: '收尾或回传中',
  failed: '重试或核对中',
  stopped: '等待回传',
};
export function displayStatus(status: any, instance: string) {
  const lines = [
    `实例：${instance}`,
    `控制台连接：${status.connected ? '已连接' : '未连接'}`,
    `节点版本：${status.version ? 'v' + status.version : '等待连接'}`,
    `接单状态：${updateActive(status.control?.update) ? '维护中，已停止接新单' : status.control?.desiredState === 'paused' ? '已暂停接新单' : '运行中'}`,
    `正在执行：${status.inFlightCount ?? 0} 个任务`,
    `未结束订单：${status.blockers?.length || 0} 单`,
    `传输组件：${status.transportReady ? '就绪' : '未就绪'}`,
  ];
  if (status.platform)
    lines.push(
      `运行系统：${status.platform === 'darwin' ? 'macOS' : 'Linux'} / ${status.arch === 'x64' ? 'amd64' : status.arch}`,
    );
  if (status.control?.update)
    lines.push(`更新状态：${updates[status.control.update.phase] || '等待处理'}`);
  if (status.control?.update?.error) lines.push(`更新说明：${status.control.update.error}`);
  for (const run of status.blockers || [])
    lines.push(`  ${run.orderNo} · ${runs[run.status] || '未结束'}`);
  if (status.message) lines.push(status.message);
  return lines.join('\n');
}
