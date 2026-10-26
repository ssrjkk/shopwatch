// Выгрузка живой базы каталога в файл-источник products-data.js.
// Формат файла: одна позиция = одна строка JSON, id сохраняются, чтобы deep link
// #/p/<id> и payload заказа значили одно и то же на сервере и на GitHub Pages.

const FIELDS = ['id', 'brand', 'series', 'category', 'name', 'price', 'image', 'specs', 'hit'];

function normalizeRow(r) {
  return {
    id: Math.trunc(Number(r.id)) || 0,
    brand: String(r.brand == null ? '' : r.brand),
    series: String(r.series == null ? '' : r.series),
    category: String(r.category == null ? '' : r.category),
    name: String(r.name == null ? '' : r.name),
    price: Math.trunc(Number(r.price)) || 0,
    image: String(r.image == null ? '' : r.image),
    specs: String(r.specs == null ? '' : r.specs),
    hit: Number(r.hit != null ? r.hit : r.is_hit) > 0 ? 1 : 0,
  };
}

function renderCatalogFile(rows, meta) {
  const items = rows.map(normalizeRow);
  const stamp = (meta && meta.date) || new Date().toISOString().slice(0, 10);
  const lines = items.map((x) => '  ' + JSON.stringify(x)).join(',\n');
  return [
    '// Единый источник каталога: server.js делает require(), index.html подключает <script src="products-data.js">.',
    '// Формат элемента: { id, brand, series, category, name, price, image, specs, hit } — id задаёт порядок и deep link #/p/<id>.',
    `// Выгружено из рабочей базы админ-ботом, дата ${stamp}, позиций: ${items.length}.`,
    'const PD_SEED_PRODUCTS = [',
    lines ? lines + ',' : '',
    '];',
    'if (typeof module !== \'undefined\' && module.exports) module.exports = PD_SEED_PRODUCTS;',
    'if (typeof window !== \'undefined\') window.SEED_PRODUCTS = PD_SEED_PRODUCTS;',
    '',
  ].join('\n');
}

// Читает содержимое файла-источника без side-effect'ов: window/module в sandbox'е пусты.
function readCatalogFile(src) {
  try {
    const fn = new Function(String(src) + '\n;return PD_SEED_PRODUCTS;');
    const rows = fn();
    return Array.isArray(rows) ? rows.map(normalizeRow) : null;
  } catch (e) {
    return null;
  }
}

function rowKey(p) {
  const n = normalizeRow(p);
  return [n.brand, n.series, n.category, n.name, n.price].join('|');
}

function diffCatalog(fileRows, dbRows) {
  const inFile = new Set((fileRows || []).map(rowKey));
  const inDb = new Set((dbRows || []).map(rowKey));
  return {
    fileCount: (fileRows || []).length,
    dbCount: (dbRows || []).length,
    onlyInDb: (dbRows || []).filter((p) => !inFile.has(rowKey(p))),
    onlyInFile: (fileRows || []).filter((p) => !inDb.has(rowKey(p))),
  };
}

// Позиции только в базе — это те, что добавлены через админку и ещё не попали в файл.
function summarizeDiff(diff) {
  const lines = [];
  lines.push(`В базе: ${diff.dbCount}, в файле: ${diff.fileCount}.`);
  lines.push(`Новых в базе (попадут в файл): ${diff.onlyInDb.length}.`);
  if (diff.onlyInFile.length) lines.push(`Есть в файле, но нет в базе (останутся в файле только если не перезаписывать): ${diff.onlyInFile.length}.`);
  return lines.join('\n');
}

module.exports = { FIELDS, normalizeRow, renderCatalogFile, readCatalogFile, rowKey, diffCatalog, summarizeDiff };
