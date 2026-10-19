// RSS Cloud 接口客户端：统一错误体 {error_code, message} 解析为 ApiError，
// 并对常见错误码给出中文指引。
class ApiError extends Error {
  constructor(status, code, message) {
    super(message || `HTTP ${status}`);
    this.status = status;
    this.code = code || '';
    this.friendly = friendlyText(status, this.code, this.message);
  }
}

function friendlyText(status, code, message) {
  switch (code) {
    case 'TOKEN_INVALID':
      return '令牌无效或已吊销（修改过密码、重置过密码、账号被封都会联动吊销），请在终端重新运行 x6o4 login';
    case 'TOKEN_SCOPE_DENIED':
      return '当前令牌为只读权限，无法标记已读；请重新运行 x6o4 login --scope readwrite';
    case 'AGENT_API_DISABLED':
      return '服务端已停用技能数据接口（AGENT_API_ENABLED=false），请联系网关管理员';
    case 'RATE_LIMITED':
      return '请求过于频繁，请等待约一分钟再试';
    case 'MINIFLUX_UNAVAILABLE':
    case 'ACCOUNT_PROVISIONING_FAILED':
      return 'RSS 上游暂时不可用或账号开通中，请稍后重试';
    default:
      if (code && code.startsWith('SUBSCRIPTION_')) {
        return `RSS Cloud 权益不足（${message || code}），续订或领取试用后即可使用`;
      }
      return message || `HTTP ${status}`;
  }
}

class Api {
  constructor(baseURL, token) {
    this.baseURL = String(baseURL || '').replace(/\/+$/, '');
    this.token = token || '';
  }

  setToken(t) { this.token = t; }

  async req(method, p, { query, body, authToken } = {}) {
    let url = this.baseURL + p;
    if (query && Object.keys(query).length) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += '?' + s;
    }
    const headers = { 'Content-Type': 'application/json' };
    const bearer = authToken || this.token;
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    const res = await fetch(url, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!res.ok) {
      throw new ApiError(res.status, data && data.error_code, data && data.message);
    }
    return data;
  }

  // 登录换取 15 分钟访问令牌（仅 login 流程使用，密码与该令牌都不落盘）。
  async login(email, password) {
    return this.req('POST', '/api/v1/auth/login', { body: { email, password } });
  }

  // 令牌管理（创建只认登录令牌；列表/吊销个人令牌即可，网关 v1.6 §4.1）。
  async createToken(jwt, name, scope) {
    return this.req('POST', '/api/v1/tokens', { body: { name, scope }, authToken: jwt });
  }
  async listTokens(jwt) {
    return this.req('GET', '/api/v1/tokens', { authToken: jwt }); // jwt 缺省时用个人令牌自身
  }
  async revokeToken(id) {
    return this.req('DELETE', `/api/v1/tokens/${id}`);
  }

  // 技能数据接口。
  async me() { return this.req('GET', '/api/v1/agent/me'); }
  async feeds() { return this.req('GET', '/api/v1/agent/feeds'); }
  async entries(params) { return this.req('GET', '/api/v1/agent/entries', { query: params }); }
  async markRead(ids) { return this.req('POST', '/api/v1/agent/entries/read', { body: { entry_ids: ids } }); }
}

module.exports = { Api, ApiError, friendlyText };
