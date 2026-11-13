#!/usr/bin/env bash
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "Первый запуск: ставлю зависимости..."
  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
fi
echo "Товарка запущена: http://localhost:8000"
exec .venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
