'use strict';

// 解析单段 Range 请求头。
// 返回：null = 无 Range / 多段不支持；{start,end} = 合法范围；'invalid' = 需要 416
function parseRange(header, size) {
  if (!Number.isSafeInteger(size) || size <= 0) return 'invalid';
  if (header == null) return null;
  if (typeof header !== 'string') return 'invalid';

  const value = header.trim();
  // 多段 Range（bytes=0-1,5-6）暂不支持，按整文件响应
  if (!value.startsWith('bytes=') || value.includes(',')) return null;

  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m) return 'invalid';

  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return 'invalid';

  let start;
  let end;

  if (rawStart === '') {
    // 后缀范围：bytes=-500 → 最后 500 字节
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    if (!Number.isSafeInteger(start) || start >= size) return 'invalid';
    if (rawEnd === '') {
      end = size - 1;
    } else {
      end = Number(rawEnd);
      if (!Number.isSafeInteger(end) || end < start) return 'invalid';
      end = Math.min(end, size - 1);
    }
  }

  return { start, end };
}

module.exports = { parseRange };
