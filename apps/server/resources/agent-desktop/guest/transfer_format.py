"""Shared limits, metadata and validation for the T3BNDL1 guest transport."""
from __future__ import annotations

import errno
import hashlib
import posixpath
from typing import TypedDict

BUNDLE_MAGIC = b"T3BNDL1\n"
END_HEADER = b"\x00\x00\x00\x00"
MAX_TRANSFER_BYTES = 1024 ** 3
MAX_HEADER_BYTES = 64 * 1024
MAX_ENTRY_COUNT = 1_000_000
MAX_ENTRY_PATH_BYTES = 16 * 1024
MAX_LINK_TARGET_BYTES = 16 * 1024
COPY_CHUNK_BYTES = 1024 * 1024
AUTO_COMPRESSION_SAMPLE_BYTES = 4 * 1024 * 1024
AUTO_COMPRESSION_MIN_BYTES = 64 * 1024
AUTO_COMPRESSION_MAX_RATIO = 0.9
GZIP_LEVEL = 1
RESOURCE_ERRNOS = {errno.ENOSPC, errno.ENOMEM, errno.EFBIG, getattr(errno, "EDQUOT", -1)}


class TransferError(Exception):
    """Reports one safe, bounded guest transfer failure."""

    def __init__(self, message: str, code: str = "unsupported-entry") -> None:
        """Creates one categorized transfer failure."""
        super().__init__(message)
        self.code = code


class Summary(TypedDict):
    """Describes one portable copied tree."""

    rootType: str
    fileCount: int
    directoryCount: int
    symlinkCount: int
    logicalBytes: int


def digest_file(path: str) -> str:
    """Computes a lowercase SHA-256 digest without materializing a file."""
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while True:
            chunk = source.read(COPY_CHUNK_BYTES)
            if not chunk:
                return digest.hexdigest()
            digest.update(chunk)


def unexpected_error_code(error: Exception, operation: str) -> str:
    """Categorizes one unexpected filesystem failure without parsing prose."""
    if isinstance(error, OSError) and error.errno in RESOURCE_ERRNOS:
        return "resource-exhausted"
    return "source-unavailable" if operation == "pack" else "invalid-destination"


def validate_symlink_target(entry_path: str, target: object) -> str:
    """Rejects symlinks whose lexical target leaves the copied tree."""
    if (
        not isinstance(target, str)
        or not target
        or "\0" in target
        or "\\" in target
        or posixpath.isabs(target)
        or len(target.encode("utf-8")) > MAX_LINK_TARGET_BYTES
    ):
        raise TransferError(f"unsafe symlink target at {entry_path}")
    base = "." if entry_path == "." else posixpath.dirname(entry_path)
    resolved = posixpath.normpath(posixpath.join(base, target))
    if resolved == ".." or resolved.startswith("../"):
        raise TransferError(f"symlink target escapes the copied tree at {entry_path}")
    return target


def check_size(size: int) -> None:
    if size > MAX_TRANSFER_BYTES:
        raise TransferError("bundle exceeds the desktop transfer byte limit", "resource-exhausted")
