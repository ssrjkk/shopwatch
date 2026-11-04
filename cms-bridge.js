/**
 * cms-bridge.js — Мост интеграции Watchop с движками WooCommerce, OpenCart 3/4 и PrestaShop 8.
 * Обеспечивает:
 * 1) Экспорт каталога (391 товаров с официальными фото) в форматы импорта WooCommerce CSV, OpenCart CSV/SQL и PrestaShop CSV.
 * 2) Совместимые REST-эндпоинты (/wp-json/wc/v3/products, /api/opencart/products, /api/prestashop/products).
 * 3) Приём вебхуков заказов из WooCommerce, OpenCart и PrestaShop с записью в единую БД и уведомлением админов в Telegram и MAX.
 */

function csvCell(val, sep = ',') {
  const s = String(val == null ? '' : val).replace(/\r?\n/g, ' ');
  if (s.includes('"') || s.includes(sep) || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Абсолютный URL фото для импорта в CMS: WooCommerce/OpenCart/PrestaShop
// скачивают картинки по URL, относительные пути каталога им не подходят.
function absImageUrl(image) {
  const s = String(image || '');
  if (!s || /^https?:\/\//i.test(s) || s.startsWith('data:')) return s;
  const base = (typeof process !== 'undefined' && process.env && process.env.SHOP_URL ? String(process.env.SHOP_URL) : 'https://ssrjkk.github.io/shopwatch').replace(/\/+$/, '');
  return base + '/' + s.replace(/^\/+/, '');
}

// Все кадры товара абсолютными URL: первичное фото + реальные ракурсы галереи.
// Порядок важен: первая картинка становится главной в WooCommerce/PrestaShop.
function allImageUrls(p) {
  const out = [];
  const push = (u) => {
    const a = absImageUrl(u);
    if (a && !out.includes(a)) out.push(a);
  };
  push(p.image);
  const extra = Array.isArray(p.images) ? p.images : [];
  for (const u of extra.slice(0, 4)) {
    const s = String(u || '');
    if (!s || /^https?:\/\//i.test(s) || s.startsWith('data:')) continue;
    push(s);
  }
  return out;
}

function toWooCommerceCsv(products) {
  const headers = [
    'ID', 'Type', 'SKU', 'Name', 'Published', 'Is featured?', 'Visibility in catalog',
    'Short description', 'Description', 'In stock?', 'Stock', 'Regular price', 'Sale price',
    'Categories', 'Images', 'Attribute 1 name', 'Attribute 1 value(s)', 'Attribute 1 visible',
    'Attribute 2 name', 'Attribute 2 value(s)', 'Attribute 2 visible'
  ];
  const lines = ['\uFEFF' + headers.join(',')];
  for (const p of products || []) {
    const id = Number(p.id) || 0;
    const sku = `REF-${String(id).padStart(4, '0')}`;
    const hasSale = (Number(p.old_price) || 0) > Number(p.price);
    const regPrice = hasSale ? Number(p.old_price) : Number(p.price);
    const salePrice = hasSale ? Number(p.price) : '';
    const stock = p.stock !== undefined ? Number(p.stock) : 4;
    const hit = Number(p.hit != null ? p.hit : p.is_hit) > 0 ? 1 : 0;
    const cat = `${p.category || 'Спортивные часы'} > ${p.brand || 'GARMIN'}`;
    const row = [
      id,
      'simple',
      sku,
      p.name || '',
      1,
      hit,
      'visible',
      p.specs || '',
      `${p.name || ''}. Бренд: ${p.brand || ''}, серия: ${p.series || ''}. Характеристики: ${p.specs || ''}. Официальная гарантия 12 месяцев.`,
      stock > 0 ? 1 : 0,
      stock,
      regPrice,
      salePrice,
      cat,
      allImageUrls(p).join(', '),
      'Бренд',
      p.brand || '',
      1,
      'Серия',
      p.series || '',
      1
    ];
    lines.push(row.map((c) => csvCell(c, ',')).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function toOpenCartCsv(products) {
  const headers = [
    'product_id', 'model', 'sku', 'name', 'manufacturer', 'category', 'series',
    'price', 'special_price', 'quantity', 'status', 'is_hit', 'image', 'description'
  ];
  const lines = ['\uFEFF' + headers.join(';')];
  for (const p of products || []) {
    const id = Number(p.id) || 0;
    const sku = `REF-${String(id).padStart(4, '0')}`;
    const hasSale = (Number(p.old_price) || 0) > Number(p.price);
    const regPrice = hasSale ? Number(p.old_price) : Number(p.price);
    const specPrice = hasSale ? Number(p.price) : '';
    const stock = p.stock !== undefined ? Number(p.stock) : 4;
    const hit = Number(p.hit != null ? p.hit : p.is_hit) > 0 ? 1 : 0;
    const row = [
      id,
      `${p.brand || 'GARMIN'}-${id}`,
      sku,
      p.name || '',
      p.brand || '',
      p.category || 'Спортивные часы',
      p.series || '',
      regPrice,
      specPrice,
      stock,
      1,
      hit,
      absImageUrl(p.image),
      p.specs || ''
    ];
    lines.push(row.map((c) => csvCell(c, ';')).join(';'));
  }
  return lines.join('\r\n') + '\r\n';
}

function sqlEsc(val) {
  return "'" + String(val == null ? '' : val).replace(/'/g, "''") + "'";
}

function toOpenCartSql(products, prefix = 'oc_') {
  const out = [
    '-- Watchop OpenCart 3.x / 4.x Catalog Seed (391 Products with Official Images)',
    'SET NAMES utf8mb4;',
    'START TRANSACTION;'
  ];
  const cats = [];
  const brands = [];
  for (const p of products || []) {
    if (p.category && !cats.includes(p.category)) cats.push(p.category);
    if (p.brand && !brands.includes(p.brand)) brands.push(p.brand);
  }
  cats.forEach((c, idx) => {
    const cid = idx + 100;
    out.push(`INSERT INTO ${prefix}category (category_id, parent_id, top, column, sort_order, status, date_added, date_modified) VALUES (${cid}, 0, 1, 1, ${idx + 1}, 1, NOW(), NOW()) ON DUPLICATE KEY UPDATE status=1;`);
    out.push(`INSERT INTO ${prefix}category_description (category_id, language_id, name, description, meta_title) VALUES (${cid}, 1, ${sqlEsc(c)}, ${sqlEsc(c)}, ${sqlEsc(c)}) ON DUPLICATE KEY UPDATE name=VALUES(name);`);
  });
  brands.forEach((b, idx) => {
    const mid = idx + 100;
    out.push(`INSERT INTO ${prefix}manufacturer (manufacturer_id, name, sort_order) VALUES (${mid}, ${sqlEsc(b)}, ${idx + 1}) ON DUPLICATE KEY UPDATE name=VALUES(name);`);
  });
  for (const p of products || []) {
    const id = Number(p.id) || 0;
    const sku = `REF-${String(id).padStart(4, '0')}`;
    const cid = cats.indexOf(p.category) + 100;
    const mid = brands.indexOf(p.brand) + 100;
    const hasSale = (Number(p.old_price) || 0) > Number(p.price);
    const basePrice = hasSale ? Number(p.old_price) : Number(p.price);
    const stock = p.stock !== undefined ? Number(p.stock) : 4;
    out.push(`INSERT INTO ${prefix}product (product_id, model, sku, quantity, stock_status_id, image, manufacturer_id, shipping, price, status, date_added, date_modified) VALUES (${id}, ${sqlEsc((p.brand || 'WATCH') + '-' + id)}, ${sqlEsc(sku)}, ${stock}, 7, ${sqlEsc(absImageUrl(p.image))}, ${mid}, 1, ${basePrice}, 1, NOW(), NOW()) ON DUPLICATE KEY UPDATE price=VALUES(price), quantity=VALUES(quantity), image=VALUES(image);`);
    out.push(`INSERT INTO ${prefix}product_description (product_id, language_id, name, description, tag, meta_title) VALUES (${id}, 1, ${sqlEsc(p.name)}, ${sqlEsc(p.specs || '')}, ${sqlEsc(p.series || '')}, ${sqlEsc(p.name)}) ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description);`);
    if (cid >= 100) {
      out.push(`INSERT IGNORE INTO ${prefix}product_to_category (product_id, category_id) VALUES (${id}, ${cid});`);
    }
    // Дополнительные ракурсы — в штатную таблицу картинок OpenCart
    allImageUrls(p).slice(1).forEach((u, i) => {
      out.push(`INSERT INTO ${prefix}product_image (product_id, image, sort_order) VALUES (${id}, ${sqlEsc(u)}, ${i + 1}) ON DUPLICATE KEY UPDATE image=VALUES(image);`);
    });
    if (hasSale) {
      out.push(`DELETE FROM ${prefix}product_special WHERE product_id = ${id};`);
      out.push(`INSERT INTO ${prefix}product_special (product_id, customer_group_id, priority, price) VALUES (${id}, 1, 1, ${Number(p.price)});`);
    }
  }
  out.push('COMMIT;');
  return out.join('\n') + '\n';
}

function toPrestaShopCsv(products) {
  const headers = [
    'Product ID', 'Active (0/1)', 'Name *', 'Categories (x,y,z...)', 'Price tax included',
    'Discount amount', 'Reference #', 'Brand', 'Summary', 'Description', 'Quantity',
    'Image URLs (x,y,z...)', 'On sale (0/1)'
  ];
  const lines = ['\uFEFF' + headers.join(';')];
  for (const p of products || []) {
    const id = Number(p.id) || 0;
    const sku = `REF-${String(id).padStart(4, '0')}`;
    const hasSale = (Number(p.old_price) || 0) > Number(p.price);
    const regPrice = hasSale ? Number(p.old_price) : Number(p.price);
    const discAmt = hasSale ? Number(p.old_price) - Number(p.price) : 0;
    const stock = p.stock !== undefined ? Number(p.stock) : 4;
    const row = [
      id,
      1,
      p.name || '',
      `Главная,${p.category || 'Спортивные часы'},${p.series || ''}`,
      regPrice,
      discAmt > 0 ? discAmt : '',
      sku,
      p.brand || '',
      p.specs || '',
      `${p.name || ''} (${p.brand || ''} ${p.series || ''}). ${p.specs || ''}`,
      stock,
      allImageUrls(p).join(','),
      hasSale ? 1 : 0
    ];
    lines.push(row.map((c) => csvCell(c, ';')).join(';'));
  }
  return lines.join('\r\n') + '\r\n';
}

function toWooCommerceRestProduct(p) {
  const id = Number(p.id) || 0;
  const hasSale = (Number(p.old_price) || 0) > Number(p.price);
  const regPrice = hasSale ? String(p.old_price) : String(p.price);
  const salePrice = hasSale ? String(p.price) : '';
  const stock = p.stock !== undefined ? Number(p.stock) : 4;
  return {
    id,
    name: String(p.name || ''),
    slug: `watch-${id}`,
    type: 'simple',
    status: 'publish',
    featured: Boolean(Number(p.hit != null ? p.hit : p.is_hit) > 0),
    catalog_visibility: 'visible',
    description: String(p.specs || ''),
    short_description: String(p.specs || ''),
    sku: `REF-${String(id).padStart(4, '0')}`,
    price: String(p.price || 0),
    regular_price: regPrice,
    sale_price: salePrice,
    on_sale: hasSale,
    stock_quantity: stock,
    stock_status: stock > 0 ? 'instock' : 'onbackorder',
    categories: [{ id: 1, name: String(p.category || 'Спортивные часы'), slug: String(p.category || 'watches') }],
    brands: [{ id: 1, name: String(p.brand || 'GARMIN') }],
    images: allImageUrls(p).map((src, i) => ({ id: id * 10 + i, src, name: String(p.name || '') })),
    attributes: [
      { id: 1, name: 'Бренд', options: [String(p.brand || '')] },
      { id: 2, name: 'Серия', options: [String(p.series || '')] }
    ]
  };
}

function normalizeCmsWebhookOrder(engine, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (engine === 'woocommerce') {
    const billing = b.billing || {};
    const shipping = b.shipping || {};
    const fio = `${billing.first_name || ''} ${billing.last_name || ''}`.trim() || String(b.customer_name || 'Покупатель WooCommerce');
    const phone = String(billing.phone || b.phone || '');
    const email = String(billing.email || b.email || '');
    const address = [shipping.city || billing.city, shipping.address_1 || billing.address_1].filter(Boolean).join(', ');
    const rawItems = Array.isArray(b.line_items) ? b.line_items : (Array.isArray(b.items) ? b.items : []);
    const items = rawItems.map((it) => ({
      id: Number(it.product_id || it.id) || 1,
      name: String(it.name || 'Товар WooCommerce').slice(0, 200),
      price: Math.trunc(Number(it.price || it.total || 0)) || 0,
      qty: Math.min(Math.max(Math.trunc(Number(it.quantity || it.qty)) || 1, 1), 99)
    }));
    const total = Math.trunc(Number(b.total || items.reduce((s, i) => s + i.price * i.qty, 0))) || 0; return { engine: 'WooCommerce', externalId: String(b.id || b.number || ''), fio, phone, email, address, customer_name: fio, customer_phone: phone, customer_comment: address, total, delivery: String(b.shipping_lines?.[0]?.method_title || 'СДЭК'), items };
  }
  if (engine === 'opencart') {
    const fio = `${b.firstname || ''} ${b.lastname || ''}`.trim() || String(b.fio || 'Покупатель OpenCart');
    const phone = String(b.telephone || b.phone || '');
    const email = String(b.email || '');
    const address = [b.shipping_city || b.payment_city, b.shipping_address_1 || b.payment_address_1].filter(Boolean).join(', ');
    const rawItems = Array.isArray(b.products) ? b.products : (Array.isArray(b.items) ? b.items : []);
    const items = rawItems.map((it) => ({
      id: Number(it.product_id || it.id) || 1,
      name: String(it.name || 'Товар OpenCart').slice(0, 200),
      price: Math.trunc(Number(it.price || 0)) || 0,
      qty: Math.min(Math.max(Math.trunc(Number(it.quantity || it.qty)) || 1, 1), 99)
    }));
    const total = Math.trunc(Number(b.total || items.reduce((s, i) => s + i.price * i.qty, 0))) || 0; return { engine: 'OpenCart', externalId: String(b.order_id || ''), fio, phone, email, address, customer_name: fio, customer_phone: phone, customer_comment: address, total, delivery: String(b.shipping_method || 'СДЭК'), items };
  }
  // PrestaShop
  const order = b.order || b;
  const customer = b.customer || {};
  const addr = b.address || {};
  const fio = `${customer.firstname || addr.firstname || ''} ${customer.lastname || addr.lastname || ''}`.trim() || String(order.fio || 'Покупатель PrestaShop');
  const phone = String(addr.phone_mobile || addr.phone || order.phone || '');
  const email = String(customer.email || order.email || '');
  const address = [addr.city, addr.address1].filter(Boolean).join(', ');
  const rawItems = Array.isArray(order.associations?.order_rows) ? order.associations.order_rows : (Array.isArray(order.items) ? order.items : []);
  const items = rawItems.map((it) => ({
    id: Number(it.product_id || it.id) || 1,
    name: String(it.product_name || it.name || 'Товар PrestaShop').slice(0, 200),
    price: Math.trunc(Number(it.unit_price_tax_incl || it.price || 0)) || 0,
    qty: Math.min(Math.max(Math.trunc(Number(it.product_quantity || it.qty)) || 1, 1), 99)
  }));
  const total = Math.trunc(Number(order.total_paid_tax_incl || order.total || items.reduce((s, i) => s + i.price * i.qty, 0))) || 0; return { engine: 'PrestaShop', externalId: String(order.id || order.reference || ''), fio, phone, email, address, customer_name: fio, customer_phone: phone, customer_comment: address, total, delivery: String(order.carrier || 'СДЭК'), items };
}

module.exports = {
  absImageUrl,
  allImageUrls,
  toWooCommerceCsv,
  toOpenCartCsv,
  toOpenCartSql,
  toPrestaShopCsv,
  toWooCommerceRestProduct,
  normalizeCmsWebhookOrder
};
