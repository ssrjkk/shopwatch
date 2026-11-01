# Синхронизация зеркал, тесты, коммит и пуш (для D:\123245).
# Использование: .\push-update.ps1 [-Message "текст коммита"]
param([string]$Message = "chore: sync pages mirrors")
$ErrorActionPreference = "Stop"

Write-Host "=== 1. Зеркала public/ -> корень (GitHub Pages) ===" -ForegroundColor Cyan
node sync-pages.js

Write-Host "=== 2. Автотесты ===" -ForegroundColor Cyan
npm test

Write-Host "=== 3. Коммит и пуш в origin/main ===" -ForegroundColor Cyan
git add -A
$status = git status --porcelain
if ($status) {
  git commit -m $Message
  git push origin main
  Write-Host "=== ЗАПУШЕНО ===" -ForegroundColor Green
} else {
  Write-Host "Дерево чистое, пушить нечего." -ForegroundColor Yellow
}
