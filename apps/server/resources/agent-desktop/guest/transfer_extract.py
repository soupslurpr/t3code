from __future__ import annotations

import ctypes
import errno
import gzip
import json
import math
import os
import shutil
import stat
import struct
import sys
import uuid
from typing import BinaryIO

from transfer_format import (
    BUNDLE_MAGIC,
    COPY_CHUNK_BYTES,
    MAX_ENTRY_COUNT,
    MAX_ENTRY_PATH_BYTES,
    MAX_HEADER_BYTES,
    Summary,
    TransferError,
    check_size,
    digest_file,
    unexpected_error_code,
    validate_symlink_target,
)


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


def rename_no_replace(source: str, destination: str, parent_identity: os.stat_result | None = None) -> None:
    """Publishes one complete sibling with Linux's exclusive rename."""
    parent_path = os.path.dirname(source)
    if (not os.path.isabs(source) or not os.path.isabs(destination)
            or parent_path != os.path.dirname(destination) or source == destination
            or any("\0" in path or os.path.basename(path) in ("", ".", "..")
                   for path in (source, destination))):
        raise TransferError("atomic publication requires distinct absolute sibling paths", "invalid-destination")
    try:
        rename = ctypes.CDLL(None, use_errno=True).renameat2
    except (AttributeError, OSError) as error:
        raise TransferError("atomic no-replace publication is unavailable; no rename was submitted", "invalid-destination") from error
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    parent = os.open(parent_path, os.O_PATH | os.O_DIRECTORY)
    failure = None
    try:
        held, current = os.fstat(parent), os.stat(parent_path)
        if ((held.st_dev, held.st_ino) != (current.st_dev, current.st_ino)
                or (parent_identity is not None and (held.st_dev, held.st_ino) != (parent_identity.st_dev, parent_identity.st_ino))):
            raise TransferError("publication parent changed; no rename was submitted", "invalid-destination")
        result = rename(parent, os.fsencode(os.path.basename(source)), parent,
                        os.fsencode(os.path.basename(destination)), 1)
        if result != 0:
            code = ctypes.get_errno()
            if code == errno.EEXIST:
                raise TransferError(f"destination already exists: {destination}", "destination-exists")
            raise TransferError(
                f"Publication outcome is unconfirmed ({code}: {os.strerror(code)}); inspect {destination} before retrying.",
                "invalid-destination",
            )
    except Exception as error:
        failure = error
        raise
    finally:
        try:
            os.close(parent)
        except OSError as cleanup_error:
            # Do not retry a possibly released descriptor or replace the publication receipt.
            detail = f"Handle cleanup failed at {parent_path}: {cleanup_error}"[:512]
            if failure is not None:
                raise TransferError(
                    f"{failure}. {detail}",
                    getattr(failure, "code", unexpected_error_code(failure, "extract")),
                ) from failure
            try:
                print(detail, file=sys.stderr)
            except OSError:
                pass


def remove_owned_staging(path: str, identity: os.stat_result) -> None:
    """Cleans only an unpublished staging inode, including restrictive directories."""
    try:
        current = os.lstat(path)
    except FileNotFoundError:
        return
    if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
        raise TransferError("staging path now belongs to a different object; it was retained")
    if stat.S_ISDIR(current.st_mode) and not stat.S_ISLNK(current.st_mode):
        os.chmod(path, 0o700)
        for name in os.listdir(path):
            child = os.path.join(path, name)
            remove_owned_staging(child, os.lstat(child))
        os.rmdir(path)
    else:
        os.unlink(path)


def install_staging(staging: str, destination: str, source_type: str, collision: str, parent_identity: os.stat_result | None = None) -> None:
    """Installs one complete staging tree under the requested collision policy."""
    if collision == "create":
        rename_no_replace(staging, destination, parent_identity)
        return
    exists = os.path.lexists(destination)
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
    staging_identity: os.stat_result | None = None
    try:
        os.makedirs(os.path.dirname(destination), mode=0o700, exist_ok=True)
        parent_identity = os.stat(os.path.dirname(destination))
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
                    if entry_path == ".":
                        staging_identity = os.lstat(path)
                    directories.append((path, mode, mtime_ms / 1000))
                    summary["directoryCount"] += 1
                elif entry_type == "file":
                    size = entry.get("size")
                    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
                        raise TransferError(f"invalid file size at {entry_path}")
                    with open(path, "xb") as output:
                        if entry_path == ".":
                            staging_identity = os.fstat(output.fileno())
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
        install_staging(staging, destination, source_type, collision, parent_identity)
        return summary
    except Exception as error:
        if staging_identity is not None:
            try:
                remove_owned_staging(staging, staging_identity)
            except Exception as cleanup_error:
                raise TransferError(
                    f"{error}. Staging cleanup was not confirmed at {staging}: {cleanup_error}",
                    getattr(error, "code", "invalid-destination"),
                ) from error
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
    wire_bytes = os.path.getsize(archive_path)
    check_size(wire_bytes)
    digest = digest_file(archive_path)
    if digest != expected_sha256:
        raise TransferError(
            "bundle SHA-256 does not match the transfer manifest", "integrity-failed"
        )
    raw_path = f"{archive_path}.{uuid.uuid4().hex}.raw"
    failure: Exception | None = None
    try:
        selected_path = archive_path
        if compression == "gzip":
            with gzip.open(archive_path, "rb") as source, open(raw_path, "xb") as target:
                while chunk := source.read(COPY_CHUNK_BYTES):
                    check_size(target.tell() + len(chunk))
                    target.write(chunk)
            selected_path = raw_path
        summary = extract_raw(selected_path, destination, collision, owner_uid, owner_gid)
        return {
            **summary,
            "archiveBytes": os.path.getsize(selected_path),
            "wireBytes": wire_bytes,
            "compression": compression,
            "sha256": digest,
        }
    except Exception as error:
        failure = error
        raise
    finally:
        try:
            os.unlink(raw_path)
        except FileNotFoundError:
            pass
        except OSError as cleanup_error:
            detail = f"Raw spool cleanup was not confirmed at {raw_path}: {cleanup_error}"[:512]
            if failure is not None:
                raise TransferError(
                    f"{failure}. {detail}",
                    getattr(failure, "code", unexpected_error_code(failure, "extract")),
                ) from failure
            try:
                print(detail, file=sys.stderr)
            except OSError:
                pass
