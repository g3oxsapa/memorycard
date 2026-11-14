"""Отправка писем. Без настроек SMTP письма пишутся в журнал и в OUTBOX (для тестов)."""
import logging
import smtplib
import ssl
from email.message import EmailMessage

from . import config

log = logging.getLogger("marginly.mail")
OUTBOX: list[dict] = []


def send(to: str, subject: str, text: str) -> None:
    if not config.SMTP_HOST:
        OUTBOX.append({"to": to, "subject": subject, "text": text})
        del OUTBOX[:-50]
        log.warning("ПИСЬМО (тестовый режим) для %s: %s\n%s", to, subject, text)
        return
    msg = EmailMessage()
    msg["From"] = config.MAIL_FROM
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    with smtplib.SMTP_SSL(config.SMTP_HOST, config.SMTP_PORT, context=ssl.create_default_context(), timeout=15) as s:
        if config.SMTP_USER:
            s.login(config.SMTP_USER, config.SMTP_PASSWORD)
        s.send_message(msg)


def send_code(to: str, purpose: str, code: str) -> None:
    if purpose == "verify":
        subject = f"Marginly: код подтверждения {code}"
        text = (f"Здравствуйте!\n\nВаш код для подтверждения почты в Marginly: {code}\n\n"
                f"Код действует {config.CODE_TTL_MIN} минут. Если вы не регистрировались, просто удалите это письмо.")
    else:
        subject = f"Marginly: код для сброса пароля {code}"
        text = (f"Здравствуйте!\n\nКод для сброса пароля в Marginly: {code}\n\n"
                f"Код действует {config.CODE_TTL_MIN} минут. Если вы не запрашивали сброс, просто удалите это письмо.")
    send(to, subject, text)
