"""Запуск сервера Marginly на своём компьютере (для проверки, без аренды сервера).

Ставит библиотеки, один раз спрашивает пароль приложения Google, проверяет вход в Gmail,
запускает сервер и открывает браузер. Данные и пароль хранятся в папке data/ рядом.
"""
import getpass
import os
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
os.chdir(HERE)
sys.path.insert(0, str(HERE))
DATA = HERE / "data"
SMTP_FILE = DATA / "smtp.env"
MAIL = "marginly.app@gmail.com"


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
    print("Первый запуск: ставлю библиотеки (1–2 минуты)...\n")
    if subprocess.call([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"]) != 0:
        raise SystemExit("Не получилось установить библиотеки. Проверь интернет и запусти ещё раз.")


def load_smtp():
    DATA.mkdir(exist_ok=True)
    if not SMTP_FILE.exists():
        print(f"Письма с кодами будут уходить с {MAIL}.")
        pw = getpass.getpass("Вставь пароль приложения Google (символы не видны) и нажми Enter.\n"
                             "Пусто — без почты, коды будут показываться в этом окне: ").replace(" ", "")
        SMTP_FILE.write_text(f"SMTP_PASSWORD={pw}\n", encoding="utf-8")
    pw = SMTP_FILE.read_text(encoding="utf-8").split("=", 1)[1].strip()
    if pw:
        os.environ.update(SMTP_HOST="smtp.gmail.com", SMTP_PORT="465", SMTP_USER=MAIL,
                          SMTP_PASSWORD=pw, MAIL_FROM=f"Marginly <{MAIL}>")
    return bool(pw)


def check_gmail():
    import smtplib
    import ssl
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context(), timeout=15) as s:
            s.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])
        print("Почта: вход в Gmail успешен, коды будут приходить на почту.")
    except smtplib.SMTPAuthenticationError:
        print("Почта: Gmail не принял пароль. Удали файл data/smtp.env и запусти снова, чтобы ввести пароль заново.")
    except Exception as e:  # noqa: BLE001
        print(f"Почта: не удалось подключиться к Gmail ({e}). Коды будут показываться в этом окне.")
        for k in ("SMTP_HOST", "SMTP_PASSWORD"):
            os.environ.pop(k, None)


def free_port(start=8080):
    for port in range(start, start + 20):
        with socket.socket() as s:
            try:
                s.bind(("0.0.0.0", port))
                return port
            except OSError:
                continue
    raise SystemExit("Нет свободного порта 8080–8099.")


def lan_ip():
    """Адрес в домашней сети (192.168…, 10…, 172.16–31…), а не адрес VPN."""
    import ipaddress
    cands = set()
    try:
        cands.update(i[4][0] for i in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET))
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            cands.add(s.getsockname()[0])
    except OSError:
        pass
    home = [c for c in cands if ipaddress.ip_address(c).is_private and not c.startswith(("127.", "198.18.", "198.19."))]
    home.sort(key=lambda c: (not c.startswith("192.168."), c))
    return home[0] if home else None


def open_when_ready(url):
    for _ in range(60):
        try:
            urllib.request.urlopen(url + "/api/health", timeout=1)
            webbrowser.open(url)
            return
        except Exception:  # noqa: BLE001
            time.sleep(0.5)


def main():
    if sys.version_info < (3, 10):
        raise SystemExit(f"Нужен Python 3.10 или новее, а установлен {sys.version.split()[0]}.")
    ensure_deps()
    if load_smtp():
        check_gmail()
    os.environ.setdefault("MARGINLY_DATA", str(DATA))
    import logging
    logging.basicConfig(level=logging.WARNING, format="%(message)s")
    import uvicorn

    port = free_port()
    url = f"http://localhost:{port}"
    ip = lan_ip()
    print("\n" + "=" * 56)
    print(f"  Marginly запущен:  {url}")
    if ip:
        print(f"  С телефона (та же Wi-Fi), в браузере: http://{ip}:{port}")
    print("  Не закрывай это окно, пока проверяешь.")
    print("=" * 56 + "\n")
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
        print("\nСервер упал с ошибкой:\n")
        traceback.print_exc()
        print("\nСделай скриншот этого окна и пришли мне.")
        pause()
