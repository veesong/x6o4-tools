// logout 的本机令牌定位测试：服务端令牌列表只返回 12 位展示前缀，
// findOwnToken 用本地令牌的前 12 位与列表前缀比对，不依赖网络。
const test = require('node:test');
const assert = require('node:assert');
const { findOwnToken } = require('../cli/login');

const localToken = 'xpat_Ab3xY9Qw7Kp2' + 'z'.repeat(40); // 前 12 位 = xpat_Ab3xY9Qw（与服务端 displayPrefixLen 一致）

test('列表前缀与本机令牌前 12 位一致时命中', () => {
  const tokens = [
    { id: 1, name: 'x6o4-tools@other-pc', token_prefix: 'xpat_OtherPrefix0' },
    { id: 2, name: 'x6o4-tools@this-pc', token_prefix: localToken.slice(0, 12) },
  ];
  assert.strictEqual(findOwnToken(tokens, localToken).id, 2);
});

test('没有匹配前缀时返回 null', () => {
  const tokens = [{ id: 1, name: 'x6o4-tools@other-pc', token_prefix: 'xpat_OtherPrefix0' }];
  assert.strictEqual(findOwnToken(tokens, localToken), null);
});

test('列表为空或本地令牌为空时返回 null，不抛错', () => {
  assert.strictEqual(findOwnToken([], localToken), null);
  assert.strictEqual(findOwnToken([{ id: 1, token_prefix: 'xpat_Ab3xY9Qw7Kp2' }], ''), null);
});
