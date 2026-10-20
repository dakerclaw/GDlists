'use strict';

// 可签名、可过期的 token 编解码器。
// 格式：base64url(JSON payload) + '.' + base64url(HMAC-SHA256)
const crypto = require('crypto');

function createTokenCodec(secret) {
  if (!secret) throw new Error('createTokenCodec: secret is required');

  // 从会话密钥派生独立的签名密钥，避免 token 与会话 cookie 共用原始密钥
  const key = crypto.createHmac('sha256', secret).update('gdlist.token.v1').digest();
  const signBody = (body) => crypto.createHmac('sha256', key).update(body).digest('base64url');

  return {
    sign(payload) {
      const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      return `${body}.${signBody(body)}`;
    },

    /** @returns {object|null} 校验失败 / 已过期时返回 null */
    verify(token) {
      if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
      const dot = token.indexOf('.');
      if (dot <= 0 || dot === token.length - 1) return null;

      const body = token.slice(0, dot);
      const signature = token.slice(dot + 1);
      const expected = signBody(body);
      const a = Buffer.from(signature, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

      let payload;
      try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
      if (payload.exp != null && (!Number.isFinite(payload.exp) || Date.now() > payload.exp)) return null;
      return payload;
    }
  };
}

module.exports = { createTokenCodec };
