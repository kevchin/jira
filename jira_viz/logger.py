"""
Structured logger for jira_viz.

Features:
- File handler + console handler (both active simultaneously)
- Pasteable plain-text format (no ANSI codes in file, readable in console)
- HTTP error logging with full context (method, URL, status, response body, action)
- Graceful shutdown: flush + close handlers on SIGINT
"""

import logging
import sys
from pathlib import Path
from typing import Optional

_DEFAULT_LOG_FILE = Path("jira_viz.log")


class _HTTPErrorFormatter(logging.Formatter):
    """Custom formatter that adds HTTP error context blocks."""

    def format(self, record: logging.LogRecord) -> str:
        msg = super().format(record)
        # If the record has extra HTTP error fields, append a structured block
        if hasattr(record, "http_method"):
            block = (
                f"\n    Method:    {record.http_method}\n"
                f"    URL:       {record.http_url}\n"
                f"    Status:    {record.http_status}\n"
                f"    Action:    {record.http_action}"
            )
            if hasattr(record, "http_response"):
                block += f"\n    Response:  {record.http_response}"
            msg += block
        return msg


def get_logger(
    name: str = "jira_viz",
    log_file: Optional[Path] = None,
    level: int = logging.DEBUG,
) -> logging.Logger:
    """
    Create (or retrieve) the application logger with file + console handlers.

    Args:
        name: Logger name (default: 'jira_viz')
        log_file: Path to log file (default: ./jira_viz.log)
        level: Logging level (default: DEBUG)

    Returns:
        Configured logging.Logger instance
    """
    logger = logging.getLogger(name)

    # Avoid adding duplicate handlers if called multiple times
    if logger.handlers:
        return logger

    logger.setLevel(level)
    logger.propagate = False

    # Format: TIMESTAMP  LEVEL  MESSAGE
    fmt = logging.Formatter(
        "%(asctime)s  %(levelname)-5s  %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # Console handler — shows coloured-ish output for quick reading
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(fmt)
    logger.addHandler(console_handler)

    # File handler — full detail for pasteable debugging
    if log_file is None:
        log_file = _DEFAULT_LOG_FILE

    file_handler = logging.FileHandler(log_file, mode="a", encoding="utf-8")
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(fmt)
    logger.addHandler(file_handler)

    logger.info("=" * 60)
    logger.info("jira_viz logger initialised — log file: %s", log_file)
    logger.info("=" * 60)

    return logger


def shutdown_logger(logger: Optional[logging.Logger] = None) -> None:
    """
    Gracefully shut down the logger: flush and close all handlers.

    Call this in a finally block on KeyboardInterrupt or normal exit.
    """
    if logger is None:
        logger = logging.getLogger("jira_viz")

    for handler in logger.handlers[:]:
        handler.flush()
        handler.close()
        logger.removeHandler(handler)

    logger.info("Logger shut down — all handlers closed.")


def log_http_error(
    logger: logging.Logger,
    *,
    method: str,
    url: str,
    status_code: int,
    action: str,
    response_body: Optional[str] = None,
    message: str = "JIRA API HTTP error",
) -> None:
    """
    Log a JIRA API HTTP error with full context in a pasteable format.

    Args:
        logger: Logger instance
        method: HTTP method (GET, POST, PUT, DELETE)
        url: Request URL
        status_code: HTTP status code
        action: What the user was trying to do
        response_body: Response body (truncated if very long)
        message: Summary message
    """
    # Truncate response body to keep log readable
    if response_body and len(response_body) > 2000:
        response_body = response_body[:2000] + "... [truncated]"

    record = logger.makeRecord(
        name=logger.name,
        level=logging.ERROR,
        fn="log_http_error",
        lno=0,
        msg=message,
        args=(),
        exc_info=None,
    )
    record.http_method = method
    record.http_url = url
    record.http_status = status_code
    record.http_action = action
    record.http_response = response_body or "(none)"

    logger.handle(record)
