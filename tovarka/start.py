"""Запуск Товарки: ставит зависимости, запускает сервер и открывает браузер, когда он готов."""

import os
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)
sys.path.insert(0, HERE)


def pause():
    try:
        input("\nНажми Enter, чтобы закрыть окно...")
    except EOFError:
        pass


def ensure_deps():
    try:
        import fastapi, uvicorn, multipart, PIL  # noqa: F401,E401
        return
    except ImportError:
        pass
    print("Первый запуск: ставлю нужные библиотеки (1–2 минуты)...\n")
    code = subprocess.call([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"])
    if code != 0:
        raise SystemExit("Не получилось установить библиотеки. Проверь интернет и запусти ещё раз.")


def free_port(start=8000):
    for port in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("0.0.0.0", port))
                return port
            except OSError:
                continue
    raise SystemExit("Не нашёл свободный порт 8000–8019.")


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return None


def open_when_ready(url):
    for _ in range(120):
        try:
            urllib.request.urlopen(url + "/api/settings", timeout=1)
            webbrowser.open(url)
            return
        except Exception:  # noqa: BLE001
            time.sleep(0.5)
    print("\nСервер долго не отвечает — посмотри ошибки выше.")


def main():
    if sys.version_info < (3, 10):
        raise SystemExit(f"Нужен Python 3.10 или новее, а установлен {sys.version.split()[0]}.")
    ensure_deps()
    import uvicorn

    port = free_port()
    url = f"http://127.0.0.1:{port}"
    ip = lan_ip()
    print("=" * 52)
    print(f"  Товарка запущена:   {url}")
    if ip:
        print(f"  С телефона (та же Wi-Fi): http://{ip}:{port}")
    print("  Не закрывай это окно, пока пользуешься.")
    print("=" * 52 + "\n")
    threading.Thread(target=open_when_ready, args=(url,), daemon=True).start()
    uvicorn.run("app.main:app", host="0.0.0.0", port=port, log_level="warning")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except SystemExit as e:
        if e.code not in (None, 0):
            print(f"\nОшибка: {e.code}")
            pause()
    except Exception:  # noqa: BLE001
        print("\nПриложение упало с ошибкой:\n")
        traceback.print_exc()
        print("\nСделай скриншот этого окна и пришли мне.")
        pause()
