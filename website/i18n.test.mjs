// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLanguage, translate, translations } from './i18n.mjs';

test('a shared language URL overrides a saved preference; unsupported values fall back', () => {
  assert.equal(resolveLanguage('?lang=en', 'zh-Hant'), 'en');
  assert.equal(resolveLanguage('?lang=zh-Hant', 'en'), 'zh-Hant');
  assert.equal(resolveLanguage('?lang=zh-TW', 'en'), 'zh-Hant');
  assert.equal(resolveLanguage('', 'zh-Hant'), 'zh-Hant');
  assert.equal(resolveLanguage('?lang=unknown', null), 'en');
});
test('localized copy preserves every dynamic quantity placeholder', () => {
  const parameters = value => [...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const [english, chinese] of Object.entries(translations)) {
    assert.ok(chinese.length > 0, english);
    assert.deepEqual(parameters(chinese), parameters(english), english);
  }
  assert.equal(translate('Test clock +{minutes}m {seconds}s', 'zh-Hant', {minutes: 0, seconds: 1}), '測試時間 +0 分 1 秒');
  assert.equal(translate('Book TSLA: {balance}', 'zh-Hant', {balance: '9.0001'}), '選擇權簿 TSLA：9.0001');
});
test('English source copy and exact contract identifiers remain intact', () => {
  assert.equal(translate('Maker wallet', 'en'), 'Maker wallet');
  assert.equal(translate('Maker wallet', 'zh-Hant'), '造市者錢包');
  assert.equal(translate('Paused(OutsideBand)', 'zh-Hant'), 'Paused(OutsideBand)');
});
