"""Собирает однофайловую версию для claude.ai: artifact/dist/tovarka.html."""
from pathlib import Path

HERE = Path(__file__).parent
css = (HERE.parent / "static" / "styles.css").read_text()

# отступы под безопасные зоны телефона и шрифты
css = css.replace(
    ".view { padding: 16px 16px calc(var(--nav-h) + 24px + env(safe-area-inset-bottom)); max-width: 1100px; margin: 0 auto; }",
    ".view { padding-block: 16px calc(var(--nav-h) + 24px + env(safe-area-inset-bottom, 0px));"
    " padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));"
    " max-width: 1100px; margin: 0 auto; }")
css = css.replace(
    "  .view { padding: 28px 32px 48px; width: 100%; }",
    "  .view { padding-block: 28px 48px; padding-left: max(32px, env(safe-area-inset-left, 0px));"
    " padding-right: max(32px, env(safe-area-inset-right, 0px)); width: 100%; }")
css = css.replace(
    "  background: var(--surface); border-top: 1px solid var(--border);\n}",
    "  padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px);\n"
    "  background: var(--surface); border-top: 1px solid var(--border);\n}")
css = css.replace("position: sticky; top: 0; height: 100vh;", "position: sticky; top: env(safe-area-inset-top, 0px); height: 100vh;")
css = css.replace('font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;',
                  'font: 15px/1.45 "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;')
css += '\nh1, .kpi .value, .nav .brand { font-family: "Space Grotesk", "Inter", system-ui, sans-serif; }\n' \
       'h1 { text-wrap: balance; }\n.nav .brand svg { width: 30px; height: 30px; }\n' \
       '@media (prefers-reduced-motion: reduce) { .sheet-panel { animation: none; } }\n'
for needle in ["padding-block: 16px", "position: sticky; top: env", "padding-left: env(safe-area"]:
    assert needle in css, needle

html = (HERE.parent / "static" / "index.html").read_text()
body = html[html.index('<div class="layout">'):html.index('<script src="/app.js">')]
body = body.replace('<img src="/icons/icon.svg" alt="">', (HERE.parent / "static" / "icons" / "icon.svg").read_text().strip())
for a, b in [('href="#/" data-route="home"', 'href="#" data-route="home"'), ('href="#/batches"', 'href="#batches"'),
             ('href="#/stock"', 'href="#stock"'), ('href="#/sales"', 'href="#sales"'),
             ('href="#/settings" data-route="settings"', 'href="#options" data-route="options"')]:
    assert a in body, a
    body = body.replace(a, b)

js = (HERE / "store.js").read_text() + "\n" + (HERE / "ui.js").read_text()
out = f"""<title>Товарка</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@600;700&display=swap">
<style>
{css}
</style>
{body}<script>
{js}
</script>
"""
(HERE / "dist").mkdir(exist_ok=True)
(HERE / "dist" / "tovarka.html").write_text(out)
print("ok", len(out))
