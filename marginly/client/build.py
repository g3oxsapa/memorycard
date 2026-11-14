"""Сборка клиента Marginly.

  python build.py            → ../server/web/ (веб-версия, сервер раздаёт её сам)
  python build.py --android URL → ../android/app/src/main/assets/ (приложение, URL — адрес сервера)
"""
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / "src"
JS_ORDER = ["store.js", "sync.js", "ui.js", "orders.js", "auth.js", "app.js"]


def build(out_dir: Path, api_base: str = "") -> Path:
    css = (SRC / "styles.css").read_text()
    fonts_css = (HERE / "fonts" / "fonts.css").read_text()
    shell = (SRC / "shell.html").read_text()
    body = shell[shell.index('<div class="layout">'):shell.index('<script src="/app.js">')]
    brand = (SRC / "app.js").read_text().split("const BRAND_SVG = '")[1].split("';")[0]
    body = body.replace("__BRAND__", brand)
    for a, b in [('href="#/" data-route="home"', 'href="#" data-route="home"'), ('href="#/batches"', 'href="#batches"'),
                 ('href="#/stock"', 'href="#stock"'), ('href="#/orders"', 'href="#orders"'),
                 ('href="#/settings" data-route="settings"', 'href="#options" data-route="options"')]:
        assert a in body, a
        body = body.replace(a, b)
    js = "\n".join((SRC / f).read_text() for f in JS_ORDER)
    js = js.replace("let API_BASE = '';", f"let API_BASE = {api_base!r};", 1)
    html = f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#15171a">
<title>Marginly</title>
<meta name="description" content="Учёт партий из Китая: карго, себестоимость, склад, заказы и прибыль">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<style>
{fonts_css}
[hidden] {{ display: none !important; }}
img {{ max-width: 100%; }}
{css}
</style>
</head>
<body>
{body}<script>
{js}
</script>
</body>
</html>
"""
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_text(html)
    (out_dir / "favicon.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" {brand[5:]}')
    shutil.copytree(HERE / "fonts", out_dir / "fonts", dirs_exist_ok=True)
    legal = out_dir / "legal"
    legal.mkdir(exist_ok=True)
    for name, title in [("terms", "Пользовательское соглашение"), ("privacy", "Политика конфиденциальности")]:
        f = legal / f"{name}.html"
        if not f.exists():
            f.write_text(f'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
                         f'<title>{title} — Marginly</title><body style="font:16px/1.5 system-ui;max-width:680px;margin:40px auto;padding:0 16px">'
                         f'<h1>{title}</h1><p>Документ готовится и появится до запуска сервиса.</p></body>')
    return out_dir / "index.html"


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--android":
        out = build(HERE.parent / "android" / "app" / "src" / "main" / "assets", sys.argv[2] if len(sys.argv) > 2 else "")
    else:
        out = build(HERE.parent / "server" / "web")
    print("ok", out, out.stat().st_size)
