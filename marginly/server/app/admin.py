"""Служебные команды: python -m app.admin grant <email> <дней> | users"""
import sys
from datetime import timedelta

from . import db


def main(argv):
    db.init()
    if argv[:1] == ["grant"] and len(argv) == 3:
        email, days = argv[1].lower(), int(argv[2])
        with db.tx() as c:
            u = c.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
            if not u:
                sys.exit("Нет такого пользователя")
            base = max(db.now(), db.parse(u["paid_until"]) or db.now())
            until = db.iso(base + timedelta(days=days))
            c.execute("UPDATE users SET paid_until = ? WHERE id = ?", (until, u["id"]))
        print(f"{email}: подписка до {until}")
    elif argv[:1] == ["users"]:
        c = db.connect()
        for u in c.execute("SELECT email, verified, created_at, trial_ends_at, paid_until FROM users ORDER BY id"):
            print(dict(u))
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
