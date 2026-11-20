from __future__ import annotations

import argparse
import json
import sys
from transfer_format import (
    TransferError,
    unexpected_error_code,
)
from transfer_pack import pack
from transfer_extract import extract


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
