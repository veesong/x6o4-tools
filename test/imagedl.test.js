// 图片分级下载测试：Referer 尝试序列与逐级重试（注入假请求，无网络）。
const test = require('node:test');
const assert = require('node:assert');
const { downloadImage, refererLadder, originOf } = require('../cli/imagedl');

test('originOf：取根域名，坏地址返回空', () => {
  assert.strictEqual(originOf('https://a.example/x/y?z=1'), 'https://a.example/');
  assert.strictEqual(originOf('bad'), '');
});

test('refererLadder：配置 → 文章来源 → 不发 → 图片自身，去重保序', () => {
  const seq = refererLadder('https://img.example/a.jpg', 'https://a.example/post/1', 'https://cfg.example/');
  assert.deepStrictEqual(seq, ['https://cfg.example/', 'https://a.example/', null, 'https://img.example/']);

  // 无配置；文章与图片同域时图片自身来源去重
  assert.deepStrictEqual(
    refererLadder('https://a.example/a.jpg', 'https://a.example/post/1', ''),
    ['https://a.example/', null],
  );

  // 配置来源与文章来源相同 → 去重
  assert.deepStrictEqual(
    refererLadder('https://img.example/a.jpg', 'https://a.example/post/1', 'https://a.example/'),
    ['https://a.example/', null, 'https://img.example/'],
  );
});

// 假请求：按调用次序返回预设状态，记录每次请求头
function fakeFetchSeq(results) {
  const calls = [];
  const impl = async (url, opts) => {
    const i = calls.length;
    calls.push({ url, headers: opts.headers });
    const r = results[i];
    if (!r) return { ok: false, status: 404, headers: { get: () => '' }, arrayBuffer: async () => Buffer.alloc(0) };
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k === 'content-type' ? r.contentType || 'image/jpeg' : '') },
      arrayBuffer: async () => Buffer.from(r.body || [1, 2, 3]),
    };
  };
  impl.calls = calls;
  return impl;
}

// 假请求：每次调用返回“是否成功”，并记录请求头序列
function recordingFetch(outcomes) {
  const calls = [];
  const impl = async (url, opts) => {
    const i = calls.length;
    calls.push({ url, headers: opts.headers });
    if (outcomes[i] === 'fail') {
      return { ok: false, status: 403, headers: { get: () => '' }, arrayBuffer: async () => Buffer.alloc(0) };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k === 'content-type' ? 'image/png' : '') },
      arrayBuffer: async () => Buffer.from([7]),
    };
  };
  impl.calls = calls;
  return impl;
}

test('downloadImage：第一级成功直接返回，带配置来源与浏览器标识', async () => {
  const f = recordingFetch(['ok']);
  const r = await downloadImage('https://img.example/a.jpg', 'https://a.example/p', 'https://cfg.example/', f);
  assert.ok(r && r.buffer.equals(Buffer.from([7])));
  assert.strictEqual(r.contentType, 'image/png');
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].headers.Referer, 'https://cfg.example/');
  assert.ok(f.calls[0].headers['User-Agent'].includes('Mozilla/5.0'), '应使用真实浏览器标识');
});

test('downloadImage：被拒后逐级重试，第三级不发 Referer，第四级用图片自身来源', async () => {
  // 图片域与文章域不同、无配置：四级 = 文章来源 → 不发 → 图片自身来源（共 3 个不同级）
  const f = recordingFetch(['fail', 'fail', 'ok']);
  const r = await downloadImage('https://img.example/a.jpg', 'https://a.example/p', '', f);
  assert.ok(r && r.buffer.equals(Buffer.from([7])));
  assert.strictEqual(f.calls.length, 3);
  assert.strictEqual(f.calls[0].headers.Referer, 'https://a.example/');
  assert.strictEqual(f.calls[1].headers.Referer, undefined, '第二级（不发 Referer 级别序列中的第三级）无 Referer');
  assert.strictEqual(f.calls[2].headers.Referer, 'https://img.example/');
});

test('downloadImage：四级全失败返回 null；非 http 地址直接 null', async () => {
  const f = recordingFetch(['fail', 'fail', 'fail', 'fail']);
  const r = await downloadImage('https://img.example/a.jpg', 'https://a.example/p', 'https://cfg.example/', f);
  assert.strictEqual(r, null);
  assert.strictEqual(f.calls.length, 4, '应尝试完 4 级');
  assert.strictEqual(await downloadImage('data:image/png;base64,xxx', 'https://a.example/p', '', f), null);
  assert.strictEqual(f.calls.length, 4, '非 http 地址不应发起请求');
});
