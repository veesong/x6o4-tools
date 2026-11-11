// RSS Cloud 接口客户端：统一错误体 {error_code, message} 解析为 ApiError，
// 并对常见错误码给出当前界面语言的指引（uitext 由入口在判定语言后设置）。
const { ui } = require('./uitext');

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || `HTTP ${status}`);
    this.status = status;
    this.code = code || '';
    this.friendly = friendlyText(status, this.code, this.message);
  }
}

function friendlyText(status, code, message) {
  const t = ui();
  switch (code) {
    case 'TOKEN_INVALID':
      return t.apiTokenInvalid;
    case 'TOKEN_SCOPE_DENIED':
      return t.apiScopeDenied;
    case 'FEED_NOT_FOUND':
      return t.apiFeedNotFound;
    case 'AGENT_API_DISABLED':
      return t.apiAgentDisabled;
    case 'RATE_LIMITED':
      return t.apiRateLimited;
    case 'MINIFLUX_UNAVAILABLE':
    case 'ACCOUNT_PROVISIONING_FAILED':
      return t.apiUpstream;
    default:
      if (code && code.startsWith('SUBSCRIPTION_')) {
        return t.apiEntitle(message || code);
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

  // 令牌管理（创建只认登录令牌；列表/吊销用个人令牌即可）。
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
  // 批量铸造「收藏文章」链接（需读写档令牌；返回 {links:[{entry_id,url}]}，
  // 链接内是网关签名的短时效令牌，不含个人访问令牌）。
  async saveLinks(ids) { return this.req('POST', '/api/v1/agent/save-links', { body: { entry_ids: ids } }); }
  // 保存单源阅读设置（需读写档令牌）。
  async putReadingConfig(feedId, cfg) {
    return this.req('PUT', `/api/v1/agent/feeds/${feedId}/reading-config`, { body: cfg });
  }
}

module.exports = { Api, ApiError, friendlyText };
