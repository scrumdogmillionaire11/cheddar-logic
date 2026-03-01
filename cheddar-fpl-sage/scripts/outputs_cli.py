"""
Outputs utility CLI.

Usage:
  python scripts/outputs_cli.py validate
  python scripts/outputs_cli.py prune --keep-days 14 --keep-latest 10 --dry-run
"""

import argparse

from scripts.prune_outputs import prune_outputs, DEFAULT_KEEP_DAYS, DEFAULT_KEEP_LATEST
from scripts.validate_latest_outputs import validate_latest


def main():
    parser = argparse.ArgumentParser(description="Outputs helper CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate_parser = subparsers.add_parser("validate", help="Validate latest bundle")
    validate_parser.set_defaults(func=lambda args: validate_latest())

    prune_parser = subparsers.add_parser("prune", help="Prune old run bundles")
    prune_parser.add_argument("--keep-days", type=int, default=DEFAULT_KEEP_DAYS)
    prune_parser.add_argument("--keep-latest", type=int, default=DEFAULT_KEEP_LATEST)
    prune_parser.add_argument("--dry-run", action="store_true")
    prune_parser.set_defaults(
        func=lambda args: prune_outputs(
            base_dir=args.base_dir,
            keep_days=args.keep_days,
            keep_latest=args.keep_latest,
            dry_run=args.dry_run,
        )
    )
    parser.add_argument(
        "--base-dir",
        type=str,
        default="outputs",
        help="Base outputs directory (default: outputs)",
    )

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
