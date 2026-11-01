const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractEncodingBlock } = require('./helpers/load');

const api = new Function(`${extractEncodingBlock()}\nreturn { decodeTextBytes, cleanText, hasReplacement, hasGarbageDeep, repairRequestEncoding };`)();

describe('Нормализация кодировки на приёме', () => {
  it('строгий UTF-8 проходит как есть, cp1251 опознаётся и перекодируется', () => {
    const utf8 = Buffer.from(JSON.stringify({ fio: 'Иванов Пётр' }), 'utf8');
    const a = api.decodeTextBytes(utf8);
    assert.equal(a.encoding, 'utf-8');
    assert.equal(JSON.parse(a.text).fio, 'Иванов Пётр');

    // 'Иванов' в cp1251: валидным UTF-8 эти байты не являются
    const cp = Buffer.from([0xC8, 0xE2, 0xE0, 0xED, 0xEE, 0xE2]);
    const b = api.decodeTextBytes(cp);
    assert.equal(b.encoding, 'windows-1251');
    assert.equal(b.text, 'Иванов');
    // 'ё' и 'М' в cp1251 лежат не там, где в cp1252 — проверяем по факту
    assert.equal(api.decodeTextBytes(Buffer.from([0xCF, 0xB8, 0xF2, 0xF0])).text, 'Пётр');
    assert.equal(api.decodeTextBytes(Buffer.from([0xCC, 0xEE, 0xF1, 0xEA, 0xE2, 0xE0])).text, 'Москва');
  });

  it('пустое тело не выдумывается, а настоящий U+FFFD в валидном UTF-8 не «чинится»', () => {
    assert.equal(api.decodeTextBytes(Buffer.alloc(0)).text, '');
    // кто-то прислал уже испорченную строку валидным UTF-8 — перекодировать нечего
    const already = Buffer.from(JSON.stringify({ fio: 'a\uFFFDb' }), 'utf8');
    const dec = api.decodeTextBytes(already);
    assert.equal(dec.encoding, 'utf-8', 'это валидный UTF-8, значит ремонт не при чём');
    assert.ok(dec.text.includes('\uFFFD'));
  });

  it('cleanText склеивает разложенную кириллицу, режет управляющие символы и нормализует переносы', () => {
    assert.equal(api.cleanText('е\u0308'), 'ё');
    assert.equal(api.cleanText('  Иванов\u0000\u0007 '), 'Иванов');
    assert.equal(api.cleanText('а\r\nб\rc\nd'), 'а\nб\nc\nd');
    assert.equal(api.cleanText('x\u001B'), 'x');
    assert.equal(api.cleanText(null), '');
    assert.equal(api.cleanText(12345), '12345');
  });

  it('повреждённые символы находятся и вглубь вложенных объектов', () => {
    assert.equal(api.hasGarbageDeep({ customer: { fio: 'a\uFFFDb' } }), true);
    assert.equal(api.hasGarbageDeep({ items: [{ name: 'ok' }], customer: { fio: 'ok' } }), false);
    assert.equal(api.hasGarbageDeep(['норм', 'тоже норм']), false);
    assert.equal(api.hasGarbageDeep(42), false);
  });

  it('ремонт тела: UTF-8 не трогает, cp1251 восстанавливает, нерешаемое оставляет', () => {
    // ровно то, что делает штатный парсер: байты декодируются как UTF-8 без
    // запрета на ошибки, кириллица превращается в U+FFFD
    const lossy = (buf) => JSON.parse(new TextDecoder('utf-8').decode(buf));

    const good = Buffer.from(JSON.stringify({ fio: 'Пётр' }), 'utf8');
    let req = { rawBody: good, body: lossy(good) };
    api.repairRequestEncoding(req, {}, () => {});
    assert.equal(req.body.fio, 'Пётр');
    assert.equal(req.bodyEncoding, undefined, 'обычный UTF-8 запрос не пересобирается');

    const cpBody = Buffer.concat([
      Buffer.from('{"fio":"', 'utf8'),
      Buffer.from([0xC8, 0xE2, 0xE0, 0xED, 0xEE, 0xE2, 0x20, 0xCF, 0xB8, 0xF2, 0xF0]), // 'Иванов Пётр' в cp1251
      Buffer.from('","note":"ok"}', 'utf8'),
    ]);
    req = { rawBody: cpBody, body: lossy(cpBody) };
    assert.ok(req.body.fio.includes('\uFFFD'), 'без ремонта имя было бы испорчено');
    api.repairRequestEncoding(req, {}, () => {});
    assert.equal(req.body.fio, 'Иванов Пётр');
    assert.equal(req.body.note, 'ok');
    assert.equal(req.bodyEncoding, 'windows-1251');

    // валидный UTF-8 с уже испорченным символом не «чинится» молча: тело
    // остаётся как есть, а поле с U+FFFD отбивает проверка в handleApiOrder
    req = { rawBody: Buffer.from(JSON.stringify({ fio: 'a\uFFFD' }), 'utf8'), body: { fio: 'a\uFFFD' } };
    api.repairRequestEncoding(req, {}, () => {});
    assert.equal(req.body.fio, 'a\uFFFD');
    assert.equal(req.bodyEncoding, undefined);
  });
});
