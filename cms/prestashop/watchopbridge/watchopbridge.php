<?php
if (!defined('_PS_VERSION_')) exit;

class WatchopBridge extends Module {
    public function __construct() {
        $this->name = 'watchopbridge';
        $this->tab = 'checkout';
        $this->version = '2.0.0';
        $this->author = 'Watchop';
        $this->need_instance = 0;
        parent::__construct();
        $this->displayName = 'Watchop — Синхронизация PrestaShop ↔ Telegram & MAX';
        $this->description = 'Передаёт новые заказы в @wwwatchshop_bot и MAX с кодом TG-XXXX.';
    }

    public function install() {
        return parent::install() && $this->registerHook('actionValidateOrder');
    }

    public function hookActionValidateOrder($params) {
        $order = $params['order'] ?? null;
        $customer = $params['customer'] ?? null;
        if (!$order) return;

        $address = new Address((int)$order->id_address_delivery);
        $products = $order->getProducts();
        $items = [];
        foreach ($products as $p) {
            $items[] = [
                'product_id'         => (int)$p['product_id'],
                'product_name'       => $p['product_name'],
                'product_quantity'   => (int)$p['product_quantity'],
                'unit_price_tax_incl'=> (int)$p['unit_price_tax_incl']
            ];
        }

        $payload = json_encode([
            'order'    => ['id' => (int)$order->id, 'reference' => $order->reference, 'items' => $items],
            'customer' => ['firstname' => $customer->firstname ?? '', 'lastname' => $customer->lastname ?? '', 'email' => $customer->email ?? ''],
            'address'  => ['city' => $address->city ?? '', 'address1' => $address->address1 ?? '', 'phone' => $address->phone_mobile ?: ($address->phone ?? '')]
        ], JSON_UNESCAPED_UNICODE);

        $webhook = getenv('WATCHOP_BOT_WEBHOOK') ?: 'http://localhost:3000/api/webhooks/prestashop';
        $secret = getenv('WATCHOP_WEBHOOK_SECRET') ?: '';
        $headers = ['Content-Type: application/json'];
        if ($secret !== '') $headers[] = 'X-Watchop-Signature: sha256=' . hash_hmac('sha256', $payload, $secret);
        $ch = curl_init($webhook);
        curl_setopt($ch, CURLOPT_POST, 1);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        curl_setopt($ch, CURLOPT_TIMEOUT, 5);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_exec($ch);
        curl_close($ch);
    }
}
