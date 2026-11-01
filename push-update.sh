#!/usr/bin/env bash
# Зеркала, тесты, коммит и пуш. Использование: ./push-update.sh "текст коммита"
set -e
MSG="${1:-chore: sync pages mirrors}"
echo "=== 1. Зеркала public/ -> корень ==="
node sync-pages.js
echo "=== 2. Автотесты ==="
npm test
echo "=== 3. Коммит и пуш в origin/main ==="
git add -A
git commit -m "$MSG" || true
git push origin main
echo "=== ГОТОВО ==="
