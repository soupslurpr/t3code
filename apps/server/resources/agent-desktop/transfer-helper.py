#!/usr/bin/env python3
"""Packs and extracts the private T3 Agent desktop transfer format."""

from __future__ import annotations

import argparse
import errno
import gzip
import hashlib
import json
import math
import os
import posixpath
import shutil
import stat
import struct
import sys
import uuid
from pathlib import Path
from typing import BinaryIO, TypedDict


BUNDLE_MAGIC = b"T3BNDL1\n"
END_HEADER = b"\x00\x00\x00\x00"
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


def write_header(output: BinaryIO, entry: dict[str, object]) -> None:
    """Writes one bounded JSON entry header."""
    header = json.dumps(entry, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if not header or len(header) > MAX_HEADER_BYTES:
        raise TransferError(f"bundle entry header exceeds {MAX_HEADER_BYTES} bytes")
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
    copied = 0
    with open(absolute_path, "rb") as source:
        while True:
            chunk = source.read(COPY_CHUNK_BYTES)
            if not chunk:
                break
            output.write(chunk)
            copied += len(chunk)
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


def digest_file(path: str) -> str:
    """Computes a lowercase SHA-256 digest without materializing a file."""
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        while True:
            chunk = source.read(COPY_CHUNK_BYTES)
            if not chunk:
                return digest.hexdigest()
            digest.update(chunk)


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


def read_exact(source: BinaryIO, size: int) -> bytes:
    """Reads exactly one bounded archive segment."""
    data = source.read(size)
    if len(data) != size:
        raise TransferError("bundle ended before its declared entry data")
    return data


def validate_entry_path(value: object) -> list[str]:
    """Rejects ambiguous entry paths and traversal attempts."""
    if not isinstance(value, str):
        raise TransferError("bundle entry path is not a string")
    if value == ".":
        return []
    if (
        not value
        or value.startswith("/")
        or "\\" in value
        or "\0" in value
        or len(value.encode("utf-8")) > MAX_ENTRY_PATH_BYTES
    ):
        raise TransferError(f"invalid bundle entry path {value!r}")
    segments = value.split("/")
    if any(not segment or segment in (".", "..") for segment in segments):
        raise TransferError(f"invalid bundle entry path {value!r}")
    return segments


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


def ensure_safe_parent(root: str, segments: list[str]) -> str:
    """Creates only real directory parents under a fresh staging root."""
    current = root
    for segment in segments[:-1]:
        current = os.path.join(current, segment)
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            os.mkdir(current, 0o700)
            continue
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise TransferError(f"bundle parent is not a directory: {'/'.join(segments)}")
    return root if not segments else os.path.join(root, *segments)


def remove_path(path: str) -> None:
    """Removes one exact path without following symlinks."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return
    if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
        shutil.rmtree(path)
    else:
        os.unlink(path)


def merge_directory(source: str, destination: str) -> None:
    """Merges one staged directory while replacing exact conflicts."""
    try:
        destination_info = os.lstat(destination)
    except FileNotFoundError:
        os.rename(source, destination)
        return
    if not stat.S_ISDIR(destination_info.st_mode) or stat.S_ISLNK(destination_info.st_mode):
        raise TransferError(
            f"merge destination is not a directory: {destination}",
            "destination-type-mismatch",
        )
    for name in sorted(os.listdir(source)):
        source_child = os.path.join(source, name)
        destination_child = os.path.join(destination, name)
        source_info = os.lstat(source_child)
        try:
            destination_child_info = os.lstat(destination_child)
        except FileNotFoundError:
            destination_child_info = None
        if (
            stat.S_ISDIR(source_info.st_mode)
            and not stat.S_ISLNK(source_info.st_mode)
            and destination_child_info is not None
            and stat.S_ISDIR(destination_child_info.st_mode)
            and not stat.S_ISLNK(destination_child_info.st_mode)
        ):
            merge_directory(source_child, destination_child)
        else:
            remove_path(destination_child)
            os.rename(source_child, destination_child)
    os.rmdir(source)


def install_staging(staging: str, destination: str, source_type: str, collision: str) -> None:
    """Installs one complete staging tree under the requested collision policy."""
    exists = os.path.lexists(destination)
    if collision == "create":
        if exists:
            raise TransferError(
                f"destination already exists: {destination}", "destination-exists"
            )
        os.rename(staging, destination)
        return
    if collision == "merge":
        if source_type != "directory":
            raise TransferError(
                "merge requires a directory source", "destination-type-mismatch"
            )
        merge_directory(staging, destination)
        return
    if not exists:
        os.rename(staging, destination)
        return
    backup = f"{destination}.t3-backup-{uuid.uuid4().hex}"
    os.rename(destination, backup)
    try:
        os.rename(staging, destination)
    except Exception:
        os.rename(backup, destination)
        raise
    remove_path(backup)


def chown_tree(path: str, uid: int, gid: int) -> None:
    """Assigns one staged tree to the graphical guest user without following links."""
    if uid < 0 or gid < 0:
        raise TransferError(
            "transfer owner identifiers cannot be negative", "invalid-destination"
        )
    info = os.lstat(path)
    if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
        for current, directories, files in os.walk(path, topdown=False, followlinks=False):
            for name in (*directories, *files):
                os.chown(os.path.join(current, name), uid, gid, follow_symlinks=False)
            os.chown(current, uid, gid, follow_symlinks=False)
        return
    os.chown(path, uid, gid, follow_symlinks=False)


def extract_raw(
    raw_path: str,
    destination: str,
    collision: str,
    owner_uid: int | None,
    owner_gid: int | None,
) -> Summary:
    """Extracts one validated raw bundle through a fresh sibling staging path."""
    destination = os.path.abspath(destination)
    if destination == os.path.abspath(os.sep):
        raise TransferError(
            "the filesystem root cannot be a transfer destination", "invalid-destination"
        )
    staging = f"{destination}.t3-transfer-{uuid.uuid4().hex}"
    seen: set[str] = set()
    directories: list[tuple[str, int, float]] = []
    symlinks: list[tuple[str, str, float]] = []
    source_type: str | None = None
    summary: Summary = {
        "rootType": "file",
        "fileCount": 0,
        "directoryCount": 0,
        "symlinkCount": 0,
        "logicalBytes": 0,
    }
    entry_count = 0
    try:
        os.makedirs(os.path.dirname(destination), mode=0o700, exist_ok=True)
        with open(raw_path, "rb") as archive:
            if read_exact(archive, len(BUNDLE_MAGIC)) != BUNDLE_MAGIC:
                raise TransferError("bundle magic does not match the supported format")
            while True:
                header_length = struct.unpack(">I", read_exact(archive, 4))[0]
                if header_length == 0:
                    break
                if header_length > MAX_HEADER_BYTES:
                    raise TransferError(f"bundle entry header exceeds {MAX_HEADER_BYTES} bytes")
                try:
                    entry = json.loads(read_exact(archive, header_length).decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise TransferError("bundle contains an invalid entry header") from error
                if not isinstance(entry, dict):
                    raise TransferError("bundle entry header is not an object")
                entry_path = entry.get("path")
                segments = validate_entry_path(entry_path)
                if entry_path in seen:
                    raise TransferError(f"bundle contains duplicate entry {entry_path!r}")
                seen.add(entry_path)
                entry_count += 1
                if entry_count > MAX_ENTRY_COUNT:
                    raise TransferError(f"bundle exceeds {MAX_ENTRY_COUNT} entries")
                if entry_count == 1 and entry_path != ".":
                    raise TransferError("the first bundle entry must describe the source root")
                entry_type = entry.get("type")
                if entry_type not in ("file", "directory", "symlink"):
                    raise TransferError(f"invalid bundle entry type at {entry_path}")
                if source_type is None:
                    source_type = entry_type
                    summary["rootType"] = entry_type
                    if source_type == "symlink":
                        raise TransferError("a transfer root cannot be a symlink")
                mode = entry.get("mode")
                mtime_ms = entry.get("mtimeMs")
                if (
                    not isinstance(mode, int)
                    or isinstance(mode, bool)
                    or mode < 0
                    or mode > 0o777
                    or not isinstance(mtime_ms, (int, float))
                    or isinstance(mtime_ms, bool)
                    or not math.isfinite(mtime_ms)
                    or mtime_ms < 0
                ):
                    raise TransferError(f"invalid bundle metadata at {entry_path}")
                path = ensure_safe_parent(staging, segments)
                if entry_type == "directory":
                    os.mkdir(path, 0o700)
                    directories.append((path, mode, mtime_ms / 1000))
                    summary["directoryCount"] += 1
                elif entry_type == "file":
                    size = entry.get("size")
                    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
                        raise TransferError(f"invalid file size at {entry_path}")
                    with open(path, "xb") as output:
                        remaining = size
                        while remaining:
                            chunk = read_exact(archive, min(remaining, COPY_CHUNK_BYTES))
                            output.write(chunk)
                            remaining -= len(chunk)
                        output.flush()
                        os.fsync(output.fileno())
                    os.chmod(path, mode)
                    os.utime(path, (mtime_ms / 1000, mtime_ms / 1000))
                    summary["fileCount"] += 1
                    summary["logicalBytes"] += size
                else:
                    target = validate_symlink_target(str(entry_path), entry.get("target"))
                    symlinks.append((path, target, mtime_ms / 1000))
                    summary["symlinkCount"] += 1
            if archive.read(1):
                raise TransferError("bundle contains trailing bytes after its terminator")
        if source_type is None:
            raise TransferError("bundle contains no root entry")
        for path, target, mtime in symlinks:
            os.symlink(target, path)
            os.utime(path, (mtime, mtime), follow_symlinks=False)
        for path, mode, mtime in reversed(directories):
            os.chmod(path, mode)
            os.utime(path, (mtime, mtime))
        if owner_uid is not None and owner_gid is not None:
            chown_tree(staging, owner_uid, owner_gid)
        install_staging(staging, destination, source_type, collision)
        return summary
    except Exception:
        remove_path(staging)
        raise


def extract(
    archive_path: str,
    destination: str,
    compression: str,
    collision: str,
    expected_sha256: str,
    owner_uid: int | None,
    owner_gid: int | None,
) -> dict[str, object]:
    """Verifies and extracts one transfer bundle."""
    digest = digest_file(archive_path)
    if digest != expected_sha256:
        raise TransferError(
            "bundle SHA-256 does not match the transfer manifest", "integrity-failed"
        )
    wire_bytes = os.path.getsize(archive_path)
    raw_path = f"{archive_path}.{uuid.uuid4().hex}.raw"
    try:
        selected_path = archive_path
        if compression == "gzip":
            with gzip.open(archive_path, "rb") as source, open(raw_path, "xb") as target:
                shutil.copyfileobj(source, target, COPY_CHUNK_BYTES)
            selected_path = raw_path
        summary = extract_raw(selected_path, destination, collision, owner_uid, owner_gid)
        return {
            **summary,
            "wireBytes": wire_bytes,
            "compression": compression,
            "sha256": digest,
        }
    finally:
        try:
            os.unlink(raw_path)
        except FileNotFoundError:
            pass


def parse_arguments(arguments: list[str]) -> argparse.Namespace:
    """Parses the bounded transfer-helper command line."""
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="operation", required=True)
    pack_parser = commands.add_parser("pack")
    pack_parser.add_argument("--source", required=True)
    pack_parser.add_argument("--output", required=True)
    pack_parser.add_argument("--compression", choices=("auto", "none", "gzip"), required=True)
    extract_parser = commands.add_parser("extract")
    extract_parser.add_argument("--archive", required=True)
    extract_parser.add_argument("--destination", required=True)
    extract_parser.add_argument("--compression", choices=("none", "gzip"), required=True)
    extract_parser.add_argument("--collision", choices=("create", "replace", "merge"), required=True)
    extract_parser.add_argument("--sha256", required=True)
    extract_parser.add_argument("--owner-uid", type=int)
    extract_parser.add_argument("--owner-gid", type=int)
    return parser.parse_args(arguments)


def unexpected_error_code(error: Exception, operation: str) -> str:
    """Categorizes one unexpected filesystem failure without parsing prose."""
    if isinstance(error, OSError) and error.errno in RESOURCE_ERRNOS:
        return "resource-exhausted"
    return "source-unavailable" if operation == "pack" else "invalid-destination"


def main(arguments: list[str]) -> int:
    """Runs one pack or extract request and writes one JSON result."""
    options = parse_arguments(arguments)
    try:
        if options.operation == "pack":
            result = pack(options.source, options.output, options.compression)
        else:
            if (options.owner_uid is None) != (options.owner_gid is None):
                raise TransferError(
                    "owner UID and GID must be provided together", "invalid-destination"
                )
            result = extract(
                options.archive,
                options.destination,
                options.compression,
                options.collision,
                options.sha256,
                options.owner_uid,
                options.owner_gid,
            )
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except TransferError as error:
        print(
            json.dumps(
                {"code": error.code, "detail": str(error)[:1024]},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            file=sys.stderr,
        )
        return 1
    except Exception as error:
        code = unexpected_error_code(error, options.operation)
        print(
            json.dumps(
                {"code": code, "detail": str(error)[:1024]},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
