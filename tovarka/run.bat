@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv (
  echo Первый запуск: ставлю зависимости...
  python -m venv .venv
  .venv\Scripts\pip install -r requirements.txt
)
echo.
echo Товарка запущена: http://localhost:8000
echo С телефона (та же Wi-Fi): http://IP-компьютера:8000
echo Закрой это окно, чтобы остановить.
start "" http://localhost:8000
.venv\Scripts\python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
