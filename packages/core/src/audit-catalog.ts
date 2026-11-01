export const auditAreas = [
  { value: 'orders', label: '订单监听' },
  { value: 'intake', label: '接单与调度' },
  { value: 'cards', label: '卡片与资金' },
  { value: 'network', label: '网络与代理' },
  { value: 'payment', label: '支付执行' },
  { value: 'cleanup', label: '收尾与回写' },
  { value: 'auth', label: '身份与权限' },
  { value: 'notification', label: '通知' },
  { value: 'other', label: '其他' },
] as const;
export const auditStatuses = [
  { value: 'all', label: '全部记录' },
  { value: 'failed', label: '失败' },
  { value: 'running', label: '等待回执' },
  { value: 'succeeded', label: '成功' },
  { value: 'pending', label: '待确认' },
  { value: 'skipped', label: '已跳过' },
] as const;
export const orderStatusLabels: Record<string, string> = {
  pending: '待领取',
  processing: '处理中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  canceled: '已取消',
  expired: '已过期',
};
