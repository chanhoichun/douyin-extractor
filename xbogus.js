'use strict';

/**
 * X-Bogus 签名算法（Node 版）
 *
 * 移植自 AngelToms 还原的 x-bogus 算法：
 * https://github.com/brock7/douyin_sign/blob/main/x_bogus/xbogus.py
 * SPDX-License-Identifier: Apache-2.0
 *
 * 管线：md5(query) -> md5 摘要再取 4 字节校验 -> RC4 混淆 -> 自定义 base64（s1 字母表）
 */

const crypto = require('crypto');

function md5Digest(data) {
  return crypto.createHash('md5').update(data).digest();
}

function md5Hex(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

/** 标准 RC4：key 为单字节数组，data 为字节数组 */
function rc4(keyBytes, dataBytes) {
  const S = [];
  for (let i = 0; i < 256; i++) S.push(i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + keyBytes[i % keyBytes.length]) & 0xff;
    const t = S[i];
    S[i] = S[j];
    S[j] = t;
  }
  let i = 0;
  j = 0;
  const out = Buffer.alloc(dataBytes.length);
  for (let n = 0; n < dataBytes.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    const t = S[i];
    S[i] = S[j];
    S[j] = t;
    const k = S[(S[i] + S[j]) & 0xff];
    out[n] = dataBytes[n] ^ k;
  }
  return out;
}

/** 自定义 base64（字母表 s1，与新版 X-Bogus 一致） */
const LETTER_S1 = 'Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=';

function dyBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const c1 = bytes[i];
    const c2 = i + 1 < bytes.length ? bytes[i + 1] : null;
    const c3 = i + 2 < bytes.length ? bytes[i + 2] : null;
    const combined = ((c1 & 0xff) << 16) | ((c2 !== null ? c2 & 0xff : 0) << 8) | (c3 !== null ? c3 & 0xff : 0);
    out += LETTER_S1[(combined >> 18) & 0x3f];
    out += LETTER_S1[(combined >> 12) & 0x3f];
    out += c2 !== null ? LETTER_S1[(combined >> 6) & 0x3f] : '=';
    out += c3 !== null ? LETTER_S1[combined & 0x3f] : '=';
  }
  return out;
}

/**
 * 生成 X-Bogus
 * @param {string} query 参与签名的查询串（不含 X-Bogus 本身）
 * @returns {string} 16 字符的 X-Bogus 值
 */
function generateXbogus(query) {
  // 与 AngelToms 版本一致：data = md5(query).digest()（二进制摘要）
  const data = md5Digest(Buffer.from(query, 'utf8'));
  const dataMd5 = md5Digest(data);
  const inSaltMd5 = md5Digest(Buffer.from('', 'utf8'));
  const inSaltMd5Md5 = md5Digest(inSaltMd5);

  const protocol = 1;
  const reventFlag = 0;
  const arg3 = 0;
  const padString = (protocol << 6) | (reventFlag << 5) | ((Math.floor(Math.random() * 100) & 1) << 4) | 0;

  const bogusIndex = (Math.floor(Math.random() * 0x3f)) & 0x3f; // 0-63
  const uArray = Buffer.alloc(9);
  uArray[0] = (arg3 << 6) | bogusIndex;
  uArray[1] = 0; // envcode 高位
  uArray[2] = 0; // envcode 低位
  uArray[3] = 0; // ubcode
  uArray[4] = inSaltMd5Md5[14];
  uArray[5] = inSaltMd5Md5[15];
  uArray[6] = dataMd5[14];
  uArray[7] = dataMd5[15];
  uArray[8] = Math.floor(Math.random() * 256) & 0xff;

  // uArray + 异或校验字节
  const payload = Buffer.alloc(10);
  let ieor = 0;
  for (let i = 0; i < 9; i++) {
    payload[i] = uArray[i];
    ieor ^= uArray[i];
  }
  payload[9] = ieor & 0xff;

  const randomKey = Math.floor(Math.random() * 256) & 0xff;
  const crypted = rc4(Buffer.from([randomKey]), payload);

  const result = Buffer.alloc(2 + crypted.length);
  result[0] = padString & 0xff;
  result[1] = randomKey;
  crypted.copy(result, 2);

  return dyBase64(result);
}

module.exports = { generateXbogus };
