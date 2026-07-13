import logging
import sys
from datetime import datetime
from pathlib import Path

_CONFIGURED = False

def setup_logging(console_level: int = logging.INFO, to_file: bool = True) -> None:
    """Konfiguruje czytelne logowanie dla całego procesu scrapowania.

    - konsola: poziom INFO (czysty przegląd przebiegu),
    - plik logs/scrape_<timestamp>.log: poziom DEBUG (pełne szczegóły, np. zmiany tytułów, zapytania do API).
    """
    global _CONFIGURED
    if _CONFIGURED:
        return
    _CONFIGURED = True

    root = logging.getLogger()
    root.setLevel(logging.DEBUG)

    fmt = logging.Formatter(
        "%(asctime)s | %(levelname)-7s | %(name)-22s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    console = logging.StreamHandler(sys.stdout)
    console.setLevel(console_level)
    console.setFormatter(fmt)
    root.addHandler(console)

    if to_file:
        logs_dir = Path(__file__).parent / "logs"
        logs_dir.mkdir(exist_ok=True)
        log_path = logs_dir / f"scrape_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
        file_handler = logging.FileHandler(log_path, encoding="utf-8")
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(fmt)
        root.addHandler(file_handler)
        logging.getLogger(__name__).info("Log zapisywany do pliku: %s", log_path)

    # Wyciszamy gadatliwe biblioteki, żeby nie zaśmiecały logu
    for noisy in ("httpx", "httpcore", "hpack", "urllib3", "asyncio", "curl_cffi"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
