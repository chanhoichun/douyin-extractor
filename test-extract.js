'use strict';

/**
 * 命令行测试：node test-extract.js "<抖音链接或分享文案>"
 */
const { extract } = require('./extract');

const input = process.argv[2] || '';
if (!input) {
  console.log('用法: node test-extract.js "<抖音链接或分享文案>"');
  process.exit(1);
}

(async () => {
  try {
    console.log('正在解析:', input.slice(0, 80));
    const result = await extract(input);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('提取失败:', e.message);
    process.exit(1);
  }
})();
