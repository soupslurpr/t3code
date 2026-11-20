from __future__ import annotations

import gzip
import json
import os
import shutil
import stat
import struct
import uuid
from typing import BinaryIO

from transfer_format import (
    AUTO_COMPRESSION_MAX_RATIO,
    AUTO_COMPRESSION_MIN_BYTES,
    AUTO_COMPRESSION_SAMPLE_BYTES,
    BUNDLE_MAGIC,
    COPY_CHUNK_BYTES,
    END_HEADER,
    GZIP_LEVEL,
    MAX_ENTRY_COUNT,
    MAX_HEADER_BYTES,
    Summary,
    TransferError,
    check_size,
    digest_file,
    validate_symlink_target,
)


def write_header(output: BinaryIO, entry: dict[str, object]) -> None:
    """Writes one bounded JSON entry header."""
    header = json.dumps(entry, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if not header or len(header) > MAX_HEADER_BYTES:
        raise TransferError(f"bundle entry header exceeds {MAX_HEADER_BYTES} bytes")
    check_size(output.tell() + 4 + len(header) + len(END_HEADER))
    output.write(struct.pack(">I", len(header)))
    output.write(header)


def root_type(info: os.stat_result, entry_path: str) -> str:
    """Maps one lstat result to a supported portable entry type."""
    mode = info.st_mode
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISLNK(mode):
        return "symlink"
    raise TransferError(f"unsupported file type at {entry_path}")


def append_file(
    output: BinaryIO,
    absolute_path: str,
    bundle_path: str,
    info: os.stat_result,
    summary: Summary,
) -> None:
    """Appends one exact regular file and detects concurrent size changes."""
    summary["fileCount"] += 1
    summary["logicalBytes"] += info.st_size
    write_header(
        output,
        {
            "path": bundle_path,
            "type": "file",
            "mode": stat.S_IMODE(info.st_mode),
            "mtimeMs": info.st_mtime_ns / 1_000_000,
            "size": info.st_size,
        },
    )
    check_size(output.tell() + info.st_size + len(END_HEADER))
    copied = 0
    with open(absolute_path, "rb") as source:
        while True:
            chunk = source.read(COPY_CHUNK_BYTES)
            if not chunk:
                break
            copied += len(chunk)
            if copied > info.st_size:
                raise TransferError(f"source file grew during copy: {bundle_path}", "source-unavailable")
            output.write(chunk)
    if copied != info.st_size:
        raise TransferError(
            f"source file changed while being copied: {bundle_path}",
            "source-unavailable",
        )


def append_directory(
    output: BinaryIO,
    absolute_path: str,
    bundle_path: str,
    info: os.stat_result,
    summary: Summary,
    symlinks: list[tuple[str, str, os.stat_result]],
    entry_count: list[int],
) -> None:
    """Traverses one directory in lexical order and defers symlinks."""
    entry_count[0] += 1
    if entry_count[0] > MAX_ENTRY_COUNT:
        raise TransferError(f"bundle exceeds {MAX_ENTRY_COUNT} entries")
    summary["directoryCount"] += 1
    write_header(
        output,
        {
            "path": bundle_path,
            "type": "directory",
            "mode": stat.S_IMODE(info.st_mode),
            "mtimeMs": info.st_mtime_ns / 1_000_000,
        },
    )
    with os.scandir(absolute_path) as iterator:
        children = sorted(iterator, key=lambda child: child.name)
    for child in children:
        if "/" in child.name or "\\" in child.name or "\0" in child.name:
            raise TransferError(f"unsupported file name {child.name!r}")
        child_absolute = os.path.join(absolute_path, child.name)
        child_bundle = child.name if bundle_path == "." else f"{bundle_path}/{child.name}"
        child_info = os.lstat(child_absolute)
        child_type = root_type(child_info, child_bundle)
        if child_type == "directory":
            append_directory(
                output,
                child_absolute,
                child_bundle,
                child_info,
                summary,
                symlinks,
                entry_count,
            )
        elif child_type == "file":
            entry_count[0] += 1
            if entry_count[0] > MAX_ENTRY_COUNT:
                raise TransferError(f"bundle exceeds {MAX_ENTRY_COUNT} entries")
            append_file(output, child_absolute, child_bundle, child_info, summary)
        else:
            symlinks.append((child_absolute, child_bundle, child_info))


def write_raw_bundle(source_path: str, output_path: str) -> Summary:
    """Builds one uncompressed portable bundle."""
    source_path = os.path.abspath(source_path)
    source_info = os.lstat(source_path)
    source_type = root_type(source_info, ".")
    if source_type == "symlink":
        raise TransferError("copying a symlink as the transfer root is not supported")
    summary: Summary = {
        "rootType": source_type,
        "fileCount": 0,
        "directoryCount": 0,
        "symlinkCount": 0,
        "logicalBytes": 0,
    }
    symlinks: list[tuple[str, str, os.stat_result]] = []
    entry_count = [0]
    with open(output_path, "xb") as output:
        output.write(BUNDLE_MAGIC)
        if source_type == "directory":
            append_directory(
                output, source_path, ".", source_info, summary, symlinks, entry_count
            )
        else:
            entry_count[0] += 1
            append_file(output, source_path, ".", source_info, summary)
        for absolute_path, bundle_path, link_info in symlinks:
            entry_count[0] += 1
            if entry_count[0] > MAX_ENTRY_COUNT:
                raise TransferError(f"bundle exceeds {MAX_ENTRY_COUNT} entries")
            target = os.readlink(absolute_path)
            target = validate_symlink_target(bundle_path, target)
            summary["symlinkCount"] += 1
            write_header(
                output,
                {
                    "path": bundle_path,
                    "type": "symlink",
                    "mode": stat.S_IMODE(link_info.st_mode),
                    "mtimeMs": link_info.st_mtime_ns / 1_000_000,
                    "target": target,
                },
            )
        output.write(END_HEADER)
        output.flush()
        os.fsync(output.fileno())
    return summary


def choose_compression(raw_path: str, preference: str) -> str:
    """Chooses gzip only when a bounded sample predicts useful savings."""
    if preference != "auto":
        return preference
    size = os.path.getsize(raw_path)
    if size < AUTO_COMPRESSION_MIN_BYTES:
        return "none"
    with open(raw_path, "rb") as source:
        sample = source.read(AUTO_COMPRESSION_SAMPLE_BYTES)
    compressed = gzip.compress(sample, compresslevel=GZIP_LEVEL, mtime=0)
    return "gzip" if len(compressed) / len(sample) <= AUTO_COMPRESSION_MAX_RATIO else "none"


def pack(source_path: str, output_path: str, preference: str) -> dict[str, object]:
    """Packs one guest tree into an optionally compressed transfer bundle."""
    raw_path = f"{output_path}.{uuid.uuid4().hex}.raw"
    owns_output = False
    try:
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), mode=0o700, exist_ok=True)
        summary = write_raw_bundle(source_path, raw_path)
        archive_bytes = os.path.getsize(raw_path)
        compression = choose_compression(raw_path, preference)
        if compression == "gzip":
            with open(raw_path, "rb") as source, open(output_path, "xb") as target:
                owns_output = True
                with gzip.GzipFile(
                    filename="", mode="wb", compresslevel=GZIP_LEVEL, fileobj=target, mtime=0
                ) as compressed:
                    shutil.copyfileobj(source, compressed, COPY_CHUNK_BYTES)
            os.unlink(raw_path)
        else:
            os.link(raw_path, output_path)
            owns_output = True
            os.unlink(raw_path)
        check_size(os.path.getsize(output_path))
        return {
            **summary,
            "archiveBytes": archive_bytes,
            "wireBytes": os.path.getsize(output_path),
            "compression": compression,
            "sha256": digest_file(output_path),
        }
    except Exception:
        cleanup_paths = (raw_path, output_path) if owns_output else (raw_path,)
        for path in cleanup_paths:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
        raise
