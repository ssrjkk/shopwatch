<?php
namespace Opencart\Catalog\Controller\Extension\Watchop\Module;
/**
 * Watchop OpenCart 3/4 -> Telegram (@wwwatchshop_bot) & MAX Bridge
 * Event trigger: catalog/model/checkout/order/addOrderHistory/after
 */
class WatchopTgMax extends \Opencart\System\Engine\Controller {
    public function onOrderHistory(&$route, &$args, &$output) {
        $order_id = isset($args[0]) ? (int)$args[0] : 0;
        if (!$order_id) return;

        $this->load->model('checkout/order');
        $order_info = $this->model_checkout_order->getOrder($order_id);
        if (!$order_info) return;

        $products = $this->model_checkout_order->getProducts($order_id);
        $items = [];
        foreach ($products as $p) {
            $items[] = [
                'product_id' => (int)$p['product_id'],
                'name'       => $p['name'],
                'quantity'   => (int)$p['quantity'],
                'price'      => (int)$p['price']
            ];
        }

        $payload = json_encode([
            'order_id'           => $order_id,
            'firstname'          => $order_info['firstname'],
            'lastname'           => $order_info['lastname'],
            'telephone'          => $order_info['telephone'],
            'email'              => $order_info['email'],
            'shipping_city'      => $order_info['shipping_city'],
            'shipping_address_1' => $order_info['shipping_address_1'],
            'shipping_method'    => is_array($order_info['shipping_method']) ? ($order_info['shipping_method']['name'] ?? 'СДЭК') : ($order_info['shipping_method'] ?? 'СДЭК'),
            'products'           => $items
        ], JSON_UNESCAPED_UNICODE);

        $webhook = getenv('WATCHOP_BOT_WEBHOOK') ?: 'http://localhost:3000/api/webhooks/opencart';
        $ch = curl_init($webhook);
        curl_setopt($ch, CURLOPT_POST, 1);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        curl_setopt($ch, CURLOPT_TIMEOUT, 5);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_exec($ch);
        curl_close($ch);
    }
}
