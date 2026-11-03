<?php
/**
 * Plugin Name: Watchop — Мост WooCommerce ↔ Telegram (@wwwatchshop_bot) & MAX
 * Description: Синхронизирует заказы WooCommerce с сервером ботов Watchop (TG-XXXX), выводит кнопку перехода в Telegram-бот на странице «Спасибо за заказ» и подключает фирменный светлый дизайн витрины.
 * Version: 2.0.0
 * Author: Watchop
 */
if (!defined('ABSPATH')) exit;

define('WATCHOP_BOT_WEBHOOK', getenv('WATCHOP_BOT_WEBHOOK') ?: 'http://localhost:3000/api/webhooks/woocommerce');
define('WATCHOP_TG_BOT_URL', getenv('WATCHOP_TG_BOT_URL') ?: 'https://t.me/wwwatchshop_bot');

add_action('woocommerce_checkout_order_processed', function ($order_id) {
    $order = wc_get_order($order_id);
    if (!$order) return;

    $tg_code = 'TG-' . (20000 + intval($order_id));
    $order->update_meta_data('_watchop_tg_code', $tg_code);
    $order->save();

    $items = [];
    foreach ($order->get_items() as $item) {
        $product = $item->get_product();
        $sku = $product ? $product->get_sku() : '';
        $pid = ($sku && preg_match('/REF-0*(\d+)/', $sku, $m)) ? intval($m[1]) : $item->get_product_id();
        $items[] = [
            'product_id' => $pid,
            'name'       => $item->get_name(),
            'quantity'   => $item->get_quantity(),
            'price'      => intval($order->get_item_total($item, true)),
        ];
    }

    $payload = [
        'id'         => $order_id,
        'tg_code'    => $tg_code,
        'billing'    => [
            'first_name' => $order->get_billing_first_name(),
            'last_name'  => $order->get_billing_last_name(),
            'phone'      => $order->get_billing_phone(),
            'email'      => $order->get_billing_email(),
            'city'       => $order->get_billing_city(),
            'address_1'  => $order->get_billing_address_1(),
        ],
        'line_items' => $items,
    ];

    wp_remote_post(WATCHOP_BOT_WEBHOOK, [
        'headers' => ['Content-Type' => 'application/json; charset=utf-8'],
        'body'    => wp_json_encode($payload),
        'timeout' => 8,
        'blocking'=> false,
    ]);
}, 10, 1);

add_action('woocommerce_thankyou', function ($order_id) {
    $order = wc_get_order($order_id);
    if (!$order) return;
    $tg_code = $order->get_meta('_watchop_tg_code') ?: ('TG-' . (20000 + intval($order_id)));
    $parts = [];
    foreach ($order->get_items() as $item) {
        $product = $item->get_product();
        $sku = $product ? $product->get_sku() : '';
        $pid = ($sku && preg_match('/REF-0*(\d+)/', $sku, $m)) ? intval($m[1]) : $item->get_product_id();
        $parts[] = $pid . 'x' . $item->get_quantity() . 'x' . intval($order->get_item_total($item, true));
    }
    $deep_link = WATCHOP_TG_BOT_URL . '?start=' . $tg_code . ($parts ? '_' . implode('_', $parts) : '');
    echo '<div style="background:#FFFFFF;border:1px solid #E5E7EB;border-radius:16px;padding:24px;margin:20px 0;text-align:center;">';
    echo '<div style="font-size:13px;color:#0E9F6E;font-weight:700;text-transform:uppercase;">Заявка зарезервирована</div>';
    echo '<div style="font-family:monospace;font-size:20px;font-weight:800;margin:8px 0;color:#141619;">' . esc_html($tg_code) . '</div>';
    echo '<p style="font-size:13px;color:#475569;margin-bottom:16px;">Нажмите кнопку ниже, чтобы получить реквизиты оплаты и трек-номер СДЭК в официальном Telegram-боте:</p>';
    echo '<a href="' . esc_url($deep_link) . '" target="_blank" style="display:inline-block;background:#2AABEE;color:#FFFFFF;font-weight:800;padding:12px 24px;border-radius:12px;text-decoration:none;">Открыть заказ в Telegram (@wwwatchshop_bot)</a>';
    echo '</div>';
}, 5, 1);
