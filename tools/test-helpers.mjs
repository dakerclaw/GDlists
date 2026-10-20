// lib/ 下纯逻辑模块的单元测试（无需安装依赖）
// 运行：npm test  或  node tools/test-helpers.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createTokenCodec } = require(path.join(root, 'lib', 'token.js'));
const { parseRange } = require(path.join(root, 'lib', 'range.js'));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    console.error(`  ✘ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('token codec');
const codec = createTokenCodec('test-secret-0123456789abcdef');
const token = codec.sign({ typ: 'file', id: 'abc', sourceId: 'work' });

test('签名后可验证', () => {
  const payload = codec.verify(token);
  assert.equal(payload.id, 'abc');
  assert.equal(payload.sourceId, 'work');
});
test('篡改内容被拒绝', () => {
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ typ: 'file', id: 'hacked' })).toString('base64url');
  assert.equal(codec.verify(`${forged}.${sig}`), null);
  assert.notEqual(body, forged);
});
test('篡改签名被拒绝', () => {
  assert.equal(codec.verify(`${token}x`), null);
});
test('换密钥无法验证', () => {
  assert.equal(createTokenCodec('another-secret-0123456789').verify(token), null);
});
test('过期 token 被拒绝', () => {
  const expired = codec.sign({ typ: 'file', id: 'abc', exp: Date.now() - 1000 });
  assert.equal(codec.verify(expired), null);
});
test('非法格式返回 null', () => {
  for (const bad of ['', 'no-dot', '.sig', 'body.', 'a.b.c', 'x'.repeat(5000), null, 42]) {
    assert.equal(codec.verify(bad), null);
  }
});

console.log('range parser');
const cases = [
  ['bytes=0-99', 1000, { start: 0, end: 99 }],
  ['bytes=100-', 1000, { start: 100, end: 999 }],
  ['bytes=-100', 1000, { start: 900, end: 999 }],
  ['bytes=-5000', 1000, { start: 0, end: 999 }],
  ['bytes=999-999', 1000, { start: 999, end: 999 }],
  ['bytes=0-99999', 1000, { start: 0, end: 999 }],
  ['bytes=0-1,5-6', 1000, null],
];
for (const [header, size, expected] of cases) {
  test(`${header} (size=${size})`, () => assert.deepEqual(parseRange(header, size), expected));
}
const invalid = ['bytes=1000-', 'bytes=5-1', 'bytes=-0', 'bytes=a-b', 'bytes=-'];
for (const header of invalid) {
  test(`非法范围 ${header}`, () => assert.equal(parseRange(header, 1000), 'invalid'));
}
test('非 bytes 单位按无 Range 处理', () => assert.equal(parseRange('items=0-1', 1000), null));
test('无 Range 返回 null', () => assert.equal(parseRange(undefined, 1000), null));
test('未知大小返回 invalid', () => assert.equal(parseRange('bytes=0-1', 0), 'invalid'));

console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败项' : ''}`);
