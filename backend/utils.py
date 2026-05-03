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
