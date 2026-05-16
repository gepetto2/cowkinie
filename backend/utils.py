import re
from datetime import datetime
from zoneinfo import ZoneInfo

def parse_start_time(start_time_raw: str) -> str:
    """Parsuje ciąg daty i w razie braku strefy czasowej dodaje Europe/Warsaw."""
    if not start_time_raw:
        return ""
    try:
        dt_obj = datetime.fromisoformat(start_time_raw)
        if dt_obj.tzinfo is None:
            dt_obj = dt_obj.replace(tzinfo=ZoneInfo("Europe/Warsaw"))
        return dt_obj.isoformat()
    except ValueError:
        return start_time_raw

def clean_title(title: str) -> str:
    if not title:
        return ""
    # Usuwa przedrostki kinowe
    title = re.sub(r'^(?:NMF|NT Live)[:\s\-]+', '', title, flags=re.IGNORECASE)
    # Usuwa rocznice np. " 40. Rocznica"
    title = re.sub(r'(?:\.\s*)?\s*\d+\.?\s*[Rr]ocznica\b.*$', '', title, flags=re.IGNORECASE)
    # Usuwa typowy dopisek CC
    title = title.replace(" - National Theatre Live 2026", "")
    return title.strip()
