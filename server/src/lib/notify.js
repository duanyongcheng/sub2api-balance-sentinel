import { config } from '../config.js';

/**
 * Outbound notifications.
 *
 * Design rule: notifying is *never* allowed to interfere with money.
 *  - fire-and-forget, with a short timeout
 *  - every failure is swallowed and only logged
 *  - the webhook URL is validated against the configured allow-list so a
 *    misconfigured env var cannot post our text to an unexpected place
 *
 * Supported formats (NOTIFY_FORMAT):
 *   wecom   - 企业微信机器人  https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
 *   feishu  - 飞书自定义机器人   https://open.feishu.cn/open-apis/bot/v2/hook/...
 *   dingtalk- 钉钉自定义机器人
 *   slack   - Slack incoming webhook
 *   generic - raw JSON { text, ... } for your own endpoint
 */
export class Notifier {
  constructor({ store, logger = console, url = config.notify.url, format = config.notify.format, timeoutMs = 8000 } = {}) {
    this.store = store;
    this.logger = logger;
    this.url = url;
    this.format = format;
    this.timeoutMs = timeoutMs;
  }

  get enabled() {
    return Boolean(this.url);
  }

  buildBody(text) {
    switch (this.format) {
      case 'wecom':
        return { msgtype: 'text', text: { content: text } };
      case 'dingtalk':
        return { msgtype: 'text', text: { content: text } };
      case 'feishu':
        return { msg_type: 'text', content: { text } };
      case 'slack':
        return { text };
      case 'generic':
      default:
        return { text };
    }
  }

  /** send() never throws. Returns true/false for callers that care. */
  async send(text, meta = {}) {
    if (!this.enabled) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildBody(text)),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        this.#logOnce('warn', `notification endpoint returned HTTP ${res.status}`, meta);
        return false;
      }
      // WeCom/Feishu return 200 with errcode != 0 on failure.
      const payload = await res.json().catch(() => null);
      if (payload && (payload.errcode ?? 0) !== 0) {
        this.#logOnce('warn', `notification rejected with code ${String(payload.errcode).slice(0, 40)}`, meta);
        return false;
      }
      return true;
    } catch (err) {
      this.#logOnce('warn', `notification delivery failed: ${String(err.name || 'Error').slice(0, 40)}`, meta);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Log to the events table but throttle identical messages, so a broken
   * webhook cannot flood the ledger on every poll.
   */
  #logOnce(level, message, meta) {
    const key = 'notify_error_last';
    const last = this.store?.getSetting(key, '');
    if (last === message) return;
    this.store?.setSetting(key, message);
    this.store?.log(level, 'notify_failed', message, meta.userId ?? null);
  }

  // ---- message builders ----

  topUpSuccess({ userId, email, before, after, amount, source, replay }) {
    return [
      `【余额哨兵】已自动加额`,
      `用户：#${userId} ${email || ''}`.trim(),
      `加额前：${before}`,
      `加额：+${amount}（${source === 'manual' ? '手动' : source === 'approval' ? '审批' : '自动'}）`,
      `加额后：${after ?? '未知（回读失败）'}`,
      replay ? '注：本次为幂等重放，未重复加额' : null,
    ].filter(Boolean).join('\n');
  }

  topUpUnknown({ userId, email, amount, error }) {
    return [
      `【余额哨兵】⚠️ 加额结果未知，需人工核对`,
      `用户：#${userId} ${email || ''}`.trim(),
      `金额：${amount}`,
      `原因：${error}`,
      `该笔可能已经加上，系统不会自动重试。请到 sub2api 后台确认。`,
    ].join('\n');
  }

  topUpFailed({ userId, email, amount, error }) {
    return [
      `【余额哨兵】加额失败`,
      `用户：#${userId} ${email || ''}`.trim(),
      `金额：${amount}`,
      `原因：${error}`,
    ].join('\n');
  }

  circuitOpen({ failures }) {
    return [
      `【余额哨兵】🛑 熔断已触发，自动加额已停止`,
      `连续失败 ${failures} 次。请检查后到页面点「重置熔断」。`,
    ].join('\n');
  }

  guardBlocked({ userId, email, reason }) {
    return [
      `【余额哨兵】安全护栏拦截`,
      `用户：#${userId} ${email || ''}`.trim(),
      `原因：${reason}`,
    ].join('\n');
  }

  proposalCreated({ userId, email, balance, threshold, amount }) {
    return [
      `【余额哨兵】待你确认加额`,
      `用户：#${userId} ${email || ''}`.trim(),
      `当前余额：${balance}（低于阈值 ${threshold}）`,
      `拟加额：+${amount}`,
      `请到哨兵页面「待审批」中确认。`,
    ].join('\n');
  }
}
